import { expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { apiBase } from './app.ts';
import { describeDb, ROLE_NAMES, useTestDb } from './db/harness.ts';
import { deliver } from './zoom.ts';

describeDb('starting the server (QOR-4568)', () => {
  const db = useTestDb();

  it('listens when BWAT_DB_URL is the runtime role, and /health answers over HTTP', async () => {
    const app = await start({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test' });
    try {
      const { port } = app.server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('refuses to start as the owner role', async () => {
    await expect(start({ BWAT_DB_URL: db.url('owner'), PORT: '0', NODE_ENV: 'test' })).rejects.toThrow(
      `database role check failed: ${ROLE_NAMES.owner} owns the database or the app schema`,
    );
  });

  it('refuses to start as any other role, even one that owns nothing (QOR-4572)', async () => {
    await expect(start({ BWAT_DB_URL: db.url('stranger'), PORT: '0', NODE_ENV: 'test' })).rejects.toThrow(
      `database role check failed: ${ROLE_NAMES.stranger} is not ${ROLE_NAMES.runtime}`,
    );
  });

  it('reads the Zoom webhook secret from BWAT_ZOOM_WEBHOOK_SECRET until the store is wired (QOR-4576)', async () => {
    const app = apiBase(await start({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', BWAT_ZOOM_WEBHOOK_SECRET: 'start-secret' }));
    try {
      const res = await deliver({ app }, { event: 'endpoint.url_validation', payload: { plainToken: 'abc' } }, { secret: 'start-secret' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
