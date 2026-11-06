import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { awsSecretStore, localSecretStore, secretStoreFromEnv, withEnvFallback } from '../src/secrets/store.ts';
import { ZOOM_SECRET_ENV } from '../src/config.ts';
import { describeDb } from './db/harness.ts';
import { FakeSecretsManager } from './fake-secrets-manager.ts';
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

// A change is audited first and the store written last, in one transaction: a store that
// cannot write must answer 503 and leave neither an audit row nor a value behind.
const secretAudits = async (pool: pg.Pool) =>
  (await pool.query(`SELECT count(*)::int AS n FROM audit WHERE target_type LIKE 'secret:%'`)).rows[0]!.n;

describeDb('/console/secrets when Secrets Manager cannot be reached', () => {
  const lines: string[] = [];
  const fake = new FakeSecretsManager();
  const t = useRoles({
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    secrets: () => awsSecretStore(fake, 'bwat/test/', { retryDelaysMs: [0] }),
  });

  it('answers 503 secret_unavailable to a set and a remove, audits nothing, and still lists the secrets as unavailable', async () => {
    fake.failWith = 'AccessDeniedException';
    try {
      for (const [method, payload] of [
        ['PUT', { value: VALUE }],
        ['DELETE', {}],
      ] as const) {
        const res = await t.app.inject({ method, url: '/console/secrets/zoom.webhook_secret', headers: ADMIN, payload });
        expect(res.statusCode, method).toBe(503);
        expect(res.json(), method).toEqual({ error: 'secret_unavailable' });
      }
      const list = await t.app.inject({ method: 'GET', url: '/console/secrets', headers: ADMIN });
      expect(list.statusCode).toBe(200);
      expect(list.json().secrets).toContainEqual({ name: 'zoom.webhook_secret', set: false, source: 'unavailable', last4: null });
    } finally {
      fake.failWith = null;
    }
    // DELETE writes its audit row before the store refuses: it must roll back.
    expect(await secretAudits(t.pool)).toBe(0);
    expect(lines.join('\n')).not.toContain(VALUE);
  });
});

describeDb('/console/secrets with no BWAT_ENC_KEY to write with', () => {
  const t = useRoles({ secrets: (pool) => secretStoreFromEnv({}, pool) });

  it('answers 503 not_configured to a set and a remove; the set\'s audit row, written before the store refuses, rolls back', async () => {
    for (const [method, payload] of [
      ['PUT', { value: VALUE }],
      ['DELETE', {}],
    ] as const) {
      const res = await t.app.inject({ method, url: '/console/secrets/zoom.client_secret', headers: ADMIN, payload });
      expect(res.statusCode, method).toBe(503);
      expect(res.json(), method).toEqual({ error: 'not_configured' });
    }
    expect(await secretAudits(t.pool)).toBe(0);
  });
});
