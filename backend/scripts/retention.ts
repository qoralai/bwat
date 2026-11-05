/**
 * `npm run retention`: runs the transcript retention job once (A255, D163), the same job the
 * server runs hourly. Logs in as the runtime role (BWAT_DB_URL_FILE > BWAT_DB_URL > aws `<prefix>BWAT_DB_URL`); the days are the stored
 * transcript_retention_days (default 90), and a stored
 * transcript_keep_forever keeps the meeting content but still clears passcodes and Zoom's
 * records (D168). Prints counts only.
 */
import { STARTUP_NAMES, startupEnv } from '../src/config.ts';
import { runtimePool } from '../src/db/pool.ts';
import { retainOnce, retentionFromSettings } from '../src/retention.ts';

try {
  const pool = runtimePool(await startupEnv(process.env, STARTUP_NAMES.runtimeScript), { max: 1 });
  try {
    const result = await retainOnce(pool, retentionFromSettings(pool));
    const records = `${result.claims_scrubbed} claim briefings cleared, ${result.ended_occurrences_deleted} ended occurrences deleted`;
    console.log(
      result.keep_forever
        ? `retention (${result.days} days, keep forever: content kept): ${records}`
        : `retention (${result.days} days): ${result.transcripts_expired} transcripts expired, ${records}, ${result.inbox_messages_deleted} inbox messages deleted, ${result.handoffs_deleted} hand-off keys deleted`,
    );
  } finally {
    await pool.end();
  }
} catch (err) {
  console.error(`retention failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
