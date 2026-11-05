import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { BusyProtection } from '../busy.ts';
import type { GetSecret } from '../config.ts';
import { inviteOccurrence, meetingBotStatus, OPEN, recallClaim } from '../claims.ts';
import { requireOnboardedPerson, signedInPerson, type AuthenticatePerson } from '../people-auth.ts';
import { zoomAppContext } from '../zoom-app-context.ts';
import { ZoomUnavailable, type ZoomApi } from '../zoom-api.ts';
import { recordZoomSpeaker } from '../zoom-speakers.ts';
import { allocateAndLog, logRetired } from './allocations.ts';
import { perMinute } from '../rate-limit.ts';
import { isAdmin, type Member } from '../members.ts';
import { SECRET } from '../secret-names.ts';

const Body = z.object({
  context: z.string().max(8192), invite: z.boolean().default(false), leave: z.boolean().default(false),
  participant_id: z.string().max(64).optional(),
}).strict()
  .refine(body => !(body.invite && body.leave));

export function zoomInviteRoutes(app: FastifyInstance, deps: {
  pool: pg.Pool; authenticatePerson: AuthenticatePerson; getSecret: GetSecret; busy: BusyProtection; zoomApi: ZoomApi;
}) {
  const { pool, authenticatePerson, getSecret, busy, zoomApi } = deps;
  const invitations = perMinute('zoom', 30);
  app.register(async people => {
    people.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));
    people.post('/zoom/meeting-bot', { bodyLimit: 10 * 1024 }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const ctx = zoomAppContext(parsed.data.context, (await getSecret(SECRET.zoomBoardClientSecret)) ?? '', Date.now());
      if (!ctx) return reply.code(400).send({ error: 'invalid_context' });
      const member = await pool.query<Pick<Member, 'role'>>(`SELECT role FROM members WHERE id = $1 AND zoom_user_id = $2 AND activated_at IS NOT NULL`, [signedInPerson(req).id, ctx.uid]);
      if (!member.rowCount) return reply.code(403).send({ error: 'wrong_zoom_identity' });
      if (ctx.bmid) return { state: 'breakout', can_invite: false };
      if (!ctx.mid) return { state: 'outside_meeting', can_invite: false };
      if (!/^[A-Za-z0-9+/=_-]{1,128}$/.test(ctx.mid)) return reply.code(400).send({ error: 'invalid_context' });
      if (parsed.data.participant_id) {
        // Only who is speaking is lost if it fails: the status check still answers.
        await recordViewer(pool, ctx.mid, parsed.data.participant_id, ctx.uid)
          .catch((err: { code?: unknown }) => req.log.warn({ event: 'zoom.viewer_unrecorded', code: err.code }, 'zoom viewer not recorded'));
      }
      const status = await meetingBotStatus(pool, ctx.mid);
      // Do not let a long-lived context preserve host powers after a host transfer.
      const age = Date.now() - (ctx.issuedAtMs ?? 0);
      const permitted = isAdmin(member.rows[0]!) || (ctx.attendrole === 'host' && age >= 0 && age <= 30_000);
      const active = await pool.query<{ id: string }>(`SELECT id FROM claims WHERE occurrence_uuid = $1 AND state IN (${OPEN}) ORDER BY created_at DESC LIMIT 1`, [ctx.mid]);
      if (parsed.data.leave) {
        if (!permitted) return reply.code(403).send({ error: 'leave_forbidden' });
        if (!active.rows[0]) return { ...status, can_leave: false, occurrence_id: ctx.mid };
        await recallClaim(pool, active.rows[0].id);
        return { state: 'leaving', can_invite: false, can_leave: false, occurrence_id: ctx.mid };
      }
      if (!parsed.data.invite || !status.can_invite) return { ...status, can_leave: permitted && !!active.rows[0], occurrence_id: ctx.mid };
      invitations.check(req); invitations.count(req);
      let meeting;
      try { meeting = await zoomApi.meetingForInvite(ctx.mid); }
      catch (err) {
        if (!(err instanceof ZoomUnavailable)) throw err;
        req.log.warn({ zoom_status: err.status }, 'Zoom meeting invitation lookup failed');
        return reply.code(503).send({ error: 'meeting_lookup_failed' });
      }
      if (!meeting) return reply.code(503).send({ error: 'zoom_lookup_not_configured' });
      const result = await inviteOccurrence(pool, {
        meetingNumber: meeting.meetingNumber, occurrenceUuid: ctx.mid,
        briefing: meeting.passcode === null ? {} : { passcode: meeting.passcode },
      });
      logRetired(req.log, result.retired);
      if ('error' in result) return reply.code(409).send({ error: result.error });
      await allocateAndLog(pool, req.log, busy);
      return { ...(await meetingBotStatus(pool, ctx.mid)), occurrence_id: ctx.mid };
    });
  });
}

/**
 * The panel viewer's own speaker id under their signed Zoom user. Accepted gap: participantId is
 * not in Zoom's signed context, so it only fills an id nobody has mapped. The board asks every few
 * seconds: an id already mapped is left alone, without the meeting's lock.
 */
async function recordViewer(pool: pg.Pool, occurrence: string, participantId: string, zoomUserId: string) {
  const { rows } = await pool.query<{ meeting_number: string }>(`SELECT meeting_number FROM (
      SELECT meeting_number FROM meetings WHERE occurrence_uuid = $1
      UNION ALL SELECT meeting_number FROM claims WHERE occurrence_uuid = $1 LIMIT 1) attended
    WHERE NOT EXISTS (SELECT 1 FROM zoom_speakers WHERE occurrence_uuid = $1 AND speaker_zoom_id = $2)`, [occurrence, participantId]);
  if (rows[0]) await recordZoomSpeaker(pool, rows[0].meeting_number, occurrence, { user_id: participantId, participant_user_id: zoomUserId }, { clientSupplied: true });
}
