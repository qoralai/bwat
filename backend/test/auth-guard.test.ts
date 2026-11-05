import type { FastifyInstance, InjectOptions } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.ts';
import { buildServer } from '../src/server.ts';
import { describeDb, useTestDb } from './db/harness.ts';

/**
 * Every route refuses a caller who presents nothing (QOR-4625): a hosted install is
 * public, with sign-in its only gate. The routes are enumerated from the router, so a new
 * route without auth fails here until it is added to OPEN, which says why it may be.
 */
const OPEN: Record<string, string> = {
  'GET /health': 'load-balancer checks; says only whether the database answers',
  'HEAD /health': 'the HEAD Fastify adds for GET /health',
  'GET /v1/auth/desktop-client': "the Google Desktop client's id and secret, which every installed copy of an app carries anyway (QOR-4713)",
  'HEAD /v1/auth/desktop-client': 'the HEAD Fastify adds for GET /v1/auth/desktop-client',
  'POST /v1/zoom/board-session': "Zoom's sealed app context is itself the proof; an unopened one is 400 (QOR-4708)",
  'POST /v1/zoom/link': 'the link code (from a Zoom context) and the pairing code (from a Google sign-in) are the proof (QOR-4708)',
  'GET /v1/plugins': "the switched-on plugins' names, which the pairing page shows before anyone signs in (QOR-4806)",
  'HEAD /v1/plugins': 'the HEAD Fastify adds for GET /v1/plugins',
};

/** Path parameters filled with values that look real: a uuid, then digits. */
const FILLS = ['0b6f7a52-6f3e-4c55-9d3a-6a1d2b3c4d5e', '123456789'];
const fill = (url: string, value: string) => url.replace(/:[A-Za-z_]+/g, value);

describeDb('every route refuses an unsigned-in caller (QOR-4625)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  let app: FastifyInstance;
  const routes: { method: string; url: string }[] = [];

  beforeAll(async () => {
    pool = createPool(db.url('runtime'));
    await pool.query(`INSERT INTO members (email, role, activated_at) VALUES ('owner@test.invalid', 'owner', now())`);
    app = buildServer({ pool });
    // /health is registered as the app is built; the /v1 routes when it loads, which this sees.
    routes.push({ method: 'GET', url: '/health' }, { method: 'HEAD', url: '/health' });
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) routes.push({ method, url: route.url });
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('has seen every route the router holds', () => {
    // Each route is one method in the printed tree: a route registered where the hook
    // cannot see it changes the count.
    const printed = app.printRoutes({ commonPrefix: false });
    const methods = [...printed.matchAll(/\(([A-Z, ]+)\)/g)].flatMap(([, list]) => list!.split(', '));
    expect(routes.length).toBe(methods.length);
    expect(new Set(routes.map((r) => `${r.method} ${r.url}`)).size).toBe(routes.length);
  });

  it('answers 401 on every route but the open ones, with path parameters filled', async () => {
    const table: string[] = [];
    for (const { method, url } of routes) {
      const name = `${method} ${url}`;
      const statuses: number[] = [];
      for (const value of url.includes(':') ? FILLS : [url]) {
        const res = await app.inject({ method: method as NonNullable<InjectOptions['method']>, url: fill(url, value) });
        statuses.push(res.statusCode);
        if (res.statusCode !== 404) break;
      }
      const status = statuses.at(-1)!;
      table.push(`${name} -> ${statuses.join('/')}`);
      // An open route answers without sign-in: 200, or 400 for an empty body it cannot use.
      if (name in OPEN) expect([200, 400], name).toContain(status);
      else expect(status, name).toBe(401);
    }
    console.info(`routes (${routes.length}):\n${table.join('\n')}`);
  });

  it('refuses an unsigned Zoom delivery with its own 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/callbacks/zoom/events', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });
});
