import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { BusyProtection } from '../busy.ts';
import { CardsUnavailable, type CardsClient } from '../cards-client.ts';
import { feedHostAllowed } from '../feed.ts';
import { claimView, heartbeat, heldClaim, idleHeartbeat, MAX_TRANSCRIPT_EPOCH, promoteOccurrence, releaseClaim } from '../claims.ts';
import type { GetSecret } from '../config.ts';
import { recordMeetingFacts } from '../meetings.ts';
import { SECRET } from '../secret-names.ts';
import { SecretUnavailable } from '../secrets/store.ts';
import { settingDef } from '../settings/catalogue.ts';
import { readStoredSetting } from '../settings/store.ts';
import { meetingSdkJwt, ZoomUnavailable, type ZoomApi } from '../zoom-api.ts';
import { allocateAndLog, logRetired } from './allocations.ts';
import { requireCaller } from './bots.ts';
import { requiredZoomSecrets } from './zoom.ts';

/** A machine code (a state, an error, a reason), never free text: free text could quote the meeting. */
const Code = z.string().max(64).regex(/^[a-z][a-z0-9_]*$/);

/** A count stored in a PostgreSQL integer: anything outside it is refused here, not by the database. */
const Count = z.number().int().nonnegative().max(2147483647);

/** A report field the backend cannot store is dropped, never refused: a report must not cost a bot its lease. */
const dropped = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);

/** The contract's BotStatus. Unknown and unusable fields are dropped, so a newer bot is not refused. */
const BotStatus = z.object({
  state: dropped(Code),
  joined: dropped(z.boolean()),
  recording: dropped(z.boolean()),
  hearing: dropped(z.boolean()),
  muted: dropped(z.boolean()),
  error: dropped(Code.nullable()),
  dictionary_sha256: dropped(z.string().regex(/^[0-9a-f]{64}$/)),
  version: dropped(z.string().max(64)),
  // Where the bot serves the feed (bot/bwat_bot/feed.py): refused, not dropped, when unusable.
  feed_host: z.string().max(64).refine(feedHostAllowed).optional(),
  feed_port: z.number().int().min(1).max(65535).optional(),
});

/**
 * The fence (claim_id, generation) and the transcript epoch (at most MAX_TRANSCRIPT_EPOCH)
 * must be usable, or the heartbeat is refused (400); the report never refuses it. With a
 * claim, or with neither claim_id nor generation from an idle bot.
 */
const HeartbeatBody = BotStatus.extend({
  claim_id: z.string().uuid().optional(),
  generation: Count.optional(),
  transcript_epoch: Count.max(MAX_TRANSCRIPT_EPOCH).optional(),
}).refine((b) => (b.claim_id === undefined) === (b.generation === undefined));

/** Names this bot's claim: the claim and the generation the bot believes it holds. */
const Held = z.object({ claim_id: z.string().uuid(), generation: Count });

/** Zoom's occurrence UUID: base64, so '/', '+' and '=' are part of it. */
const OccurrenceBody = Held.extend({
  occurrence_uuid: z.string().regex(/^[A-Za-z0-9+/=_-]{1,128}$/),
  // Optional SDK metadata must never cause an otherwise valid promotion to fail.
  meeting_title: dropped(z.string().refine((title) => !title.includes('\0'))
    .transform((title) => Array.from(title.replace(/\s+/g, ' ').trim()).slice(0, 200).join('') || undefined)),
});

/**
 * A plain release (could not join, recalled, ...) stores its reason, and one whose reason
 * is a failed placement (RETRY_REASONS) is requeued by the backend; `meeting_ended`
 * leaves the meeting's tombstone; `requeue` (the bot is being stopped mid-meeting)
 * hands the meeting back to the pool and ignores the reason.
 */
const ReleaseBody = Held.extend({
  reason: Code.optional(),
  meeting_ended: z.boolean().optional(),
  requeue: z.boolean().optional(),
}).refine((b) => !(b.requeue && b.meeting_ended));

/** Which list the bot posts in the meeting chat: the agenda on joining, or the open questions at the five-minute warning. */
const ChatCardsBody = Held.extend({ list: z.enum(['agenda', 'questions']) });

/** The event each refusal logs. */
const REFUSED = {
  stale_claim: 'claim.stale',
  stale_epoch: 'epoch.stale',
  occurrence_conflict: 'occurrence.refused',
  meeting_already_ended: 'occurrence.refused',
} as const satisfies Record<string, string>;

/**
 * 409 for a bot call on a claim it does not hold (stale_claim: leave the meeting) or an
 * occurrence it may not record. Logs the event, the ids and the code; never the body.
 */
function refuse(req: FastifyRequest, reply: FastifyReply, error: keyof typeof REFUSED, ids: { claimId: string; botId: string }) {
  const event = REFUSED[error];
  req.log.info({ event, code: error, claim_id: ids.claimId, bot_id: ids.botId }, 'bot call refused');
  return reply.code(409).send({ error });
}

/** A bot's own claim: heartbeat, occurrence and release. The bot id comes from its token. */
export function assignmentRoutes(
  app: FastifyInstance,
  {
    pool,
    busy,
    getSecret,
    zoomApi,
    feedKey,
    later,
    cards,
    clock = Date.now,
  }: {
    pool: pg.Pool;
    busy: BusyProtection;
    getSecret: GetSecret;
    zoomApi: ZoomApi;
    feedKey: Buffer | undefined;
    /** Runs a task after the answer is sent (the meeting's title and host from Zoom). */
    later: (task: () => Promise<void>) => void;
    /** The card service, for what the bot posts in the meeting chat; none on an install without one. */
    cards?: CardsClient | undefined;
    clock?: () => number;
  },
): void {
  app.post('/assignment/heartbeat', async (req, reply) => {
    const botId = await requireCaller(pool, 'bot', req, reply);
    if (!botId) return reply;
    const body = HeartbeatBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const { claim_id: claimId, generation, transcript_epoch: transcriptEpoch, ...status } = body.data;
    if (claimId === undefined || generation === undefined) {
      // An idle ready bot pulls waiting work: it may have been stale when the claim opened.
      if (await idleHeartbeat(pool, botId, status)) await allocateAndLog(pool, req.log, busy);
      return null;
    }
    const claim = await heartbeat(pool, { botId, claimId, generation, transcriptEpoch, status });
    // stale_epoch: an epoch this occurrence already used. The lease is not renewed.
    if (typeof claim === 'string') return refuse(req, reply, claim, { claimId, botId });
    return claimView(claim, feedKey);
  });

  // The bot reports the occurrence once Zoom provides it; the claim is promoted.
  app.post('/assignment/occurrence', async (req, reply) => {
    const botId = await requireCaller(pool, 'bot', req, reply);
    if (!botId) return reply;
    const body = OccurrenceBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const { claim_id: claimId, generation, occurrence_uuid: occurrenceUuid, meeting_title: meetingTitle } = body.data;
    const promoted = await promoteOccurrence(pool, { botId, claimId, generation, occurrenceUuid, meetingTitle });
    if ('error' in promoted) {
      // A claim sent into an ended meeting has ended: its bot is free for waiting work.
      if (promoted.error === 'meeting_already_ended') await allocateAndLog(pool, req.log, busy);
      return refuse(req, reply, promoted.error, { claimId, botId });
    }
    // The meeting's title and host, from Zoom, after the answer: the bot is not kept waiting
    // on Zoom. Without the S2S app there is nothing to ask. Logs a code only, never either value.
    const meetingNumber = promoted.claim.meeting_number;
    const log = req.log;
    later(async () => {
      try {
        const found = await zoomApi.meeting(meetingNumber);
        if (found) await recordMeetingFacts(pool, occurrenceUuid, found);
      } catch (err) {
        log.info({ event: 'zoom.meeting_facts', outcome: 'failed', code: (err as { code?: unknown }).code }, 'zoom meeting facts');
      }
    });
    return claimView(promoted.claim, feedKey);
  });

  // The bot hands its claim back.
  app.post('/assignment/release', async (req, reply) => {
    const botId = await requireCaller(pool, 'bot', req, reply);
    if (!botId) return reply;
    const body = ReleaseBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const { claim_id: claimId, generation, reason, meeting_ended: meetingEnded, requeue } = body.data;
    const how = requeue ? 'requeue' : meetingEnded ? 'meeting_ended' : 'release';
    const released = await releaseClaim(pool, { botId, claimId, generation, reason: reason ?? null, how });
    if (!released) return refuse(req, reply, 'stale_claim', { claimId, botId });
    // Pending again (a requeue, or a failed placement the backend retries) or ended. The
    // bot's own reason is never logged; an exhausted claim logs the backend's code.
    const status = released.state === 'pending' ? 'requeued' : 'released';
    if (released.state === 'abandoned') logRetired(req.log, [released]);
    req.log.info({ event: `claim.${status}`, claim_id: claimId, bot_id: botId }, 'claim handed back');
    // The bot is free: re-run allocation so it takes waiting work.
    await allocateAndLog(pool, req.log, busy);
    return { status };
  });

  // What the bot posts in the meeting chat, from the card service. Fenced as a heartbeat is;
  // without a card service, or while it is down, 503 and the bot posts nothing of it.
  app.post('/assignment/chat-cards', async (req, reply) => {
    const botId = await requireCaller(pool, 'bot', req, reply);
    if (!botId) return reply;
    const body = ChatCardsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const { claim_id: claimId, generation, list } = body.data;
    const held = await heldClaim(pool, { botId, claimId, generation });
    if (!held) return refuse(req, reply, 'stale_claim', { claimId, botId });
    const listed = await cards
      ?.meetingChat({ list, meeting_number: held.meeting_number, occurrence_uuid: held.occurrence_uuid })
      .catch((err: unknown) => {
        if (err instanceof CardsUnavailable) return undefined;
        throw err;
      });
    if (!listed) {
      req.log.warn({ event: 'cards.unavailable', claim_id: claimId }, 'meeting chat cards unavailable');
      return reply.code(503).send({ error: 'unavailable' });
    }
    return listed;
  });

  // The bot's Zoom credentials for its claim's meeting, minted here so the bot holds no
  // Zoom app secret. Fenced as a heartbeat is; never logged, never cached by a proxy.
  app.post('/assignment/join-token', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const botId = await requireCaller(pool, 'bot', req, reply);
    if (!botId) return reply;
    const body = Held.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const { claim_id: claimId, generation } = body.data;
    const held = await heldClaim(pool, { botId, claimId, generation });
    if (!held) return refuse(req, reply, 'stale_claim', { claimId, botId });
    const credentials = await requiredZoomSecrets(getSecret, [SECRET.zoomClientId, SECRET.zoomClientSecret], 'zoom app credentials', req, reply);
    if (!credentials) return reply;
    const [clientId, clientSecret] = credentials;
    // The recording token is the S2S app's: without it the bot still joins, so a failure
    // to get one is a code beside the SDK JWT, never a failed call.
    let recording: Awaited<ReturnType<ZoomApi['recordingToken']>> = null;
    let recordingError: 'not_configured' | 'not_found' | 'zoom_unavailable' | 'secret_unavailable' | undefined;
    try {
      recording = await zoomApi.recordingToken(held.meeting_number, await bypassWaitingRoom(pool));
      if (!recording) recordingError = 'not_configured';
    } catch (err) {
      if (err instanceof ZoomUnavailable && err.status === 404) recordingError = 'not_found';
      else if (err instanceof ZoomUnavailable) {
        recordingError = 'zoom_unavailable';
        req.log.warn({ event: 'zoom.unavailable', status: err.status, claim_id: claimId }, 'zoom recording token unavailable');
      } else if (err instanceof SecretUnavailable) {
        recordingError = 'secret_unavailable';
        req.log.error({ event: 'zoom.secret_unavailable' }, 'zoom S2S credentials unreadable');
      } else throw err;
    }
    const sdk = meetingSdkJwt({ clientId, clientSecret, meetingNumber: held.meeting_number, nowMs: clock() });
    req.log.info(
      { event: 'zoom.join_token', claim_id: claimId, bot_id: botId, recording: recording !== null, recording_error: recordingError },
      'join token minted',
    );
    return {
      sdk_jwt: sdk.token,
      sdk_jwt_expires_at: sdk.expiresAt,
      recording_token: recording?.token ?? null,
      recording_token_expires_at: recording?.expiresAt ?? null,
      ...(recordingError && { recording_token_error: recordingError }),
    };
  });
}

/** The admin's "Skip the waiting room", or its default while unset (QOR-4893). */
async function bypassWaitingRoom(pool: pg.Pool): Promise<boolean> {
  return ((await readStoredSetting(pool, 'bypass_waiting_room')) ?? settingDef('bypass_waiting_room')!.codeDefault) === true;
}
