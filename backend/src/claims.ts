import type pg from 'pg';
import { withTransaction } from './db/pool.ts';
import { feedToken } from './feed.ts';

/**
 * Claims: a bot sent to a Zoom meeting. pending -> claimed -> attending -> done | abandoned.
 * One open claim per meeting and one live claim per bot are held by unique indexes
 * (migration 0002); the rules for who gets what live here.
 */

/**
 * Release reasons that mean the placement failed, not the meeting: the backend puts the
 * claim back to pending for another bot, and the attempt counts toward MAX_ALLOCATIONS.
 */
const RETRY_REASONS: ReadonlySet<string> = new Set([
  'waiting_for_host_timeout',
  'waiting_room_timeout',
  'unable_to_connect',
  'sdk_auth_failed',
  'obf_user_not_in_meeting',
]);

/** A claim still pending this many allocations in is abandoned (allocations_exhausted). */
export const MAX_ALLOCATIONS = 3;
/** How long a requeued claim may wait for a bot; a new claim's bound is the column default (migration 0002). */
const PENDING_SECONDS = 300;
/** How long a held claim may drain after Zoom's end, unless BWAT_DRAIN_SECONDS says otherwise (config.ts). */
export const DRAIN_SECONDS = 300;
/** How long a newly allocated claim is held before its bot must renew it. */
export const LEASE_SECONDS = 90;
/** A bot unheard from for longer than this is stale: never allocated, and shown as stale. */
export const STALE_SECONDS = 45;
/**
 * The highest transcript epoch a bot may declare. Epochs only rise per occurrence, so one
 * declared at the top leaves no higher epoch for a later holder; the bound keeps the top
 * far below the int4 column's, so raising it later needs no migration.
 */
export const MAX_TRANSCRIPT_EPOCH = 1_000_000;
/** Advisory lock key ('bwat' in ASCII) that serializes allocator runs. */
export const ALLOCATOR_LOCK = 0x62776174;
/**
 * First key of the per-meeting advisory lock (two-key form, so it never meets
 * ALLOCATOR_LOCK): a meeting's end and a webhook's start of it take turns.
 */
export const MEETING_LOCK = 0x626d7467;

export type ClaimState = 'pending' | 'claimed' | 'attending' | 'done' | 'abandoned';

/**
 * A claim still open for its meeting, and one holding its bot. These mirror the
 * predicates of migration 0002's partial unique indexes (claims_one_open_per_meeting,
 * claims_one_live_per_bot); test/claim-states.test.ts keeps them equal.
 */
export const OPEN_STATES = ['pending', 'claimed', 'attending'] as const satisfies readonly ClaimState[];
export const LIVE_STATES = ['claimed', 'attending'] as const satisfies readonly ClaimState[];
/** A claim that has ended, either way. */
const ENDED_STATES = ['done', 'abandoned'] as const satisfies readonly ClaimState[];

/** A state list as SQL literals. Constants only: ON CONFLICT must restate the index predicate, not a parameter. */
const sqlList = (states: readonly ClaimState[]) => states.map((s) => `'${s}'`).join(', ');
/** OPEN_STATES, LIVE_STATES and ENDED_STATES for `state IN (...)`. */
export const OPEN = sqlList(OPEN_STATES);
const LIVE = sqlList(LIVE_STATES);
export const ENDED = sqlList(ENDED_STATES);

export interface ClaimRow {
  id: string;
  meeting_number: string;
  occurrence_uuid: string | null;
  state: ClaimState;
  bot_id: string | null;
  generation: number;
  lease_until: Date | null;
  refused_reason: string | null;
  /** The bot's reason for its last failed placement (RETRY_REASONS); null until one fails. */
  last_placement_failure: string | null;
  /** The epoch this holder declared and had accepted, which the transcript push takes; null until it has one. */
  transcript_epoch: number | null;
  /** Set by Zoom's end on a held claim: past it the claim ends (drain_expired); null until then. */
  drain_until: Date | null;
  /** When its bot first reported it was in the meeting; null until then, and again once requeued. */
  joined_at: Date | null;
  briefing: Record<string, unknown>;
}

/**
 * The SET list that ends a claim: its state and reason (SQL expressions), when it ended,
 * and no lease. `endedAt` is a CASE where the same statement may leave the claim open.
 * The caller sets updated_at.
 */
const endClaim = (state: string, reason: string, endedAt = 'now()') =>
  `state = ${state}, refused_reason = ${reason}, ended_at = ${endedAt}, lease_until = NULL`;

/**
 * A held claim whose lease lapsed or whose drain after Zoom's end ran out: retireLapsed
 * retires it, and listFleet gives capture no feed address for it meanwhile. `c` is the
 * claims table's alias, with its dot.
 */
const lapsed = (c = '') => `(${c}lease_until <= now() OR ${c}drain_until <= now())`;

/**
 * Retires every claim no longer open, whatever its meeting: a pending claim past its
 * bound or out of allocation attempts, and a held claim whose lease lapsed or whose drain
 * after Zoom's end ran out (done, drain_expired, which wins when both), so its bot is
 * free again. Runs at the start of every allocation, so placement needs no conditions
 * of its own, and before opening a claim, so a dead one never answers `already_claimed`.
 * Returns what it retired: a held claim's bot is free again.
 */
async function retireLapsed(client: pg.ClientBase): Promise<ClaimRow[]> {
  const { rows } = await client.query<ClaimRow>(
    `UPDATE claims
        SET ${endClaim(
              `CASE WHEN state <> 'pending' AND drain_until <= now() THEN 'done' ELSE 'abandoned' END`,
              `CASE WHEN state <> 'pending' AND drain_until <= now() THEN 'drain_expired'
                    WHEN state <> 'pending' THEN 'lease_expired'
                    WHEN allocation_count >= $1 THEN 'allocations_exhausted'
                    ELSE 'no_bot_available' END`,
            )}, updated_at = now()
      WHERE (state = 'pending' AND (pending_until <= now() OR allocation_count >= $1))
         OR (state IN (${LIVE}) AND ${lapsed()})
      RETURNING *`,
    [MAX_ALLOCATIONS],
  );
  return rows;
}

/** A claim's briefing: the meeting's passcode and scheduled end, each only when known. */
export const briefingOf = (passcode: string | null, scheduledEnd: string | null | undefined) => ({
  ...(passcode !== null && { passcode }),
  ...(scheduledEnd && { scheduled_end: scheduledEnd }),
});

/**
 * Opens a pending claim for the meeting, or finds the one already open. A repeat
 * request never opens a second claim, even when two arrive at once: the insert yields
 * to the open-claim index and the other request's claim is returned instead.
 */
export async function openClaim(
  pool: pg.Pool,
  req: { meetingNumber: string; briefing: { passcode?: string; scheduled_end?: string } },
): Promise<{ claim: ClaimRow; created: boolean; retired: ClaimRow[] }> {
  return withTransaction(pool, async (client) => {
    const retired = await retireLapsed(client);
    return { ...(await openOrFind(client, { ...req, occurrenceUuid: null })), retired };
  });
}

async function openOrFind(
  client: pg.ClientBase,
  req: { meetingNumber: string; occurrenceUuid: string | null; briefing: { passcode?: string; scheduled_end?: string } },
): Promise<{ claim: ClaimRow; created: boolean }> {
  const inserted = await client.query<ClaimRow>(
    `INSERT INTO claims (meeting_number, occurrence_uuid, briefing) VALUES ($1, $2, $3)
     ON CONFLICT (meeting_number) WHERE state IN (${OPEN}) DO NOTHING
     RETURNING *`,
    [req.meetingNumber, req.occurrenceUuid, req.briefing],
  );
  if (inserted.rows[0]) return { claim: inserted.rows[0], created: true };
  return (await findOpen(client, req.meetingNumber))!;
}

// A recalled bot learns to leave on its next heartbeat. Until an idle report confirms
// departure, allow its full lease to elapse before offering another invitation.
const RECALL_LEAVING = `c.state = 'abandoned' AND c.refused_reason = 'recalled'
  AND c.bot_id IS NOT NULL AND c.ended_at > now() - interval '${LEASE_SECONDS} seconds'
  AND NOT COALESCE(b.last_heartbeat > c.ended_at AND b.status->>'state' = 'idle'
                  AND b.status->>'joined' = 'false', false)`;

/** An explicit in-meeting invitation may retry a departed bot, but never reopen an ended/deleted meeting. */
export async function inviteOccurrence(
  pool: pg.Pool,
  req: { meetingNumber: string; occurrenceUuid: string; briefing: { passcode?: string } },
) {
  return withTransaction(pool, async client => {
    await lockMeeting(client, req.meetingNumber);
    const retired = await retireLapsed(client);
    if (await meetingEnded(client, req.occurrenceUuid)) return { error: 'meeting_ended' as const, retired };
    const leaving = await client.query(`SELECT 1 FROM claims c LEFT JOIN bots b ON b.id = c.bot_id
      WHERE c.occurrence_uuid = $1 AND ${RECALL_LEAVING} LIMIT 1`, [req.occurrenceUuid]);
    if (leaving.rowCount) return { error: 'bot_leaving' as const, retired };
    const opened = await openOrFind(client, req);
    if (!opened.created) {
      const { rows } = await client.query<ViewedClaim>(`SELECT c.*, ${OCCURRENCE_EPOCH} FROM claims c WHERE id = $1 FOR UPDATE OF c`, [opened.claim.id]);
      const promoted = await promoteLocked(client, rows[0]!, req.occurrenceUuid);
      if (typeof promoted === 'string') return { error: promoted, retired };
    }
    return { retired };
  });
}

/**
 * A claim (aliased `c`, its bot `b`) whose bot is in the meeting now: attending, its lease and
 * drain not run out, the bot heard from lately and joined by its report since this claim was
 * allocated. Never null. Asked of an occurrence's latest claim only (botPresentSql, meetingBotStatus).
 */
const CLAIM_PRESENT = `COALESCE(c.state = 'attending' AND NOT COALESCE(c.lease_until <= now() OR c.drain_until <= now(), false)
  AND b.last_heartbeat > now() - interval '${STALE_SECONDS} seconds'
  AND b.last_heartbeat >= c.allocated_at AND b.status->>'joined' = 'true', false)`;

/** Whether a bot is in the meeting `occurrence` (SQL) names now, as meetingBotStatus says present. */
export const botPresentSql = (occurrence: string) => `COALESCE((SELECT ${CLAIM_PRESENT}
  FROM claims c LEFT JOIN bots b ON b.id = c.bot_id WHERE c.occurrence_uuid = ${occurrence}
  ORDER BY c.created_at DESC, c.id DESC LIMIT 1), false)`;

/** Only this occurrence's current claim; a silent bot is unknown, never confidently present. */
export async function meetingBotStatus(pool: pg.Pool, occurrence: string) {
  const ended = await pool.query<{ ended: boolean }>(`SELECT ${meetingEndedSql('$1')} AS ended`, [occurrence]);
  if (ended.rows[0]!.ended) return { state: 'ended', can_invite: false };
  const { rows } = await pool.query<{
    state: ClaimState; refused_reason: string | null; expired: boolean; stale: boolean; leaving: boolean;
    present: boolean; report: { state?: string } | null; joined_at: Date | null;
  }>(`SELECT c.state, c.refused_reason, c.joined_at, (${RECALL_LEAVING}) AS leaving, ${CLAIM_PRESENT} AS present,
      CASE WHEN c.state = 'pending' THEN c.pending_until <= now() OR c.allocation_count >= $2
           ELSE c.lease_until <= now() OR c.drain_until <= now() END AS expired,
      b.last_heartbeat <= now() - interval '${STALE_SECONDS} seconds' AS stale,
      CASE WHEN b.last_heartbeat >= c.allocated_at THEN b.status END AS report
      FROM claims c LEFT JOIN bots b ON b.id = c.bot_id WHERE c.occurrence_uuid = $1
      ORDER BY c.created_at DESC, c.id DESC LIMIT 1`, [occurrence, MAX_ALLOCATIONS]);
  const claim = rows[0];
  if (!claim) return { state: 'absent', can_invite: true };
  if (claim.leaving) return { state: 'leaving', can_invite: false };
  if (claim.state === 'abandoned' && claim.refused_reason === 'recalled') return { state: 'absent', can_invite: true };
  if (claim.expired || claim.state === 'abandoned') return { state: 'failed', can_invite: true };
  if (claim.state === 'done') return { state: 'absent', can_invite: true };
  if (claim.state === 'pending') return { state: 'queued', can_invite: false };
  if (claim.stale) return { state: 'checking', can_invite: false };
  if (claim.present) return { state: 'present', can_invite: false, joined_at: claim.joined_at };
  const waiting = claim.report?.state;
  return { state: waiting === 'waiting_room' || waiting === 'waiting_for_host' ? waiting : 'joining', can_invite: false };
}

/** The meeting's open claim, if any. Never opens one. */
async function findOpen(client: pg.ClientBase, meetingNumber: string): Promise<{ claim: ClaimRow; created: false } | null> {
  const open = await client.query<ClaimRow>(`SELECT * FROM claims WHERE meeting_number = $1 AND state IN (${OPEN})`, [meetingNumber]);
  return open.rows[0] ? { claim: open.rows[0], created: false } : null;
}

/**
 * openClaim for a meeting Zoom says has started: the claim names the occurrence, and
 * an occurrence whose meeting has already ended (meetingEnded), or whose claim ended in any
 * way (released, or abandoned: say its lease lapsed once the host removed bwat), is
 * refused with `ended`. An open claim found with no occurrence (a person's send) is
 * stamped with this one by the promotion's own locked transition (promoteLocked), so its
 * end closes the occurrence too; one a bot already promoted to another is left alone.
 * Zoom's events carry no passcode, so a claim is opened only with a `briefing` built from
 * the meeting looked up in Zoom. Without one, only a claim already open is found (and
 * stamped); with none open the start is refused with `unknown`. A past claim's passcode
 * is never reused: retention erases it, and an erased briefing would read as a meeting
 * without one. Takes the meeting's lock, so it cannot interleave with its end.
 */
export async function openOccurrenceClaim(
  pool: pg.Pool,
  req: {
    meetingNumber: string;
    occurrenceUuid: string | null;
    deliveryKey: Buffer;
    briefing?: { passcode?: string; scheduled_end?: string };
  },
): Promise<({ claim: ClaimRow; created: boolean } | { ended: true } | { unknown: true }) & { retired: ClaimRow[] } | { duplicate: true }> {
  return withTransaction(pool, async (client) => {
    await lockMeeting(client, req.meetingNumber);
    if (!(await recordDelivery(client, req.deliveryKey))) return { duplicate: true as const };
    const retired = await retireLapsed(client);
    if (req.occurrenceUuid !== null) {
      const claimEnded = await client.query(
        `SELECT 1 FROM claims WHERE meeting_number = $1 AND occurrence_uuid = $2 AND state IN (${ENDED}) LIMIT 1`,
        [req.meetingNumber, req.occurrenceUuid],
      );
      if (claimEnded.rowCount || (await meetingEnded(client, req.occurrenceUuid))) return { ended: true as const, retired };
    }
    const { briefing } = req;
    const opened = briefing ? await openOrFind(client, { ...req, briefing }) : await findOpen(client, req.meetingNumber);
    if (!opened) return { unknown: true as const, retired };
    if (!opened.created && req.occurrenceUuid !== null) {
      // The found claim, locked and read again: a bot may have promoted it meanwhile.
      const { rows } = await client.query<ViewedClaim>(`SELECT c.*, ${OCCURRENCE_EPOCH} FROM claims c WHERE id = $1 FOR UPDATE OF c`, [
        opened.claim.id,
      ]);
      const stamped = await promoteLocked(client, rows[0]!, req.occurrenceUuid);
      if (stamped === 'meeting_already_ended') return { ended: true as const, retired };
      opened.claim = stamped === 'occurrence_conflict' ? rows[0]! : stamped;
    }
    return { ...opened, retired };
  });
}

/**
 * Places pending claims, oldest first, on ready bots that hold no meeting. Only a bot
 * that declared itself ready is a candidate, and never one the fleet is draining (fleet.ts). Allocator runs are serialized by an
 * advisory lock taken before any candidate is read: otherwise a run that skipped bots
 * locked by another could return while that other run, having already looked for
 * pending claims, finishes with a free bot unused and the new claim left pending.
 * Returns the claims it placed and those the retire step ended.
 */
export async function allocate(pool: pg.Pool): Promise<{ placed: ClaimRow[]; retired: ClaimRow[] }> {
  return withTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(${ALLOCATOR_LOCK})`);
    const retired = await retireLapsed(client);
    // Pairs the n-th free bot (longest ready first) with the n-th pending claim (oldest
    // first). FOR UPDATE cannot share a SELECT with row_number(), so it locks inside.
    const { rows } = await client.query<ClaimRow>(
      `WITH free AS (
         SELECT b.id, b.ready_at FROM bots b
          WHERE b.ready_at IS NOT NULL AND b.last_heartbeat > now() - make_interval(secs => $2)
            AND b.draining_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.bot_id = b.id AND c.state IN (${LIVE}))
          FOR UPDATE SKIP LOCKED
       ), waiting AS (
         SELECT id, created_at FROM claims WHERE state = 'pending' FOR UPDATE SKIP LOCKED
       ), pairs AS (
         SELECT w.id AS claim_id, f.id AS bot_id
           FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM waiting) w
           JOIN (SELECT id, row_number() OVER (ORDER BY ready_at, id) AS n FROM free) f USING (n)
       ), placed AS (
         UPDATE claims c
            SET state = 'claimed', bot_id = p.bot_id, generation = c.generation + 1,
                allocation_count = c.allocation_count + 1, allocated_at = now(), updated_at = now(),
                lease_until = now() + make_interval(secs => $1)
           FROM pairs p
          WHERE c.id = p.claim_id
         RETURNING c.*
       )
       SELECT * FROM placed ORDER BY created_at, id`,
      [LEASE_SECONDS, STALE_SECONDS],
    );
    return { placed: rows, retired };
  });
}

/** A claim row with its occurrence's highest accepted transcript epoch (null before promotion, or before any). */
type ViewedClaim = ClaimRow & { occurrence_epoch: number | null };

/** Selects occurrence_epoch for the claims row aliased `c`. */
const OCCURRENCE_EPOCH = `(SELECT o.highest_epoch FROM occurrence_epochs o WHERE o.occurrence_uuid = c.occurrence_uuid) AS occurrence_epoch`;

/**
 * Records `epoch` as the occurrence's highest when it is above the highest so far, or the
 * first: true when it did. The upsert takes the occurrence's row lock, so two holders can
 * never both win the same epoch.
 */
async function raiseOccurrenceEpoch(client: pg.ClientBase, occurrenceUuid: string, epoch: number): Promise<boolean> {
  const { rows } = await client.query(
    `INSERT INTO occurrence_epochs (occurrence_uuid, highest_epoch) VALUES ($1, $2)
     ON CONFLICT (occurrence_uuid) DO UPDATE SET highest_epoch = EXCLUDED.highest_epoch, updated_at = now()
      WHERE occurrence_epochs.highest_epoch < EXCLUDED.highest_epoch
     RETURNING 1`,
    [occurrenceUuid, epoch],
  );
  return rows.length > 0;
}

/**
 * The live claim of the bot holding this token digest, in one statement: the claim, null
 * for a known bot with none, undefined for no such bot. One per bot (claims_one_live_per_bot).
 * The poll is the contract's idle signal, so it is also the bot's liveness: it refreshes
 * last_heartbeat, and a ready bot that only polls stays a candidate for allocation.
 */
export async function assignmentForToken(pool: pg.Pool, tokenDigest: Buffer): Promise<ViewedClaim | null | undefined> {
  const { rows } = await pool.query<ViewedClaim>(
    `WITH b AS (UPDATE bots SET last_heartbeat = now() WHERE token_sha256 = $1 RETURNING id)
     SELECT c.*, ${OCCURRENCE_EPOCH} FROM b LEFT JOIN claims c ON c.bot_id = b.id AND c.state IN (${LIVE})`,
    [tokenDigest],
  );
  return rows[0] && (rows[0].id ? rows[0] : null);
}

/**
 * The contract's Claim: what a bot is told about its meeting. transcript_epoch is the
 * occurrence's highest; feed_token is this generation's (null without BWAT_FEED_KEY).
 */
export function claimView(claim: ViewedClaim, key: Buffer | undefined) {
  return {
    claim_id: claim.id,
    generation: claim.generation,
    feed_token: key ? feedToken(key, claim.id, claim.generation) : null,
    lease_until: claim.lease_until,
    meeting_number: claim.meeting_number,
    occurrence_uuid: claim.occurrence_uuid,
    transcript_epoch: claim.occurrence_epoch,
    briefing: claim.briefing,
  };
}

/** A claim state as people see it (the contract's Allocation.claim_state). */
const SHOWN: Record<ClaimState, string> = {
  pending: 'pending',
  claimed: 'claimed',
  attending: 'attending',
  done: 'released',
  abandoned: 'refused',
};

/** The contract's Allocation: what people see of a claim. No briefing. */
export function allocationView(claim: ClaimRow) {
  return {
    id: claim.id,
    meeting_number: claim.meeting_number,
    occurrence_id: claim.occurrence_uuid,
    claim_state: SHOWN[claim.state],
    refused_reason: claim.refused_reason,
    error: null,
  };
}

/**
 * The fence every bot mutation of a claim locks behind ($1 claim, $2 bot, $3 generation):
 * the bot holds this generation of the claim and the claim is live. No clock here: a row
 * that was only locked, not updated, while the statement waited is not read again, so a
 * clock in the locking predicate would be read before the wait. The lease is judged once
 * the row is held (lockHeld). A refusal is 409 stale_claim, the bot's order to leave.
 */
const FENCE = `id = $1 AND bot_id = $2 AND generation = $3 AND state IN (${LIVE})`;

/** The claim a bot names, and the generation it believes it holds. */
type HeldRef = { botId: string; claimId: string; generation: number };

/**
 * Judges a claim this transaction has locked, by the clock now (clock_timestamp(), not
 * now(): now() is when the transaction began, and a write that waited on a lock must be
 * judged when it runs): `running` while its lease runs; `drained` once its drain after
 * Zoom's end ran out (drain_until), whatever its lease, and then it ends here (done,
 * drain_expired) in the caller's transaction; `lapsed` once its lease has, left for the
 * sweep to retire.
 */
export async function judgeHeld(client: pg.ClientBase, claimId: string): Promise<'running' | 'lapsed' | 'drained'> {
  const { rows } = await client.query<{ verdict: 'running' | 'lapsed' | 'drained' }>(
    `SELECT CASE WHEN drain_until <= clock_timestamp() THEN 'drained'
                 WHEN lease_until > clock_timestamp() THEN 'running'
                 ELSE 'lapsed' END AS verdict
       FROM claims WHERE id = $1`,
    [claimId],
  );
  const { verdict } = rows[0]!;
  if (verdict === 'drained') {
    await client.query(`UPDATE claims SET ${endClaim(`'done'`, `'drain_expired'`)}, updated_at = now() WHERE id = $1`, [claimId]);
  }
  return verdict;
}

/**
 * Locks the bot's claim behind the fence, then judges it on the locked row (judgeHeld),
 * for a transaction that goes on to write it: the claim, or undefined when the bot does not
 * hold it, its lease lapsed or its drain ran out. Checked once, here; the writes after it
 * key on the id alone. The judgement reads the clock, so a second check could fail where this one passed (the lease lapsing while the
 * transaction waits on another lock) and answer stale_claim for a transaction that has
 * already written. Once this passes, the call succeeds: nothing can retire the claim
 * while its row is locked, and the write renews or keeps it.
 */
async function lockHeld(client: pg.ClientBase, ref: HeldRef): Promise<ViewedClaim | undefined> {
  const { rows } = await client.query<ViewedClaim>(
    `SELECT c.*, ${OCCURRENCE_EPOCH} FROM claims c WHERE ${FENCE} FOR UPDATE OF c`,
    [ref.claimId, ref.botId, ref.generation],
  );
  const held = rows[0];
  if (!held || (await judgeHeld(client, held.id)) !== 'running') return undefined;
  return held;
}

/**
 * The bot's claim behind the fence, judged as a heartbeat judges it (lockHeld), in a
 * transaction of its own that commits before the caller goes on: undefined when the bot
 * does not hold it, its lease lapsed or its drain ran out (which ends it). For a call
 * that only reads the claim, so the row lock is never held across a call to Zoom.
 */
export const heldClaim = (pool: pg.Pool, ref: HeldRef): Promise<ViewedClaim | undefined> =>
  withTransaction(pool, (client) => lockHeld(client, ref));

/**
 * Stores a bot's status (a snapshot of what it reports, never merged), its version when
 * it sends one, and its heartbeat time, on its own row. `returning` is a RETURNING list.
 */
function recordStatus<R extends pg.QueryResultRow = pg.QueryResultRow>(
  db: pg.Pool | pg.ClientBase,
  botId: string,
  status: { version?: string | undefined },
  returning?: string,
) {
  return db.query<R>(
    `UPDATE bots SET status = $2, version = COALESCE($3, version), last_heartbeat = now() WHERE id = $1
     ${returning ? `RETURNING ${returning}` : ''}`,
    [botId, status, status.version ?? null],
  );
}

/**
 * A bot's heartbeat, in one transaction: stores its status and heartbeat time, then
 * renews the lease of its claim behind the fence. A claim the bot reports joined moves to
 * attending. stale_claim when the bot does not hold the claim.
 *
 * The transcript epoch, when sent: before promotion it is claim-local and stored as sent.
 * Once the claim names its occurrence it is per occurrence: the claim's current epoch is
 * accepted, and one above the occurrence's highest is accepted and raises both; anything
 * else is stale_epoch, and the lease is not renewed.
 */
export async function heartbeat(
  pool: pg.Pool,
  beat: HeldRef & {
    transcriptEpoch?: number | undefined;
    status: { joined?: boolean | undefined; version?: string | undefined } & Record<string, unknown>;
  },
): Promise<ViewedClaim | 'stale_claim' | 'stale_epoch'> {
  return withTransaction(pool, async (client) => {
    // The claim's lock before the bot's, the order releaseClaim takes them in: the
    // opposite order deadlocks a heartbeat against its own bot's release.
    const held = await lockHeld(client, beat);
    await recordStatus(client, beat.botId, beat.status);
    if (!held) return 'stale_claim';
    const epoch = beat.transcriptEpoch;
    if (
      epoch !== undefined &&
      held.occurrence_uuid !== null &&
      epoch !== held.transcript_epoch &&
      !(await raiseOccurrenceEpoch(client, held.occurrence_uuid, epoch))
    ) {
      return 'stale_epoch';
    }
    const { rows } = await client.query<ViewedClaim>(
      `UPDATE claims c
          SET lease_until = now() + make_interval(secs => $2), updated_at = now(),
              state = CASE WHEN $3 THEN 'attending' ELSE state END,
              joined_at = COALESCE(joined_at, CASE WHEN $3 THEN now() END),
              transcript_epoch = COALESCE($4, transcript_epoch)
        WHERE id = $1
        RETURNING c.*, ${OCCURRENCE_EPOCH}`,
      [held.id, LEASE_SECONDS, beat.status.joined === true, epoch ?? null],
    );
    return rows[0]!;
  });
}

/**
 * The heartbeat of a bot holding no claim: stores its status and heartbeat time. True
 * when it is ready and a claim is waiting, so the caller should run allocation; the
 * check keeps a fleet of idle bots from contending for the allocator on every beat.
 */
export async function idleHeartbeat(pool: pg.Pool, botId: string, status: { version?: string | undefined }): Promise<boolean> {
  const { rows } = await recordStatus<{ pull: boolean }>(
    pool,
    botId,
    status,
    `ready_at IS NOT NULL AND EXISTS (SELECT 1 FROM claims WHERE state = 'pending') AS pull`,
  );
  return rows[0]?.pull === true;
}

/**
 * Has this occurrence's meeting ended? The one answer both the promotion check and
 * auto-join's late-start refusal read. Its record is a claim ended at meeting end
 * (meeting_ended_at: a bot's meeting_ended release, or Zoom's meeting.ended releasing it),
 * or every end Zoom reported, zoom_ended_occurrences. A deleted meeting's occurrence
 * (deleted_occurrences, the deletion fence) counts as ended too, and so does one whose
 * transcript retention expired (meetings.transcript_expired_at, D163; retention prunes
 * Zoom's records with the same window): nothing opens either again.
 */
async function meetingEnded(db: pg.ClientBase, occurrenceUuid: string): Promise<boolean> {
  const { rows } = await db.query<{ ended: boolean }>(`SELECT ${meetingEndedSql('$1')} AS ended`, [occurrenceUuid]);
  return rows[0]!.ended;
}

/** meetingEnded as an SQL boolean, for the occurrence `occurrence` (an SQL expression), so a read can take it in the same statement. */
export const meetingEndedSql = (occurrence: string) =>
  `(EXISTS (SELECT 1 FROM claims WHERE occurrence_uuid = ${occurrence} AND meeting_ended_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM zoom_ended_occurrences WHERE occurrence_uuid = ${occurrence})
    OR EXISTS (SELECT 1 FROM deleted_occurrences WHERE occurrence_uuid = ${occurrence})
    OR EXISTS (SELECT 1 FROM meetings WHERE occurrence_uuid = ${occurrence} AND transcript_expired_at IS NOT NULL))`;

/**
 * Records the occurrence on a bot's own claim, behind the fence: the claim, or why not.
 * The same occurrence again is a no-op; a different one is a conflict (a claim names one
 * sitting). An occurrence whose meeting already ended is refused and its claim ends with
 * it (done, meeting_already_ended), so the bot's next call answers stale_claim and its
 * bot is free. POST /allocations carries no occurrence, so a person's send into an
 * ended occurrence is stopped here, once the bot reports where it is; a Zoom start is
 * refused before a claim opens (openOccurrenceClaim). A promotion opens bwat's meeting
 * for the occurrence, as the first transcript push would, so the board lists it from the
 * bot's arrival.
 *
 * Takes the meeting's lock first, the order Zoom's start and end take it in (meeting,
 * then claim): Zoom's end skips a claim not yet promoted, so a promotion between the
 * end's update of the claims and its record would otherwise bind a claim to an ended
 * occurrence. A claim's meeting never changes, so it is read before either lock.
 */
export async function promoteOccurrence(
  pool: pg.Pool,
  ev: HeldRef & { occurrenceUuid: string; meetingTitle?: string | undefined },
): Promise<{ claim: ViewedClaim } | { error: 'stale_claim' | 'occurrence_conflict' | 'meeting_already_ended' }> {
  return withTransaction(pool, async (client) => {
    const meeting = await client.query<{ meeting_number: string }>(`SELECT meeting_number FROM claims WHERE id = $1`, [ev.claimId]);
    if (!meeting.rows[0]) return { error: 'stale_claim' };
    await lockMeeting(client, meeting.rows[0].meeting_number);
    const held = await lockHeld(client, ev);
    if (!held) return { error: 'stale_claim' };
    const promoted = await promoteLocked(client, held, ev.occurrenceUuid);
    if (typeof promoted === 'string') return { error: promoted };
    // The bot is in the meeting: it is listed, and live, from now, not from its first line.
    // As with REST meeting facts, keep the first non-empty title from either source.
    await client.query(
      `INSERT INTO meetings (occurrence_uuid, meeting_number, title) VALUES ($1, $2, $3)
       ON CONFLICT (occurrence_uuid) DO UPDATE SET title = EXCLUDED.title
         WHERE meetings.title IS NULL AND EXCLUDED.title IS NOT NULL`,
      [ev.occurrenceUuid, held.meeting_number, ev.meetingTitle ?? null],
    );
    return { claim: promoted };
  });
}

/**
 * Names the occurrence on a claim whose row this transaction has locked: a bot's promotion
 * and a Zoom start stamping a person's send both take this one transition. The same
 * occurrence again is a no-op; a different one is a conflict and the claim is left alone;
 * an ended one ends the claim (done, meeting_already_ended).
 */
async function promoteLocked(
  client: pg.ClientBase,
  held: ViewedClaim,
  occurrenceUuid: string,
): Promise<ViewedClaim | 'occurrence_conflict' | 'meeting_already_ended'> {
  if (held.occurrence_uuid === occurrenceUuid) return held;
  if (held.occurrence_uuid !== null) return 'occurrence_conflict';
  if (await meetingEnded(client, occurrenceUuid)) {
    await client.query(`UPDATE claims SET ${endClaim(`'done'`, `'meeting_already_ended'`)}, updated_at = now() WHERE id = $1`, [held.id]);
    return 'meeting_already_ended';
  }
  // An epoch declared before promotion becomes the occurrence's only when it is above the
  // occurrence's highest; otherwise another holder already used it, and the claim drops it.
  const keepEpoch = held.transcript_epoch !== null && (await raiseOccurrenceEpoch(client, occurrenceUuid, held.transcript_epoch));
  const { rows } = await client.query<ViewedClaim>(
    `UPDATE claims c SET occurrence_uuid = $2, transcript_epoch = CASE WHEN $3 THEN transcript_epoch END, updated_at = now()
      WHERE id = $1
      RETURNING c.*, ${OCCURRENCE_EPOCH}`,
    [held.id, occurrenceUuid, keepEpoch],
  );
  return rows[0]!;
}

/**
 * Records the end on bwat's meeting for the occurrence (meetings.ended_at, the first end
 * kept), at either end record: a bot's meeting_ended release or Zoom's meeting.ended. The
 * final push (complete: true) records it too, but a meeting whose final push never landed
 * would otherwise read as open forever. No meeting yet (nothing pushed) is no change.
 */
async function meetingEndsNow(client: pg.ClientBase, occurrenceUuid: string | null): Promise<void> {
  await client.query(`UPDATE meetings SET ended_at = coalesce(ended_at, now()) WHERE occurrence_uuid = $1`, [occurrenceUuid]);
}

/**
 * A bot hands its claim back, behind the fence; null when the bot does not hold it.
 *   release        done, with the bot's reason.
 *   meeting_ended  done, and the meeting's tombstone (meeting_ended_at).
 *   requeue        the bot is being stopped mid-meeting: the claim is pending again with
 *                  its briefing and occurrence, no bot and the next generation (so the
 *                  stopping bot's next call is stale), and a fresh pending bound. The
 *                  bot is withdrawn in the same statement, so it is not handed the
 *                  meeting back. The placement did not fail, so it is not counted
 *                  against the allocation cap: a meeting losing its third bot to a
 *                  deploy is not abandoned as allocations_exhausted.
 * A plain release whose reason is a failed placement (RETRY_REASONS) is requeued by the
 * backend: pending again like a requeue, but the attempt counts, so a claim already at
 * MAX_ALLOCATIONS is abandoned as allocations_exhausted instead. The failing bot stays
 * ready but goes to the back of the queue, so another ready bot is tried first. Either
 * way the bot's reason is kept as last_placement_failure.
 */
export async function releaseClaim(
  pool: pg.Pool,
  rel: HeldRef & { reason: string | null; how: 'release' | 'meeting_ended' | 'requeue' },
): Promise<ClaimRow | null> {
  return withTransaction(pool, async (client) => {
    const held = await lockHeld(client, rel);
    if (!held) return null;
    if (rel.how === 'requeue') {
      const { rows } = await client.query<ClaimRow>(
        `WITH requeued AS (
           UPDATE claims
              SET state = 'pending', bot_id = NULL, generation = generation + 1, lease_until = NULL, transcript_epoch = NULL,
                  allocation_count = allocation_count - 1, allocated_at = NULL, joined_at = NULL, pending_until = now() + make_interval(secs => $3), updated_at = now()
            WHERE id = $1
            RETURNING *
         ), withdrawn AS (
           UPDATE bots SET ready_at = NULL WHERE id = $2
         )
         SELECT * FROM requeued`,
        [held.id, rel.botId, PENDING_SECONDS],
      );
      return rows[0]!;
    }
    if (rel.how === 'release' && rel.reason !== null && RETRY_REASONS.has(rel.reason)) {
      const { rows } = await client.query<ClaimRow>(
        `WITH retried AS (
           UPDATE claims
              SET ${endClaim(
                    `CASE WHEN allocation_count >= $3 THEN 'abandoned' ELSE 'pending' END`,
                    `CASE WHEN allocation_count >= $3 THEN 'allocations_exhausted' END`,
                    `CASE WHEN allocation_count >= $3 THEN now() END`,
                  )},
                  bot_id = CASE WHEN allocation_count >= $3 THEN bot_id END,
                  generation = CASE WHEN allocation_count >= $3 THEN generation ELSE generation + 1 END,
                  allocated_at = CASE WHEN allocation_count >= $3 THEN allocated_at END,
                  joined_at = CASE WHEN allocation_count >= $3 THEN joined_at END,
                  pending_until = CASE WHEN allocation_count >= $3 THEN pending_until
                                       ELSE now() + make_interval(secs => $4) END,
                  last_placement_failure = $5, transcript_epoch = NULL, updated_at = now()
            WHERE id = $1
            RETURNING *
         ), queued_last AS (
           UPDATE bots SET ready_at = now()
            WHERE id = $2 AND ready_at IS NOT NULL AND EXISTS (SELECT 1 FROM retried WHERE state = 'pending')
         )
         SELECT * FROM retried`,
        [held.id, rel.botId, MAX_ALLOCATIONS, PENDING_SECONDS, rel.reason],
      );
      return rows[0]!;
    }
    const { rows } = await client.query<ClaimRow>(
      `UPDATE claims
          SET ${endClaim(`'done'`, '$2')}, updated_at = now(), meeting_ended_at = CASE WHEN $3 THEN now() END
        WHERE id = $1
        RETURNING *`,
      [held.id, rel.reason, rel.how === 'meeting_ended'],
    );
    if (rel.how === 'meeting_ended') await meetingEndsNow(client, held.occurrence_uuid);
    return rows[0]!;
  });
}

/** Updates a claim only while it is open: the claim, 'not_live' once it has ended, null when there is none. */
async function updateOpenClaim(
  pool: Pick<pg.ClientBase, 'query'>,
  claimId: string,
  set: string,
  params: unknown[],
): Promise<ClaimRow | 'not_live' | null> {
  const { rows } = await pool.query<ClaimRow>(
    `UPDATE claims SET ${set}, updated_at = now() WHERE id = $1 AND state IN (${OPEN}) RETURNING *`,
    [claimId, ...params],
  );
  if (rows[0]) return rows[0];
  const found = await pool.query(`SELECT 1 FROM claims WHERE id = $1`, [claimId]);
  return found.rows.length ? 'not_live' : null;
}

/**
 * A person recalls this claim, and only it. Abandoned (not done: done is the meeting-end
 * tombstone, and a recall must not stop bwat being sent back). A held claim's bot is not
 * told: its next heartbeat answers 409 stale_claim, its order to leave.
 */
export const recallClaim = (pool: pg.Pool, claimId: string) =>
  withTransaction(pool, async client => {
    const found = await client.query<{ meeting_number: string }>('SELECT meeting_number FROM claims WHERE id = $1', [claimId]);
    if (!found.rows[0]) return null;
    // Invitation checks and insertions must not interleave with a recall.
    await lockMeeting(client, found.rows[0].meeting_number);
    return updateOpenClaim(client, claimId, endClaim(`'abandoned'`, `'recalled'`), []);
  });

/** How far back GET /allocations shows ended claims. */
const RECENT_SECONDS = 24 * 60 * 60;

/** What the holding bot last reported (migration 0002 bots.status); null until it reports. */
type BotReport = {
  joined?: boolean;
  recording?: boolean;
  hearing?: boolean;
  muted?: boolean;
  error?: string | null;
};

/** What the bot reports doing in its meeting, as GET /fleet shows it: each field as sent, or null when it sent none. */
function pickReport(report: BotReport) {
  return {
    joined: report.joined ?? null,
    recording: report.recording ?? null,
    hearing: report.hearing ?? null,
    muted: report.muted ?? null,
  };
}

type ListedClaim = ClaimRow & { created_at: Date; ended_at: Date | null; report: BotReport | null; meeting_title: string | null };

/**
 * Live claims and those ended in the last RECENT_SECONDS, newest first, each with its
 * holding bot's last report (only while the bot still holds it) and its meeting's title,
 * once bwat has the meeting.
 */
export async function listAllocations(pool: pg.Pool): Promise<ListedClaim[]> {
  const { rows } = await pool.query<ListedClaim>(
    `SELECT c.*, CASE WHEN c.state IN (${LIVE}) THEN NULLIF(b.status, '{}') END AS report, m.title AS meeting_title
       FROM claims c LEFT JOIN bots b ON b.id = c.bot_id
                     LEFT JOIN meetings m ON m.occurrence_uuid = c.occurrence_uuid
      WHERE c.state IN (${OPEN}) OR c.ended_at > now() - make_interval(secs => $1)
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT 200`,
    [RECENT_SECONDS],
  );
  return rows;
}

/** An Allocation as GET /allocations shows it, with the holding bot's last error and why its last placement failed. */
export function listedAllocationView(claim: ListedClaim) {
  return {
    ...allocationView(claim),
    last_placement_failure: claim.last_placement_failure,
    meeting_title: claim.meeting_title,
    error: claim.report?.error ?? null,
    created_at: claim.created_at,
    joined_at: claim.joined_at,
    ended_at: claim.ended_at,
  };
}

/** A bot silent for longer than this, and holding no claim, is left out of GET /fleet (a restart registers a new bot). */
const FLEET_SECONDS = 10 * 60;

/**
 * The live bots, one row each: any bot heard from in the last FLEET_SECONDS, and any bot
 * still holding a claim however long it has been silent. A heartbeat older than
 * STALE_SECONDS reads as stale. The report fields are what the bot last sent; a held
 * meeting Zoom has named carries its title and start (meeting_title, meeting_started_at). `feed` is
 * set for the card service only (QOR-4662): its rows add what capture dials and checks
 * (bot/bwat_bot/feed.py): the claim's generation and transcript epoch, the feed token (derived
 * with `feed.key`, null without one) and the feed address the bot last reported, null once
 * the bot is stale, or past its lease or drain (QOR-5113). People's rows never carry them.
 */
export async function listFleet(pool: pg.Pool, feed?: { key: Buffer | undefined }) {
  const { rows } = await pool.query<{
    bot_id: string;
    version: string | null;
    ready: boolean;
    busy: boolean;
    stale: boolean;
    last_report_at: Date;
    status: BotReport & { state?: string; dictionary_sha256?: string; feed_host?: string; feed_port?: number };
    claim_id: string | null;
    claim_live: boolean;
    generation: number | null;
    transcript_epoch: number | null;
    claim_state: ClaimState | null;
    meeting_number: string | null;
    occurrence_id: string | null;
    meeting_title: string | null;
    meeting_started_at: Date | null;
  }>(
    `SELECT b.id AS bot_id, b.version, b.ready_at IS NOT NULL AS ready, c.id IS NOT NULL AS busy,
            b.last_heartbeat <= now() - make_interval(secs => $1) AS stale,
            b.last_heartbeat AS last_report_at, b.status,
            c.id AS claim_id, c.id IS NOT NULL AND NOT coalesce(${lapsed('c.')}, false) AS claim_live, c.generation, c.transcript_epoch, c.state AS claim_state, c.meeting_number, c.occurrence_uuid AS occurrence_id,
            m.title AS meeting_title, m.started_at AS meeting_started_at
       FROM bots b LEFT JOIN claims c ON c.bot_id = b.id AND c.state IN (${LIVE})
                   LEFT JOIN meetings m ON m.occurrence_uuid = c.occurrence_uuid
      WHERE c.id IS NOT NULL OR b.last_heartbeat > now() - make_interval(secs => $2)
      ORDER BY b.registered_at, b.id`,
    [STALE_SECONDS, FLEET_SECONDS],
  );
  return rows.map(({ status, claim_state, generation, transcript_epoch, claim_live, ...row }) => {
    // Capture dials every row with an address: a bot that went quiet, or whose claim lapsed
    // but is not yet retired, is gone. Not ready is no sign: a bot can hold a claim it took
    // while not ready (QOR-5113).
    const dialable = !row.stale && claim_live;
    return {
      ...row,
      ...(feed && {
        generation,
        transcript_epoch,
        feed_token: feed.key && row.claim_id && generation !== null ? feedToken(feed.key, row.claim_id, generation) : null,
        feed_host: dialable ? (status.feed_host ?? null) : null,
        feed_port: dialable ? (status.feed_port ?? null) : null,
      }),
      state: status.state ?? null,
      ...pickReport(status),
      error: status.error ?? null,
      dictionary_sha256: status.dictionary_sha256 ?? null,
      claim_state: claim_state && SHOWN[claim_state],
    };
  });
}

/**
 * Serializes this transaction against any other holding the same meeting's lock: a
 * promotion, Zoom's start and end, a meeting's delete and the retention job, each before
 * any claim or meeting row.
 */
export async function lockMeeting(client: pg.ClientBase, meetingNumber: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [MEETING_LOCK, meetingNumber]);
}

/** A delivery's digest is kept this long: past Zoom's last retry of a delivery. */
const DELIVERY_TTL = '1 day';

/**
 * Records a Zoom delivery (its body's sha256) in the transaction that acts on it, so a
 * failed or crashed handling rolls it back and Zoom's retry is acted on; false when it
 * was already recorded. Called under the meeting's lock, so a retry that arrives while
 * the first attempt runs waits for its outcome. Digests past DELIVERY_TTL are swept.
 */
async function recordDelivery(client: pg.ClientBase, key: Buffer): Promise<boolean> {
  await client.query(`DELETE FROM zoom_deliveries WHERE received_at < now() - $1::interval`, [DELIVERY_TTL]);
  const fresh = await client.query(`INSERT INTO zoom_deliveries (body_sha256) VALUES ($1) ON CONFLICT DO NOTHING`, [key]);
  return fresh.rowCount === 1;
}

/**
 * Zoom says the occurrence ended. Its end is recorded in zoom_ended_occurrences, whatever
 * auto-join says and whether or not a claim is open, so meetingEnded answers true for it
 * from then on: neither a late start nor a bot's promotion can open it. The record is kept
 * as long as the meeting's transcripts (the retention job prunes it; nothing here does).
 * A pending claim naming this occurrence has no bot to drain, so it is released as a bot's
 * meeting_ended release would release it ('done', meeting_ended, meeting_ended_at). A
 * held claim naming it stays live: its bot sees the end through
 * the Zoom SDK, pushes its final batch (complete:true), then releases with meeting_ended;
 * a bot that never does loses the claim when its lease lapses, and one that keeps
 * heartbeating without completing loses it once its drain runs out (drain_until,
 * `drainSeconds` from the end: done, drain_expired). A claim not yet promoted is
 * left alone: it may be in the meeting's next sitting, and if its bot is in this one, its
 * promotion is refused (meeting_already_ended) and ends it.
 * Returns what it released, and whether the end was new.
 */
export async function endMeeting(
  pool: pg.Pool,
  req: { meetingNumber: string; occurrenceUuid: string; deliveryKey: Buffer; drainSeconds?: number | undefined },
): Promise<{ released: ClaimRow[]; tombstoned: boolean } | { duplicate: true }> {
  return withTransaction(pool, async (client) => {
    await lockMeeting(client, req.meetingNumber);
    if (!(await recordDelivery(client, req.deliveryKey))) return { duplicate: true as const };
    // The held claims' drain is bounded from the first end recorded; a later one never extends it.
    await client.query(
      `UPDATE claims SET drain_until = coalesce(drain_until, now() + make_interval(secs => $3)), updated_at = now()
        WHERE meeting_number = $1 AND occurrence_uuid = $2 AND state IN (${LIVE})`,
      [req.meetingNumber, req.occurrenceUuid, req.drainSeconds ?? DRAIN_SECONDS],
    );
    const released = await client.query<ClaimRow>(
      `UPDATE claims
          SET ${endClaim(`'done'`, `'meeting_ended'`)}, meeting_ended_at = now(), updated_at = now()
        WHERE meeting_number = $1 AND state = 'pending' AND occurrence_uuid = $2
       RETURNING *`,
      [req.meetingNumber, req.occurrenceUuid],
    );
    const written = await client.query(
      `INSERT INTO zoom_ended_occurrences (meeting_number, occurrence_uuid) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.meetingNumber, req.occurrenceUuid],
    );
    await meetingEndsNow(client, req.occurrenceUuid);
    return { released: released.rows, tombstoned: written.rowCount === 1 };
  });
}
