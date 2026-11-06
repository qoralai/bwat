import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { localSecretStore } from '../src/secrets/store.ts';
import { raceBehindLock } from './app.ts';
import { describeDb } from './db/harness.ts';
import { ADMIN, ADMIN_ID, OWNER, useRoles } from './people.ts';

const KEY = 'sk-openai-0123456789-abcdefghij-KEY1';
const SECRET = 'panel-secret-0123456789-abcdefghij-SEC1';

// The admin check that decides a write is made inside the write's own transaction, and
// waits for a role change in flight: a demotion committed while the save waits on it wins.
describeDb('an admin demoted while their write waits is refused inside its transaction (QOR-4575, QOR-4578)', () => {
  const t = useRoles({ secrets: (pool) => localSecretStore(pool, randomBytes(32)), checkKey: async () => 'valid' });
  const auditCount = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM audit WHERE target_type <> 'member'`)).rows[0].n;
  const version = async () => (await t.pool.query(`SELECT version FROM settings_version`)).rows[0].version;

  const writes = [
    {
      name: 'PUT /console/settings/{section}',
      method: 'PUT' as const,
      url: '/console/settings/jev',
      payload: { changes: { jev_enabled: { value: true, expectedRevision: null } } },
    },
    { name: 'PUT /console/model-keys/{provider}', method: 'PUT' as const, url: '/console/model-keys/anthropic', payload: { key: KEY } },
    { name: 'DELETE /console/model-keys/{provider}', method: 'DELETE' as const, url: '/console/model-keys/openai', payload: {} },
    { name: 'POST /console/model-keys/{provider}/validate', method: 'POST' as const, url: '/console/model-keys/openai/validate', payload: {} },
    // The panel secrets take the same in-transaction check.
    { name: 'PUT /console/secrets/{name}', method: 'PUT' as const, url: '/console/secrets/zoom.webhook_secret', payload: { value: `${SECRET}-NEW` } },
    { name: 'DELETE /console/secrets/{name}', method: 'DELETE' as const, url: '/console/secrets/zoom.webhook_secret', payload: {} },
  ];

  for (const write of writes) {
    it(`${write.name}: 403 forbidden, and nothing changes`, async () => {
      // A key for DELETE and validate to act on, set by the owner.
      const set = await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: OWNER, payload: { key: KEY } });
      expect(set.statusCode).toBe(200);
      // And a panel secret for its PUT to overwrite and its DELETE to remove.
      const secret = await t.app.inject({ method: 'PUT', url: '/console/secrets/zoom.webhook_secret', headers: OWNER, payload: { value: SECRET } });
      expect(secret.statusCode).toBe(200);
      const [auditsBefore, versionBefore] = [await auditCount(), await version()];
      const settingsBefore = (await t.pool.query(`SELECT key, value, revision FROM settings ORDER BY key`)).rows;
      const secretsBefore = (await t.pool.query(`SELECT name, ciphertext FROM secrets ORDER BY name`)).rows;
      try {
        // The demotion has run its UPDATE and not committed; the write starts behind it.
        const res = await raceBehindLock(
          t,
          { sql: `UPDATE members SET role = 'member', updated_at = now() WHERE id = $1`, params: [ADMIN_ID] },
          () => t.app.inject({ method: write.method, url: write.url, headers: ADMIN, payload: write.payload }),
        );
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden' });
      } finally {
        await t.pool.query(`UPDATE members SET role = 'admin' WHERE id = $1`, [ADMIN_ID]);
      }
      expect(await auditCount()).toBe(auditsBefore);
      expect(await version()).toBe(versionBefore);
      expect((await t.pool.query(`SELECT key, value, revision FROM settings ORDER BY key`)).rows).toEqual(settingsBefore);
      expect((await t.pool.query(`SELECT name, ciphertext FROM secrets ORDER BY name`)).rows).toEqual(secretsBefore);
    });
  }
});
