import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { FakeSecretsManager, serveOverHttp } from './fake-secrets-manager.ts';
import { envWithoutDb, runNpmScript } from './npm-script.ts';

const CLIENT_IDS = 'web-client.apps.googleusercontent.com,desktop-client.apps.googleusercontent.com';

/**
 * B3: every tier-1 name the backend reads (backend/README.md, Secrets) goes through one startup resolver,
 * NAME_FILE > NAME > the aws store, before anything checks it: the server, migrate,
 * seed-secrets and fleet-credential.
 */
describeDb('startup secrets resolved before anything checks them (B3)', () => {
  const db = useTestDb();
  const lines: string[] = [];
  const logger = { level: 'info', stream: { write: (line: string) => void lines.push(line) } };
  const production = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'production', BWAT_FEED_KEY: '0'.repeat(64), ...extra });

  it('starts in production with BWAT_GOOGLE_CLIENT_IDS_FILE and BWAT_ALLOWED_DOMAINS_FILE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwat-tier1-'));
    writeFileSync(join(dir, 'ids'), `${CLIENT_IDS}\n`);
    writeFileSync(join(dir, 'domains'), 'example.test\n');
    lines.length = 0;
    const app = await start(production({ BWAT_GOOGLE_CLIENT_IDS_FILE: join(dir, 'ids'), BWAT_ALLOWED_DOMAINS_FILE: join(dir, 'domains') }), { logger });
    await app.close();
    expect(lines.join('')).not.toContain('auth.allowed_domains_unset');
  });

  it('starts in production with the Google ids and domains from aws, <prefix><NAME>', async () => {
    const fake = new FakeSecretsManager();
    fake.secrets.set('bwat/test/BWAT_GOOGLE_CLIENT_IDS', { value: CLIENT_IDS, scheduled: false });
    fake.secrets.set('bwat/test/BWAT_ALLOWED_DOMAINS', { value: 'example.test', scheduled: false });
    const app = await start(production({ BWAT_SECRET_STORE: 'aws', BWAT_SECRET_PREFIX: 'bwat/test/' }), { logger, awsClient: fake });
    await app.close();
  });

  it('still refuses to start in production when neither resolves from anywhere', async () => {
    await expect(start(production({ BWAT_SECRET_STORE: 'aws', BWAT_SECRET_PREFIX: 'bwat/test/' }), { logger, awsClient: new FakeSecretsManager() })).rejects.toThrow(
      /^BWAT_ALLOWED_DOMAINS is required when NODE_ENV=production$/,
    );
  });

  it('never asks aws for BWAT_ENC_KEY, which keys the local store only', async () => {
    const fake = new FakeSecretsManager();
    fake.secrets.set('bwat/test/BWAT_GOOGLE_CLIENT_IDS', { value: CLIENT_IDS, scheduled: false });
    fake.secrets.set('bwat/test/BWAT_ALLOWED_DOMAINS', { value: 'example.test', scheduled: false });
    const asked: string[] = [];
    const client = {
      send: (command: object) => {
        asked.push(String((command as { input: { SecretId?: string } }).input.SecretId));
        return fake.send(command);
      },
    };
    const app = await start(production({ BWAT_SECRET_STORE: 'aws', BWAT_SECRET_PREFIX: 'bwat/test/' }), { logger, awsClient: client });
    await app.close();
    expect(asked).toContain('bwat/test/BWAT_ALLOWED_DOMAINS');
    expect(asked).not.toContain('bwat/test/BWAT_ENC_KEY');
  });

  describeDb('the scripts, against Secrets Manager over HTTP', () => {
    const fake = new FakeSecretsManager();
    let aws: Awaited<ReturnType<typeof serveOverHttp>>;
    beforeAll(async () => {
      aws = await serveOverHttp(fake);
    });
    afterAll(() => aws.close());
    const awsEnv = () => {
      const env: NodeJS.ProcessEnv = { ...envWithoutDb(), ...aws.env, BWAT_SECRET_STORE: 'aws', BWAT_SECRET_PREFIX: 'bwat/test/' };
      delete env.BWAT_OWNER_DB_URL;
      delete env.AWS_PROFILE;
      return env;
    };

    it('npm run migrate reads BWAT_OWNER_DB_URL from aws', async () => {
      fake.secrets.set('bwat/test/BWAT_OWNER_DB_URL', { value: db.url('owner'), scheduled: false });
      const run = await runNpmScript('migrate', awsEnv());
      expect(run.stderr).not.toContain('failed');
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('nothing to apply');
    }, 30_000);

    it('npm run fleet-credential and npm run seed-secrets read BWAT_DB_URL from aws', async () => {
      fake.secrets.set('bwat/test/BWAT_DB_URL', { value: db.url('runtime'), scheduled: false });
      const fleet = await runNpmScript('fleet-credential', awsEnv());
      expect(fleet.stderr).not.toContain('failed');
      expect(fleet.stdout).toMatch(/bwf_[A-Za-z0-9_-]{43}/);
      const dir = mkdtempSync(join(tmpdir(), 'bwat-tier1-'));
      writeFileSync(join(dir, 'seed.json'), JSON.stringify({ 'zoom.s2s_account_id': 'seeded-account-id' }), { mode: 0o600 });
      const seed = await runNpmScript('seed-secrets', awsEnv(), [join(dir, 'seed.json')]);
      expect(seed.stderr).not.toContain('failed');
      expect(seed.stdout).toContain('seeded 1 secret: zoom.s2s_account_id');
      expect(fake.secrets.get('bwat/test/zoom.s2s_account_id')?.value).toBe('seeded-account-id');
    }, 60_000);

    it('a script in aws mode without BWAT_SECRET_PREFIX refuses to run', async () => {
      const env = awsEnv();
      delete env.BWAT_SECRET_PREFIX;
      const run = await runNpmScript('migrate', env);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('migrate failed: BWAT_SECRET_PREFIX must be set when BWAT_SECRET_STORE=aws');
    }, 30_000);
  });
});
