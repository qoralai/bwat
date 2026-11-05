import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { asSuperuser, describeDb, ROLE_NAMES, useTestDb } from './db/harness.ts';

const BACKEND = join(import.meta.dirname, '..');

/** Polls until check() returns something truthy, or fails after timeoutMs. */
async function waitFor<T>(check: () => T, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describeDb('the server when the database goes away (QOR-4572)', () => {
  const db = useTestDb();

  it('logs an idle connection error without details, stays up, and /health answers 503', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, BWAT_DB_URL: db.url('runtime'), PORT: '0' };
    delete env.VITEST;
    delete env.NODE_ENV;
    // The real entry point, in its own process: an unhandled 'error' event would end it.
    const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { cwd: BACKEND, env });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      const port = await waitFor(() => /listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]);
      const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).status;
      expect(await health()).toBe(200); // leaves an idle client in the pool

      await asSuperuser(async (su) => {
        await su.query(`ALTER DATABASE ${db.name} WITH ALLOW_CONNECTIONS false`);
        await su.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND usename = $2`, [
          db.name,
          ROLE_NAMES.runtime,
        ]);
      });

      await waitFor(() => output.includes('db.pool_error') || child.exitCode !== null);
      expect(child.exitCode).toBeNull();
      expect(await health()).toBe(503);
      expect(child.exitCode).toBeNull();
      const password = decodeURIComponent(new URL(db.url('runtime')).password);
      for (const marker of [password, db.name, ROLE_NAMES.runtime]) expect(output).not.toContain(marker);
    } finally {
      child.kill();
      await exited;
      await asSuperuser((su) => su.query(`ALTER DATABASE ${db.name} WITH ALLOW_CONNECTIONS true`));
    }
  }, 30_000);
});
