import { describe, expect, it } from 'vitest';
import { digest } from '../src/credentials.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { envWithoutDb, runNpmScript } from './npm-script.ts';

describe('npm run fleet-credential without a database (QOR-4571)', () => {
  it('fails, naming the missing variable', async () => {
    const run = await runNpmScript('fleet-credential', envWithoutDb());
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('fleet-credential failed: BWAT_DB_URL is not set');
  }, 30_000);
});

describeDb('npm run fleet-credential (QOR-4571)', () => {
  const db = useTestDb();

  it('issues a fleet credential as the runtime role, prints it once, and stores only its digest', async () => {
    const run = await runNpmScript('fleet-credential', { ...envWithoutDb(), BWAT_DB_URL: db.url('runtime') }, ['--label', 'fleet-a']);
    expect(run.code).toBe(0);
    const tokens = run.stdout.match(/bwf_[A-Za-z0-9_-]{43}/g) ?? [];
    expect(tokens).toHaveLength(1);

    const owner = await db.connect('owner');
    try {
      const { rows } = await owner.query(`SELECT label, token_sha256 FROM bwat.fleet_credentials`);
      expect(rows).toEqual([{ label: 'fleet-a', token_sha256: digest(tokens[0]!) }]);
    } finally {
      await owner.end();
    }
    const password = decodeURIComponent(new URL(db.url('runtime')).password);
    expect(run.stdout + run.stderr).not.toContain(password);
  }, 30_000);
});
