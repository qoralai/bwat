/**
 * `npm run install-credential [-- --label <name>]`: issues the onboarding page's
 * credential (QOR-4334), the bearer token setup/onboard reads GET /install/status with. It
 * expires in 30 days. Logs in as the runtime role (BWAT_DB_URL_FILE > BWAT_DB_URL > aws
 * `<prefix>BWAT_DB_URL`). Prints the token once; only its sha256 is stored. Never prints the URL.
 */
import { parseArgs } from 'node:util';
import { STARTUP_NAMES, startupEnv } from '../src/config.ts';
import { issueInstallCredential } from '../src/credentials.ts';
import { runtimePool } from '../src/db/pool.ts';

try {
  const { values } = parseArgs({ options: { label: { type: 'string' } } });
  const pool = runtimePool(await startupEnv(process.env, STARTUP_NAMES.runtimeScript), { max: 1 });
  try {
    const token = await issueInstallCredential(pool, values.label ?? null);
    console.log('onboarding page credential (shown once; kept in .bwat/onboard/state.json):');
    console.log(token);
  } finally {
    await pool.end();
  }
} catch (err) {
  console.error(`install-credential failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
