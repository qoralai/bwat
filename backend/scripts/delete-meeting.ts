/**
 * `npm run delete-meeting -- --meeting <uuid>`: deletes one meeting and everything about
 * it, as DELETE /meetings/{meetingId} does (legal blocker 3). Logs in as the runtime role
 * (BWAT_DB_URL_FILE > BWAT_DB_URL > aws `<prefix>BWAT_DB_URL`). Prints ids and counts only; never the URL.
 */
import { parseArgs } from 'node:util';
import { STARTUP_NAMES, startupEnv } from '../src/config.ts';
import { runtimePool } from '../src/db/pool.ts';
import { deleteMeeting } from '../src/meetings.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

try {
  const { values } = parseArgs({ options: { meeting: { type: 'string' } } });
  const id = values.meeting;
  if (!id || !UUID.test(id)) throw new Error('--meeting <uuid> is required');
  const pool = runtimePool(await startupEnv(process.env, STARTUP_NAMES.runtimeScript), { max: 1 });
  try {
    const result = await deleteMeeting(pool, id, null);
    if (!result) throw new Error('no such meeting');
    if (result === 'meeting_live') throw new Error('the meeting is live (a claim is open for it)');
    console.log(`meeting ${id} deleted: ${result.segments_deleted} segments, ${result.claims_cleared} claim briefings cleared`);
  } finally {
    await pool.end();
  }
} catch (err) {
  console.error(`delete-meeting failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
