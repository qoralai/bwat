import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.ts';
import { jwksKeys } from '../src/jwks.ts';
import { peopleAuth, peopleAuthConfig } from '../src/people-auth.ts';
import { start } from '../src/server.ts';
import { apiBase, bearer, race } from './app.ts';
import { describeDb, useTestDb, type TestDb } from './db/harness.ts';
import { CLIENT_ID, idToken, jwksFetch, newSigningKey } from './google-fixture.ts';
import { brief, client } from './sessions.ts';

const ALICE = 'alice-token-'.padEnd(40, 'a');
const BOB = 'bob-token-'.padEnd(40, 'b');
const CAROL = 'carol-token-'.padEnd(40, 'c');

/** The config error for `value`, or null when it is accepted. */
const refusal = (value: string, env: NodeJS.ProcessEnv = {}) => {
  try {
    peopleAuthConfig({ NODE_ENV: 'test', ...env, BWAT_TEST_PEOPLE: value });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};

describe('BWAT_TEST_PEOPLE (QOR-4590)', () => {
  it('reads name:role:token entries, comma-separated', () => {
    expect(peopleAuthConfig({ NODE_ENV: 'test', BWAT_TEST_PEOPLE: ` carol:owner:${CAROL} ,alice:admin:${ALICE},bob:member:${BOB},, ` }).testPeople).toEqual([
      { name: 'carol', role: 'owner', token: CAROL },
      { name: 'alice', role: 'admin', token: ALICE },
      { name: 'bob', role: 'member', token: BOB },
    ]);
    expect(peopleAuthConfig({}).testPeople).toEqual([]);
    expect(peopleAuthConfig({ BWAT_TEST_PEOPLE: '' }).testPeople).toEqual([]);
  });

  it('is refused when NODE_ENV=production (as everywhere outside development and test), as the dev token is: a deployed install must never take a stand-in sign-in', () => {
    const production = { NODE_ENV: 'production', BWAT_ALLOWED_DOMAINS: 'example.com', BWAT_GOOGLE_CLIENT_IDS: 'web.example' };
    // Refused before it is read: a malformed value says the same.
    for (const value of [`alice:member:${ALICE}`, 'nonsense', ' ']) {
      expect(refusal(value, production), value).toBe('BWAT_TEST_PEOPLE is refused unless NODE_ENV is development or test');
    }
    expect(refusal('', production)).toBeNull();
  });

  it('fails closed: only NODE_ENV development or test turns stand-in sign-in on, for test people and the dev token alike', () => {
    const entry = `alice:member:${ALICE}`;
    const devToken = 'd'.repeat(40);
    for (const NODE_ENV of [undefined, '', 'Production', 'PRODUCTION', 'production ', ' development', 'staging', 'prod', 'dev']) {
      const env = NODE_ENV === undefined ? {} : { NODE_ENV };
      expect(() => peopleAuthConfig({ ...env, BWAT_TEST_PEOPLE: entry }), `test people, NODE_ENV=${JSON.stringify(NODE_ENV)}`).toThrow(
        'BWAT_TEST_PEOPLE is refused unless NODE_ENV is development or test',
      );
      expect(() => peopleAuthConfig({ ...env, BWAT_DEV_PERSON_TOKEN: devToken }), `dev token, NODE_ENV=${JSON.stringify(NODE_ENV)}`).toThrow(
        'BWAT_DEV_PERSON_TOKEN is refused unless NODE_ENV is development or test',
      );
    }
    for (const NODE_ENV of ['development', 'test']) {
      expect(peopleAuthConfig({ NODE_ENV, BWAT_TEST_PEOPLE: entry }).testPeople).toHaveLength(1);
      expect(peopleAuthConfig({ NODE_ENV, BWAT_DEV_PERSON_TOKEN: devToken }).devToken).toBe(devToken);
    }
  });

  it('refuses to start on a malformed entry, naming its position and never its text (it holds a token)', () => {
    const malformed = [
      `alice:${ALICE}`, // two parts
      `alice:member:${ALICE}:x`, // four parts
      `Alice:member:${ALICE}`, // name not lower-case
      `1alice:member:${ALICE}`, // name not starting with a letter
      `${'a'.repeat(33)}:member:${ALICE}`, // name over 32
      `alice_b:member:${ALICE}`, // name with an underscore
      `alice:superuser:${ALICE}`, // no such role
      `alice:Owner:${ALICE}`, // roles are lower-case
      `alice:member:${'x'.repeat(31)}`, // token under 32
      `alice:member:${ALICE.slice(0, 39)}!`, // token outside [A-Za-z0-9._~-]
      `alice:member:${ALICE} x`, // token with a space
      `alice:member:`, // no token
    ];
    for (const entry of malformed) {
      const message = refusal(`bob:member:${BOB},${entry}`);
      expect(message, entry).toBe('BWAT_TEST_PEOPLE entry 2 is malformed: want name:role:token, see backend/README.md');
    }
    expect(refusal(`alice:member:${'x'.repeat(32)}`)).toBeNull();
    expect(refusal(`a:member:A.b_c~d-${'x'.repeat(26)}`)).toBeNull();
    expect(refusal(`${'a'.repeat(32)}:member:${ALICE}`)).toBeNull();
  });

  it('refuses to start on a repeated name or token, or a token equal to BWAT_DEV_PERSON_TOKEN (it would never sign in)', () => {
    expect(refusal(`alice:member:${ALICE},alice:admin:${BOB}`)).toBe('BWAT_TEST_PEOPLE entry 2 repeats a name');
    expect(refusal(`alice:member:${ALICE},bob:admin:${ALICE}`)).toBe('BWAT_TEST_PEOPLE entry 2 repeats a token');
    expect(refusal(`alice:member:${ALICE}`, { BWAT_DEV_PERSON_TOKEN: ALICE })).toBe(
      'BWAT_TEST_PEOPLE entry 1 repeats a token',
    );
  });
});

/** The server as `start` builds it from the env, with BWAT_TEST_PEOPLE set and no other sign-in; what it logs goes to `lines`. */
function useTestPeople(value: string): { readonly app: FastifyInstance; readonly db: TestDb; lines: string[] } {
  const db = useTestDb();
  const lines: string[] = [];
  let app: FastifyInstance | undefined;
  beforeAll(async () => {
    const env = { BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', BWAT_TEST_PEOPLE: value };
    app = apiBase(await start(env, { logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } } }));
  });
  afterAll(() => app?.close());
  return {
    get app() {
      return app!;
    },
    db,
    lines,
  };
}

const DAVE = 'dave-token-'.padEnd(40, 'd');
const ERIN = 'erin-token-'.padEnd(40, 'e');
const PEOPLE = `carol:owner:${CAROL},alice:member:${ALICE},bob:member:${BOB},dave:admin:${DAVE},erin:member:${ERIN}`;

describeDb('test people sign in on the started server (QOR-4590)', () => {
  const t = useTestPeople(PEOPLE);
  const get = (url: string, token: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) });

  it("signs each entry in as <name>@test.bwat.invalid in its role, activated; an owner's first sign-in onboards the install (D149)", async () => {
    // No activated owner yet: the panel is closed to a member, though GET /me answers.
    expect((await get('/members', BOB)).json()).toEqual({ error: 'not_onboarded' });
    for (const [token, name, role] of [
      [CAROL, 'carol', 'owner'],
      [ALICE, 'alice', 'member'],
      [DAVE, 'dave', 'admin'],
    ]) {
      const me = await get('/me', token!);
      expect(me.statusCode, name).toBe(200);
      expect(me.json(), name).toEqual({ id: expect.any(String), email: `${name}@test.bwat.invalid`, display_name: name, role });
      expect((await get('/me', token!)).json().id, `${name} again`).toBe(me.json().id);
    }
    expect((await get('/members', BOB)).statusCode).toBe(200);
  });

  it('answers 401 to a token that is not one of them', async () => {
    for (const wrong of [`${ALICE}x`, ALICE.slice(1), 'x'.repeat(40), `${ALICE} `]) {
      expect((await get('/me', wrong)).statusCode, wrong).toBe(401);
    }
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: ALICE } })).statusCode).toBe(401);
  });
});

describeDb('two test members on the started server (QOR-4590)', () => {
  const t = useTestPeople(PEOPLE);
  const call = (method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, payload?: object) =>
    t.app.inject({ method, url, headers: bearer(token), ...(payload && { payload }) });
  const SECRET_BODY = 'leaky brief body for alice only';

  /** Alice's live session, and the message a hand-off to it queued: their ids. */
  async function alicesMessage(): Promise<{ session: string; message: string }> {
    await call('GET', '/me', CAROL); // the owner's first sign-in onboards the install (D149)
    const session = `sess-alice-${randomUUID()}`;
    expect((await call('PUT', `/sessions/${session}`, ALICE, { client: client(), instance_id: 'i-1' })).statusCode).toBe(200);
    expect((await call('POST', '/handoffs', ALICE, brief(session, { body: SECRET_BODY }))).statusCode).toBe(202);
    const listed = (await call('GET', `/me/inbox?scope=session&client_session=${session}`, ALICE)).json();
    return { session, message: listed.messages[0].id };
  }

  it("keeps D148 between them: bob gets 404 for alice's message and 403 handing off to alice's session", async () => {
    const { session, message } = await alicesMessage();
    expect((await call('GET', `/me/inbox/${message}`, ALICE)).json().body).toBe(SECRET_BODY);
    expect((await call('GET', `/me/inbox/${message}`, BOB)).statusCode).toBe(404);
    expect((await call('PATCH', `/me/inbox/${message}`, BOB)).statusCode).toBe(404);
    expect((await call('GET', '/me/inbox', BOB)).json().messages).toEqual([]);
    expect((await call('POST', '/handoffs', BOB, brief(session))).statusCode).toBe(403);
    expect((await call('GET', `/me/inbox/${message}`, ALICE)).json().read_at).toBeNull();
  });

  it('keeps the stored role when it differs from the entry: a test may change it through the API', async () => {
    await call('GET', '/me', CAROL);
    const erin = (await call('GET', '/me', ERIN)).json();
    expect(erin.role).toBe('member');
    expect((await call('PATCH', `/members/${erin.id}`, CAROL, { role: 'admin' })).statusCode).toBe(200);
    expect((await call('GET', '/me', ERIN)).json()).toEqual({ ...erin, role: 'admin' });
  });

  it('creates one member when the first uses of one entry race', async () => {
    const [a, b] = await race(t.db, [() => call('GET', '/me', DAVE), () => call('GET', '/me', DAVE)]);
    expect([a!.statusCode, b!.statusCode]).toEqual([200, 200]);
    expect(a!.json().id).toBe(b!.json().id);
    const pool = createPool(t.db.url('runtime'));
    try {
      const { rows } = await pool.query(`SELECT action FROM audit WHERE target_id = $1`, [a!.json().id]);
      expect(rows).toEqual([{ action: 'member.test_member_created' }]);
    } finally {
      await pool.end();
    }
  });

  it('logs no token, no test email and no brief', async () => {
    await alicesMessage();
    const log = t.lines.join('');
    expect(log).toContain('"event":"auth.test_people_on"');
    for (const secret of [ALICE, BOB, CAROL, DAVE, ERIN, 'alice-token', 'Bearer', 'test.bwat.invalid', SECRET_BODY]) {
      expect(log, secret).not.toContain(secret);
    }
  });
});

describeDb('test people are checked before Google (QOR-4590)', () => {
  const db = useTestDb();
  const key = newSigningKey('kid-1');

  it('decides a token both would take as the test person, without asking Google', async () => {
    const pool = createPool(db.url('runtime'));
    const served = jwksFetch(() => [key], 3600);
    // A valid Google ID token for ada, also listed as alice's test token: only precedence tells them apart.
    const both = idToken(key, { email: 'ada@example.com' });
    const config = { googleClientIds: [CLIENT_ID], allowedDomains: ['example.com'] };
    const auth = peopleAuth(pool, { ...config, testPeople: [{ name: 'alice', role: 'member', token: both }] }, { keys: jwksKeys({ fetch: served.fetch }) });
    const req = (authorization: string) =>
      ({ headers: { authorization }, log: { info() {}, warn() {} }, server: { signInFailures: { check() {}, count() {} } } }) as never;
    try {
      expect(await auth(req(`Bearer ${both}`))).toMatchObject({ member: { email: 'alice@test.bwat.invalid' } });
      expect(served.calls).toEqual([]);
      // Without the entry the same token is ada's Google sign-in.
      const google = peopleAuth(pool, config, { keys: jwksKeys({ fetch: served.fetch }) });
      expect(await google(req(`Bearer ${both}`))).toMatchObject({ member: { email: 'ada@example.com' } });
    } finally {
      await pool.end();
    }
  });
});
