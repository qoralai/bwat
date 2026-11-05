import type { FastifyInstance, InjectOptions } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { issueCardsCredential, issueFleetCredential } from '../src/credentials.ts';
import { createPool } from '../src/db/pool.ts';
import type { SigningKeys } from '../src/google-id-token.ts';
import { jwksKeys } from '../src/jwks.ts';
import { peopleAuth } from '../src/people-auth.ts';
import { buildServer, type ServerOptions } from '../src/server.ts';
import { boardSignIn } from '../src/zoom-board-signin.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { CLIENT_ID, idToken, jwksFetch, newSigningKey } from './google-fixture.ts';

// QOR-4749: the card service asks who a board's bearer is with its own credential, naming
// the client address it saw, so its checks are counted per end user and never against the
// card service's own address.

const DEV_TOKEN = 'd'.repeat(40);
const URL = '/v1/card-service/person';
/** The card service's own address, as the backend sees it. */
const CARDS_IP = '198.51.100.7';
const A = '203.0.113.1';
const B = '203.0.113.2';
const BAD = 'not.a.token';

describeDb('POST /card-service/person (QOR-4749)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  let cards: string;
  const key = newSigningKey('kid-1');
  const keys: SigningKeys = jwksKeys({ fetch: jwksFetch(() => [key], 3600).fetch });
  const google = idToken(key, { email: 'ada@example.com', sub: 'sub-ada' });
  const apps: FastifyInstance[] = [];

  const app = (options: Partial<ServerOptions> = {}) => {
    const built = buildServer({
      pool,
      authenticatePerson: peopleAuth(pool, { devToken: DEV_TOKEN, googleClientIds: [CLIENT_ID], allowedDomains: ['example.com'] }, { keys }),
      rateLimits: { signInFailuresPerMin: 3, zoomPerMin: 600 },
      ...options,
    });
    apps.push(built);
    return built;
  };
  const resolve = (a: FastifyInstance, payload: unknown, authorization = `Bearer ${cards}`, extra: Partial<InjectOptions> = {}) =>
    a.inject({ method: 'POST', url: URL, headers: { authorization, ...extra.headers }, payload: payload as object, remoteAddress: CARDS_IP });
  const me = (a: FastifyInstance, remoteAddress: string, token = google) =>
    a.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` }, remoteAddress });

  beforeAll(async () => {
    pool = createPool(db.url('runtime'));
    await pool.query(`INSERT INTO members (email, role, activated_at, zoom_user_id) VALUES ('ada@example.com', 'owner', now(), 'zoom-ada')`);
    cards = await issueCardsCredential(pool);
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    await pool?.end();
  });

  it('answers with exactly what GET /me answers, for a Google token, a board token and the dev token', async () => {
    const a = app();
    const expected = (await me(a, A)).json();
    expect(Object.keys(expected).sort()).toEqual(['display_name', 'email', 'id', 'role']);
    const board = await boardSignIn(pool, 'zoom-ada');
    if (!('token' in board)) throw new Error('want a board token');
    for (const bearer of [google, board.token]) {
      const res = await resolve(a, { bearer, client_ip: A });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ person: expected });
    }
    const dev = await resolve(a, { bearer: DEV_TOKEN, client_ip: A });
    expect(dev.json()).toEqual({ person: (await me(a, A, DEV_TOKEN)).json() });
  });

  it('answers a bearer that signs nobody in with person null, not an error', async () => {
    const a = app();
    for (const bearer of [BAD, `bwz_${'A'.repeat(43)}`]) {
      const res = await resolve(a, { bearer, client_ip: A });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ person: null });
    }
  });

  it('is open before onboarding, as GET /me is', async () => {
    const a = app();
    await pool.query(`UPDATE members SET activated_at = NULL WHERE role = 'owner'`);
    try {
      expect((await resolve(a, { bearer: google, client_ip: A })).statusCode).toBe(200);
    } finally {
      await pool.query(`UPDATE members SET activated_at = now() WHERE role = 'owner'`);
    }
  });

  it('refuses any caller but the card service: nothing, a person, another credential, an unknown bwc_', async () => {
    const a = app();
    const fleet = await issueFleetCredential(pool);
    const body = { bearer: google, client_ip: A };
    expect((await a.inject({ method: 'POST', url: URL, payload: body, remoteAddress: CARDS_IP })).statusCode).toBe(401);
    for (const authorization of [`Bearer ${google}`, `Bearer ${DEV_TOKEN}`, `Bearer ${fleet}`, `Bearer bwc_${'A'.repeat(43)}`]) {
      const res = await resolve(a, body, authorization);
      expect(res.statusCode, authorization.slice(0, 12)).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('refuses a body without a bearer and a client address', async () => {
    const a = app();
    for (const body of [{}, { bearer: google }, { client_ip: A }, { bearer: google, client_ip: 'not-an-ip' }, { bearer: 'two words', client_ip: A },
      { bearer: google, client_ip: A, extra: 1 }]) {
      expect((await resolve(a, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('counts failures against the client address it is given, never the card service own address', async () => {
    const a = app();
    for (let i = 0; i < 3; i++) expect((await resolve(a, { bearer: BAD, client_ip: A })).json()).toEqual({ person: null });
    // A has spent its failures, through the card service or directly.
    const limited = await resolve(a, { bearer: google, client_ip: A });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await me(a, A)).statusCode).toBe(429);
    // Another client, through the same card service, is its own.
    expect((await resolve(a, { bearer: google, client_ip: B })).statusCode).toBe(200);
    // The card service's own address has spent nothing.
    expect((await me(a, CARDS_IP)).statusCode).toBe(200);
    expect((await me(a, CARDS_IP, BAD)).statusCode).toBe(401);
    expect((await me(a, CARDS_IP)).statusCode).toBe(200);
  });

  it('trusts the client address only on this route: a person forwarding one on GET /me is keyed on its socket', async () => {
    const a = app();
    for (let i = 0; i < 3; i++) {
      const res = await a.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${BAD}`, 'x-forwarded-for': `192.0.2.${i}` }, remoteAddress: B });
      expect(res.statusCode).toBe(401);
    }
    expect((await me(a, B)).statusCode).toBe(429);
  });
});
