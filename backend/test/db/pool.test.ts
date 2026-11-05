import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, POOL_DEFAULTS, withTransaction } from '../../src/db/pool.ts';
import { describeDb, ROLE_NAMES, useTestDb } from './harness.ts';

describe('pool defaults (QOR-4568)', () => {
  it('bound every statement, every query and every connection attempt', () => {
    expect(POOL_DEFAULTS.statement_timeout).toBeGreaterThan(0);
    expect(POOL_DEFAULTS.query_timeout).toBeGreaterThan(POOL_DEFAULTS.statement_timeout);
    expect(POOL_DEFAULTS.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(POOL_DEFAULTS.idle_in_transaction_session_timeout).toBeGreaterThan(0);
  });
});

describeDb('the database pool (QOR-4568)', () => {
  const db = useTestDb();
  let pool: pg.Pool;

  beforeAll(async () => {
    const owner = await db.connect('owner');
    await owner.query(`CREATE TABLE bwat.items (id int PRIMARY KEY)`);
    await owner.query(`GRANT SELECT, INSERT ON bwat.items TO ${ROLE_NAMES.runtime}`);
    await owner.end();
    pool = createPool(db.url('runtime'));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('logs in as the runtime role with the app schema on the search path and the timeouts set', async () => {
    const { rows } = await pool.query(
      `SELECT current_user AS who, current_setting('search_path') AS path,
              current_setting('statement_timeout') AS statement,
              current_setting('idle_in_transaction_session_timeout') AS idle`,
    );
    expect(rows).toEqual([
      {
        who: ROLE_NAMES.runtime,
        path: 'bwat',
        statement: `${POOL_DEFAULTS.statement_timeout}ms`.replace(/^(\d+)000ms$/, '$1s'),
        idle: `${POOL_DEFAULTS.idle_in_transaction_session_timeout}ms`.replace(/^(\d+)000ms$/, '$1s'),
      },
    ]);
  });

  it('cancels a statement that runs past statement_timeout', async () => {
    const short = createPool(db.url('runtime'), { statement_timeout: 200 });
    try {
      await expect(short.query('SELECT pg_sleep(5)')).rejects.toMatchObject({ code: '57014' });
    } finally {
      await short.end();
    }
  });

  it('gives up on a query that gets no answer within query_timeout', async () => {
    const short = createPool(db.url('runtime'), { statement_timeout: 60_000, query_timeout: 200 });
    try {
      await expect(short.query('SELECT pg_sleep(2)')).rejects.toThrow('Query read timeout');
    } finally {
      await short.end();
    }
  });

  it('withTransaction commits what fn wrote and returns its result', async () => {
    const result = await withTransaction(pool, async (client) => {
      await client.query('INSERT INTO items (id) VALUES (1)');
      return 'done';
    });
    expect(result).toBe('done');
    // Read on a separate session: only committed rows are visible there.
    const other = await db.connect('runtime');
    try {
      expect((await other.query('SELECT id FROM bwat.items WHERE id = 1')).rows).toEqual([{ id: 1 }]);
    } finally {
      await other.end();
    }
  });

  it('withTransaction rolls back when fn throws, rethrows the same error, and releases the client', async () => {
    const one = createPool(db.url('runtime'), { max: 1, connectionTimeoutMillis: 1_000 });
    const boom = new Error('boom');
    try {
      await expect(
        withTransaction(one, async (client) => {
          await client.query('INSERT INTO items (id) VALUES (2)');
          throw boom;
        }),
      ).rejects.toBe(boom);
      // With max 1, this would time out waiting if the client had not been released,
      // and would see id 2 if the insert had been committed.
      expect((await one.query('SELECT id FROM items WHERE id = 2')).rows).toEqual([]);
    } finally {
      await one.end();
    }
  });

  it('withTransaction destroys the client when ROLLBACK fails, rather than pooling an open transaction (QOR-4572)', async () => {
    const one = createPool(db.url('runtime'), { max: 1, connectionTimeoutMillis: 1_000 });
    const boom = new Error('boom');
    try {
      await expect(
        withTransaction(one, async (client) => {
          await client.query('INSERT INTO items (id) VALUES (3)');
          // The connection stays up but ROLLBACK never reaches the server (a client-side timeout, say).
          const query = client.query.bind(client);
          client.query = ((sql: unknown, ...rest: unknown[]) =>
            sql === 'ROLLBACK' ? Promise.reject(new Error('rollback lost')) : query(sql as string, ...(rest as []))) as typeof client.query;
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(one.totalCount).toBe(0);
    } finally {
      await one.end();
    }
  });
});
