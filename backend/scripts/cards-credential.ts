/**
 * `npm run cards-credential [-- --label <name>]`: issues the card service's credential, the
 * bearer token it reads /fleet and transcripts with (QOR-4662). Logs in as the runtime role
 * (BWAT_DB_URL_FILE > BWAT_DB_URL > aws `<prefix>BWAT_DB_URL`). Prints the token once; only its sha256 is stored, so it cannot be
 * shown again. Never prints the URL.
 */
import { parseArgs } from 'node:util';
import { STARTUP_NAMES, startupEnv } from '../src/config.ts';
import { issueCardsCredential } from '../src/credentials.ts';
import { runtimePool } from '../src/db/pool.ts';

try {
  const { values } = parseArgs({ options: { label: { type: 'string' } } });
  const pool = runtimePool(await startupEnv(process.env, STARTUP_NAMES.runtimeScript), { max: 1 });
  try {
    const token = await issueCardsCredential(pool, values.label ?? null);
    console.log('card-service credential (shown once; store it as the card service\'s BWAT_CARDS_CREDENTIAL):');
    console.log(token);
  } finally {
    await pool.end();
  }
} catch (err) {
  console.error(`cards-credential failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
