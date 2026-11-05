import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { AutoJoinSwitch } from './auto-join-switch.ts';
import type { AutoJoinReadiness } from './auto-join-readiness.ts';
import type { BusyProtection } from './busy.ts';
import { briefingOf, endMeeting, openOccurrenceClaim } from './claims.ts';
import type { ZoomConfig } from './config.ts';
import { allocateAndLog, logRetired } from './routes/allocations.ts';
import { MEETING_NUMBER, retryOnce, scheduledEndOf, transientStatus, ZOOM_EVENT_KINDS, type ZoomApi } from './zoom-api.ts';
import { linkZoomByEmail, type EmailLinkOutcome } from './zoom-board-signin.ts';
import { forgetUnattendedSpeakers, recordZoomSpeaker } from './zoom-speakers.ts';

/** A verified Zoom webhook body. Meeting content: never logged. */
interface ZoomEvent {
  event: string;
  event_ts?: number | undefined;
  payload?: { account_id?: unknown; object?: unknown } | undefined;
}

export interface ZoomDeps {
  pool: pg.Pool;
  /** The delivery's body sha256: recorded with the change it makes, so it is acted on once. */
  deliveryKey: Buffer;
  zoom: ZoomConfig;
  autoJoinSwitch: AutoJoinSwitch;
  autoJoinReadiness: AutoJoinReadiness;
  deliveryObserved: Promise<void>;
  busy: BusyProtection;
  log: FastifyBaseLogger;
  zoomApi: ZoomApi;
  /** The meeting lookups' shared state, one per server (meetingLookups). */
  lookups: MeetingLookups;
  /** Runs `task` after the answer is sent (the meeting lookup); the server waits for it before it closes. */
  later: (task: () => Promise<void>) => void;
  /** The email domains in force: only an email in one of them links a Zoom account (linkJoinedByEmail). */
  allowedDomains: () => Promise<readonly string[]>;
}

/** The event type for the log: one handled here by name, or `other` (a type is never free text in a log). */
export const kindOf = (event: string) => (ZOOM_EVENT_KINDS.has(event) ? event : 'other');

/** What handling an event did, as a code; and the claim it touched, if any. */
interface Handled {
  outcome: string;
  claimId?: string | undefined;
}

/** The meeting an event is about: its number (9 to 12 digits), occurrence and scheduled end, or null. */
function meetingOf(event: ZoomEvent): Meeting | null {
  const object = (event.payload?.object ?? {}) as Record<string, unknown>;
  const id = typeof object.id === 'number' || typeof object.id === 'string' ? String(object.id) : '';
  if (!MEETING_NUMBER.test(id)) return null;
  const uuid = typeof object.uuid === 'string' && object.uuid.length > 0 && object.uuid.length <= 128 ? object.uuid : null;
  return { meetingNumber: id, occurrenceUuid: uuid, scheduledEnd: scheduledEndOf(object) };
}

/**
 * A start older than this is not acted on: a delivery retried long after the fact
 * must not send bwat into a meeting that is over.
 */
const MAX_EVENT_AGE_MS = 10 * 60_000;

type Meeting = { meetingNumber: string; occurrenceUuid: string | null; scheduledEnd?: string | null };

/**
 * meeting.ended releases; meeting.started (or, when the host must be present,
 * meeting.participant_joined) sends bwat on its own when auto-join allows it. Other
 * events are ignored.
 */
export async function handleZoomEvent(event: ZoomEvent, deps: ZoomDeps): Promise<Handled> {
  // Meeting allocation happens first: a speaker-store failure may request delivery
  // retry, but cannot prevent a host's arrival from opening/offering the claim.
  const handled = await handleMeetingEvent(event, deps);
  // Arriving before the host: bwat attends once the host comes, unless the switch is off.
  const awaitingHost = handled.outcome === 'not_host' && (await deps.autoJoinSwitch.isOn());
  await recordJoinedSpeaker(event, deps, awaitingHost);
  linkJoinedByEmail(event, deps);
  return handled;
}

/** Email-link outcomes that are every join of a linked person, or nothing to act on: logged at debug only. */
const QUIET_LINK_OUTCOMES: ReadonlySet<string> = new Set<EmailLinkOutcome>(['already_linked', 'no_member', 'domain_not_allowed', 'invalid', 'not_configured']);

/**
 * A signed arrival naming both the participant's Zoom account and its email links that
 * account to the member with that email (QOR-5111), whatever meeting it is, once Zoom's API
 * confirms the email is that account's (linkZoomByEmail). An email without the account, a
 * guest's, is never tried. It runs after the answer (`later`): it may ask Zoom, and it never
 * fails the delivery. A link logs at info; a conflict, an unconfirmed email or a failure that
 * may pass at warn; the rest only at debug. Never the email or the account.
 */
function linkJoinedByEmail(event: ZoomEvent, { pool, log, allowedDomains, zoomApi, later }: ZoomDeps): void {
  if (event.event !== 'meeting.participant_joined') return;
  const { participant } = (event.payload?.object ?? {}) as { participant?: { participant_user_id?: unknown; email?: unknown } };
  const zoomUserId = participant?.participant_user_id;
  const email = participant?.email;
  if (typeof zoomUserId !== 'string' || !zoomUserId || typeof email !== 'string' || !email.trim()) return;
  later(async () => {
    let outcome: string;
    let status: unknown;
    let code: unknown;
    try {
      outcome = await linkZoomByEmail(pool, {
        zoomUserId,
        email,
        allowedDomains: await allowedDomains(),
        confirmedEmail: (id) => zoomApi.userEmail(id),
      });
    } catch (err) {
      // Zoom not answering, not finding the user (404: not on this account) or answering about
      // anyone else is no link, logged with Zoom's status; anything else (the database) with its code.
      ({ code, status } = err as { code?: unknown; status?: unknown });
      outcome = code === 'zoom_unavailable' || code === 'secret_unavailable' ? code : 'failed';
    }
    // A refusal from Zoom that will not pass (a missing user:read:user:admin, a user not on this
    // account) answers every such join alike: debug, so it does not bury an outage.
    const settled = outcome === 'zoom_unavailable' && !transientStatus(status);
    const level = outcome === 'linked' ? 'info' : QUIET_LINK_OUTCOMES.has(outcome) || settled ? 'debug' : 'warn';
    const detail = outcome === 'failed' ? { code } : status === undefined ? {} : { status };
    log[level]({ event: 'zoom.email_link', outcome, ...detail }, 'zoom account linked by email');
  });
}

async function recordJoinedSpeaker(event: ZoomEvent, deps: ZoomDeps, awaitingHost = false): Promise<void> {
  if (event.event === 'meeting.participant_joined') {
    const meeting = meetingOf(event);
    if (meeting?.occurrenceUuid) {
      const object = event.payload?.object as { participant?: unknown };
      await recordZoomSpeaker(deps.pool, meeting.meetingNumber, meeting.occurrenceUuid, object.participant, { awaitingHost });
    }
  }
}

async function handleMeetingEvent(event: ZoomEvent, deps: ZoomDeps): Promise<Handled> {
  if (event.event === 'meeting.ended') {
    // An end names its occurrence: one that does not cannot say which sitting ended.
    const meeting = meetingOf(event);
    return meeting?.occurrenceUuid
      ? meetingEnded({ ...meeting, occurrenceUuid: meeting.occurrenceUuid }, deps)
      : { outcome: 'ignored_no_meeting' };
  }
  const starts = event.event === 'meeting.started';
  if (!starts && event.event !== 'meeting.participant_joined') return { outcome: 'ignored' };
  if (!deps.zoom.autoJoin) return { outcome: 'auto_join_off' };
  // The env is the ceiling (A109): a stored false relaxes it, nothing can force it on.
  const requireHost = deps.zoom.requireHost && (await deps.autoJoinSwitch.requiresHost());
  // Waiting for the host, the start only says so; the host's arrival decides.
  // Not waiting, the start decides and arrivals change nothing.
  if (starts && requireHost) return { outcome: 'waiting_for_host' };
  if (!starts && !requireHost) return { outcome: 'ignored' };
  if (!starts && !hostArrived(event)) return { outcome: 'not_host' };
  const meeting = meetingOf(event);
  if (!meeting) return { outcome: 'ignored_no_meeting' };
  return autoJoin(event, meeting, deps);
}

/** How long auto-join waits for the host before anyone arriving will do. */
const HOST_WAIT_MS = 4 * 60_000;

/**
 * Whether a participant_joined lets bwat in: the host arriving (the participant's
 * Zoom user id, participant_user_id or the deprecated id, is the meeting's host_id; a
 * missing id never matches, so a guest is never taken for the host), or anyone once the
 * host is HOST_WAIT_MS late, so an absent host or a missed delivery does not leave the
 * meeting unattended.
 */
function hostArrived(event: ZoomEvent): boolean {
  const object = (event.payload?.object ?? {}) as {
    host_id?: unknown;
    participant?: { id?: unknown; participant_user_id?: unknown };
    start_time?: unknown;
  };
  const hostId = object.host_id;
  const { id, participant_user_id: userId } = object.participant ?? {};
  if (typeof hostId === 'string' && hostId !== '' && (hostId === userId || hostId === id)) return true;
  const started = typeof object.start_time === 'string' ? Date.parse(object.start_time) : NaN;
  const now = typeof event.event_ts === 'number' ? event.event_ts : Date.now();
  return Number.isFinite(started) && now - started > HOST_WAIT_MS;
}

/**
 * Opens a claim for the meeting and offers it to a ready bot, unless the event is
 * stale or the stored switch is off. The switch is read through its cache; a failed
 * read throws, so nothing is opened and the delivery is retried (fail closed). A claim
 * already open (a person's send) is only stamped with the occurrence: nobody new joins.
 * A new claim is opened only once the meeting is looked up (lookUpMeeting).
 */
async function autoJoin(event: ZoomEvent, meeting: Meeting, deps: ZoomDeps): Promise<Handled> {
  if (typeof event.event_ts === 'number' && Date.now() - event.event_ts > MAX_EVENT_AGE_MS) {
    return { outcome: 'stale_event' };
  }
  if (!(await deps.autoJoinSwitch.isOn())) return { outcome: 'switched_off' };
  const handled = await openAndOffer(meeting, deps);
  return handled.outcome === 'not_open' ? lookUpMeeting(event, meeting, deps) : handled;
}

/**
 * Opens the meeting's claim (openOccurrenceClaim) and offers a pending one to a ready bot.
 * Without `lookedUp` it only finds a claim already open: `not_open` when there is none.
 * A claim it opens carries the looked-up passcode (none: the meeting has none) and the
 * scheduled end from Zoom's event, which times the bot's chat posts.
 */
async function openAndOffer(
  meeting: Meeting,
  { pool, busy, log, deliveryKey }: ZoomDeps,
  lookedUp?: { passcode: string | null },
): Promise<Handled> {
  const briefing = lookedUp && briefingOf(lookedUp.passcode, meeting.scheduledEnd);
  const opened = await openOccurrenceClaim(pool, { ...meeting, deliveryKey, ...(briefing && { briefing }) });
  if ('duplicate' in opened) return { outcome: 'duplicate' };
  logRetired(log, opened.retired);
  if ('ended' in opened) return { outcome: 'already_ended' };
  if ('unknown' in opened) return { outcome: 'not_open' };
  const { claim, created } = opened;
  if (claim.state === 'pending') await allocateAndLog(pool, log, busy);
  return { outcome: created ? 'claim_opened' : 'already_claimed', claimId: claim.id };
}

/** How long a missing meeting (404) is kept for its occurrence. */
export const LOOKUP_NEGATIVE_TTL_MS = 60_000;
/** The most occurrences kept with a no; past it, the oldest goes. */
const LOOKUP_NEGATIVE_MAX = 1_000;

/**
 * What the meeting lookups share: the occurrences being looked up (one lookup per
 * occurrence at a time) and those Zoom gave a final no for, each kept LOOKUP_NEGATIVE_TTL_MS.
 * Both are kept by occurrence, so a meeting's next occurrence is always looked up: the host
 * may have changed the meeting meanwhile, and its delivery is already recorded. A meeting
 * that names no occurrence is never held back. A failure that may pass is never kept.
 */
export interface MeetingLookups {
  /** Starts a lookup: null, or why none is needed (`lookup_in_flight`, `lookup_cached`). */
  begin(meeting: Meeting): 'lookup_in_flight' | 'lookup_cached' | null;
  /** Ends a lookup begun, keeping a final no when `refused`. */
  end(meeting: Meeting, refused: boolean): void;
  /** The pause before a retry. */
  sleep(ms: number): Promise<void>;
}

/** The occurrence's key (a meeting number is digits only), or null when it names none. */
const occurrenceKey = ({ meetingNumber, occurrenceUuid }: Meeting) => (occurrenceUuid === null ? null : `${meetingNumber}:${occurrenceUuid}`);

export function meetingLookups({
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): MeetingLookups {
  const running = new Set<string>();
  /** Occurrence key to when its no runs out, oldest first. */
  const refusals = new Map<string, number>();
  return {
    begin(meeting) {
      const key = occurrenceKey(meeting);
      if (key === null) return null;
      if (running.has(key)) return 'lookup_in_flight';
      const until = refusals.get(key);
      if (until !== undefined && now() < until) return 'lookup_cached';
      refusals.delete(key);
      running.add(key);
      return null;
    },
    end(meeting, refused) {
      const key = occurrenceKey(meeting);
      if (key === null) return;
      running.delete(key);
      if (!refused) return;
      refusals.delete(key);
      refusals.set(key, now() + LOOKUP_NEGATIVE_TTL_MS);
      if (refusals.size > LOOKUP_NEGATIVE_MAX) refusals.delete(refusals.keys().next().value!);
    },
    sleep,
  };
}


/**
 * After acknowledging Zoom, verify setup and look up the current passcode. Every
 * account meeting is eligible regardless of automatic recording. Single-flight and
 * bounded 404 caching avoid repeated lookups; transient meeting failures retry once.
 * Recheck the admin preference and configuration before claiming. The occurrence
 * transaction still refuses ended or duplicate meetings. Never log meeting content.
 */
async function lookUpMeeting(event: ZoomEvent, meeting: Meeting, deps: ZoomDeps): Promise<Handled> {
  const logged = (outcome: string, more: object = {}, level: 'info' | 'warn' = 'info') =>
    deps.log[level]({ event: 'zoom.meeting_lookup', outcome, ...more }, 'zoom meeting lookup');
  const skipped = deps.lookups.begin(meeting);
  if (skipped) return { outcome: skipped };
  // Until the lookup is handed to `later`, which ends it, it ends here: not configured or
  // an unreadable store is no answer from Zoom, so nothing is kept.
  let handedOff = false;
  try {
    try {
      if (!(await deps.zoomApi.configured())) return { outcome: 'recording_unknown' };
    } catch {
      logged('secret_unavailable');
      return { outcome: 'recording_unknown' };
    }
    const deliveryKey = createHash('sha256').update(deps.deliveryKey).update('passcode_lookup').digest();
    deps.later(async () => {
      let refused = false;
      try {
        await deps.deliveryObserved;
        const readiness = await deps.autoJoinReadiness.check(event.payload?.account_id ?? null);
        if (!readiness.ready) return logged('not_ready', {}, 'warn');
        const found = await retryOnce(() => deps.zoomApi.meeting(meeting.meetingNumber), deps.lookups.sleep);
        if (!found) return logged('not_configured');
        // The admin may turn joining off or rotate credentials while Zoom is answering.
        // Read the preference fresh across backend processes, immediately before claiming.
        if (!(await deps.autoJoinReadiness.unchanged(readiness.fingerprint))) return logged('configuration_changed');
        if (!(await deps.autoJoinSwitch.isOn(true))) return logged('switched_off');
        const { outcome, claimId } = await openAndOffer(meeting, { ...deps, deliveryKey }, found);
        await recordJoinedSpeaker(event, deps);
        logged(outcome, { claim_id: claimId });
      } catch (err) {
        // A store or Zoom code is the outcome; anything else (a database error) is `failed`, with its code.
        const { code, status } = err as { code?: unknown; status?: unknown };
        if (code === 'zoom_unavailable') {
          refused = status === 404;
          logged(code, { status }, transientStatus(status) ? 'warn' : 'info');
        } else if (code === 'secret_unavailable') logged(code);
        else logged('failed', { code });
      } finally {
        deps.lookups.end(meeting, refused);
      }
    });
    handedOff = true;
    return { outcome: 'meeting_lookup' };
  } finally {
    if (!handedOff) deps.lookups.end(meeting, false);
  }
}

/**
 * The end of an occurrence is always recorded, whatever auto-join says, and releases the
 * pending claims naming it, a person's send too. A held claim stays live for its bot to
 * drain, for at most zoom.drainSeconds (endMeeting). A freed bot is offered the next waiting meeting.
 */
async function meetingEnded(meeting: Meeting & { occurrenceUuid: string }, { pool, zoom, busy, log, deliveryKey }: ZoomDeps): Promise<Handled> {
  const ended = await endMeeting(pool, { ...meeting, deliveryKey, drainSeconds: zoom.drainSeconds });
  if ('duplicate' in ended) return { outcome: 'duplicate' };
  const { released, tombstoned } = ended;
  for (const claim of released) log.info({ event: 'claim.released', claim_id: claim.id }, 'claim released');
  if (released.some((c) => c.bot_id)) await allocateAndLog(pool, log, busy);
  // Best effort: the end is already recorded, so a retry would not get here; retention's day cap backs it up.
  await forgetUnattendedSpeakers(pool, meeting.occurrenceUuid)
    .catch((err: { code?: unknown }) => log.warn({ event: 'zoom.speakers_unforgotten', code: err.code }, 'zoom speakers not forgotten'));
  if (released.length) return { outcome: 'released', claimId: released[0]!.id };
  return { outcome: tombstoned ? 'tombstoned' : 'already_ended' };
}
