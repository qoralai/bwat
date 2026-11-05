import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.ts';
import { seedSecrets } from '../src/secrets/seed.ts';
import { awsSecretStore, localSecretStore, SecretUnavailable } from '../src/secrets/store.ts';
import { asSuperuser, describeDb, useTestDb } from './db/harness.ts';
import { FakeSecretsManager } from './fake-secrets-manager.ts';
import { holdSettingsLock } from './locks.ts';

const VALUE = 'sk-seeded-0123456789-abcdefgh-SEED';
const dir = mkdtempSync(join(tmpdir(), 'bwat-seed-'));
const file = (name: string, body: unknown) => {
  const path = join(dir, name);
  // 0600, as the setup script writes it: the import refuses one others can read (POSIX).
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 });
  return path;
};

describeDb('seedSecrets (QOR-4578)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool(db.url('runtime'));
  });
  afterAll(() => pool.end());
  const version = async () => (await pool.query(`SELECT version FROM settings_version`)).rows[0].version;

  it('imports every model key in the file, then deletes the file, bumps the version once and audits as system', async () => {
    const store = awsSecretStore(new FakeSecretsManager(), 'p/');
    const path = file('ok.json', { 'provider.openai': VALUE, 'provider.cerebras': `${VALUE}2` });
    expect(await seedSecrets(pool, store, path)).toEqual({ stored: ['provider.openai', 'provider.cerebras'], matched: [], kept: [] });
    expect(existsSync(path)).toBe(false);
    expect(await store.get('provider.cerebras')).toBe(`${VALUE}2`);
    expect(await version()).toBe(1);
    const { rows } = await pool.query(`SELECT actor_id AS actor, action, target_type AS target, after FROM audit`);
    expect(rows).toEqual([{ actor: null, action: 'secrets.seeded', target: 'secrets', after: { names: ['provider.openai', 'provider.cerebras'] } }]);
    expect(JSON.stringify(rows)).not.toContain(VALUE);
  });

  it('imports any tier-2 secret name, the zoom ones included', async () => {
    const store = awsSecretStore(new FakeSecretsManager(), 'p/');
    const path = file('tier2.json', { 'zoom.webhook_secret': VALUE, 'zoom.s2s_client_secret': `${VALUE}3` });
    expect(await seedSecrets(pool, store, path)).toEqual({ stored: ['zoom.webhook_secret', 'zoom.s2s_client_secret'], matched: [], kept: [] });
    expect(await store.get('zoom.webhook_secret')).toBe(VALUE);
  });

  it('keeps a value already stored unless forced: the rest are stored, and the file is deleted either way', async () => {
    const store = awsSecretStore(new FakeSecretsManager(), 'p/');
    await store.put('provider.anthropic', 'sk-already-0123456789-abcdef-KEEP');
    const before = await version();
    const path = file('kept.json', { 'provider.anthropic': VALUE, 'provider.openrouter': VALUE });
    expect(await seedSecrets(pool, store, path)).toEqual({ stored: ['provider.openrouter'], matched: [], kept: ['provider.anthropic'] });
    expect(await store.get('provider.anthropic')).toBe('sk-already-0123456789-abcdef-KEEP');
    expect(existsSync(path)).toBe(false);
    expect(await version()).toBe(before + 1);

    const forced = file('forced.json', { 'provider.anthropic': VALUE });
    expect(await seedSecrets(pool, store, forced, { force: true })).toEqual({ stored: ['provider.anthropic'], matched: [], kept: [] });
    expect(await store.get('provider.anthropic')).toBe(VALUE);

    const nothingNew = file('again.json', { 'provider.anthropic': `${VALUE}-again` });
    const at = await version();
    expect(await seedSecrets(pool, store, nothingNew)).toEqual({ stored: [], matched: [], kept: ['provider.anthropic'] });
    expect(await version()).toBe(at);
    expect(existsSync(nothingNew)).toBe(false);
  });

  it('checks what is already stored under the settings lock: a key saved meanwhile is kept without --force', async () => {
    const store = awsSecretStore(new FakeSecretsManager(), 'p/');
    const path = file('race.json', { 'zoom.s2s_account_id': VALUE });
    const held = await holdSettingsLock(pool);
    let seeded;
    try {
      seeded = seedSecrets(pool, store, path);
      await held.waitForBlocked();
      // A console save in flight stores the value, then commits.
      await store.put('zoom.s2s_account_id', 'saved-meanwhile@example.com');
    } finally {
      await held.release();
    }
    expect(await seeded).toEqual({ stored: [], matched: [], kept: ['zoom.s2s_account_id'] });
    expect(await store.get('zoom.s2s_account_id')).toBe('saved-meanwhile@example.com');
  });

  it('refuses, storing nothing, when the store cannot be asked whether a value is stored, and keeps the file', async () => {
    const fake = new FakeSecretsManager();
    // Writes work, but reads do not: unknown is not "not stored".
    const store = {
      ...awsSecretStore(fake, 'p/'),
      get: async () => {
        throw new SecretUnavailable('secret store: aws ThrottlingException reading provider.openai');
      },
    };
    const path = file('unreachable.json', { 'provider.openai': VALUE });
    const err = await seedSecrets(pool, store, path).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'secret_unavailable' });
    expect(fake.secrets.size).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('fails, saying so, when the file cannot be deleted after storing', async () => {
    const store = awsSecretStore(new FakeSecretsManager(), 'p/');
    const path = file('stuck.json', { 'zoom.s2s_account_id': VALUE });
    const remove = () => {
      throw new Error('EPERM');
    };
    const err = await seedSecrets(pool, store, path, { remove }).catch((e: Error) => e);
    expect((err as Error).message).toBe('seed-secrets: stored zoom.s2s_account_id, but the file could not be deleted: delete it by hand');
    expect(await store.get('zoom.s2s_account_id')).toBe(VALUE);
  });

  it('stores no key when its audit cannot be written (local store: one transaction), and keeps the file', async () => {
    const store = localSecretStore(pool, randomBytes(32));
    const path = file('audit.json', { 'provider.openai': VALUE });
    const refuse = (sql: string) => asSuperuser((su) => su.query(sql), db.name);
    await refuse(`ALTER TABLE bwat.audit ADD CONSTRAINT test_refuse_seed CHECK (action <> 'secrets.seeded') NOT VALID`);
    try {
      await expect(seedSecrets(pool, store, path)).rejects.toThrow();
    } finally {
      await refuse(`ALTER TABLE bwat.audit DROP CONSTRAINT test_refuse_seed`);
    }
    expect((await pool.query(`SELECT name FROM secrets`)).rows).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('repairs on retry what a run that stored in aws and then failed in the database left out: the version and the audit', async () => {
    const store = awsSecretStore(new FakeSecretsManager(), 'p/');
    const path = file('retry.json', { 'provider.openai': VALUE, 'provider.anthropic': `${VALUE}4` });
    const refuse = (sql: string) => asSuperuser((su) => su.query(sql), db.name);
    const before = await version();
    const audits = async () => (await pool.query(`SELECT after FROM audit WHERE action = 'secrets.seeded' ORDER BY at`)).rows.length;
    const auditsBefore = await audits();
    await refuse(`ALTER TABLE bwat.audit ADD CONSTRAINT test_refuse_seed CHECK (action <> 'secrets.seeded') NOT VALID`);
    try {
      await expect(seedSecrets(pool, store, path)).rejects.toThrow();
    } finally {
      await refuse(`ALTER TABLE bwat.audit DROP CONSTRAINT test_refuse_seed`);
    }
    // aws cannot roll back: the values are there, with no bump and no audit.
    expect(await store.get('provider.openai')).toBe(VALUE);
    expect(await version()).toBe(before);
    expect(existsSync(path)).toBe(true);

    // The ordinary retry: the same values count as present, are named, and are recorded once.
    expect(await seedSecrets(pool, store, path)).toEqual({ stored: [], matched: ['provider.openai', 'provider.anthropic'], kept: [] });
    expect(await version()).toBe(before + 1);
    const { rows } = await pool.query(`SELECT after FROM audit WHERE action = 'secrets.seeded' ORDER BY at DESC LIMIT 1`);
    expect(rows).toEqual([{ after: { names: ['provider.openai', 'provider.anthropic'] } }]);
    expect(await audits()).toBe(auditsBefore + 1);
    expect(existsSync(path)).toBe(false);
  });

  it('keeps a value stored but unreadable (another BWAT_ENC_KEY) unless forced', async () => {
    await localSecretStore(pool, randomBytes(32)).put('zoom.s2s_account_id', 'written-under-another-key');
    const path = file('unreadable.json', { 'zoom.s2s_account_id': VALUE });
    expect(await seedSecrets(pool, localSecretStore(pool, randomBytes(32)), path)).toEqual({ stored: [], matched: [], kept: ['zoom.s2s_account_id'] });
    await pool.query(`DELETE FROM secrets WHERE name = 'zoom.s2s_account_id'`);
  });

  it('refuses a file readable by group or others on POSIX, naming its mode and no value, and stores nothing', async () => {
    const store = awsSecretStore(new FakeSecretsManager(), 'p/');
    const path = file('open.json', { 'zoom.client_secret': VALUE });
    chmodSync(path, 0o644);
    const err = await seedSecrets(pool, store, path, { posix: true }).catch((e: Error) => e);
    // Windows reports 0666 for any writable file; POSIX the 0644 set above.
    expect((err as Error).message).toMatch(/^seed-secrets: the file is readable by group or others \(mode 06[46]{2}\): chmod 600 it$/);
    expect((err as Error).message).not.toContain(VALUE);
    expect(existsSync(path)).toBe(true);
    expect(await store.get('zoom.client_secret')).toBeNull();
    // `-` has no file and no mode.
    expect(await seedSecrets(pool, store, { text: JSON.stringify({ 'zoom.client_secret': VALUE }) }, { posix: true })).toMatchObject({ stored: ['zoom.client_secret'] });
  });

  it.skipIf(process.platform === 'win32')('takes a 0600 file on POSIX', async () => {
    const store = awsSecretStore(new FakeSecretsManager(), 'p/');
    const path = file('closed.json', { 'zoom.client_id': VALUE });
    expect(await seedSecrets(pool, store, path, { posix: true })).toMatchObject({ stored: ['zoom.client_id'] });
  });

  it('refuses a file that is not an object of known names and non-empty strings, stores nothing and keeps the file', async () => {
    const store = awsSecretStore(new FakeSecretsManager(), 'p/');
    for (const [name, body, message] of [
      ['bad.json', '{not json', 'seed-secrets: the file is not JSON'],
      ['array.json', [VALUE], 'seed-secrets: the file must be a JSON object of secret name to value'],
      ['unknown.json', { 'provider.openai': VALUE, bwat_enc_key: VALUE }, 'seed-secrets: not a secret this store keeps: bwat_enc_key'],
      ['startup.json', { BWAT_ENC_KEY: VALUE }, 'seed-secrets: not a secret this store keeps: BWAT_ENC_KEY'],
      ['old-name.json', { 'model-key/openai': VALUE }, 'seed-secrets: not a secret this store keeps: model-key/openai'],
      ['empty.json', { 'provider.openai': '' }, 'seed-secrets: provider.openai has no value'],
    ] as const) {
      const path = file(name, body);
      const err = await seedSecrets(pool, store, path).catch((e: Error) => e);
      expect((err as Error).message).toBe(message);
      expect((err as Error).message).not.toContain(VALUE);
      expect(existsSync(path)).toBe(true);
    }
    expect(await store.get('provider.openai')).toBeNull();
  });
});

describeDb('npm run seed-secrets (QOR-4578)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool(db.url('runtime'));
  });
  afterAll(() => pool.end());

  const key = randomBytes(32).toString('hex');
  const seed = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, '..', 'scripts', 'seed-secrets.ts'), ...args],
      { env: { ...process.env, BWAT_DB_URL: db.url('runtime'), BWAT_ENC_KEY: key, BWAT_SECRET_STORE: 'local' } },
    );

  it('imports into the local store from the env, prints names only, and deletes the file', async () => {
    const path = file('cli.json', { 'provider.anthropic': VALUE });
    const { stdout, stderr } = await seed(path);
    expect(stdout).toContain('seeded 1 secret: provider.anthropic');
    expect(`${stdout}${stderr}`).not.toContain(VALUE);
    expect(existsSync(path)).toBe(false);
    expect(await localSecretStore(pool, Buffer.from(key, 'hex')).get('provider.anthropic')).toBe(VALUE);
  });

  it('keeps an existing value without --force, overwrites it with --force (either order), and prints names only', async () => {
    const again = file('cli-again.json', { 'provider.anthropic': `${VALUE}-new` });
    const kept = await seed(again);
    expect(kept.stdout).toContain('seeded 0 secrets; kept 1 already stored (--force overwrites): provider.anthropic');
    expect(await localSecretStore(pool, Buffer.from(key, 'hex')).get('provider.anthropic')).toBe(VALUE);
    const forced = file('cli-force.json', { 'provider.anthropic': `${VALUE}-new` });
    const out = await seed('--force', forced);
    expect(out.stdout).toContain('seeded 1 secret: provider.anthropic');
    expect(`${kept.stdout}${kept.stderr}${out.stdout}${out.stderr}`).not.toContain(VALUE);
    expect(await localSecretStore(pool, Buffer.from(key, 'hex')).get('provider.anthropic')).toBe(`${VALUE}-new`);
    expect(existsSync(forced)).toBe(false);
  });

  it('exits non-zero, naming no value, for a refused file or an unknown flag, and keeps the file', async () => {
    const bad = file('cli-bad.json', { BWAT_ENC_KEY: VALUE });
    const err = await seed(bad).catch((e: { code: number; stdout: string; stderr: string }) => e);
    expect(err).toMatchObject({ code: 1 });
    expect((err as { stderr: string }).stderr).toContain('seed-secrets failed: seed-secrets: not a secret this store keeps: BWAT_ENC_KEY');
    expect(JSON.stringify(err)).not.toContain(VALUE);
    expect(existsSync(bad)).toBe(true);
    await expect(seed('--overwrite', bad)).rejects.toMatchObject({ code: 1 });
  });

  // `-`: the installer pipes the JSON in and never writes it to disk, so there is no file to delete.
  const seedStdin = (body: string, ...args: string[]) => {
    const run = seed(...args);
    run.child.stdin!.end(body);
    return run;
  };
  const stored = async (name: string) => localSecretStore(pool, Buffer.from(key, 'hex')).get(name);

  it('imports JSON piped to `-`, prints names only, and names no file', async () => {
    const { stdout, stderr } = await seedStdin(JSON.stringify({ 'zoom.s2s_client_secret': VALUE }), '-');
    expect(stdout).toContain('seeded 1 secret: zoom.s2s_client_secret');
    expect(stdout).not.toContain('file');
    expect(`${stdout}${stderr}`).not.toContain(VALUE);
    expect(await stored('zoom.s2s_client_secret')).toBe(VALUE);
  });

  it('names a value already stored with the same value as matched, and records it (B1 seed retry)', async () => {
    const again = await seedStdin(JSON.stringify({ 'zoom.s2s_client_secret': VALUE }), '-');
    expect(again.stdout).toContain('seeded 0 secrets; matched 1 already stored with this value: zoom.s2s_client_secret');
    expect(`${again.stdout}${again.stderr}`).not.toContain(VALUE);
  });

  it('keeps a value already stored from `-` unless --force', async () => {
    const kept = await seedStdin(JSON.stringify({ 'zoom.s2s_client_secret': `${VALUE}-new` }), '-');
    expect(kept.stdout).toContain('seeded 0 secrets; kept 1 already stored (--force overwrites): zoom.s2s_client_secret');
    expect(await stored('zoom.s2s_client_secret')).toBe(VALUE);
    const forced = await seedStdin(JSON.stringify({ 'zoom.s2s_client_secret': `${VALUE}-new` }), '-', '--force');
    expect(forced.stdout).toContain('seeded 1 secret: zoom.s2s_client_secret');
    expect(`${kept.stdout}${kept.stderr}${forced.stdout}${forced.stderr}`).not.toContain(VALUE);
    expect(await stored('zoom.s2s_client_secret')).toBe(`${VALUE}-new`);
  });

  it('exits non-zero for bad JSON or a refused name on `-`, stores nothing, and echoes no value', async () => {
    for (const [body, message] of [
      [`{"zoom.client_secret": "${VALUE}"`, 'seed-secrets: the input is not JSON'],
      [JSON.stringify({ 'zoom.client_secret': VALUE, BWAT_ENC_KEY: VALUE }), 'seed-secrets: not a secret this store keeps: BWAT_ENC_KEY'],
    ]) {
      const err = await seedStdin(body!, '-').catch((e: { code: number; stdout: string; stderr: string }) => e);
      expect(err).toMatchObject({ code: 1 });
      expect((err as { stderr: string }).stderr).toContain(`seed-secrets failed: ${message}`);
      expect(JSON.stringify(err)).not.toContain(VALUE);
    }
    expect(await stored('zoom.client_secret')).toBeNull();
  });
});
