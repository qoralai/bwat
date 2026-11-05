import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { localSecretStore, withEnvFallback } from '../src/secrets/store.ts';
import { ZOOM_SECRET_ENV } from '../src/config.ts';
import { describeDb } from './db/harness.ts';
import { ADMIN, ADMIN_ID, MEMBER, OWNER, useRoles } from './people.ts';

// QOR-4668 (D142, D173): the Zoom secrets, and the plugins' own, are entered in the admin panel, like
// the model keys: status only, never a value back.

const VALUE = 'zoom-webhook-secret-0123456789-WHSK';

describeDb('/console/secrets (QOR-4668)', () => {
  const lines: string[] = [];
  const t = useRoles({
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    secrets: (pool) => withEnvFallback(localSecretStore(pool, randomBytes(32)), ZOOM_SECRET_ENV, {}),
  });
  const bodies: string[] = [];
  const call = async (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = ADMIN) => {
    const res = await t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    bodies.push(res.body);
    return res;
  };

  it('lets an admin set a Zoom secret, stored encrypted; the status shows set, store and the last 4', async () => {
    const set = await call('PUT', '/console/secrets/zoom.webhook_secret', { value: VALUE });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ name: 'zoom.webhook_secret', set: true, source: 'store', last4: 'WHSK' });

    const list = (await call('GET', '/console/secrets')).json().secrets;
    expect(list.map((s: { name: string }) => s.name)).toEqual([
      'zoom.client_id',
      'zoom.client_secret',
      'zoom.webhook_secret',
      'zoom.board_client_secret',
      'zoom.s2s_account_id',
      'zoom.s2s_client_id',
      'zoom.s2s_client_secret',
    ]);
    expect(list).toContainEqual({ name: 'zoom.webhook_secret', set: true, source: 'store', last4: 'WHSK' });

    const { rows } = await t.pool.query(`SELECT * FROM secrets`);
    expect(JSON.stringify(rows)).not.toContain(VALUE);
    const audit = await t.pool.query(`SELECT actor_id AS actor, action FROM audit WHERE target_type = 'secret:zoom.webhook_secret'`);
    expect(audit.rows).toEqual([{ actor: ADMIN_ID, action: 'secret.set' }]);

    const removed = await call('DELETE', '/console/secrets/zoom.webhook_secret', {});
    expect(removed.json()).toEqual({ name: 'zoom.webhook_secret', set: false, source: null, last4: null });
    // Removing what is not stored changes nothing and audits nothing.
    await call('DELETE', '/console/secrets/zoom.webhook_secret', {});
    const audited = await t.pool.query(`SELECT action, before, after FROM audit WHERE target_type = 'secret:zoom.webhook_secret' ORDER BY at`);
    expect(audited.rows).toEqual([
      { action: 'secret.set', before: { set: false }, after: { set: true } },
      { action: 'secret.removed', before: { set: true }, after: { set: false } },
    ]);
    expect([...bodies, ...lines].join('\n')).not.toContain(VALUE);
  });

  it("is owner or admin only: 403 for a member, and 404 for a name that is not a Zoom or a plugin's secret", async () => {
    expect((await call('PUT', '/console/secrets/zoom.webhook_secret', { value: VALUE }, MEMBER)).statusCode).toBe(403);
    expect((await call('GET', '/console/secrets', undefined, MEMBER)).statusCode).toBe(403);
    expect((await call('GET', '/console/secrets', undefined, OWNER)).statusCode).toBe(200);
    expect((await call('PUT', '/console/secrets/provider.openai', { value: VALUE })).statusCode).toBe(404);
    // A plugin's secret is no secret here while no shipped plugin declares it.
    expect((await call('PUT', '/console/secrets/probe.token', { value: 'probe-token-0123456789' })).statusCode).toBe(404);
  });

  it('refuses a value that is empty or holds whitespace: 400 invalid_value', async () => {
    for (const value of ['', 'has a space', 42]) {
      const res = await call('PUT', '/console/secrets/zoom.s2s_client_secret', { value });
      expect(res.statusCode, String(value)).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_value' });
    }
  });
});
