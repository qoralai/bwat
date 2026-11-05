/**
 * `npm run fleet-credential [-- --label <name>]`: issues a fleet credential, the bearer
 * token a bot presents to POST /bots/register. Logs in as the runtime role
 * (BWAT_DB_URL_FILE > BWAT_DB_URL > aws `<prefix>BWAT_DB_URL`). Prints the token once; only its sha256 is stored, so it cannot be
 * shown again. Never prints the URL.
 */
import { parseArgs } from 'node:util';
import { STARTUP_NAMES, startupEnv } from '../src/config.ts';
import { issueFleetCredential } from '../src/credentials.ts';
import { runtimePool } from '../src/db/pool.ts';

try {
  const { values } = parseArgs({ options: { label: { type: 'string' } } });
  const pool = runtimePool(await startupEnv(process.env, STARTUP_NAMES.runtimeScript), { max: 1 });
  try {
    const token = await issueFleetCredential(pool, values.label ?? null);
    console.log('fleet credential (shown once; store it as the bot fleet\'s secret):');
    console.log(token);
  } finally {
    await pool.end();
  }
} catch (err) {
  console.error(`fleet-credential failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
