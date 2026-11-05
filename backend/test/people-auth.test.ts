import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '../src/db/pool.ts';
import { jwksKeys } from '../src/jwks.ts';
import { DEV_MEMBER_EMAIL, hasOwner, inviteMember, MEMBERS_LOCK_KEY, removeMember } from '../src/members.ts';
import { peopleAuth, peopleAuthConfig, type AuthenticatePerson } from '../src/people-auth.ts';
import { buildServer, start } from '../src/server.ts';
import { apiBase, race } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { CLIENT_ID, PLUGIN_CLIENT_ID, idToken, jwksFetch, newSigningKey } from './google-fixture.ts';

const TOKEN = 'a'.repeat(40);
const SIGN_IN = { BWAT_ALLOWED_DOMAINS: 'example.com', BWAT_GOOGLE_CLIENT_IDS: 'web.example' };
/** A request carrying `authorization`; the event codes it logs go to `events`. */
const req = (authorization?: string, events: unknown[] = []) =>
  ({
    headers: authorization ? { authorization } : {},
    log: { info: (fields: { event?: string }) => void events.push(fields.event), warn() {} },
    // The sign-in bucket (QOR-4625) never spent: test/rate-limits.test.ts covers it.
    server: { signInFailures: { check() {}, count() {} } },
  }) as never;

describe('peopleAuthConfig (QOR-4575)', () => {
  it('refuses the local token on a production build: dev endpoints are public until the VPN link exists', () => {
    // The image sets NODE_ENV=production; only the local compose stack overrides it.
    expect(() => peopleAuthConfig({ NODE_ENV: 'production', BWAT_DEV_PERSON_TOKEN: 'x'.repeat(40) })).toThrow(
      /BWAT_DEV_PERSON_TOKEN is refused unless NODE_ENV is development or test/,
    );
    expect(() => peopleAuthConfig({ NODE_ENV: 'production', ...SIGN_IN })).not.toThrow();
  });

  it('refuses to start a production build without BWAT_ALLOWED_DOMAINS or BWAT_GOOGLE_CLIENT_IDS (D146): Google is its only sign-in', async () => {
    for (const unset of ['BWAT_ALLOWED_DOMAINS', 'BWAT_GOOGLE_CLIENT_IDS'] as const) {
      for (const value of [undefined, '', ' , ']) {
        const env = { NODE_ENV: 'production', ...SIGN_IN, [unset]: value };
        expect(() => peopleAuthConfig(env), `${unset}=${value}`).toThrow(`${unset} is required when NODE_ENV=production`);
        await expect(start({ ...env, BWAT_DB_URL: 'postgres://unused@127.0.0.1:1/x', PORT: '0' })).rejects.toThrow(
          `${unset} is required when NODE_ENV=production`,
        );
      }
    }
    // Off production (a local stack, the tests) either may be unset: sign-in is refused and startup logs it.
    expect(() => peopleAuthConfig({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('refuses a local token shorter than 32 characters', () => {
    expect(() => peopleAuthConfig({ NODE_ENV: 'development', BWAT_DEV_PERSON_TOKEN: 'short' })).toThrow(
      'BWAT_DEV_PERSON_TOKEN must be at least 32 characters',
    );
  });

  it('reads BWAT_GOOGLE_CLIENT_IDS as a comma-separated list, and neither set as nobody signed in', () => {
    expect(peopleAuthConfig({ BWAT_GOOGLE_CLIENT_IDS: ' a.example ,b.example,, ' })).toEqual({
      devToken: undefined,
      testPeople: [],
      googleClientIds: ['a.example', 'b.example'],
      allowedDomains: [],
    });
    expect(peopleAuthConfig({ BWAT_DEV_PERSON_TOKEN: '' })).toEqual({
      devToken: undefined,
      testPeople: [],
      googleClientIds: [],
      allowedDomains: [],
    });
  });

  it('reads BWAT_ALLOWED_DOMAINS as a lower-cased comma-separated list (D146), empty when unset', () => {
    expect(peopleAuthConfig({ BWAT_ALLOWED_DOMAINS: ' Example.com ,example.ORG,, ' }).allowedDomains).toEqual([
      'example.com',
      'example.org',
    ]);
    expect(peopleAuthConfig({}).allowedDomains).toEqual([]);
  });

  it('reads both the web and the plugin client ids from BWAT_GOOGLE_CLIENT_IDS', () => {
    expect(peopleAuthConfig({ BWAT_GOOGLE_CLIENT_IDS: `${CLIENT_ID},${PLUGIN_CLIENT_ID}` }).googleClientIds).toEqual([
      CLIENT_ID,
      PLUGIN_CLIENT_ID,
    ]);
  });

  it('reads BWAT_FIRST_OWNER_EMAIL trimmed and lower-cased (QOR-4749), unset when empty', () => {
    expect(peopleAuthConfig({ ...SIGN_IN, BWAT_FIRST_OWNER_EMAIL: ' Ada@Example.COM ' }).firstOwnerEmail).toBe('ada@example.com');
    expect(peopleAuthConfig({ ...SIGN_IN }).firstOwnerEmail).toBeUndefined();
    expect(peopleAuthConfig({ ...SIGN_IN, BWAT_FIRST_OWNER_EMAIL: ' ' }).firstOwnerEmail).toBeUndefined();
  });

  it('refuses to start with a BWAT_FIRST_OWNER_EMAIL that is not one address in an allowed domain, never echoing it', async () => {
    for (const value of ['ada', 'ada@', '@example.com', 'a da@example.com', 'ada@example.com,bob@example.com', 'ada@@example.com']) {
      expect(() => peopleAuthConfig({ ...SIGN_IN, BWAT_FIRST_OWNER_EMAIL: value }), value).toThrow(
        /^BWAT_FIRST_OWNER_EMAIL must be one email address$/,
      );
    }
    // Nobody outside BWAT_ALLOWED_DOMAINS ever signs in, so that owner could never claim.
    expect(() => peopleAuthConfig({ ...SIGN_IN, BWAT_FIRST_OWNER_EMAIL: 'ada@other.example' })).toThrow(
      /^BWAT_FIRST_OWNER_EMAIL must be in one of BWAT_ALLOWED_DOMAINS$/,
    );
    const env = { NODE_ENV: 'production', ...SIGN_IN, BWAT_FIRST_OWNER_EMAIL: 'ada@other.example' };
    await expect(start({ ...env, BWAT_DB_URL: 'postgres://unused@127.0.0.1:1/x', PORT: '0' })).rejects.toThrow(
      'BWAT_FIRST_OWNER_EMAIL must be in one of BWAT_ALLOWED_DOMAINS',
    );
  });

  it('starts a production build without BWAT_FIRST_OWNER_EMAIL: the self-host installer never sets it', () => {
    expect(peopleAuthConfig({ NODE_ENV: 'production', ...SIGN_IN }).firstOwnerEmail).toBeUndefined();
  });

  it('has no bootstrap owner email: BWAT_BOOTSTRAP_OWNER_EMAIL is retired (D149)', () => {
    expect(peopleAuthConfig({ BWAT_BOOTSTRAP_OWNER_EMAIL: 'ada@example.com' })).toEqual({
      devToken: undefined,
      testPeople: [],
      googleClientIds: [],
      allowedDomains: [],
    });
  });
});

describeDb('people auth against members (QOR-4575)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  const key = newSigningKey('kid-1');
  const keys = jwksKeys({ fetch: jwksFetch(() => [key], 3600).fetch });
  let auth: AuthenticatePerson;
  /** A Google sign-in; each address is its own Google account (sub) unless `claims` say otherwise. */
  const google = (email: string, claims: Record<string, unknown> = {}, events: unknown[] = []) =>
    auth(req(`Bearer ${idToken(key, { email, sub: `sub-${email.toLowerCase()}`, ...claims })}`, events));
  /** Each member's Google account, and whether it has signed in (activated). */
  const bindings = async () =>
    (
      await pool.query<{ email: string; google_sub: string | null; activated: boolean }>(
        `SELECT email, google_sub, activated_at IS NOT NULL AS activated FROM members ORDER BY email`,
      )
    ).rows;
  const members = async () =>
    (await pool.query<{ id: string; email: string; role: string }>(`SELECT id, email, role FROM members ORDER BY email`))
      .rows;

  beforeAll(() => {
    pool = createPool(db.url('runtime'));
    auth = peopleAuth(
      pool,
      {
        devToken: TOKEN,
        googleClientIds: [CLIENT_ID, PLUGIN_CLIENT_ID],
        allowedDomains: ['example.com', 'example.org'],
      },
      { keys },
    );
  });
  afterAll(() => pool?.end());
  beforeEach(() => pool.query('DELETE FROM removed_members; DELETE FROM members'));

  const owners = async () => (await members()).filter((m) => m.role === 'owner');

  it('makes the first verified sign-in from an allowed domain the owner of an install with no owner (D149), and audits it', async () => {
    const person = await google('Ada@Example.com');
    expect(await members()).toEqual([{ id: person!.id, email: 'ada@example.com', role: 'owner' }]);
    const audit = await pool.query(`SELECT actor_id, action, target_id, after FROM audit WHERE target_id = $1`, [
      person!.id,
    ]);
    expect(audit.rows).toEqual([
      { actor_id: null, action: 'member.owner_claimed', target_id: person!.id, after: { role: 'owner' } },
    ]);
    // The same person again is the same member; the next person from an allowed domain joins as a member.
    expect(await google('ada@example.com')).toEqual(person);
    const bob = await google('bob@example.org', { hd: 'example.org' });
    expect(await members()).toEqual([
      { id: person!.id, email: 'ada@example.com', role: 'owner' },
      { id: bob!.id, email: 'bob@example.org', role: 'member' },
    ]);
    const joined = await pool.query(`SELECT actor_id, action, after FROM audit WHERE target_id = $1`, [bob!.id]);
    expect(joined.rows).toEqual([{ actor_id: null, action: 'member.joined', after: { role: 'member' } }]);
    expect(await google('bob@example.org', { hd: 'example.org' })).toEqual(bob);
  });

  it('makes a member the owner when it signs in first on an install whose members have no owner', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO members (email, role) VALUES ('bob@example.com', 'member') RETURNING id`,
    );
    expect((await google('bob@example.com'))?.id).toBe(rows[0]!.id);
    expect(await members()).toEqual([{ id: rows[0]!.id, email: 'bob@example.com', role: 'owner' }]);
    expect((await google('ada@example.com'))?.member?.role).toBe('member');
  });

  it('lets the first sign-in claim the owner while the only owner has never signed in, so it cannot block recovery (D149)', async () => {
    await pool.query(`INSERT INTO members (email, role) VALUES ('gone@example.com', 'owner')`);
    const ada = await google('ada@example.com');
    expect(await owners()).toEqual([
      { id: ada!.id, email: 'ada@example.com', role: 'owner' },
      { id: expect.any(String), email: 'gone@example.com', role: 'owner' },
    ]);
    // Owned now: the next person from an allowed domain joins as a member.
    expect((await google('bob@example.com'))?.member?.role).toBe('member');
  });

  it('makes nobody the owner from a domain that is not allowed, a consumer account, or a bad token', async () => {
    expect(await google('bob@gmail.com', { hd: undefined })).toBeNull();
    expect(await google('eve@other.example', { hd: 'other.example' })).toBeNull();
    expect(await google('ada@example.com', { email_verified: false })).toBeNull();
    expect(await google('ada@example.com', { aud: 'someone-else' })).toBeNull();
    expect(await auth(req('Bearer not-a-token'))).toBeNull();
    expect(await auth(req())).toBeNull();
    expect(await members()).toEqual([]);
  });

  it('makes exactly one owner when eight different people sign in first at once; the rest join as members', async () => {
    // Without the members lock, each racer would see no owner.
    const results = await race(db, Array.from({ length: 8 }, (_, i) => () => google(`racer${i}@example.com`)));
    expect(results.filter(Boolean)).toHaveLength(8);
    expect(await owners()).toHaveLength(1);
    expect(await members()).toHaveLength(8);
  });

  it('re-checks under the lock: an owner added while a first sign-in waited means it joins as a member, not a second owner', async () => {
    const holder = await db.connect('runtime');
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [MEMBERS_LOCK_KEY]);
      const signingIn = google('ada@example.com');
      const waiting = () =>
        holder.query(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
           WHERE l.locktype = 'advisory' AND l.objid = $1 AND NOT l.granted AND d.datname = current_database()`,
          [MEMBERS_LOCK_KEY],
        );
      while ((await waiting()).rows[0].n < 1) await new Promise((r) => setTimeout(r, 10));
      await holder.query(
        `INSERT INTO bwat.members (email, role, activated_at) VALUES ('bob@example.com', 'owner', now())`,
      );
      await holder.query('COMMIT');
      expect((await signingIn)?.member?.role).toBe('member');
      expect((await owners()).map((m) => m.email)).toEqual(['bob@example.com']);
    } finally {
      await holder.end();
    }
  });

  it('signs in a member by the verified email, whatever its case', async () => {
    await google('ada@example.com');
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO members (email) VALUES ('bob@example.com') RETURNING id`,
    );
    expect((await google('BOB@example.com'))?.id).toBe(rows[0]!.id);
    expect((await owners()).map((m) => m.email)).toEqual(['ada@example.com']);
  });

  it('refuses a removed member who signs in again, by email or by Google account, until an admin invites them again', async () => {
    const ada = await google('ada@example.com');
    const bob = await google('bob@example.com');
    expect(await removeMember(pool, ada!.id, bob!.id)).toEqual({ ok: { id: bob!.id } });
    const events: unknown[] = [];
    expect(await google('bob@example.com', {}, events)).toBeNull();
    expect(events).toEqual(['auth.removed']);
    // The same Google account under a new address is refused too.
    expect(await google('robert@example.com', { sub: 'sub-bob@example.com' })).toBeNull();
    expect((await members()).map((m) => m.email)).toEqual(['ada@example.com']);
    // Invited again, the next sign-in binds the invite.
    const invited = await inviteMember(pool, ada!.id, { email: 'bob@example.com', role: 'member' }, ['example.com']);
    const back = await google('bob@example.com', {}, events);
    expect(back?.id).toBe('ok' in invited ? invited.ok.id : undefined);
    expect(events).toEqual(['auth.removed', 'member.activated']);
  });

  it('signs in a member who already joined without waiting on the members lock', async () => {
    await google('ada@example.com');
    const bob = await google('bob@example.com');
    const holder = await db.connect('runtime');
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [MEMBERS_LOCK_KEY]);
      const within = <T>(p: Promise<T>) =>
        Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('waited on the members lock')), 1_000))]);
      expect(await within(google('bob@example.com'))).toEqual(bob);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  it('binds the first owner to its Google account (sub) and activates it (D149)', async () => {
    await google('ada@example.com');
    expect(await bindings()).toEqual([{ email: 'ada@example.com', google_sub: 'sub-ada@example.com', activated: true }]);
  });

  it('binds an invited member to the Google account it first signs in with, audited by id only', async () => {
    await google('ada@example.com');
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO members (email, role) VALUES ('bob@example.com', 'admin') RETURNING id`,
    );
    const bob = rows[0]!.id;
    const events: unknown[] = [];
    expect((await google('bob@example.com', { sub: 'sub-A' }, events))?.id).toBe(bob);
    expect(events).toEqual(['member.activated']);
    expect((await bindings())[1]).toEqual({ email: 'bob@example.com', google_sub: 'sub-A', activated: true });
    const audit = await pool.query(`SELECT actor_id, action, target_id, before, after FROM audit WHERE target_id = $1`, [bob]);
    expect(audit.rows).toEqual([{ actor_id: bob, action: 'member.activated', target_id: bob, before: null, after: null }]);
    // Again: already bound, so nothing more is audited.
    expect((await google('bob@example.com', { sub: 'sub-A' }))?.id).toBe(bob);
    expect((await pool.query(`SELECT 1 FROM audit WHERE target_id = $1`, [bob])).rowCount).toBe(1);
  });

  it("names each member from their Google account's name, and never replaces a name an admin set", async () => {
    const names = async () =>
      (await pool.query<{ email: string; display_name: string | null }>(`SELECT email, display_name FROM members ORDER BY email`))
        .rows;
    // The owner's claim and a join.
    await google('ada@example.com', { name: 'Ada Lovelace' });
    await google('bob@example.com', { name: 'Bob Byron' });
    // An invite with no name, and one an admin named.
    await pool.query(
      `INSERT INTO members (email, role) VALUES ('cy@example.com', 'member');
       INSERT INTO members (email, display_name, role) VALUES ('di@example.com', 'Dee', 'member')`,
    );
    await google('cy@example.com', { name: 'Cy Babbage' });
    await google('di@example.com', { name: 'Diana Somerville' });
    // A member who signed in before names were kept is named on their next sign-in.
    await google('ed@example.com');
    expect((await names()).find((m) => m.email === 'ed@example.com')?.display_name).toBeNull();
    await google('ed@example.com', { name: 'Ed Menabrea' });
    // A name is not replaced once set: not by the account's next name either.
    await google('ada@example.com', { name: 'Augusta Ada King' });
    expect(await names()).toEqual([
      { email: 'ada@example.com', display_name: 'Ada Lovelace' },
      { email: 'bob@example.com', display_name: 'Bob Byron' },
      { email: 'cy@example.com', display_name: 'Cy Babbage' },
      { email: 'di@example.com', display_name: 'Dee' },
      { email: 'ed@example.com', display_name: 'Ed Menabrea' },
    ]);
  });

  it('refuses a reassigned address: the same email from another Google account inherits no role, not even owner', async () => {
    await pool.query(`INSERT INTO members (email, role) VALUES ('ada@example.com', 'owner'), ('bob@example.com', 'owner')`);
    expect(await google('ada@example.com', { sub: 'sub-A' })).not.toBeNull();
    expect(await google('bob@example.com', { sub: 'sub-B' })).not.toBeNull();
    // ada@ is given to someone new, who has a new Google account.
    const events: unknown[] = [];
    expect(await google('ada@example.com', { sub: 'sub-C' }, events)).toBeNull();
    expect(events).toEqual(['auth.subject_mismatch']);
    const bound = [
      { email: 'ada@example.com', google_sub: 'sub-A', activated: true },
      { email: 'bob@example.com', google_sub: 'sub-B', activated: true },
    ];
    expect(await bindings()).toEqual(bound);
    // Nor on an install with no activated owner: a bound address is never claimed as the first owner.
    await pool.query(`UPDATE members SET role = 'member'`);
    expect(await google('ada@example.com', { sub: 'sub-C' })).toBeNull();
    expect((await members()).map((m) => m.role)).toEqual(['member', 'member']);
    expect(await bindings()).toEqual(bound);
  });

  it('signs in the same Google account under a changed email as the same member, keeping the stored email', async () => {
    const ada = await google('ada@example.com', { sub: 'sub-A' });
    const renamed = await google('ada.lovelace@example.com', { sub: 'sub-A' });
    expect(renamed?.id).toBe(ada!.id);
    expect(renamed?.member?.email).toBe('ada@example.com');
    expect(await members()).toEqual([{ id: ada!.id, email: 'ada@example.com', role: 'owner' }]);
  });

  it('refuses a token with no sub, and binds nobody', async () => {
    for (const sub of [undefined, '']) expect(await google('ada@example.com', { sub }), String(sub)).toBeNull();
    expect(await members()).toEqual([]);
  });

  it('signs in only from an allowed Google Workspace domain: no hd, a wrong hd or an email outside hd is refused (D146)', async () => {
    await pool.query(
      `INSERT INTO members (email, role) VALUES ('ada@example.com', 'owner'), ('bob@gmail.com', 'member'), ('eve@other.example', 'member')`,
    );
    // A consumer account (gmail) carries no hd at all.
    expect(await google('bob@gmail.com', { hd: undefined })).toBeNull();
    expect(await google('ada@example.com', { hd: undefined })).toBeNull();
    expect(await google('ada@example.com', { hd: 'other.example' })).toBeNull();
    // A member, in a Workspace domain that is not allowed.
    expect(await google('eve@other.example', { hd: 'other.example' })).toBeNull();
    expect(await google('ada@example.com', { hd: 42 })).toBeNull();
    // hd allowed, but the email is not in it.
    expect(await google('ada@example.com', { hd: 'example.org' })).toBeNull();
    // hd compared case-insensitively.
    expect(await google('ada@example.com', { hd: 'EXAMPLE.com' })).not.toBeNull();
    expect(await google('ada@example.com')).not.toBeNull();
  });

  it('refuses every Google sign-in, without calling Google, when BWAT_ALLOWED_DOMAINS is unset or empty (D146)', async () => {
    await pool.query(`INSERT INTO members (email, role) VALUES ('ada@example.com', 'owner')`);
    for (const domains of [undefined, '', ' , ']) {
      const served = jwksFetch(() => [key], 3600);
      const config = peopleAuthConfig({ BWAT_GOOGLE_CLIENT_IDS: CLIENT_ID, BWAT_ALLOWED_DOMAINS: domains });
      const noDomains = peopleAuth(pool, config, { keys: jwksKeys({ fetch: served.fetch }) });
      expect(await noDomains(req(`Bearer ${idToken(key)}`)), String(domains)).toBeNull();
      expect(served.calls).toEqual([]);
    }
  });

  it('reads the allowed domains at each sign-in, so a list an admin saves applies without a restart (QOR-5070)', async () => {
    await pool.query(`INSERT INTO members (email, role) VALUES ('ada@example.com', 'owner'), ('eve@newco.example', 'member')`);
    let saved: string[] = ['example.com'];
    const live = peopleAuth(pool, { googleClientIds: [CLIENT_ID], allowedDomains: ['example.com'] }, { keys, domains: async () => saved });
    const eve = () => live(req(`Bearer ${idToken(key, { email: 'eve@newco.example', sub: 'sub-eve', hd: 'newco.example' })}`));
    expect(await eve()).toBeNull();
    saved = ['newco.example'];
    expect(await eve()).not.toBeNull();
    // The env's list no longer applies once another is saved.
    expect(await live(req(`Bearer ${idToken(key, { sub: 'sub-ada' })}`))).toBeNull();
  });

  it('reads hd and email_verified only from the signed token: a payload edited after signing is refused', async () => {
    // Signed as a Gmail account (no hd, unverified), then the payload swapped for one that
    // is valid in every other way and claims an allowed domain and a verified email.
    const [header, , signature] = idToken(key, { email: 'eve@gmail.com', hd: undefined, email_verified: false }).split('.');
    const [, claimed] = idToken(key, { email: 'eve@example.com', hd: 'example.com', email_verified: true }).split('.');
    expect(await auth(req(`Bearer ${header}.${claimed}.${signature}`))).toBeNull();
    expect(await members()).toEqual([]);
  });

  it('accepts a token for the web client or the plugin Desktop client, and no other audience', async () => {
    await pool.query(`INSERT INTO members (email, role) VALUES ('ada@example.com', 'owner')`);
    expect(await google('ada@example.com', { aud: CLIENT_ID })).not.toBeNull();
    expect(await google('ada@example.com', { aud: PLUGIN_CLIENT_ID })).not.toBeNull();
    for (const aud of ['someone-else.apps.googleusercontent.com', `${CLIENT_ID},${PLUGIN_CLIENT_ID}`, '', [CLIENT_ID]]) {
      expect(await google('ada@example.com', { aud }), JSON.stringify(aud)).toBeNull();
    }
  });

  it('maps BWAT_DEV_PERSON_TOKEN to one dev member, the owner of a local stack', async () => {
    const first = await auth(req(`Bearer ${TOKEN}`));
    expect(await auth(req(`Bearer ${TOKEN}`))).toEqual(first);
    expect(await members()).toEqual([{ id: first!.id, email: DEV_MEMBER_EMAIL, role: 'owner' }]);
    const audit = await pool.query(`SELECT action FROM audit WHERE target_id = $1`, [first!.id]);
    expect(audit.rows).toEqual([{ action: 'member.dev_member_created' }]);
    // Activated, so it keeps a local stack owned; never bound to a Google account.
    expect(await bindings()).toEqual([{ email: DEV_MEMBER_EMAIL, google_sub: null, activated: true }]);
    for (const wrong of [TOKEN, `Bearer ${TOKEN}b`, `Bearer ${TOKEN.slice(1)}`, 'Bearer ']) {
      expect(await auth(req(wrong)), wrong).toBeNull();
    }
  });

  it('makes the dev member a plain member, not a second owner, on a stack a Google sign-in already owns (D149)', async () => {
    const owner = await google('ada@example.com');
    const dev = await auth(req(`Bearer ${TOKEN}`));
    expect(await members()).toEqual([
      { id: owner!.id, email: 'ada@example.com', role: 'owner' },
      { id: dev!.id, email: DEV_MEMBER_EMAIL, role: 'member' },
    ]);
    const audit = await pool.query(`SELECT action, after FROM audit WHERE target_id = $1`, [dev!.id]);
    expect(audit.rows).toEqual([{ action: 'member.dev_member_created', after: { role: 'member' } }]);
  });

  it('signs in nobody, and never calls Google, when neither sign-in is configured', async () => {
    const served = jwksFetch(() => [key], 3600);
    const none = peopleAuth(pool, { googleClientIds: [], allowedDomains: ['example.com'] }, { keys: jwksKeys({ fetch: served.fetch }) });
    expect(await none(req(`Bearer ${TOKEN}`))).toBeNull();
    expect(await none(req(`Bearer ${idToken(key)}`))).toBeNull();
    expect(await members()).toEqual([]);
    expect(served.calls).toEqual([]);
  });

  it("throws, rather than signing out, when Google's keys cannot be fetched", async () => {
    const down = jwksKeys({ fetch: async () => new Response('', { status: 503 }) });
    const offline = peopleAuth(pool, { googleClientIds: [CLIENT_ID], allowedDomains: ['example.com'] }, { keys: down });
    await expect(offline(req(`Bearer ${idToken(key)}`))).rejects.toThrow('jwks_unavailable');
  });
});

describeDb('BWAT_FIRST_OWNER_EMAIL pins who may claim the owner role (QOR-4749)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  const key = newSigningKey('kid-1');
  const keys = jwksKeys({ fetch: jwksFetch(() => [key], 3600).fetch });
  let auth: AuthenticatePerson;
  const google = (email: string, events: unknown[] = []) =>
    auth(req(`Bearer ${idToken(key, { email, sub: `sub-${email.toLowerCase()}` })}`, events));
  const members = async () =>
    (await pool.query<{ email: string; role: string }>(`SELECT email, role FROM members ORDER BY email`)).rows;
  const auditOf = async (id: string) =>
    (await pool.query(`SELECT actor_id, action, after FROM audit WHERE target_id = $1 ORDER BY at`, [id])).rows;

  beforeAll(() => {
    pool = createPool(db.url('runtime'));
    // Read as the server reads it, so its case and spaces are the config's to settle.
    const config = peopleAuthConfig({
      BWAT_GOOGLE_CLIENT_IDS: CLIENT_ID,
      BWAT_ALLOWED_DOMAINS: 'example.com',
      BWAT_FIRST_OWNER_EMAIL: ' Ada@Example.com ',
    });
    auth = peopleAuth(pool, config, { keys });
  });
  afterAll(() => pool?.end());
  beforeEach(() => pool.query('DELETE FROM removed_members; DELETE FROM members'));

  it('makes anyone else who signs in first a plain member, so the panel stays closed, until the named person claims the owner', async () => {
    const events: unknown[] = [];
    const bob = await google('bob@example.com', events);
    expect(bob?.member?.role).toBe('member');
    expect(events).toEqual(['member.joined']);
    expect(await auditOf(bob!.id)).toEqual([{ actor_id: null, action: 'member.joined', after: { role: 'member' } }]);
    expect(await hasOwner(pool)).toBe(false);
    // Signing in again changes nothing and audits nothing.
    expect(await google('bob@example.com', events)).toEqual(bob);
    expect(events).toEqual(['member.joined']);
    // The named person, in any case, claims it.
    const ada = await google('aDA@example.COM', events);
    expect(ada?.member?.role).toBe('owner');
    expect(events).toEqual(['member.joined', 'member.owner_claimed']);
    expect(await members()).toEqual([
      { email: 'ada@example.com', role: 'owner' },
      { email: 'bob@example.com', role: 'member' },
    ]);
  });

  it('signs in a member who joined before the owner again without waiting on the members lock', async () => {
    const bob = await google('bob@example.com');
    const holder = await db.connect('runtime');
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [MEMBERS_LOCK_KEY]);
      const within = <T>(p: Promise<T>) =>
        Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('waited on the members lock')), 1_000))]);
      expect(await within(google('bob@example.com'))).toEqual(bob);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  it('activates an invited member who signs in first as what they were invited as, never the owner', async () => {
    await pool.query(`INSERT INTO members (email, role) VALUES ('bob@example.com', 'member')`);
    const events: unknown[] = [];
    expect((await google('bob@example.com', events))?.member?.role).toBe('member');
    expect(events).toEqual(['member.activated']);
    expect(await hasOwner(pool)).toBe(false);
  });

  it('has no effect once an activated owner exists: the named person joins as a member', async () => {
    await pool.query(`INSERT INTO members (email, role, activated_at) VALUES ('bob@example.com', 'owner', now())`);
    expect((await google('ada@example.com'))?.member?.role).toBe('member');
    expect((await members()).filter((m) => m.role === 'owner')).toEqual([{ email: 'bob@example.com', role: 'owner' }]);
  });

  it('makes the named person the one owner when eight people sign in first at once', async () => {
    const emails = ['ada@example.com', ...Array.from({ length: 7 }, (_, i) => `racer${i}@example.com`)];
    const results = await race(db, emails.map((email) => () => google(email)));
    expect(results.filter(Boolean)).toHaveLength(8);
    expect((await members()).filter((m) => m.role === 'owner')).toEqual([{ email: 'ada@example.com', role: 'owner' }]);
  });
});

describeDb('people routes read the signed-in member once (QOR-4575)', () => {
  const db = useTestDb();
  const key = newSigningKey('kid-1');

  it('answers GET /me with one read of members, for a Google member and for the dev member', async () => {
    const pool = createPool(db.url('runtime'));
    const keys = jwksKeys({ fetch: jwksFetch(() => [key], 3600).fetch });
    const app = apiBase(
      buildServer({
        pool,
        authenticatePerson: peopleAuth(pool, { devToken: TOKEN, googleClientIds: [CLIENT_ID], allowedDomains: ['example.com'] }, { keys }),
      }),
    );
    try {
      await pool.query(`INSERT INTO members (email) VALUES ('ada@example.com')`);
      await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${TOKEN}` } }); // creates the dev member
      const queries = vi.spyOn(pool, 'query');
      for (const authorization of [`Bearer ${idToken(key)}`, `Bearer ${TOKEN}`]) {
        queries.mockClear();
        const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization } });
        expect(me.statusCode).toBe(200);
        expect(queries).toHaveBeenCalledTimes(1);
      }
    } finally {
      await app.close();
      await pool.end();
    }
  });
});

describeDb('people routes on the started server (QOR-4571)', () => {
  const db = useTestDb();

  async function post(app: FastifyInstance, authorization?: string) {
    const { port } = app.server.address() as { port: number };
    return fetch(`http://127.0.0.1:${port}/v1/allocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ zoom_url: 'https://zoom.us/j/123456789' }),
    });
  }

  it('refuses everyone by default: no sign-in is configured', async () => {
    const app = await start({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test' });
    try {
      expect((await post(app)).status).toBe(401);
      expect((await post(app, `Bearer ${TOKEN}`)).status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('says at startup, by event code, that every Google sign-in is refused while BWAT_ALLOWED_DOMAINS is unset (D146)', async () => {
    const env = { BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', BWAT_GOOGLE_CLIENT_IDS: CLIENT_ID };
    for (const [domains, logged] of [[undefined, true], ['example.com', false]] as const) {
      const lines: string[] = [];
      const logger = { level: 'info', stream: { write: (line: string) => void lines.push(line) } };
      const app = await start({ ...env, BWAT_ALLOWED_DOMAINS: domains }, { logger });
      try {
        expect(lines.join('').includes('"event":"auth.allowed_domains_unset"'), String(domains)).toBe(logged);
      } finally {
        await app.close();
      }
    }
  });

  it('invites only from BWAT_ALLOWED_DOMAINS on the started server (D146)', async () => {
    const env = { BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', BWAT_DEV_PERSON_TOKEN: TOKEN, BWAT_ALLOWED_DOMAINS: 'example.com' };
    const app = apiBase(await start(env));
    try {
      const invite = (email: string) =>
        app.inject({ method: 'POST', url: '/members', headers: { authorization: `Bearer ${TOKEN}` }, payload: { email } });
      expect((await invite('in@example.com')).statusCode).toBe(201);
      expect((await invite('out@gmail.com')).json()).toEqual({ error: 'domain_not_allowed' });
    } finally {
      await app.close();
    }
  });

  it('lets in the holder of BWAT_DEV_PERSON_TOKEN when it is set', async () => {
    const env = { BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', BWAT_DEV_PERSON_TOKEN: TOKEN };
    const app = await start(env);
    try {
      expect((await post(app, `Bearer ${TOKEN}`)).status).toBe(202);
      expect((await post(app, 'Bearer nope')).status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
