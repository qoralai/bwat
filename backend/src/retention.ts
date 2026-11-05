import type pg from 'pg';
import { ENDED, lockMeeting } from './claims.ts';
import { withTransaction } from './db/pool.ts';
import { MEETING_HAS_OPEN_CLAIM } from './meetings.ts';
import { repeat } from './repeat.ts';
import { settingDef, validateSection } from './settings/catalogue.ts';
import { readStoredSetting } from './settings/store.ts';

/** The settings catalogue keys that hold the retention days and the keep-forever choice. */
const RETENTION_KEY = 'transcript_retention_days';
const KEEP_FOREVER_KEY = 'transcript_keep_forever';

/**
 * Transcript retention (A255, D163): one job expires transcripts older than the retention
 * setting; the meeting and its cards stay. The settings are read on every run, so a change
 * applies without a restart.
 */

/** Where the retention settings come from: retentionFromSettings. */
interface RetentionSettings {
  transcriptRetentionDays(): Promise<number>;
  /** True: the job keeps meeting content (transcripts, inbox briefs, hand-off keys) and still clears passcodes and Zoom's records (QOR-4600, D168). */
  keepForever(): Promise<boolean>;
}

/** A stored retention value, when the catalogue would accept it; else the catalogue's default (unset, reset or refused). */
async function storedOrDefault(pool: pg.Pool, key: string): Promise<unknown> {
  const stored = await readStoredSetting(pool, key);
  return stored != null && validateSection('retention', { [key]: stored }).length === 0 ? stored : settingDef(key)!.codeDefault;
}

/**
 * The admin panel's retention settings (QOR-4578, QOR-4600), read on every call: a stored
 * value wins, and while it is unset the catalogue's default applies (90 days; keep forever
 * on, QOR-4760). A stored value the catalogue would refuse is ignored rather than run: 0 days would
 * expire every ended meeting.
 */
export function retentionFromSettings(pool: pg.Pool): RetentionSettings {
  return {
    transcriptRetentionDays: async () => (await storedOrDefault(pool, RETENTION_KEY)) as number,
    keepForever: async () => (await storedOrDefault(pool, KEEP_FOREVER_KEY)) as boolean,
  };
}

/** Runs `statement` ($1 days, $2 batch size) until a batch deletes fewer than `batchSize`; the rows deleted. */
async function deleteInBatches(pool: pg.Pool, statement: string, days: number, batchSize: number): Promise<number> {
  let deleted = 0;
  for (;;) {
    const batch = (await pool.query(statement, [days, batchSize])).rowCount ?? 0;
    deleted += batch;
    if (batch < batchSize) return deleted;
  }
}

/**
 * Expires the transcripts of the meetings that ended (or, never ended, started) more than
 * `days` ago and are not expired yet (D163): deletes their segments and stamps
 * transcript_expired_at; the meeting row and its cards stay. `batchSize` at a time, each
 * batch its own transaction: a meeting a claim is open for is skipped
 * (MEETING_HAS_OPEN_CLAIM: its bot could still push; a later run takes it once the claim
 * ends), each meeting's lock is taken, and the check is made again under the locks, as an
 * admin's delete does. An expired occurrence counts as ended from then on (meetingEndedSql)
 * and a push for it stores nothing, so nothing reopens or refills it. The locks go in one
 * order (by the lock's key), so two runs never deadlock; nothing else holds more than one.
 * The transcripts expired.
 */
async function expireOldTranscripts(pool: pg.Pool, days: number, batchSize: number): Promise<number> {
  let expired = 0;
  for (;;) {
    const batch = await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ id: string; meeting_number: string }>(
        `SELECT m.id, m.meeting_number FROM meetings m
          WHERE m.transcript_expired_at IS NULL
            AND coalesce(m.ended_at, m.started_at) < now() - make_interval(days => $1) AND NOT ${MEETING_HAS_OPEN_CLAIM}
          ORDER BY hashtext(m.meeting_number), m.meeting_number
          LIMIT $2`,
        [days, batchSize],
      );
      for (const number of new Set(rows.map((r) => r.meeting_number))) await lockMeeting(client, number);
      const done = await client.query<{ n: number }>(
        `WITH expired AS (
           UPDATE meetings m SET transcript_expired_at = now()
            WHERE m.id = ANY($1::uuid[]) AND m.transcript_expired_at IS NULL AND NOT ${MEETING_HAS_OPEN_CLAIM}
            RETURNING m.id
         ), segments AS (
           DELETE FROM transcript_segments s USING expired e WHERE s.meeting_id = e.id
         )
         SELECT count(*)::int AS n FROM expired`,
        [rows.map((r) => r.id)],
      );
      return { picked: rows.length, expired: done.rows[0]!.n };
    });
    expired += batch.expired;
    if (batch.picked < batchSize) return expired;
  }
}

/** How many rows each retention batch takes. */
const BATCH_SIZE = 100;

/**
 * The meeting content retention expires, all but the transcripts by their own age: expires
 * every transcript of a meeting that ended (or, never ended, started) more than `days` ago,
 * unless a claim is still open for it (expireOldTranscripts: the meeting and its cards
 * stay); deletes every hand-off inbox message that old, read or not, and every hand-off key
 * (handoffs) that old, so a request_key deduplicates for `days`. Keep forever skips it (D168).
 */
async function expireContent(pool: pg.Pool, days: number, batchSize: number) {
  const transcriptsExpired = await expireOldTranscripts(pool, days, batchSize);
  // Hand-off briefs quote meetings (QOR-4589): read or not, they go by their own age. One
  // naming a meeting goes with it sooner only if an admin deletes the meeting (migration
  // 0008's cascade); expiry keeps the meeting (D163).
  const inboxDeleted = await deleteInBatches(
    pool,
    `DELETE FROM inbox_messages WHERE id IN (
       SELECT id FROM inbox_messages WHERE created_at < now() - make_interval(days => $1) LIMIT $2)`,
    days,
    batchSize,
  );
  const handoffsDeleted = await deleteInBatches(
    pool,
    `DELETE FROM handoffs WHERE id IN (
       SELECT id FROM handoffs WHERE created_at < now() - make_interval(days => $1) LIMIT $2)`,
    days,
    batchSize,
  );
  return { transcripts_expired: transcriptsExpired, inbox_messages_deleted: inboxDeleted, handoffs_deleted: handoffsDeleted };
}

/**
 * What retention clears whatever keep forever says (D168): deletes every Zoom meeting.ended
 * record (zoom_ended_occurrences) older than `days`, and clears the briefing (the passcode)
 * of every claim that ended that long ago. Ended claims stay as tombstones for good; the
 * runtime role cannot delete them.
 */
async function pruneRecords(pool: pg.Pool, days: number, batchSize: number) {
  await deleteInBatches(pool, `DELETE FROM zoom_speakers WHERE (occurrence_uuid, speaker_zoom_id) IN (
    SELECT z.occurrence_uuid, z.speaker_zoom_id FROM zoom_speakers z
    LEFT JOIN meetings m ON m.occurrence_uuid = z.occurrence_uuid
    WHERE m.transcript_expired_at IS NOT NULL
       OR (m.id IS NULL AND z.received_at < now() - make_interval(days => $1))
       -- Kept while waiting for a host who never brought bwat in.
       OR (m.id IS NULL AND z.received_at < now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.occurrence_uuid = z.occurrence_uuid)) LIMIT $2)`, days, batchSize);
  const endedDeleted = await deleteInBatches(
    pool,
    `DELETE FROM zoom_ended_occurrences WHERE (meeting_number, occurrence_uuid) IN (
       SELECT meeting_number, occurrence_uuid FROM zoom_ended_occurrences WHERE ended_at < now() - make_interval(days => $1) LIMIT $2)`,
    days,
    batchSize,
  );
  const claims = await pool.query(
    `UPDATE claims SET briefing = '{}', updated_at = now()
      WHERE state IN (${ENDED}) AND ended_at < now() - make_interval(days => $1) AND briefing <> '{}'`,
    [days],
  );
  return { claims_scrubbed: claims.rowCount ?? 0, ended_occurrences_deleted: endedDeleted };
}

/**
 * Everything retention does for `days` (expireContent, then pruneRecords). Transcripts,
 * Zoom's records, inbox messages and hand-off keys go `batchSize` at a time, each batch its
 * own statement or transaction: a backlog (the first run over old data, or the setting
 * lowered) never needs one statement longer than the pool's statement_timeout, and no batch
 * holds its locks for long.
 */
export async function runRetention(pool: pg.Pool, days: number, batchSize = BATCH_SIZE) {
  // Before Zoom's records go: an expired occurrence must already read as ended without them.
  const content = await expireContent(pool, days, batchSize);
  return { ...content, ...(await pruneRecords(pool, days, batchSize)) };
}

/**
 * One retention run as the settings say (QOR-4600, D168). Keep forever keeps the meeting
 * content only: while it is on, no transcript expires and no inbox brief or hand-off key is
 * deleted, but ended claims' passcodes are still cleared and Zoom's records still pruned on
 * the days' window (pruneRecords). Off, runRetention with the days.
 */
export async function retainOnce(pool: pg.Pool, settings: RetentionSettings) {
  const keepForever = await settings.keepForever();
  const days = await settings.transcriptRetentionDays();
  if (keepForever) return { days, keep_forever: true as const, ...(await pruneRecords(pool, days, BATCH_SIZE)) };
  return { days, keep_forever: false as const, ...(await runRetention(pool, days)) };
}

type RetentionLog = { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };

/**
 * Runs retention (retainOnce) at once and then `intervalMs` (hourly by default) after each
 * run settles (repeat), until the returned stop is called. One run at a time. stop starts no new
 * run and resolves once a run in progress has finished, so a shutdown that awaits it never
 * closes the pool under a run. The timer never holds the process open.
 * A run logs retention.ran with keep_forever and the counts of the steps it ran (retainOnce);
 * a failed run is logged by its code only and the next one still runs.
 */
export function startRetention(
  pool: pg.Pool,
  settings: RetentionSettings,
  log: RetentionLog,
  intervalMs = 60 * 60 * 1000,
): () => Promise<void> {
  const run = async () => {
    try {
      log.info({ event: 'retention.ran', ...(await retainOnce(pool, settings)) }, 'retention ran');
    } catch (err) {
      log.error({ event: 'retention.failed', code: (err as { code?: unknown }).code }, 'retention failed');
    }
  };
  return repeat(run, intervalMs, 0).stop;
}
