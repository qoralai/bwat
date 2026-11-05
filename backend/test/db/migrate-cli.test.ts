import { describe, expect, it } from 'vitest';
import { runNpmScript } from '../npm-script.ts';
import { describeDb, useTestDb } from './harness.ts';

const npmRunMigrate = (env: NodeJS.ProcessEnv) => runNpmScript('migrate', env);

const baseEnv = () => {
  const env = { ...process.env };
  delete env.BWAT_OWNER_DB_URL;
  return env;
};

describe('npm run migrate without a database (QOR-4568)', () => {
  it('fails, naming the missing variable', async () => {
    const run = await npmRunMigrate(baseEnv());
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('migrate failed: BWAT_OWNER_DB_URL is not set');
  }, 30_000);
});

describeDb('npm run migrate (QOR-4568)', () => {
  const db = useTestDb({ migrate: false });

  it('applies the migrations as the owner role from BWAT_OWNER_DB_URL, then has nothing to apply', async () => {
    const env = { ...baseEnv(), BWAT_OWNER_DB_URL: db.url('owner') };
    const first = await npmRunMigrate(env);
    expect(first.stdout).toContain('applied: 0001_app_schema.sql');
    expect(first.code).toBe(0);

    const second = await npmRunMigrate(env);
    expect(second.stdout).toContain('nothing to apply');
    expect(second.code).toBe(0);
    const password = decodeURIComponent(new URL(db.url('owner')).password);
    expect(first.stdout + first.stderr + second.stdout + second.stderr).not.toContain(password);
  }, 30_000);
});
