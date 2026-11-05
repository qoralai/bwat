import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '../src/db/pool.ts';
import { buildServer } from '../src/server.ts';
import { describeDb, useTestDb } from './db/harness.ts';

describeDb('/health with a database (QOR-4568)', () => {
  const db = useTestDb();
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPool(db.url('runtime'));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('answers 200 with db: ok when the database answers the runtime role', async () => {
    const app = buildServer({ pool });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
    await app.close();
  });
});

describe('/health without a database (QOR-4568)', () => {
  // Nothing listens on port 1; every part of this URL is a marker that must not leak.
  const url = 'postgres://leaky_user:leaky_password@127.0.0.1:1/leaky_database';

  it('answers 503 with db: unavailable and says nothing about the connection', async () => {
    const pool = createPool(url, { connectionTimeoutMillis: 2_000 });
    const app = buildServer({ pool });
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'error', db: 'unavailable' });
      for (const marker of ['leaky_user', 'leaky_password', 'leaky_database', '127.0.0.1', ':1', 'ECONNREFUSED']) {
        expect(res.body).not.toContain(marker);
      }
    } finally {
      await app.close();
      await pool.end();
    }
  }, 10_000);
});
