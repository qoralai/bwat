import type pg from 'pg';
import { withTransaction } from './db/pool.ts';
import { LIVE_SESSION } from './sessions.ts';

/**
 * Hand-offs and the hand-off inbox (QOR-4589; backend/README.md, Client sessions, hand-offs and the inbox). A hand-off
 * is queued, never started: the backend stores the recipient's copy and nothing more.
 * Every read and write is by the recipient's member id: another member's message is
 * answered as one that does not exist (D148).
 */

/** The caps on a brief. */
export const SUBJECT_MAX = 500;
export const BODY_MAX = 10_000;

/** First key of the per-request_key advisory lock ('bhof'; two-key form, unlike claims.ts's MEETING_LOCK). */
const HANDOFF_LOCK = 0x62686f66;

export interface Handoff {
  source_kind: 'card' | 'todo';
  source_id: string;
  occurrence_id?: string | undefined;
  target_session_id: string;
  request_key: string;
  subject: string;
  body: string;
}

/**
 * Queues `handoff` for one of the sender's own sessions, as one unread message whose
 * recipient is the sender (the contract's v1: a member routes to their own sessions).
 * A repeated request_key answers the first hand-off (created false) and queues nothing. Otherwise a
 * meeting it names (occurrence_id) must still be held: one deleted, or never held, is
 * `meeting_deleted`. Then the target is locked (FOR SHARE) and judged by the clock once
 * the lock is held, so an end or a takeover in flight commits first and is seen, and a
 * session that went quiet while this waited is not passed: not the sender's is
 * `forbidden`, not live is `session_unreachable`. A refusal stores nothing, the
 * request_key included.
 */
export async function sendHandoff(
  pool: pg.Pool,
  senderId: string,
  handoff: Handoff,
): Promise<{ handoff_id: string; created: boolean } | 'meeting_deleted' | 'forbidden' | 'session_unreachable'> {
  return withTransaction(pool, async (client) => {
    // Admission is one at a time per sender and request_key, before anything is judged: a
    // replay waits for the send in flight and answers it, never a refusal the first one
    // passed (the session ending in between). A hash collision only makes two wait.
    await client.query(`SELECT pg_advisory_xact_lock($1, hashtext($2 || ':' || $3))`, [HANDOFF_LOCK, senderId, handoff.request_key]);
    const repeated = (
      await client.query<{ id: string }>(`SELECT id FROM handoffs WHERE sender_member_id = $1 AND request_key = $2`, [senderId, handoff.request_key])
    ).rows[0];
    if (repeated) return { handoff_id: repeated.id, created: false };

    // The meeting it quotes, held against its delete until this commits (the lock its
    // foreign key takes): one deleted first is gone here, and a delete after this waits,
    // then takes the copy with the meeting (migration 0008's cascade).
    if (handoff.occurrence_id !== undefined) {
      const meeting = await client.query(`SELECT 1 FROM meetings WHERE id = $1 FOR KEY SHARE`, [handoff.occurrence_id]);
      if (!meeting.rows[0]) return 'meeting_deleted';
    }

    // Locked first, then judged: a row only locked, not updated, while this waited is not
    // read again, so a clock in the locking statement would be read before the wait.
    const session = [senderId, handoff.target_session_id];
    const target = await client.query(`SELECT 1 FROM sessions WHERE member_id = $1 AND session_id = $2 FOR SHARE`, session);
    if (!target.rows[0]) return 'forbidden';
    const judged = await client.query<{ live: boolean }>(`SELECT ${LIVE_SESSION} AS live FROM sessions WHERE member_id = $1 AND session_id = $2`, session);
    if (!judged.rows[0]!.live) return 'session_unreachable';

    const created = await client.query<{ id: string }>(`INSERT INTO handoffs (sender_member_id, request_key) VALUES ($1, $2) RETURNING id`, [
      senderId,
      handoff.request_key,
    ]);
    const id = created.rows[0]!.id;
    await client.query(
      `INSERT INTO inbox_messages
         (recipient_member_id, sender_member_id, handoff_id, target_client_session, source_kind, source_id, occurrence_id, subject, body)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8)`,
      [senderId, id, handoff.target_session_id, handoff.source_kind, handoff.source_id, handoff.occurrence_id ?? null, handoff.subject, handoff.body],
    );
    return { handoff_id: id, created: true };
  });
}

/** The hand-off this sender already queued under `requestKey`, if any (read without the admission lock). */
export async function repeatedHandoff(pool: pg.Pool, senderId: string, requestKey: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM handoffs WHERE sender_member_id = $1 AND request_key = $2`, [senderId, requestKey]);
  return rows[0]?.id;
}

/** A message as stored; `body` only when one message is read. */
export interface MessageRow {
  id: string;
  created_at: Date;
  read_at: Date | null;
  target_client_session: string;
  source_kind: 'card' | 'todo';
  source_id: string;
  occurrence_id: string | null;
  handoff_id: string;
  subject: string;
  body?: string;
}

/** Where a page starts: after this message, in (created_at, id) order. */
export interface InboxCursor {
  created_at: Date;
  id: string;
}

const LISTED = 'id, created_at, read_at, target_client_session, source_kind, source_id, occurrence_id, handoff_id, subject';

/**
 * One page of the member's inbox, oldest first, plus the cursor for the next page (null
 * on the last). Keyset paging on (created_at, id): created_at has millisecond precision
 * (migration 0008), so a cursor carried as a JavaScript Date is exact. `session` limits
 * it to one client session's messages. No body: the session reads each message by id.
 */
export async function inboxPage(
  pool: pg.Pool,
  memberId: string,
  { unreadOnly, session, limit, after }: { unreadOnly: boolean; session: string | null; limit: number; after: InboxCursor | null },
): Promise<{ messages: MessageRow[]; next: InboxCursor | null }> {
  const { rows } = await pool.query<MessageRow>(
    `SELECT ${LISTED} FROM inbox_messages
      WHERE recipient_member_id = $1
        AND (NOT $2 OR read_at IS NULL)
        AND ($3::text IS NULL OR target_client_session = $3)
        AND ($4::timestamptz IS NULL OR (created_at, id) > ($4::timestamptz, $5::uuid))
      ORDER BY created_at, id
      LIMIT $6`,
    [memberId, unreadOnly, session, after?.created_at ?? null, after?.id ?? null, limit + 1],
  );
  const messages = rows.slice(0, limit);
  const last = messages[messages.length - 1];
  return { messages, next: rows.length > limit && last ? { created_at: last.created_at, id: last.id } : null };
}

/** The member's message, body included, or null: another member's is not theirs to see. */
export async function inboxMessage(pool: pg.Pool, memberId: string, id: string): Promise<MessageRow | null> {
  const { rows } = await pool.query<MessageRow>(`SELECT ${LISTED}, body FROM inbox_messages WHERE id = $1 AND recipient_member_id = $2`, [id, memberId]);
  return rows[0] ?? null;
}

/**
 * Marks the member's message read, keeping the first read_at: one statement, so a
 * second mark that waited on the first sees its read_at and keeps it. Null when it is
 * not the member's message.
 */
export async function markRead(
  pool: pg.Pool,
  memberId: string,
  id: string,
): Promise<Pick<MessageRow, 'id' | 'source_kind' | 'source_id' | 'handoff_id'> & { read_at: Date } | null> {
  const { rows } = await pool.query<Pick<MessageRow, 'id' | 'source_kind' | 'source_id' | 'handoff_id'> & { read_at: Date }>(
    `UPDATE inbox_messages SET read_at = coalesce(read_at, now()) WHERE id = $1 AND recipient_member_id = $2
     RETURNING id, read_at, source_kind, source_id, handoff_id`,
    [id, memberId],
  );
  return rows[0] ?? null;
}

/**
 * Hard-deletes the member's message. `not_found` only for another member's message;
 * one already gone, or never there, is `deleted` (the delete is idempotent).
 */
/** Deletes the member's own message `id`, if there is one; anyone else's is left untouched. */
export async function deleteMessage(pool: pg.Pool, memberId: string, id: string): Promise<void> {
  await pool.query(`DELETE FROM inbox_messages WHERE id = $1 AND recipient_member_id = $2`, [id, memberId]);
}
