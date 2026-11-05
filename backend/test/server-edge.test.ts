import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameAncestors, trustProxy } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import { buildServer, start } from '../src/server.ts';
import { PERSON, signedIn } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';

/**
 * The server's edge (QOR-4588): every API route under /v1 with /health at the root, the
 * proxy's forwarded headers trusted only when configured, and the security headers on
 * every answer. Built raw (no test/app.ts prefixing), so the paths here are the real ones.
 */
describeDb('the server edge (QOR-4588)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  const apps: FastifyInstance[] = [];
  const app = (options: { trustProxy?: FastifyServerOptions['trustProxy']; frameAncestors?: string[] } = {}) => {
    const built = buildServer({ pool, authenticatePerson: signedIn, ...options });
    // Test-only routes, at the root: what the request looked like, a failure, a 304.
    built.get('/test/whoami', async (req) => ({ ip: req.ip, protocol: req.protocol }));
    built.get('/test/boom', async () => {
      throw new Error('boom');
    });
    built.get('/test/unchanged', async (_req, reply) => reply.code(304).send());
    apps.push(built);
    return built;
  };

  beforeAll(async () => {
    pool = createPool(db.url('runtime'));
    await pool.query(`INSERT INTO members (email, role, activated_at) VALUES ('owner@test.invalid', 'owner', now())`);
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    await pool?.end();
  });

  describe('the /v1 base path', () => {
    it('answers the API under /v1 and /health at the root', async () => {
      const a = app();
      expect((await a.inject({ method: 'GET', url: '/v1/allocations', headers: PERSON })).statusCode).toBe(200);
      expect((await a.inject({ method: 'GET', url: '/v1/fleet', headers: PERSON })).statusCode).toBe(200);
      expect((await a.inject({ method: 'GET', url: '/v1/assignment' })).statusCode).toBe(401);
      expect((await a.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok', db: 'ok' });
    });

    it('serves the Zoom webhook at /v1/callbacks/zoom/events', async () => {
      // Unsigned: refused by the route itself (401 or 503 with no secret), not a 404.
      const res = await app().inject({ method: 'POST', url: '/v1/callbacks/zoom/events', payload: {} });
      expect(res.statusCode).not.toBe(404);
    });

    it('answers an old unprefixed path, and /v1/health, through the not-found handler', async () => {
      const a = app();
      for (const url of ['/me', '/members', '/allocations', '/assignment', '/fleet', '/meetings', '/console/settings', '/bot/settings', '/v1/health']) {
        const res = await a.inject({ method: 'GET', url, headers: PERSON });
        expect(res.statusCode, url).toBe(404);
        expect(res.json(), url).toEqual({ error: 'not_found' });
      }
      const zoom = await a.inject({ method: 'POST', url: '/callbacks/zoom/events', payload: {} });
      expect(zoom.statusCode).toBe(404);
    });
  });

  describe('trustProxy (BWAT_TRUST_PROXY)', () => {
    const forwarded = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };
    const whoami = (a: FastifyInstance, remoteAddress: string) =>
      a.inject({ method: 'GET', url: '/test/whoami', remoteAddress, headers: forwarded }).then((r) => r.json());

    it('ignores X-Forwarded-For and -Proto when off (the default)', async () => {
      expect(await whoami(app(), '10.0.0.1')).toEqual({ ip: '10.0.0.1', protocol: 'http' });
    });

    it('takes the client address and protocol from them when on', async () => {
      expect(await whoami(app({ trustProxy: true }), '10.0.0.1')).toEqual({ ip: '203.0.113.9', protocol: 'https' });
    });

    it('trusts them only from a listed proxy when given addresses', async () => {
      const a = app({ trustProxy: trustProxy({ BWAT_TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }) });
      expect(await whoami(a, '10.0.0.1')).toEqual({ ip: '203.0.113.9', protocol: 'https' });
      expect(await whoami(a, '192.0.2.1')).toEqual({ ip: '192.0.2.1', protocol: 'http' });
    });
  });

  describe('security headers on every answer', () => {
    const EXPECTED = {
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': 'frame-ancestors https://*.zoom.us https://*.zoom.com',
    };

    it.each([
      ['a success', { url: '/v1/allocations', headers: PERSON }, 200],
      ['/health', { url: '/health' }, 200],
      ['a 404', { url: '/nowhere' }, 404],
      ['a 401', { url: '/v1/me' }, 401],
      ['a 500', { url: '/test/boom' }, 500],
      ['a 304', { url: '/test/unchanged' }, 304],
    ])('on %s', async (_name, request, status) => {
      const res = await app().inject({ method: 'GET', ...request });
      expect(res.statusCode).toBe(status);
      expect(res.headers).toMatchObject(EXPECTED);
      // Framing is governed by frame-ancestors alone: X-Frame-Options would forbid Zoom.
      expect(res.headers['x-frame-options']).toBeUndefined();
    });

    it('adds BWAT_FRAME_ANCESTORS to Zoom, on every answer, router errors included (QOR-4830)', async () => {
      const a = app({ frameAncestors: ['https://hub.example.test:4519', 'qv:'] });
      for (const url of ['/health', '/v1/me', '/v1/meetings/%ZZ/transcript']) {
        const res = await a.inject({ method: 'GET', url });
        expect(res.headers['content-security-policy'], url).toBe('frame-ancestors https://*.zoom.us https://*.zoom.com https://hub.example.test:4519 qv:');
      }
    });

    // The router's own errors never reach onSend: they are answered by frameworkErrors.
    it.each([
      ['a malformed URL', '/v1/meetings/%ZZ/transcript', 400, { error: 'bad_url' }],
      ['an overlong path parameter', `/v1/meetings/${'a'.repeat(200)}/transcript`, 414, { error: 'too_long' }],
    ])('on %s, with a body that does not echo the path', async (_name, url, status, body) => {
      const res = await app().inject({ method: 'GET', url });
      expect(res.statusCode).toBe(status);
      expect(res.headers).toMatchObject(EXPECTED);
      expect(res.headers['x-frame-options']).toBeUndefined();
      expect(res.json()).toEqual(body);
      expect(res.body).not.toContain('meetings');
    });
  });
});

describe('BWAT_TRUST_PROXY parsing (QOR-4588)', () => {
  it('is off when unset, empty or false', () => {
    for (const value of [undefined, '', 'false', ' FALSE ', '0']) expect(trustProxy({ BWAT_TRUST_PROXY: value }), String(value)).toBe(false);
  });

  it('accepts true, or a list of addresses and CIDRs', () => {
    expect(trustProxy({ BWAT_TRUST_PROXY: 'true' })).toBe(true);
    expect(trustProxy({ BWAT_TRUST_PROXY: '172.16.0.0/12, 127.0.0.1' })).toEqual(['172.16.0.0/12', '127.0.0.1']);
  });

  it('refuses a hop count, which Fastify 5.12 would silently treat as trusting nothing, and stops the server starting', async () => {
    expect(() => trustProxy({ BWAT_TRUST_PROXY: '2' })).toThrow(/^BWAT_TRUST_PROXY must be true or proxy addresses\/CIDRs, not a hop count$/);
    // Refused before the database is opened: nothing listens on port 1.
    await expect(start({ BWAT_DB_URL: 'postgres://unused@127.0.0.1:1/x', PORT: '0', NODE_ENV: 'test', BWAT_TRUST_PROXY: '1' })).rejects.toThrow(/hop count/);
  });
});

describe('BWAT_FRAME_ANCESTORS parsing (QOR-4830)', () => {
  it('is none when unset or empty, so Zoom alone frames bwat', () => {
    for (const value of [undefined, '', '   ']) expect(frameAncestors({ BWAT_FRAME_ANCESTORS: value }), String(value)).toEqual([]);
  });

  it('takes https origins, with a port or :*, and bare schemes, space-separated', () => {
    expect(frameAncestors({ BWAT_FRAME_ANCESTORS: ' https://hub.example.test  https://10.0.0.5:4519	https://hub.example.test:* qv: ' })).toEqual([
      'https://hub.example.test',
      'https://10.0.0.5:4519',
      'https://hub.example.test:*',
      'qv:',
    ]);
  });

  it('refuses anything else, naming the source, and stops the server starting', async () => {
    for (const bad of [
      'http://hub.example.test',
      'https://hub.example.test/',
      'https://hub.example.test/board',
      'https://*.example.test',
      'https://user@hub.example.test',
      'hub.example.test',
      "'self'",
      "'none'",
      '*',
      'https:',
      'http:',
      'data:',
      'blob:',
      'https://hub.example.test:99999x',
      'https://hub.example.test,qv:',
    ]) {
      expect(() => frameAncestors({ BWAT_FRAME_ANCESTORS: `qv: ${bad}` }), bad).toThrow(`BWAT_FRAME_ANCESTORS: ${JSON.stringify(bad)} is not`);
    }
    // Refused before the database is opened: nothing listens on port 1.
    await expect(start({ BWAT_DB_URL: 'postgres://unused@127.0.0.1:1/x', PORT: '0', NODE_ENV: 'test', BWAT_FRAME_ANCESTORS: 'https:' })).rejects.toThrow(/BWAT_FRAME_ANCESTORS/);
  });
});
