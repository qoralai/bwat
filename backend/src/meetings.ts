import type pg from 'pg';
import { audit } from './audit.ts';
import { botPresentSql, ENDED, judgeHeld, LIVE_STATES, lockMeeting, meetingEndedSql, OPEN } from './claims.ts';
import { withTransaction } from './db/pool.ts';

/**
 * Meetings (one per Zoom occurrence bwat attended) and their transcripts (migration 0006).
 * Everything here is meeting content: callers log ids and counts, never a title, a
 * speaker label or a segment's text.
 */

interface SegmentIn {
  seq: number;
  speaker_label: string;
  speaker_member_id?: string | null | undefined;
  speaker_zoom_id?: string | null | undefined;
  text: string;
  start_ms: number;
  end_ms: number;
  source: 'asr' | 'chat';
  original_text?: string | null | undefined;
  original_speaker_label?: string | null | undefined;
  dictionary_version?: string | null | undefined;
}

/**
 * Stores a bot's transcript push. Chat lines are segments like any other: the same seq
 * space, retention and deletes. Only the bot holding a live claim on this occurrence,
 * at the epoch it declared and had accepted (claims.transcript_epoch), with its lease
 * unexpired, may write: anything else is `stale_epoch` and stores nothing; a claim past
 * its drain after Zoom's end (drain_until) ends here, and the push is `stale_claim`. The claim row
 * is locked for the transaction, so no release, recall, requeue or epoch change can commit
 * between the check and the write: one that commits first refuses the push, and one that
 * comes after waits for it. The first push opens the meeting. A
 * segment already stored for (meeting, epoch, seq) is left as it is, so a retried push
 * is a no-op. `complete` marks the transcript complete and the meeting ended; after that
 * a push that would add a segment is `transcript_complete` and stores nothing. A push for an occurrence whose
 * meeting was deleted (deleted_occurrences) is `meeting_deleted` and stores nothing. A push for a
 * meeting whose transcript retention expired (D163) is `transcript_expired` and stores nothing,
 * even one that adds nothing, so no retry refills it.
 */
export async function storeTranscript(
  pool: pg.Pool,
  push: { botId: string; occurrence: string; epoch: number; complete: boolean; segments: SegmentIn[]; return_segments?: boolean | undefined },
): Promise<
  | { status: 'stored'; meetingId: string; stored: number; segments?: SegmentRow[] }
  | { status: 'stale_epoch' | 'stale_claim' | 'transcript_complete' | 'meeting_deleted' | 'transcript_expired' }
> {
  return withTransaction(pool, async (client) => {
    // Admission, judged once on the locked claim row (claims.ts's lockHeld fence, keyed on
    // the bot and occurrence: a push carries no claim id or generation). The lease is read
    // after the lock, by the clock then: a row only locked, not updated, while the push
    // waited is not read again, so a clock in the locking predicate would be stale.
    const claim = await client.query<{ id: string; meeting_number: string }>(
      `SELECT id, meeting_number FROM claims
        WHERE bot_id = $1 AND occurrence_uuid = $2 AND state = ANY($3) AND transcript_epoch = $4
        FOR UPDATE`,
      [push.botId, push.occurrence, LIVE_STATES, push.epoch],
    );
    const held = claim.rows[0];
    if (!held) return { status: 'stale_epoch' };
    const verdict = await judgeHeld(client, held.id);
    // Past its drain after Zoom's end the claim has just ended: the bot's order to leave.
    if (verdict === 'drained') return { status: 'stale_claim' };
    if (verdict === 'lapsed') return { status: 'stale_epoch' };
    // The deletion fence. A deleter checks for an open claim under the meeting's lock, and
    // a claim reaches an occurrence only under that lock, so no delete can commit while
    // this push holds a live claim on it: the fence read here is final for the push.
    const deleted = await client.query(`SELECT 1 FROM deleted_occurrences WHERE occurrence_uuid = $1`, [push.occurrence]);
    if (deleted.rowCount) return { status: 'meeting_deleted' };

    // Opens the meeting, or finds it, and locks it until commit: a delete waits for this push.
    const meeting = (
      await client.query<{ id: string; finalization: MeetingRow['finalization']; transcript_expired_at: Date | null }>(
        `INSERT INTO meetings (occurrence_uuid, meeting_number) VALUES ($1, $2)
         ON CONFLICT (occurrence_uuid) DO UPDATE SET occurrence_uuid = EXCLUDED.occurrence_uuid
         RETURNING id, finalization, transcript_expired_at`,
        [push.occurrence, held.meeting_number],
      )
    ).rows[0]!;
    const meetingId = meeting.id;
    const s = push.segments;
    const answer = async (stored: number) => ({ status: 'stored' as const, meetingId, stored,
      ...(push.return_segments ? { segments: (await client.query<SegmentRow>(
        `SELECT ${SEGMENT_COLUMNS} FROM transcript_segments s
          JOIN v_transcript_speakers v USING (meeting_id, epoch, seq)
          WHERE s.meeting_id = $1 AND s.epoch = $2 AND s.seq = ANY($3::int[]) ORDER BY s.seq`,
        [meetingId, push.epoch, s.map((x) => x.seq)])).rows } : {}) });
    // Expired takes nothing, not even the final push again: every segment would read as new.
    if (meeting.transcript_expired_at) return { status: 'transcript_expired' };

    // A complete transcript takes nothing new; a retried push that adds nothing is fine.
    if (meeting.finalization === 'transcript_complete') {
      const fresh = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM unnest($3::int[]) AS p(seq)
          WHERE NOT EXISTS (SELECT 1 FROM transcript_segments x WHERE x.meeting_id = $1 AND x.epoch = $2 AND x.seq = p.seq)`,
        [meetingId, push.epoch, s.map((x) => x.seq)],
      );
      if (fresh.rows[0]!.n > 0) return { status: 'transcript_complete' };
      return answer(0);
    }

    const inserted = await client.query(
      `INSERT INTO transcript_segments (meeting_id, epoch, seq, speaker_label, speaker_member_id, text, start_ms, end_ms, source,
                                       original_text, original_speaker_label, dictionary_version, speaker_zoom_id)
       SELECT $1, $2, p.* FROM unnest($3::int[], $4::text[], $5::uuid[], $6::text[], $7::int[], $8::int[], $9::text[],
                                     $10::text[], $11::text[], $12::text[], $13::text[]) AS p(seq)
       ON CONFLICT (meeting_id, epoch, seq) DO NOTHING`,
      [
        meetingId,
        push.epoch,
        s.map((x) => x.seq),
        s.map((x) => x.speaker_label),
        s.map((x) => x.speaker_zoom_id ? null : x.speaker_member_id ?? null),
        s.map((x) => x.text),
        s.map((x) => x.start_ms),
        s.map((x) => x.end_ms),
        s.map((x) => x.source),
        s.map((x) => x.original_text ?? null),
        s.map((x) => x.original_speaker_label ?? null),
        s.map((x) => x.dictionary_version ?? null),
        s.map((x) => x.speaker_zoom_id ?? null),
      ],
    );
    if (push.complete) {
      await client.query(
        `UPDATE meetings SET finalization = 'transcript_complete', ended_at = coalesce(ended_at, now()) WHERE id = $1`,
        [meetingId],
      );
    }
    return answer(inserted.rowCount ?? 0);
  });
}

export interface MeetingRow {
  id: string;
  occurrence_uuid: string;
  title: string | null;
  /** The host's email from Zoom, shown beside the title; null until Zoom is asked. */
  host_email: string | null;
  started_at: Date;
  ended_at: Date | null;
  duration_seconds: number | null;
  attendee_count: number | null;
  finalization: 'open' | 'transcript_complete';
  transcript_available: boolean;
  /** When retention deleted the transcript (D163); null while it is kept. */
  transcript_expired_at: Date | null;
  /** Live while a claim is open for it: what the board shows as Live (see OccurrenceState). */
  occurrence_state: OccurrenceState;
  /** The bots that were in this meeting (held a claim on its occurrence); empty for none. */
  bot_ids: string[];
  /** The error code the bot holding the meeting last reported (bots.status), such as model_out_of_credit; null for none. */
  bot_error: string | null;
  /** A bot is in the live meeting now, as the Zoom panel's check (meetingBotStatus) says present: claims.ts botPresentSql. */
  bot_present: boolean;
}

/** Where a page of history starts: after this meeting, in (started_at desc, id desc) order. */
interface HistoryCursor {
  started_at: Date;
  id: string;
}

/**
 * One page of meeting history, newest first, plus the cursor for the next page (null on
 * the last). Keyset paging on (started_at, id): started_at has millisecond precision
 * (migration 0006), so a cursor carried as a JavaScript Date is exact.
 */
export async function meetingHistory(
  pool: pg.Pool,
  { limit, after, withBot = false }: { limit: number; after: HistoryCursor | null; withBot?: boolean },
): Promise<{ meetings: MeetingRow[]; next: HistoryCursor | null }> {
  const { rows } = await pool.query<MeetingRow>(
    `SELECT m.id, m.occurrence_uuid, m.title, m.host_email, m.started_at, m.ended_at, m.duration_seconds, m.attendee_count,
            m.finalization, EXISTS (SELECT 1 FROM transcript_segments s WHERE s.meeting_id = m.id) AS transcript_available,
            m.transcript_expired_at, t.occurrence_state,
            ARRAY(SELECT DISTINCT c.bot_id::text FROM claims c
                   WHERE c.occurrence_uuid = m.occurrence_uuid AND c.bot_id IS NOT NULL) AS bot_ids,
            (SELECT b.status->>'error' FROM claims c JOIN bots b ON b.id = c.bot_id
              WHERE c.occurrence_uuid = m.occurrence_uuid AND c.state = ANY($4) LIMIT 1) AS bot_error,
            -- Read for a live meeting only (the board pages the whole history every 15 s). A live one
            -- whose end is recorded is draining, and bwat is not in it (meetingBotStatus: ended).
            CASE WHEN t.occurrence_state = 'live' AND NOT ${meetingEndedSql('m.occurrence_uuid')}
                 THEN ${botPresentSql('m.occurrence_uuid')} ELSE false END AS bot_present
       FROM meetings m
      -- The state once a row: bot_present reads it rather than deriving it again (OFFSET 0 keeps
      -- Postgres from inlining the subquery, which would copy the expression back into both places).
      CROSS JOIN LATERAL (SELECT ${OCCURRENCE_STATE} AS occurrence_state OFFSET 0) t
      WHERE ($1::timestamptz IS NULL OR (m.started_at, m.id) < ($1::timestamptz, $2::uuid))
        AND (NOT $5 OR EXISTS (SELECT 1 FROM claims c WHERE c.occurrence_uuid = m.occurrence_uuid AND c.bot_id IS NOT NULL))
      ORDER BY m.started_at DESC, m.id DESC
      LIMIT $3`,
    [after?.started_at ?? null, after?.id ?? null, limit + 1, LIVE_STATES, withBot],
  );
  const meetings = rows.slice(0, limit);
  const last = meetings[meetings.length - 1];
  return { meetings, next: rows.length > limit && last ? { started_at: last.started_at, id: last.id } : null };
}

export interface SegmentRow {
  epoch: number;
  seq: number;
  speaker_label: string;
  speaker_member_id: string | null;
  speaker_zoom_id: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
  source: 'asr' | 'chat';
  original_text: string | null;
  original_speaker_label: string | null;
  dictionary_version: string | null;
  /** When the backend stored it (QOR-4769): the card service times its lines by it. */
  created_at: Date;
}

const SEGMENT_COLUMNS = `s.epoch, s.seq, s.speaker_label, v.speaker_member_id, s.speaker_zoom_id,
  s.text, s.start_ms, s.end_ms, s.source, s.original_text, s.original_speaker_label, s.dictionary_version, s.created_at`;

/**
 * Where an occurrence is, derived at read time from the meeting and its claims:
 *   ended      the transcript is complete, or the meeting's end is recorded
 *              (claims.ts meetingEnded: a claim's meeting_ended_at, Zoom's
 *              meeting.ended record, or its transcript's expiry) and no claim is open on the occurrence. A write
 *              fence: nothing more is stored, and it stays ended. A complete transcript
 *              refuses new segments (storeTranscript); otherwise no claim can hold the
 *              occurrence again (promotion and Zoom's start refuse an ended occurrence),
 *              and a push needs one.
 *   live       a claim is open (pending or held) for it.
 *   abandoned  not ended, and every claim for it is terminal.
 * A complete transcript wins over an open claim: after the final push the bot is still in
 * its claim. A recorded end does not: a claim still open on the occurrence may yet push
 * (Zoom's end leaves a held claim live for its bot to drain).
 * A pending claim has no occurrence yet, so an open claim with none counts for every
 * meeting with its number, except one whose end is already recorded: a Zoom occurrence
 * that ended does not restart (the next one is a new occurrence).
 */
export const OCCURRENCE_STATES = ['live', 'ended', 'abandoned'] as const;
type OccurrenceState = (typeof OCCURRENCE_STATES)[number];

type MeetingState = Pick<MeetingRow, 'id' | 'occurrence_uuid' | 'finalization' | 'transcript_expired_at'> & {
  occurrence_state: OccurrenceState;
};

/**
 * Whether a claim is open for the meeting aliased `m` (an SQL boolean): one on its
 * occurrence, or, unless its end is recorded, one sent to its meeting number and not yet
 * promoted to an occurrence (see OccurrenceState).
 */
export const MEETING_HAS_OPEN_CLAIM = `(
  EXISTS (SELECT 1 FROM claims c WHERE c.occurrence_uuid = m.occurrence_uuid AND c.state IN (${OPEN}))
  OR (NOT ${meetingEndedSql('m.occurrence_uuid')}
      AND EXISTS (SELECT 1 FROM claims c WHERE c.occurrence_uuid IS NULL AND c.meeting_number = m.meeting_number AND c.state IN (${OPEN}))))`;

/** The meeting aliased `m`'s OccurrenceState, as SQL. */
const OCCURRENCE_STATE = `CASE WHEN m.finalization = 'transcript_complete' THEN 'ended'
                 WHEN ${MEETING_HAS_OPEN_CLAIM} THEN 'live'
                 WHEN ${meetingEndedSql('m.occurrence_uuid')} THEN 'ended'
                 ELSE 'abandoned' END`;

/**
 * One meeting's identity and state (see OccurrenceState), by its id or by its Zoom
 * occurrence, or undefined when there is no such meeting. The card service reads the same
 * state from bwat.v_cards_occurrences (migration 0010, replaced by 0011), which inlines this CASE: a change
 * here needs a migration that replaces the view (test/occurrence-state.test.ts compares them).
 */
export async function findMeeting(db: pg.Pool | pg.ClientBase, key: { id: string } | { occurrence: string }): Promise<MeetingState | undefined> {
  const { rows } = await db.query<MeetingState>(
    `SELECT m.id, m.occurrence_uuid, m.finalization, m.transcript_expired_at, ${OCCURRENCE_STATE} AS occurrence_state
       FROM meetings m WHERE ${'id' in key ? 'm.id = $1' : 'm.occurrence_uuid = $1'}`,
    ['id' in key ? key.id : key.occurrence],
  );
  return rows[0];
}

/** One page of a meeting's transcript in (epoch, seq) order, after `after` when given. */
export async function transcriptPage(
  db: pg.Pool | pg.ClientBase,
  meetingId: string,
  { limit, after }: { limit: number; after: { epoch: number; seq: number } | null },
): Promise<{ segments: SegmentRow[]; next: SegmentRow | null }> {
  const { rows } = await db.query<SegmentRow>(
    `SELECT ${SEGMENT_COLUMNS}
       FROM transcript_segments s JOIN v_transcript_speakers v USING (meeting_id, epoch, seq)
      WHERE s.meeting_id = $1 AND ($2::int IS NULL OR (s.epoch, s.seq) > ($2::int, $3::int))
      ORDER BY s.epoch, s.seq
      LIMIT $4`,
    [meetingId, after?.epoch ?? null, after?.seq ?? null, limit + 1],
  );
  const segments = rows.slice(0, limit);
  return { segments, next: rows.length > limit ? (segments[segments.length - 1] ?? null) : null };
}

/** A meeting's newest `limit` segments, in (epoch, seq) order: the board's transcript footer. */
export async function transcriptTail(db: pg.Pool | pg.ClientBase, meetingId: string, limit: number): Promise<SegmentRow[]> {
  const { rows } = await db.query<SegmentRow>(
    `SELECT ${SEGMENT_COLUMNS}
       FROM transcript_segments s JOIN v_transcript_speakers v USING (meeting_id, epoch, seq)
      WHERE s.meeting_id = $1
      ORDER BY s.epoch DESC, s.seq DESC
      LIMIT $2`,
    [meetingId, limit],
  );
  return rows.reverse();
}

/**
 * Keeps the title and host Zoom gave for an occurrence's meeting (zoom-api.ts meeting()):
 * the first ones kept stay. No meeting for the occurrence is no change.
 */
export async function recordMeetingFacts(
  pool: pg.Pool,
  occurrenceUuid: string,
  facts: { topic: string | null; hostEmail: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE meetings SET title = coalesce(title, $2), host_email = coalesce(host_email, $3) WHERE occurrence_uuid = $1`,
    [occurrenceUuid, facts.topic, facts.hostEmail],
  );
}

/**
 * Deletes one meeting and everything about it: the meeting, its transcript, the hand-off
 * inbox messages that name it (migration 0008's cascade), and the briefing (the passcode)
 * of its ended claims. Ended claims stay as
 * tombstones. Undefined when there is no such meeting; `meeting_live`, deleting nothing,
 * while a claim is open for it (MEETING_HAS_OPEN_CLAIM, even after its final push): its
 * bot could still push. A push stores only under a live claim, so none is in flight once
 * this passes. The occurrence is fenced (deleted_occurrences) in the same transaction, so
 * no later push, promotion or Zoom start opens it again.
 *
 * Takes the meeting's lock first, the order promotion and Zoom's start and end take it in
 * (meeting, then claim): a claim reaches an occurrence only under that lock, so one that
 * did before this check is seen open, and one that tries after it meets the fence. A
 * person's send takes no lock: it names no occurrence, so the fence cannot apply to it;
 * it counts as open here (unless the occurrence's end is recorded) until its promotion,
 * which takes the lock and meets the fence.
 */
export async function deleteMeeting(
  pool: pg.Pool,
  meetingId: string,
  actorId: string | null,
): Promise<{ segments_deleted: number; claims_cleared: number } | 'meeting_live' | undefined> {
  return withTransaction(pool, async (client) => {
    // A meeting's number never changes, so it is read before the lock.
    const number = await client.query<{ meeting_number: string }>(`SELECT meeting_number FROM meetings WHERE id = $1`, [meetingId]);
    if (!number.rows[0]) return undefined;
    await lockMeeting(client, number.rows[0].meeting_number);
    const meeting = await client.query<{ occurrence_uuid: string; live: boolean }>(
      `SELECT m.occurrence_uuid, ${MEETING_HAS_OPEN_CLAIM} AS live FROM meetings m WHERE m.id = $1 FOR UPDATE OF m`,
      [meetingId],
    );
    const found = meeting.rows[0];
    if (!found) return undefined;
    if (found.live) return 'meeting_live';
    const occurrence = found.occurrence_uuid;
    await client.query(`INSERT INTO deleted_occurrences (occurrence_uuid) VALUES ($1) ON CONFLICT DO NOTHING`, [occurrence]);
    await client.query(`DELETE FROM zoom_speakers WHERE occurrence_uuid = $1`, [occurrence]);
    const segments = await client.query(`DELETE FROM transcript_segments WHERE meeting_id = $1`, [meetingId]);
    await client.query(`DELETE FROM meetings WHERE id = $1`, [meetingId]);
    const claims = await client.query(
      `UPDATE claims SET briefing = '{}', updated_at = now()
        WHERE occurrence_uuid = $1 AND state IN (${ENDED})`,
      [occurrence],
    );
    await audit(client, { actor: actorId, action: 'meeting.deleted', target: 'meeting', targetId: meetingId });
    return { segments_deleted: segments.rowCount ?? 0, claims_cleared: claims.rowCount ?? 0 };
  });
}
