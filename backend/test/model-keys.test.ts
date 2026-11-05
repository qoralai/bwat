import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyChecker, MODEL_KEY_ENV, PROVIDERS } from '../src/model-keys.ts';
import { awsSecretStore, localSecretStore, secretStoreFromEnv, withEnvFallback } from '../src/secrets/store.ts';
import { asSuperuser, describeDb } from './db/harness.ts';
import { FakeSecretsManager } from './fake-secrets-manager.ts';
import { holdSettingsLock } from './locks.ts';
import { ADMIN, ADMIN_ID, MEMBER, OWNER, OWNER_ID, useRoles } from './people.ts';

const KEY = 'sk-model-KEY-0123456789-abcdef-LAST';
const ENV_KEY = 'sk-ant-from-the-env-0123456789-ENVK';

describeDb('/console/model-keys (QOR-4578)', () => {
  const lines: string[] = [];
  const checked: { provider: string; key: string }[] = [];
  const t = useRoles({
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    secrets: () =>
      withEnvFallback(awsSecretStore(new FakeSecretsManager(), 'bwat/test/'), MODEL_KEY_ENV, { ANTHROPIC_API_KEY: ENV_KEY }),
    checkKey: async (provider, key) => {
      checked.push({ provider, key });
      return key === KEY ? 'valid' : 'invalid';
    },
  });
  const bodies: string[] = [];
  const call = async (method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: object, headers: Record<string, string> = ADMIN) => {
    const res = await t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    bodies.push(res.body);
    return res;
  };
  const version = async () => (await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER })).json().settingsVersion;

  it('is owner or admin only, reading included: 401 for nobody and 403 for a member on every route', async () => {
    for (const [method, url, payload] of [
      ['GET', '/console/model-keys'],
      ['PUT', '/console/model-keys/openai', { key: KEY }],
      ['DELETE', '/console/model-keys/openai', {}],
      ['POST', '/console/model-keys/openai/validate', {}],
    ] as const) {
      const anonymous = await call(method, url, payload, {});
      expect(anonymous.statusCode, `${method} ${url}`).toBe(401);
      expect(anonymous.json()).toEqual({ error: 'unauthorized' });
      const member = await call(method, url, payload, MEMBER);
      expect(member.statusCode, `${method} ${url}`).toBe(403);
      expect(member.json()).toEqual({ error: 'forbidden' });
    }
    expect(checked).toEqual([]);
    expect(await version()).toBe(0);
  });

  it('lets an owner read, set, validate and remove, as an admin can (D141, D149)', async () => {
    expect((await call('GET', '/console/model-keys', undefined, OWNER)).statusCode).toBe(200);
    const set = await call('PUT', '/console/model-keys/openrouter', { key: KEY }, OWNER);
    expect(set.json()).toEqual({ provider: 'openrouter', set: true, source: 'store', last4: 'LAST' });
    expect((await call('POST', '/console/model-keys/openrouter/validate', {}, OWNER)).json()).toEqual({ result: 'valid' });
    const removed = await call('DELETE', '/console/model-keys/openrouter', {}, OWNER);
    expect(removed.json()).toEqual({ provider: 'openrouter', set: false, source: null, last4: null });
    const { rows } = await t.pool.query(`SELECT actor_id AS actor, action FROM audit WHERE target_type = 'model_key:openrouter' ORDER BY at`);
    expect(rows).toEqual([
      { actor: OWNER_ID, action: 'model_key.set' },
      { actor: OWNER_ID, action: 'model_key.validated' },
      { actor: OWNER_ID, action: 'model_key.removed' },
    ]);
    checked.length = 0;
  });

  it('lists the six providers by status only: the env fallback shows as env', async () => {
    const res = await call('GET', '/console/model-keys');
    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toEqual([
      { provider: 'openai', set: false, source: null, last4: null },
      { provider: 'anthropic', set: true, source: 'env', last4: 'ENVK' },
      { provider: 'openrouter', set: false, source: null, last4: null },
      { provider: 'cerebras', set: false, source: null, last4: null },
      { provider: 'deepgram', set: false, source: null, last4: null },
      { provider: 'custom', set: false, source: null, last4: null },
    ]);
    expect(PROVIDERS).toEqual(['openai', 'anthropic', 'openrouter', 'cerebras', 'deepgram', 'custom']);
  });

  it('sets a key, answers its status only, bumps the settings version and audits without the value', async () => {
    const before = await version();
    const res = await call('PUT', '/console/model-keys/openai', { key: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'openai', set: true, source: 'store', last4: 'LAST' });
    expect(await version()).toBe(before + 1);
    const { rows } = await t.pool.query(`SELECT actor_id AS actor, action, target_type AS target, before, after FROM audit WHERE target_type = 'model_key:openai'`);
    expect(rows).toEqual([{ actor: ADMIN_ID, action: 'model_key.set', target: 'model_key:openai', before: { set: false }, after: { set: true } }]);
  });

  it('refuses an unknown provider (404) and a key that is not one (400)', async () => {
    expect((await call('PUT', '/console/model-keys/zoom', { key: KEY })).json()).toEqual({ error: 'unknown_provider' });
    for (const key of ['short', 'has a space in it 0123', 'x'.repeat(513), 42]) {
      const res = await call('PUT', '/console/model-keys/cerebras', { key });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_key' });
    }
  });

  it('validates the stored key with the provider, and the env key when none is stored', async () => {
    const res = await call('POST', '/console/model-keys/openai/validate', {});
    expect(res.json()).toEqual({ result: 'valid' });
    expect((await call('POST', '/console/model-keys/anthropic/validate', {})).json()).toEqual({ result: 'invalid' });
    expect(checked).toEqual([
      { provider: 'openai', key: KEY },
      { provider: 'anthropic', key: ENV_KEY },
    ]);
    const nothing = await call('POST', '/console/model-keys/cerebras/validate', {});
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json()).toEqual({ error: 'not_set' });
  });

  it('removes a stored key: the status falls back, the version bumps once, and a second remove changes nothing', async () => {
    const before = await version();
    const res = await call('DELETE', '/console/model-keys/openai', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'openai', set: false, source: null, last4: null });
    expect((await call('DELETE', '/console/model-keys/openai', {})).statusCode).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  it('never puts a key in a response or a log line', () => {
    for (const secret of [KEY, ENV_KEY]) {
      expect(bodies.join('\n')).not.toContain(secret);
      expect(lines.join('')).not.toContain(secret);
    }
    expect(lines.join('')).toMatch(/"event":"model_key.set","provider":"openai"/);
  });
});

describeDb('/console/model-keys without a secret store key (QOR-4578)', () => {
  const t = useRoles({ secrets: (pool) => secretStoreFromEnv({}, pool) });

  it('answers 503 to a set or a remove, and still lists', async () => {
    for (const [method, payload] of [
      ['PUT', { key: KEY }],
      ['DELETE', {}],
    ] as const) {
      const res = await t.app.inject({ method, url: '/console/model-keys/openai', headers: ADMIN, payload });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'not_configured' });
    }
    expect((await t.app.inject({ method: 'GET', url: '/console/model-keys', headers: ADMIN })).statusCode).toBe(200);
  });

  it('answers a validate 409 not_set, not 503: nothing is stored, so there is no key to check', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/console/model-keys/openai/validate', headers: ADMIN, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not_set' });
  });
});

describeDb('/console/model-keys on the local store (QOR-4578)', () => {
  const encKey = randomBytes(32);
  // BWAT_ENC_KEY as the server gets it: from the env (D141).
  const t = useRoles({ secrets: (pool) => secretStoreFromEnv({ BWAT_ENC_KEY: encKey.toString('base64') }, pool) });

  it('keeps the key encrypted and BWAT_ENC_KEY out of every secrets row, setting and audit row', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key: KEY } });
    expect(res.json()).toEqual({ provider: 'openai', set: true, source: 'store', last4: 'LAST' });
    const saved = await t.app.inject({
      method: 'PUT',
      url: '/console/settings/joining',
      headers: ADMIN,
      payload: { changes: { display_name: { value: 'Scribe', expectedRevision: null } } },
    });
    expect(saved.statusCode).toBe(200);
    const dump = JSON.stringify([
      (await t.pool.query(`SELECT * FROM secrets`)).rows,
      (await t.pool.query(`SELECT * FROM settings`)).rows,
      (await t.pool.query(`SELECT * FROM settings_version`)).rows,
      (await t.pool.query(`SELECT * FROM dictionary`)).rows,
      (await t.pool.query(`SELECT * FROM audit`)).rows,
    ]);
    expect(dump).toContain('Scribe');
    expect((await t.pool.query(`SELECT name FROM secrets`)).rows).toEqual([{ name: 'provider.openai' }]);
    for (const form of [encKey.toString('hex'), encKey.toString('base64'), KEY]) expect(dump).not.toContain(form);
  });
});

describeDb('/console/model-keys: a key change and its audit are one change (QOR-4578)', () => {
  const encKey = randomBytes(32);
  const t = useRoles({ secrets: (pool) => localSecretStore(pool, encKey) });
  const refuseAudit = (on: boolean) =>
    asSuperuser(
      (su) =>
        su.query(
          on
            ? `ALTER TABLE bwat.audit ADD CONSTRAINT test_refuse_model_key CHECK (action NOT LIKE 'model_key.%') NOT VALID`
            : `ALTER TABLE bwat.audit DROP CONSTRAINT test_refuse_model_key`,
        ),
      t.db.name,
    );
  const stored = async () => (await t.pool.query(`SELECT name FROM secrets`)).rows.map((r) => r.name);

  it('keeps no key, and removes none, when the audit cannot be written', async () => {
    await refuseAudit(true);
    try {
      const put = await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key: KEY } });
      expect(put.statusCode).toBe(500);
      expect(await stored()).toEqual([]);
    } finally {
      await refuseAudit(false);
    }
    expect((await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key: KEY } })).statusCode).toBe(200);
    await refuseAudit(true);
    try {
      const del = await t.app.inject({ method: 'DELETE', url: '/console/model-keys/openai', headers: ADMIN, payload: {} });
      expect(del.statusCode).toBe(500);
      expect(await stored()).toEqual(['provider.openai']);
    } finally {
      await refuseAudit(false);
    }
  });
});

describeDb('/console/model-keys on Secrets Manager: no key change without its audit (QOR-4578)', () => {
  const fake = new FakeSecretsManager();
  const t = useRoles({ secrets: () => awsSecretStore(fake, 'bwat/test/', { retryDelaysMs: [0] }) });
  const refuseAudit = (on: boolean) =>
    asSuperuser(
      (su) =>
        su.query(
          on
            ? `ALTER TABLE bwat.audit ADD CONSTRAINT test_refuse_model_key_aws CHECK (action NOT LIKE 'model_key.%') NOT VALID`
            : `ALTER TABLE bwat.audit DROP CONSTRAINT test_refuse_model_key_aws`,
        ),
      t.db.name,
    );
  const version = async () => (await t.pool.query(`SELECT version FROM settings_version`)).rows[0].version;

  it('writes nothing to Secrets Manager when the audit or the bump fails, and removes nothing', async () => {
    await refuseAudit(true);
    try {
      const put = await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key: KEY } });
      expect(put.statusCode).toBe(500);
      expect([...fake.secrets.keys()]).toEqual([]);
    } finally {
      await refuseAudit(false);
    }
    expect((await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key: KEY } })).statusCode).toBe(200);
    const at = await version();
    await refuseAudit(true);
    try {
      const del = await t.app.inject({ method: 'DELETE', url: '/console/model-keys/openai', headers: ADMIN, payload: {} });
      expect(del.statusCode).toBe(500);
      expect(fake.secrets.get('bwat/test/provider.openai')).toMatchObject({ value: KEY, scheduled: false });
      expect(fake.secrets.get('bwat/test/provider.openai')?.pending).toBeUndefined();
    } finally {
      await refuseAudit(false);
    }
    expect(await version()).toBe(at);
  });

  it('reads whether the key was set under the settings lock, so the audit says what the change replaced', async () => {
    const held = await holdSettingsLock(t.pool);
    let put;
    try {
      put = t.app.inject({ method: 'PUT', url: '/console/model-keys/openrouter', headers: ADMIN, payload: { key: KEY } });
      await held.waitForBlocked();
      // A change in flight stores a key, then commits.
      await awsSecretStore(fake, 'bwat/test/').put('provider.openrouter', `${KEY}-other`);
    } finally {
      await held.release();
    }
    expect((await put).statusCode).toBe(200);
    const { rows } = await t.pool.query(`SELECT before, after FROM audit WHERE target_type = 'model_key:openrouter' ORDER BY at DESC LIMIT 1`);
    expect(rows).toEqual([{ before: { set: true }, after: { set: true } }]);
  });

  it('bumps nothing and audits nothing for a removal of a key that is not stored', async () => {
    const at = await version();
    const audits = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM audit`)).rows[0].n;
    const before = await audits();
    const del = await t.app.inject({ method: 'DELETE', url: '/console/model-keys/anthropic', headers: ADMIN, payload: {} });
    expect(del.statusCode).toBe(200);
    expect(await version()).toBe(at);
    expect(await audits()).toBe(before);
  });
});

describeDb('/console/model-keys when Secrets Manager cannot be reached (QOR-4578)', () => {
  const fake = new FakeSecretsManager();
  const t = useRoles({ secrets: () => awsSecretStore(fake, 'bwat/test/', { retryDelaysMs: [0] }) });

  it('answers 503 to a set or a remove, writes no audit and no version, and lists the keys as unavailable', async () => {
    fake.failWith = 'AccessDeniedException';
    for (const [method, payload] of [
      ['PUT', { key: KEY }],
      ['DELETE', {}],
    ] as const) {
      const res = await t.app.inject({ method, url: '/console/model-keys/openai', headers: ADMIN, payload });
      expect(res.statusCode, method).toBe(503);
      expect(res.json()).toEqual({ error: 'secret_unavailable' });
    }
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM audit`)).rows[0].n).toBe(0);
    expect((await t.pool.query(`SELECT version FROM settings_version`)).rows[0].version).toBe(0);
    const check = await t.app.inject({ method: 'POST', url: '/console/model-keys/openai/validate', headers: ADMIN, payload: {} });
    expect(check.statusCode).toBe(503);
    expect(check.json()).toEqual({ error: 'secret_unavailable' });
    const list = await t.app.inject({ method: 'GET', url: '/console/model-keys', headers: ADMIN });
    expect(list.json().keys[0]).toEqual({ provider: 'openai', set: false, source: 'unavailable', last4: null });
  });
});

describeDb('/console/model-keys with a stored key this server cannot read (QOR-4578)', () => {
  // A row written under another BWAT_ENC_KEY (the key rotated, or the row moved).
  const t = useRoles({ secrets: (pool) => localSecretStore(pool, randomBytes(32)) });

  it('answers a validate 503 secret_unavailable, and still lists the key as set', async () => {
    await localSecretStore(t.pool, randomBytes(32)).put('provider.openai', KEY);
    const check = await t.app.inject({ method: 'POST', url: '/console/model-keys/openai/validate', headers: ADMIN, payload: {} });
    expect(check.statusCode).toBe(503);
    expect(check.json()).toEqual({ error: 'secret_unavailable' });
    expect(check.body).not.toContain(KEY);
    const list = await t.app.inject({ method: 'GET', url: '/console/model-keys', headers: ADMIN });
    expect(list.json().keys[0]).toEqual({ provider: 'openai', set: true, source: 'store', last4: null });
  });
});

describeDb('/console/model-keys for deepgram (QOR-4632, D167)', () => {
  const DG_ENV = 'dg-from-env-0123456789abcdef012345678-DGE1';
  const DG_KEY = 'dg-stored-0123456789abcdef0123456789-DGK1';
  const lines: string[] = [];
  const t = useRoles({
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    secrets: () => withEnvFallback(awsSecretStore(new FakeSecretsManager(), 'bwat/test/'), MODEL_KEY_ENV, { DEEPGRAM_API_KEY: DG_ENV }),
  });
  const status = async () => {
    const res = await t.app.inject({ method: 'GET', url: '/console/model-keys', headers: ADMIN });
    expect(res.body).not.toContain(DG_ENV);
    expect(res.body).not.toContain(DG_KEY);
    return res.json().keys.find((k: { provider: string }) => k.provider === 'deepgram');
  };

  it('shows DEEPGRAM_API_KEY as set from the env, then a stored key over it, by its last four only', async () => {
    expect(await status()).toEqual({ provider: 'deepgram', set: true, source: 'env', last4: 'DGE1' });
    const saved = await t.app.inject({ method: 'PUT', url: '/console/model-keys/deepgram', headers: ADMIN, payload: { key: DG_KEY } });
    expect(saved.json()).toEqual({ provider: 'deepgram', set: true, source: 'store', last4: 'DGK1' });
    expect(await status()).toEqual({ provider: 'deepgram', set: true, source: 'store', last4: 'DGK1' });
    await t.app.inject({ method: 'DELETE', url: '/console/model-keys/deepgram', headers: ADMIN, payload: {} });
    expect(await status()).toEqual({ provider: 'deepgram', set: true, source: 'env', last4: 'DGE1' });
  });

  it('never logs the deepgram key', () => {
    for (const secret of [DG_ENV, DG_KEY]) expect(lines.join('')).not.toContain(secret);
  });
});

describe('checkKey for deepgram (QOR-4632)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks Deepgram its key-check endpoint, which needs no project scope, with its Token scheme (QOR-4632 review)', async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.authorization });
      return new Response(null, { status: 401 });
    });
    expect(await keyChecker('https://openrouter.ai/api/v1')('deepgram', 'dg-key')).toBe('invalid');
    expect(seen).toEqual([{ url: 'https://api.deepgram.com/v1/auth/token', auth: 'Token dg-key' }]);
  });
});

describe('checkKey for the custom endpoint (QOR-4910)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the models at the card writer's address with the key as a bearer", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.authorization });
      return new Response(null, { status: 200 });
    });
    expect(await keyChecker('https://models.example.com/v1')('custom', 'cu-key')).toBe('valid');
    expect(seen).toEqual([{ url: 'https://models.example.com/v1/models', auth: 'Bearer cu-key' }]);
  });

  it('sends the key nowhere when the address is plain http, as GET /cards/settings does', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return new Response(null, { status: 200 });
    });
    expect(await keyChecker('http://cards-stub:8080/v1')('custom', 'cu-key')).toBe('unreachable');
    expect(seen).toEqual([]);
  });
});
