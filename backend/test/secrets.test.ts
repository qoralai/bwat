import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.ts';
import {
  awsSecretStore,
  localSecretStore,
  secretStoreFromEnv,
  withEnvFallback,
  TIER2_NAMES,
  type SecretStore,
} from '../src/secrets/store.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { FakeSecretsManager } from './fake-secrets-manager.ts';

const KEY = randomBytes(32);
const VALUE = 'sk-test-0123456789abcdefWXYZ';

/** The behaviour every SecretStore implementation must have. */
function secretStoreContract(name: string, make: () => SecretStore, outer: typeof describe = describe) {
  outer(`SecretStore contract: ${name} (QOR-4578)`, () => {
    let store: SecretStore;
    beforeAll(() => {
      store = make();
    });

    it('reads null and shows not set for a secret never stored', async () => {
      expect(await store.get('zoom.client_id')).toBeNull();
      expect(await store.status('zoom.client_id')).toEqual({ set: false, source: null, last4: null });
    });

    it('stores, reads back and overwrites a value', async () => {
      await store.put('provider.openai', VALUE);
      expect(await store.get('provider.openai')).toBe(VALUE);
      await store.put('provider.openai', `${VALUE}-2`);
      expect(await store.get('provider.openai')).toBe(`${VALUE}-2`);
    });

    it('shows only set, the source and the last 4 characters', async () => {
      await store.put('provider.anthropic', VALUE);
      expect(await store.status('provider.anthropic')).toEqual({ set: true, source: 'store', last4: 'WXYZ' });
    });

    it('never shows any of a value too short to hide', async () => {
      await store.put('zoom.client_id', 'abcdefgh');
      expect(await store.status('zoom.client_id')).toEqual({ set: true, source: 'store', last4: null });
    });

    it('deletes: true once, then false, and the name can be stored again', async () => {
      await store.put('provider.cerebras', VALUE);
      expect(await store.delete('provider.cerebras')).toBe(true);
      expect(await store.get('provider.cerebras')).toBeNull();
      expect(await store.delete('provider.cerebras')).toBe(false);
      await store.put('provider.cerebras', 'sk-again-0123456789');
      expect(await store.get('provider.cerebras')).toBe('sk-again-0123456789');
    });

    // QOR-4977: the names it keeps are core's and the switched-in plugins' own.
    it("keeps a plugin's secret it was given, and no name it was not", async () => {
      await store.put('probe.key', VALUE);
      expect(await store.get('probe.key')).toBe(VALUE);
      expect(store.keeps('probe.key')).toBe(true);
      expect(store.keeps('provider.openai')).toBe(true);
      expect(store.keeps('other.key')).toBe(false);
      await expect(store.put('other.key', VALUE)).rejects.toThrow('secret store: unknown secret name');
    });

    it('refuses a bad name or an empty value without echoing either', async () => {
      await expect(store.put('../etc', VALUE)).rejects.toThrow('secret store: unknown secret name');
      await expect(store.put('provider.openrouter', '')).rejects.toThrow('secret store: empty value');
      await expect(store.get('Model Key')).rejects.toThrow('secret store: unknown secret name');
    });
  });
}

describeDb('the local secret store (QOR-4578)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool(db.url('runtime'));
  });
  afterAll(() => pool.end());

  secretStoreContract('local', () => localSecretStore(pool, KEY, { pluginNames: ['probe.key'] }), describe);

  it('shows a key as unavailable, not as set, when the database cannot be asked', async () => {
    const gone = createPool(db.url('runtime'));
    await gone.end();
    const store = localSecretStore(gone, KEY);
    expect(await store.status('provider.openai')).toEqual({ set: false, source: 'unavailable', last4: null });
    await expect(store.get('provider.openai')).rejects.toMatchObject({ code: 'secret_unavailable' });
  });

  it('stores only a pk1: envelope, never the plaintext', async () => {
    await localSecretStore(pool, KEY).put('zoom.client_id', VALUE);
    const { rows } = await pool.query(`SELECT ciphertext FROM secrets WHERE name = 'zoom.client_id'`);
    expect(rows[0].ciphertext).toMatch(/^pk1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(rows[0].ciphertext).not.toContain(VALUE);
  });

  it('cannot read a value under another key, or one moved to another name', async () => {
    await localSecretStore(pool, KEY).put('zoom.client_secret', VALUE);
    await expect(localSecretStore(pool, randomBytes(32)).get('zoom.client_secret')).rejects.toThrow('secret store: unreadable');
    await pool.query(`INSERT INTO secrets (name, ciphertext) SELECT 'zoom.webhook_secret', ciphertext FROM secrets WHERE name = 'zoom.client_secret'`);
    await expect(localSecretStore(pool, KEY).get('zoom.webhook_secret')).rejects.toThrow('secret store: unreadable');
    expect(await localSecretStore(pool, KEY).status('zoom.webhook_secret')).toEqual({ set: true, source: 'store', last4: null });
  });
});

secretStoreContract('aws (fake Secrets Manager)', () => awsSecretStore(new FakeSecretsManager(), 'bwat/test/', { pluginNames: ['probe.key'] }));

describe('the aws secret store (QOR-4578)', () => {
  it('names each secret under BWAT_SECRET_PREFIX, creating it on first put', async () => {
    const fake = new FakeSecretsManager();
    const store = awsSecretStore(fake, 'bwat/dev/');
    await store.put('provider.openai', VALUE);
    await store.put('provider.openai', VALUE);
    expect([...fake.secrets.keys()]).toEqual(['bwat/dev/provider.openai']);
    expect(fake.calls).toEqual(['PutSecretValueCommand', 'CreateSecretCommand', 'PutSecretValueCommand']);
  });
});

describe('the aws secret store and a deletion still in progress (QOR-4578)', () => {
  // Secrets Manager deletes asynchronously, even with ForceDeleteWithoutRecovery: for a
  // while the name answers InvalidRequestException to a read, a write and a create.
  const quick = { retryDelaysMs: [0, 0, 0] };

  it('reads a name still being deleted as not set', async () => {
    const fake = new FakeSecretsManager({ pendingCalls: 2 });
    const store = awsSecretStore(fake, 'p/', quick);
    await store.put('provider.openai', VALUE);
    expect(await store.delete('provider.openai')).toBe(true);
    expect(await store.status('provider.openai')).toEqual({ set: false, source: null, last4: null });
    expect(await store.delete('provider.openai')).toBe(false);
  });

  it('re-adds a removed name once its deletion completes, retrying the write', async () => {
    const fake = new FakeSecretsManager({ pendingCalls: 3 });
    const store = awsSecretStore(fake, 'p/', quick);
    await store.put('provider.openai', VALUE);
    await store.delete('provider.openai');
    fake.calls.length = 0;
    await store.put('provider.openai', 'sk-again-0123456789');
    expect(await store.get('provider.openai')).toBe('sk-again-0123456789');
    // Three attempts meet the deletion, the fourth finds the name gone and creates it.
    expect(fake.calls.slice(0, 5)).toEqual([
      'PutSecretValueCommand',
      'PutSecretValueCommand',
      'PutSecretValueCommand',
      'PutSecretValueCommand',
      'CreateSecretCommand',
    ]);
  });

  it('gives up with secret_unavailable when the deletion outlasts the retries', async () => {
    const fake = new FakeSecretsManager({ pendingCalls: 50 });
    const store = awsSecretStore(fake, 'p/', quick);
    await store.put('provider.openai', VALUE);
    await store.delete('provider.openai');
    await expect(store.put('provider.openai', VALUE)).rejects.toMatchObject({ code: 'secret_unavailable' });
  });
});

describe('the aws secret store when Secrets Manager cannot be reached (QOR-4578)', () => {
  const broken = () => {
    const fake = new FakeSecretsManager();
    fake.failWith = 'AccessDeniedException';
    return awsSecretStore(fake, 'p/', { retryDelaysMs: [0] });
  };

  it('shows the key as unavailable, not as set, and refuses writes as unreachable', async () => {
    const store = broken();
    expect(await store.status('provider.openai')).toEqual({ set: false, source: 'unavailable', last4: null });
    await expect(store.get('provider.openai')).rejects.toMatchObject({ code: 'secret_unavailable' });
    await expect(store.put('provider.openai', VALUE)).rejects.toMatchObject({ code: 'secret_unavailable' });
    await expect(store.delete('provider.openai')).rejects.toMatchObject({ code: 'secret_unavailable' });
  });

  it('never falls back to the env behind withEnvFallback: reads refuse and status says unavailable (B2)', async () => {
    const store = withEnvFallback(broken(), { 'provider.openai': 'OPENAI_API_KEY' }, { OPENAI_API_KEY: 'sk-from-env-0123456789-ENV1' });
    await expect(store.get('provider.openai')).rejects.toMatchObject({ code: 'secret_unavailable' });
    expect(await store.status('provider.openai')).toEqual({ set: false, source: 'unavailable', last4: null });
    const none = withEnvFallback(broken(), { 'provider.openai': 'OPENAI_API_KEY' }, {});
    expect(await none.status('provider.openai')).toEqual({ set: false, source: 'unavailable', last4: null });
    await expect(none.get('provider.openai')).rejects.toMatchObject({ code: 'secret_unavailable' });
  });
});

describe('withEnvFallback (QOR-4578)', () => {
  const env = { OPENAI_API_KEY: 'sk-from-env-0123456789-ENV1' };
  const make = () => withEnvFallback(awsSecretStore(new FakeSecretsManager(), 'p/', { pluginNames: ['probe.key'] }), { 'provider.openai': 'OPENAI_API_KEY' }, env);

  it('falls back to the env while nothing is stored, and says so', async () => {
    const store = make();
    expect(await store.get('provider.openai')).toBe(env.OPENAI_API_KEY);
    expect(await store.status('provider.openai')).toEqual({ set: true, source: 'env', last4: 'ENV1' });
  });

  it('lets a stored value override the env, and falls back again once it is deleted', async () => {
    const store = make();
    await store.put('provider.openai', VALUE);
    expect(await store.get('provider.openai')).toBe(VALUE);
    expect((await store.status('provider.openai')).source).toBe('store');
    expect(await store.delete('provider.openai')).toBe(true);
    expect(await store.get('provider.openai')).toBe(env.OPENAI_API_KEY);
  });

  it('reads the *_FILE form too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwat-secret-'));
    writeFileSync(join(dir, 'k'), 'sk-from-file-0123456789-FIL1\n');
    const store = withEnvFallback(awsSecretStore(new FakeSecretsManager(), 'p/'), { 'provider.openai': 'OPENAI_API_KEY' }, {
      OPENAI_API_KEY_FILE: join(dir, 'k'),
    });
    expect(await store.get('provider.openai')).toBe('sk-from-file-0123456789-FIL1');
  });
});

describe('secretStoreFromEnv (QOR-4578)', () => {
  const pool = {} as pg.Pool;

  it('without BWAT_ENC_KEY gives a store that is unavailable for writes, so the server still starts', async () => {
    const store = secretStoreFromEnv({}, pool);
    expect(await store.get('provider.openai')).toBeNull();
    expect(await store.status('provider.openai')).toEqual({ set: false, source: null, last4: null });
    await expect(store.put('provider.openai', VALUE)).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('refuses a BWAT_ENC_KEY that is not 32 bytes, an unknown store and aws without a prefix', () => {
    expect(() => secretStoreFromEnv({ BWAT_ENC_KEY: 'short' }, pool)).toThrow('BWAT_ENC_KEY must be 32 bytes, as 64 hex characters or base64');
    expect(() => secretStoreFromEnv({ BWAT_SECRET_STORE: 'vault' }, pool)).toThrow('BWAT_SECRET_STORE must be local or aws');
    expect(() => secretStoreFromEnv({ BWAT_SECRET_STORE: 'aws' }, pool)).toThrow('BWAT_SECRET_PREFIX must be set');
  });

  it('accepts the key as hex or base64, and aws with a prefix and an injected client', () => {
    expect(() => secretStoreFromEnv({ BWAT_ENC_KEY: KEY.toString('hex') }, pool)).not.toThrow();
    expect(() => secretStoreFromEnv({ BWAT_ENC_KEY: KEY.toString('base64') }, pool)).not.toThrow();
    expect(() => secretStoreFromEnv({ BWAT_SECRET_STORE: 'aws', BWAT_SECRET_PREFIX: 'bwat/dev/' }, pool, { awsClient: new FakeSecretsManager() })).not.toThrow();
  });
});

describe('the tier-2 secret names (QOR-4578)', () => {
  it('are exactly the names the backend README lists', () => {
    expect([...TIER2_NAMES]).toEqual([
      'provider.openrouter',
      'provider.anthropic',
      'provider.openai',
      'provider.cerebras',
      'provider.deepgram',
      'provider.custom',
      'zoom.client_id',
      'zoom.client_secret',
      'zoom.webhook_secret',
      'zoom.board_client_secret',
      'zoom.s2s_account_id',
      'zoom.s2s_client_id',
      'zoom.s2s_client_secret',
    ]);
  });

  it('are the only names the store accepts: a startup secret or any other name is refused, without echoing the value', async () => {
    const fake = new FakeSecretsManager();
    const store = awsSecretStore(fake, 'p/');
    for (const name of ['BWAT_ENC_KEY', 'bwat_enc_key', 'BWAT_DB_URL', 'bwat_owner_db_url', 'BWAT_SESSION_SECRET', 'model-key/openai', 'provider.gemini', 'zoom.webhook_secret ']) {
      for (const call of [() => store.put(name, VALUE), () => store.get(name), () => store.status(name), () => store.delete(name)]) {
        const err = await call().catch((e: Error) => e);
        expect((err as Error).message, name).toBe('secret store: unknown secret name');
      }
    }
    expect(fake.calls).toEqual([]);
    for (const name of TIER2_NAMES) await store.put(name, VALUE);
    expect([...fake.secrets.keys()]).toEqual(TIER2_NAMES.map((name) => `p/${name}`));
  });
});
