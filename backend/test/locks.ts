import type pg from 'pg';
import { lockSettings } from '../src/settings/store.ts';

/**
 * Holds the settings lock in a transaction of its own, as a console change in flight
 * does, until `release` commits it. `waitForBlocked` resolves once another connection to
 * this database is waiting on a lock, so a test can act at the moment the change under
 * test is blocked behind this one. Never by timing: it polls pg_locks.
 */
export async function holdSettingsLock(pool: pg.Pool): Promise<{
  client: pg.PoolClient;
  waitForBlocked: () => Promise<void>;
  release: () => Promise<void>;
}> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await lockSettings(client);
  const waitForBlocked = async () => {
    for (let i = 0; i < 500; i++) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND a.datname = current_database()`,
      );
      if (rows[0]!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('test: nothing blocked on the settings lock');
  };
  const release = async () => {
    try {
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };
  return { client, waitForBlocked, release };
}
