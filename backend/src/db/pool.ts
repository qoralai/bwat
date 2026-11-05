import pg from 'pg';
import { dbTls, runtimeDbUrl } from '../config.ts';

/** Every statement, query and connection attempt is bounded: nothing waits forever. */
export const POOL_DEFAULTS = {
  max: 10,
  /** Waiting for a connection from the pool or to the server. */
  connectionTimeoutMillis: 5_000,
  /** Server side: Postgres cancels a statement that runs longer. */
  statement_timeout: 10_000,
  /** Client side: gives up on a query with no answer (a dead connection), after the server's own limit. */
  query_timeout: 15_000,
  /** Server side: ends a session left idle inside an open transaction. */
  idle_in_transaction_session_timeout: 30_000,
} satisfies pg.PoolConfig;

/** The app schema created by migration 0001. Queries use unqualified table names. */
export const APP_SCHEMA = 'bwat';

/**
 * A pool for the app, logged in with `connectionString` (BWAT_DB_URL, the runtime role).
 * Never pass the owner's URL here; the server checks the role before it listens.
 */
export function createPool(connectionString: string, overrides: Partial<pg.PoolConfig> = {}): pg.Pool {
  const pool = new pg.Pool({
    ...POOL_DEFAULTS,
    ...overrides,
    connectionString,
    options: `-c search_path=${APP_SCHEMA}`,
  });
  // An idle client losing its connection emits 'error' on the pool; unhandled, that
  // ends the process. The pool drops that client and the next query reconnects (or
  // fails, and /health says 503). Logs the code only: the message can name the host.
  pool.on('error', (err) => {
    console.error(JSON.stringify({ event: 'db.pool_error', code: (err as { code?: string }).code }));
  });
  return pool;
}

/** The app's pool from the resolved env: BWAT_DB_URL, over TLS when BWAT_DB_SSLROOTCERT is set. */
export function runtimePool(env: NodeJS.ProcessEnv, overrides: Partial<pg.PoolConfig> = {}): pg.Pool {
  return createPool(runtimeDbUrl(env), { ...overrides, ssl: dbTls(env) });
}

/**
 * Runs fn inside one transaction on `client`: COMMIT when it resolves, ROLLBACK and
 * rethrow the same error when it throws. A failed ROLLBACK is passed to
 * onRollbackError: the connection may still be inside the transaction.
 */
export async function inTransaction<C extends pg.ClientBase, T>(
  client: C,
  fn: (client: C) => Promise<T>,
  onRollbackError: (err: Error) => void = () => {},
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // A failed ROLLBACK (dropped connection) must not hide the real cause.
    await client.query('ROLLBACK').catch(onRollbackError);
    throw err;
  }
}

/**
 * inTransaction on one pooled client, which goes back to the pool, or is destroyed
 * when its ROLLBACK failed.
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    return await inTransaction(client, fn, (err) => (broken = err));
  } finally {
    client.release(broken);
  }
}
