import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { settleBusy, type BusyProtection } from '../busy.ts';
import {
  allocate,
  allocationView,
  briefingOf,
  listAllocations,
  listedAllocationView,
  openClaim,
  recallClaim,
  type ClaimRow,
} from '../claims.ts';
import { requireAdmin, requireOnboardedPerson, type AuthenticatePerson } from '../people-auth.ts';
import { parseZoomLink } from '../zoom-link.ts';
import { RateLimited, type Bucket } from '../rate-limit.ts';
import type { ZoomApi } from '../zoom-api.ts';

const AllocationBody = z.object({ zoom_url: z.string().max(2048) });

const AllocationId = z.object({ id: z.string().uuid() });
/** A recall always names its allocation alone. */
const PatchBody = z.object({ recall: z.literal(true) }).strict();

/** People's allocation routes. Every one needs a signed-in person, on an onboarded install (D149). */
export function allocationRoutes(
  app: FastifyInstance,
  {
    pool,
    authenticatePerson,
    busy,
    zoomApi,
    limitZoom,
  }: {
    pool: pg.Pool;
    authenticatePerson: AuthenticatePerson;
    busy: BusyProtection;
    zoomApi: ZoomApi;
    /** The Zoom bucket (per client address): a send's schedule lookup spends it, and is skipped once it is spent. */
    limitZoom: Bucket;
  },
): void {
  app.register(async (people) => {
    people.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    // Send bwat to a meeting. 202 with the new claim, or 200 already_claimed for a
    // meeting that already has an open one (allocation re-runs while it is pending).
    // A person's send is the explicit invite (D71): Zoom is never asked whether it records,
    // only for the meeting's scheduled end, which times the bot's chat posts. A meeting
    // Zoom cannot tell us about still goes ahead, with no end.
    people.post('/allocations', async (req, reply) => {
      const body = AllocationBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const meeting = parseZoomLink(body.data.zoom_url);
      if (!meeting) return reply.code(422).send({ error: 'not_a_zoom_meeting_link' });

      const scheduledEnd = spends(limitZoom, req)
        ? await zoomApi.meeting(meeting.meetingNumber).then(
            (found) => found?.scheduledEnd ?? null,
            (err: { code?: unknown }) => {
              req.log.warn({ event: 'allocation.schedule_unknown', code: err.code }, 'meeting schedule unknown');
              return null;
            },
          )
        : null;
      const { claim, created, retired } = await openClaim(pool, {
        meetingNumber: meeting.meetingNumber,
        briefing: briefingOf(meeting.passcode, scheduledEnd),
      });
      req.log.info({ event: 'allocation.requested', claim_id: claim.id, created }, 'allocation requested');
      logRetired(req.log, retired);
      const placed = claim.state === 'pending' ? await allocateAndLog(pool, req.log, busy) : [];

      const view = allocationView(placed.find((c) => c.id === claim.id) ?? claim);
      return created ? reply.code(202).send(view) : reply.code(200).send({ ...view, status: 'already_claimed' });
    });

    // Live and recent allocations, newest first.
    people.get('/allocations', async () => ({ allocations: (await listAllocations(pool)).map(listedAllocationView) }));

    // Recall THIS allocation (a pending claim is cancelled; a held claim's bot learns on
    // its next heartbeat).
    people.patch('/allocations/:id', async (req, reply) => {
      const params = AllocationId.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      if (!PatchBody.safeParse(req.body).success) return reply.code(400).send({ error: 'invalid_body' });
      const { id } = params.data;
      // Host recalls use the Zoom route's signed current-meeting context.
      if (!(await requireAdmin(pool, req, reply))) return;
      const claim = await recallClaim(pool, id);
      if (claim === null) return reply.code(404).send({ error: 'not_found' });
      if (claim === 'not_live') return reply.code(409).send({ error: 'not_live' });
      req.log.info({ event: 'allocation.recalled', claim_id: id }, 'allocation recalled');
      return allocationView(claim);
    });
  });
}

/** Logs claims the backend ended for its own reason: each one's id and reason code only. */
export function logRetired(log: FastifyBaseLogger, claims: ClaimRow[]): void {
  for (const claim of claims) {
    log.info({ event: 'claim.retired', claim_id: claim.id, reason: claim.refused_reason }, 'claim retired');
  }
}

/**
 * One allocation step, which is also the sweep: retires lapsed claims, places pending
 * ones, logs both (ids only), tells the busy seam, and returns the placed claims.
 */
export async function allocateAndLog(pool: pg.Pool, log: FastifyBaseLogger, busy: BusyProtection): Promise<ClaimRow[]> {
  const { placed, retired } = await allocate(pool);
  logRetired(log, retired);
  for (const claim of placed) {
    log.info({ event: 'claim.allocated', claim_id: claim.id, bot_id: claim.bot_id }, 'claim allocated');
  }
  await settleBusy(busy, log, placed.map((c) => c.bot_id!));
  return placed;
}

/** Spends one from `bucket` for the request; false, spending nothing, when it is already spent. */
function spends(bucket: Bucket, req: FastifyRequest): boolean {
  try {
    bucket.check(req);
  } catch (err) {
    if (err instanceof RateLimited) return false;
    throw err;
  }
  bucket.count(req);
  return true;
}
