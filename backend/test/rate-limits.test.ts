import type { FastifyInstance, FastifyServerOptions, InjectOptions } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rateLimits } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import type { SigningKeys } from '../src/google-id-token.ts';
import { jwksKeys } from '../src/jwks.ts';
import { peopleAuth } from '../src/people-auth.ts';
import { perMinute } from '../src/rate-limit.ts';
import { buildServer, type ServerOptions } from '../src/server.ts';
import { registerBot } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { CLIENT_ID, idToken, jwksFetch, newSigningKey } from './google-fixture.ts';
import { ZOOM_SECRET, zoomSecret } from './zoom.ts';
import { zoomSignature } from '../src/zoom-signature.ts';

const DEV_TOKEN = 'd'.repeat(40);
const A = '203.0.113.1';
const B = '203.0.113.2';
const ZOOM_URL = '/v1/callbacks/zoom/events';
const BAD = 'Bearer not.a.token';

describe('rate-limit settings (QOR-4625)', () => {
  it('defaults to 30 failed sign-ins and 600 Zoom deliveries a minute', () => {
    expect(rateLimits({})).toEqual({ signInFailuresPerMin: 30, zoomPerMin: 600 });
    expect(rateLimits({ BWAT_RATE_LIMIT_SIGNIN_FAILURES_PER_MIN: '', BWAT_RATE_LIMIT_ZOOM_PER_MIN: '' })).toEqual({
      signInFailuresPerMin: 30,
      zoomPerMin: 600,
    });
    expect(rateLimits({ BWAT_RATE_LIMIT_SIGNIN_FAILURES_PER_MIN: '5', BWAT_RATE_LIMIT_ZOOM_PER_MIN: '1' })).toEqual({
      signInFailuresPerMin: 5,
      zoomPerMin: 1,
    });
  });

  it('refuses anything but a whole number of at least 1, naming the variable', () => {
    for (const name of ['BWAT_RATE_LIMIT_SIGNIN_FAILURES_PER_MIN', 'BWAT_RATE_LIMIT_ZOOM_PER_MIN']) {
      for (const value of ['0', '-1', '1.5', 'ten', ' 7', '1e3', '07']) {
        expect(() => rateLimits({ [name]: value }), `${name}=${value}`).toThrow(`${name} must be a whole number per minute, at least 1`);
      }
    }
  });
});

describe('perMinute (QOR-4625)', () => {
  const ip = (address: string) => ({ ip: address }) as never;

  it('keeps at most maxIps addresses, forgetting the oldest first', () => {
    const bucket = perMinute('signin', 1, { maxIps: 3 });
    for (const address of ['1', '2', '3']) bucket.count(ip(address));
    for (const address of ['1', '2', '3']) expect(() => bucket.check(ip(address))).toThrow('rate_limited');
    bucket.count(ip('4'));
    expect(() => bucket.check(ip('1'))).not.toThrow();
    for (const address of ['2', '3', '4']) expect(() => bucket.check(ip(address))).toThrow('rate_limited');
  });

  it('checks without counting', () => {
    const bucket = perMinute('signin', 1);
    for (let i = 0; i < 5; i++) bucket.check(ip('1'));
    bucket.count(ip('1'));
    expect(() => bucket.check(ip('1'))).toThrow('rate_limited');
  });
});

/**
 * The public edge's rate limits (QOR-4625), per client IP: failed Google sign-ins (checked
 * before a bearer is verified, counted only when it fails), and Zoom webhook deliveries
 * (every one, checked before the signature). A successful sign-in, the bot routes and the
 * local stand-in tokens are never counted.
 */
describeDb('rate limits on the public edge (QOR-4625)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  const key = newSigningKey('kid-1');
  const jwks = jwksKeys({ fetch: jwksFetch(() => [key], 3600).fetch });
  /** Google's keys, counting each verification that reaches them. */
  let verifications = 0;
  const keys: SigningKeys = { get: (kid) => (verifications++, jwks.get(kid)) };
  const apps: FastifyInstance[] = [];

  const app = (options: Partial<ServerOptions> & { trustProxy?: FastifyServerOptions['trustProxy'] } = {}, lines: string[] = []) => {
    const built = buildServer({
      pool,
      authenticatePerson: peopleAuth(pool, { devToken: DEV_TOKEN, googleClientIds: [CLIENT_ID], allowedDomains: ['example.com'] }, { keys }),
      getSecret: zoomSecret,
      logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
      ...options,
    });
    apps.push(built);
    return built;
  };
  const limits = (signInFailuresPerMin: number, zoomPerMin = 600) => ({ rateLimits: { signInFailuresPerMin, zoomPerMin } });
  const google = idToken(key, { email: 'ada@example.com', sub: 'sub-ada' });
  const me = (a: FastifyInstance, remoteAddress: string, authorization = `Bearer ${google}`, extra: Partial<InjectOptions> = {}) =>
    a.inject({ method: 'GET', url: '/v1/me', headers: { authorization, ...extra.headers }, remoteAddress });
  const unsigned = (a: FastifyInstance, remoteAddress: string) =>
    a.inject({ method: 'POST', url: ZOOM_URL, headers: { 'content-type': 'application/json' }, payload: '{}', remoteAddress });

  beforeAll(async () => {
    pool = createPool(db.url('runtime'));
    await pool.query(`INSERT INTO members (email, role, activated_at) VALUES ('ada@example.com', 'owner', now())`);
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    await pool?.end();
  });

  it('never limits a successful sign-in: 1000 from one IP in a minute, at the default limits', async () => {
    const a = app();
    for (let i = 1; i <= 1000; i++) expect((await me(a, A)).statusCode, `request ${i}`).toBe(200);
  }, 60_000);

  it('answers the request after N failed sign-ins from one IP 429, even with a valid token, without verifying it', async () => {
    const lines: string[] = [];
    const a = app(limits(3), lines);
    for (let i = 0; i < 3; i++) expect((await me(a, A, BAD)).statusCode).toBe(401);
    verifications = 0;
    const limited = await me(a, A);
    expect(limited.statusCode).toBe(429);
    expect(verifications).toBe(0);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60).toBe(true);
    // The error handler's answer, with the security headers every answer carries.
    expect(limited.headers['x-content-type-options']).toBe('nosniff');
    expect(limited.headers['content-security-policy']).toContain('frame-ancestors');
    // Another IP is its own.
    expect((await me(a, B)).statusCode).toBe(200);

    // Logged as its event and group only: never the IP or the token.
    const logged = lines.join('');
    expect(logged).toContain('"event":"rate_limited"');
    expect(logged).toContain('"group":"signin"');
    expect(logged).not.toContain(A);
    expect(logged).not.toContain(google);
  });

  it('counts each way a Google bearer fails: unverified, a refused domain, another subject', async () => {
    const a = app(limits(3));
    // Ada signs in first, binding her sub; a success is not counted.
    expect((await me(a, A)).statusCode).toBe(200);
    expect((await me(a, A, BAD)).statusCode).toBe(401);
    expect((await me(a, A, `Bearer ${idToken(key, { email: 'eve@other.test', hd: 'other.test', sub: 'sub-eve' })}`)).statusCode).toBe(401);
    expect((await me(a, A, `Bearer ${idToken(key, { email: 'ada@example.com', sub: 'sub-not-ada' })}`)).statusCode).toBe(401);
    expect((await me(a, A)).statusCode).toBe(429);
  });

  it('never counts a request with no bearer, nor the dev token, which still signs in over the limit', async () => {
    const a = app(limits(1));
    for (let i = 0; i < 5; i++) {
      expect((await a.inject({ method: 'GET', url: '/v1/me', remoteAddress: A })).statusCode).toBe(401);
      expect((await me(a, A, `Bearer ${DEV_TOKEN}`)).statusCode).toBe(200);
    }
    expect((await me(a, A)).statusCode).toBe(200);
    expect((await me(a, A, BAD)).statusCode).toBe(401);
    expect((await me(a, A)).statusCode).toBe(429);
    expect((await me(a, A, `Bearer ${DEV_TOKEN}`)).statusCode).toBe(200);
  });

  it('opens the bucket again once the minute is over', async () => {
    let now = Date.now();
    const a = app({ ...limits(1), clock: () => now });
    expect((await me(a, A, BAD)).statusCode).toBe(401);
    const limited = await me(a, A);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    now += 59_000;
    expect((await me(a, A)).statusCode).toBe(429);
    now += 1_000;
    expect((await me(a, A)).statusCode).toBe(200);
  });

  it('keys on the socket address, ignoring X-Forwarded-For, unless BWAT_TRUST_PROXY is set', async () => {
    const forwarded = (address: string) => ({ headers: { 'x-forwarded-for': address } });
    const off = app(limits(1));
    expect((await me(off, A, BAD, forwarded('198.51.100.1'))).statusCode).toBe(401);
    expect((await me(off, A, undefined, forwarded('198.51.100.2'))).statusCode).toBe(429);

    const on = app({ ...limits(1), trustProxy: true });
    expect((await me(on, A, BAD, forwarded('198.51.100.1'))).statusCode).toBe(401);
    expect((await me(on, A, undefined, forwarded('198.51.100.2'))).statusCode).toBe(200);
    expect((await me(on, A, undefined, forwarded('198.51.100.1'))).statusCode).toBe(429);
  });

  it('gives the Zoom webhook its own bucket, every delivery counted, checked before the signature', async () => {
    const lines: string[] = [];
    let secretReads = 0;
    const a = app({ ...limits(1, 3), getSecret: async (name) => (secretReads++, zoomSecret(name)) }, lines);
    // The sign-in bucket spent: the webhook is unaffected.
    expect((await me(a, A, BAD)).statusCode).toBe(401);
    expect((await me(a, A)).statusCode).toBe(429);
    for (let i = 0; i < 3; i++) expect((await unsigned(a, A)).statusCode).toBe(401);

    // The fourth delivery from A is refused before anything reads it, even a signed one.
    const raw = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'abc' } });
    const at = String(Math.floor(Date.now() / 1000));
    const signed = await a.inject({
      method: 'POST',
      url: ZOOM_URL,
      headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': at, 'x-zm-signature': zoomSignature(ZOOM_SECRET, at, Buffer.from(raw)) },
      payload: raw,
      remoteAddress: A,
    });
    expect(signed.statusCode).toBe(429);
    expect(signed.json()).toEqual({ error: 'rate_limited' });
    expect(Number(signed.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(secretReads).toBe(0);
    expect(lines.join('')).toContain('"group":"zoom"');

    // Another IP's deliveries, and A's sign-in bucket, are their own.
    expect((await unsigned(a, B)).statusCode).toBe(401);
    expect((await me(a, B)).statusCode).toBe(200);
  });

  it('never limits the bot routes', async () => {
    const a = app(limits(1, 1));
    const bot = await registerBot({ app: apiPrefixed(a), pool } as never);
    for (let i = 0; i < 70; i++) {
      const res = await a.inject({ method: 'GET', url: '/v1/bot/settings', headers: { authorization: `Bearer ${bot.bot_token}` }, remoteAddress: A });
      expect(res.statusCode, `request ${i + 1}`).toBe(200);
    }
    expect((await a.inject({ method: 'GET', url: '/health', remoteAddress: A })).statusCode).toBe(200);
  });
});

/** registerBot names routes without /v1, as test/app.ts's apiBase does. */
function apiPrefixed(a: FastifyInstance): FastifyInstance {
  return { inject: (options: InjectOptions) => a.inject({ ...options, url: `/v1${options.url as string}` }) } as never;
}
