import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dbTls } from '../../src/config.ts';
import { start } from '../../src/server.ts';
import { describeDb, superuserUrl, useTestDb } from './harness.ts';
import { envWithoutDb, runNpmScript } from '../npm-script.ts';

// QOR-4642: BWAT_DB_SSLROOTCERT turns on TLS for every backend database connection,
// verified against that CA (verify-full); unset, there is none (compose and these tests).
// The test server speaks no TLS, so a connection that asks for it is refused with pg's
// own message: that proves each entry point asks.

const dir = mkdtempSync(join(tmpdir(), 'bwat-tls-'));
const ca = join(dir, 'ca.pem');
writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----\n');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NO_TLS = 'The server does not support SSL connections';

describe('dbTls (QOR-4642)', () => {
  it('is no TLS without BWAT_DB_SSLROOTCERT, and verify-full against the file it names', () => {
    expect(dbTls({})).toBeUndefined();
    expect(dbTls({ BWAT_DB_SSLROOTCERT: ca })).toEqual({ ca: '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----\n', rejectUnauthorized: true });
    expect(() => dbTls({ BWAT_DB_SSLROOTCERT: join(dir, 'missing.pem') })).toThrow('BWAT_DB_SSLROOTCERT cannot be read');
  });
});

describeDb('BWAT_DB_SSLROOTCERT on every entry point (QOR-4642)', () => {
  const db = useTestDb();

  it('the server', async () => {
    await expect(start({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', BWAT_DB_SSLROOTCERT: ca })).rejects.toThrow(NO_TLS);
  });

  // QOR-4749: cards-credential opened its pool without TLS, and RDS refused it.
  it.each(['retention', 'fleet-credential', 'cards-credential'])('a runtime script (%s)', async (name) => {
    const run = await runNpmScript(name, { ...envWithoutDb(), BWAT_DB_URL: db.url('runtime'), BWAT_DB_SSLROOTCERT: ca });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(NO_TLS);
  }, 30_000);

  it('migrate', async () => {
    const run = await runNpmScript('migrate', { ...process.env, BWAT_OWNER_DB_URL: db.url('owner'), BWAT_DB_SSLROOTCERT: ca });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(NO_TLS);
  }, 30_000);

  it('db-bootstrap', async () => {
    const run = await runNpmScript('db-bootstrap', {
      ...process.env,
      BWAT_DB_ADMIN_URL: superuserUrl('postgres'),
      BWAT_OWNER_PASSWORD: 'a1',
      BWAT_RUNTIME_PASSWORD: 'b2',
      BWAT_CARDS_PASSWORD: 'c3',
      BWAT_DB_SSLROOTCERT: ca,
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(NO_TLS);
  }, 30_000);
});
