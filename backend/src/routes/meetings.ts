import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../db/pool.ts';
import { Cursor, encodeCursor } from '../http.ts';
import {
  deleteMeeting,
  findMeeting,
  meetingHistory,
  storeTranscript,
  transcriptPage,
  transcriptTail,
  type MeetingRow,
  type SegmentRow,
} from '../meetings.ts';
import { cardServiceOrPerson } from '../card-service.ts';
import { requireAdmin, requireOnboardedPerson, type AuthenticatePerson } from '../people-auth.ts';
import { requireCaller } from './bots.ts';

/** The longest occurrence UUID, as migration 0006's meetings CHECK allows. */
export const OCCURRENCE_MAX_LENGTH = 128;

/** A Zoom occurrence UUID: opaque, may carry `/`, `+` and `=` (sent URL-encoded). */
const Occurrence = z.string().min(1).max(OCCURRENCE_MAX_LENGTH);

/** A non-negative Postgres integer: seq, epoch and the offsets are `int` columns. */
const PgInt = z.number().int().min(0).max(2_147_483_647);

/** Where a segment came from: the meeting's own audio, or its chat (D80). Speech is out (D122/D123). */
export const SEGMENT_SOURCES = ['asr', 'chat'] as const;

const Segment = z
  .object({
    seq: PgInt,
    speaker_label: z.string().min(1).max(200),
    speaker_member_id: z.string().uuid().nullable().optional(),
    speaker_zoom_id: z.string().regex(/^[1-9][0-9]{0,9}$/).refine((id) => Number(id) <= 4_294_967_295).nullable().optional(),
    text: z.string().max(20_000),
    start_ms: PgInt,
    end_ms: PgInt,
    source: z.enum(SEGMENT_SOURCES).default('asr'),
    original_text: z.string().max(20_000).nullable().optional(),
    original_speaker_label: z.string().max(200).nullable().optional(),
    dictionary_version: z.string().max(200).nullable().optional(),
  })
  .refine((s) => s.end_ms >= s.start_ms);

const TranscriptPush = z.object({
  return_segments: z.boolean().optional(),
  epoch: PgInt,
  complete: z.boolean().default(false),
  segments: z.array(Segment).max(500),
});

const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: Cursor(z.tuple([z.string().datetime(), z.string().uuid()]).transform(([t, id]) => ({ started_at: new Date(t), id }))),
  /** `1`: only meetings a bot was in (the admin's Recent meetings); by default every meeting (the board). */
  with_bot: z.literal('1').optional(),
});

const TranscriptQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  cursor: Cursor(z.tuple([PgInt, PgInt]).transform(([epoch, seq]) => ({ epoch, seq }))),
  /** The newest `tail` segments only, oldest of them first, with no cursor: the board's transcript footer. */
  tail: z.coerce.number().int().min(1).max(500).optional(),
});

// The text download reads the transcript this many segments at a time.
const TRANSCRIPT_TEXT_PAGE = 500;

const segmentView = (s: SegmentRow) => ({
  epoch: s.epoch,
  seq: s.seq,
  speaker: { label: s.speaker_label, member_id: s.speaker_member_id,
    ...(s.speaker_zoom_id !== null ? { zoom_id: s.speaker_zoom_id } : {}) },
  text: s.text,
  start_ms: s.start_ms,
  end_ms: s.end_ms,
  source: s.source,
  created_at: s.created_at.toISOString(),
  ...(s.original_text !== null ? { original_text: s.original_text } : {}),
  ...(s.original_speaker_label !== null ? { original_speaker_label: s.original_speaker_label } : {}),
  ...(s.dictionary_version !== null ? { dictionary_version: s.dictionary_version } : {}),
});

/** The history entry people see: no meeting number, no link. */
function meetingView(m: MeetingRow) {
  return {
    id: m.id,
    occurrence_id: m.occurrence_uuid,
    title: m.title,
    host_email: m.host_email,
    started_at: m.started_at,
    ended_at: m.ended_at,
    duration_seconds: m.duration_seconds,
    attendee_count: m.attendee_count,
    transcript_available: m.transcript_available,
    finalization: m.finalization,
    occurrence_state: m.occurrence_state,
    bot_ids: m.bot_ids,
    bot_error: m.bot_error,
    bot_present: m.bot_present,
    ...expiry(m),
  };
}

/** Whether retention deleted the transcript (D163): the meeting and its cards stay. */
const expiry = (m: { transcript_expired_at: Date | null }) => ({
  transcript_expired: m.transcript_expired_at !== null,
  transcript_expired_at: m.transcript_expired_at,
});

/** Meetings and transcripts. Logs carry ids and counts only, never text, labels or titles. */
export function meetingRoutes(
  app: FastifyInstance,
  { pool, authenticatePerson }: { pool: pg.Pool; authenticatePerson: AuthenticatePerson },
): void {
  // People's routes: every one needs a signed-in person, on an onboarded install (D149).
  app.register(async (people) => {
    people.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    // History, newest first, keyset-paged. Any member reads any meeting (D148).
    people.get('/meetings', async (req, reply) => {
      const query = HistoryQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
      const page = await meetingHistory(pool, { limit: query.data.limit, after: query.data.cursor ?? null, withBot: query.data.with_bot === '1' });
      return {
        meetings: page.meetings.map(meetingView),
        next_cursor: page.next && encodeCursor([page.next.started_at.toISOString(), page.next.id]),
      };
    });

    // Admin: delete one meeting and everything about it (legal blocker 3).
    people.delete<{ Params: { meetingId: string } }>('/meetings/:meetingId', async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      const id = z.string().uuid().safeParse(req.params.meetingId);
      if (!id.success) return reply.code(404).send({ error: 'not_found' });
      const result = await deleteMeeting(pool, id.data, admin.id);
      if (!result) return reply.code(404).send({ error: 'not_found' });
      if (result === 'meeting_live') return reply.code(409).send({ error: 'meeting_live' });
      req.log.info({ event: 'meeting.deleted', meeting_id: id.data, ...result }, 'meeting deleted');
      return { meeting_id: id.data, ...result };
    });
  });

  // One meeting's transcript, (epoch, seq) order, paged. The schema is in backend/README.md.
  // The meeting is named by its id or, for the bot feed, which knows only the occurrence,
  // by its Zoom occurrence (URL-encoded; the router decodes it): a canonical UUID is the
  // id, anything else the occurrence. Zoom's occurrence is base64, which has no '-', so
  // it is never UUID-shaped and the two cannot collide.
  // People read it, and so does the card service (QOR-4662) with its credential, on any
  // install and for every meeting.
  app.get<{ Params: { meetingId: string } }>(
    '/meetings/:meetingId/transcript',
    { preHandler: cardServiceOrPerson(pool, authenticatePerson) },
    async (req, reply) => {
      const id = z.string().uuid().safeParse(req.params.meetingId);
      const occurrence = Occurrence.safeParse(req.params.meetingId);
      if (!id.success && !occurrence.success) return reply.code(404).send({ error: 'not_found' });
      const query = TranscriptQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
      // The state and the page come from one snapshot, so an expiry committed between them
      // never reads as transcript_expired false with an empty page.
      const read = await withTransaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const found = await findMeeting(client, id.success ? { id: id.data } : { occurrence: req.params.meetingId });
        if (!found) return undefined;
        const { limit, cursor, tail } = query.data;
        const page = tail
          ? { segments: await transcriptTail(client, found.id, tail), next: null }
          : await transcriptPage(client, found.id, { limit, after: cursor ?? null });
        return { meeting: found, page };
      });
      if (!read) return reply.code(404).send({ error: 'not_found' });
      const { meeting, page } = read;
      return {
        meeting_id: meeting.id,
        occurrence_id: meeting.occurrence_uuid,
        finalization: meeting.finalization,
        complete: meeting.finalization === 'transcript_complete',
        occurrence_state: meeting.occurrence_state,
        ...expiry(meeting),
        segments: page.segments.map(segmentView),
        next_cursor: page.next && encodeCursor([page.next.epoch, page.next.seq]),
      };
    },
  );

  // The board's "Download transcript": the whole transcript as text, a "speaker: text" line a
  // segment, (epoch, seq) order. A live meeting's lines said while it downloads may be in it, and
  // a retention expiry or a deletion that lands mid-download ends the file short.
  app.get<{ Params: { meetingId: string } }>(
    '/meetings/:meetingId/transcript.txt',
    // Who may read it is who may read the transcript above.
    { preHandler: cardServiceOrPerson(pool, authenticatePerson) },
    async (req, reply) => {
      const id = z.string().uuid().safeParse(req.params.meetingId);
      if (!id.success) return reply.code(404).send({ error: 'not_found' });
      const meeting = await findMeeting(pool, { id: id.data });
      if (!meeting) return reply.code(404).send({ error: 'not_found' });
      // Written a page at a time as it is read, each page its own short keyset read, so neither
      // the whole text nor a database connection is held while a slow reader takes it. The first
      // page is read before the answer starts, so a read that fails at once is still an error.
      const read = (after: { epoch: number; seq: number } | null) =>
        transcriptPage(pool, meeting.id, { limit: TRANSCRIPT_TEXT_PAGE, after });
      const text = (page: Awaited<ReturnType<typeof read>>) =>
        page.segments.map((s) => `${s.speaker_label || 'Unknown speaker'}: ${s.text}\n`).join('');
      const first = await read(null);
      async function* lines() {
        yield text(first);
        for (let after = first.next; after; ) {
          const page = await read(after);
          yield text(page);
          after = page.next;
        }
      }
      // An expired transcript answers as the read above does: no lines, and when it expired.
      if (meeting.transcript_expired_at) reply.header('x-transcript-expired-at', meeting.transcript_expired_at.toISOString());
      return reply
        .type('text/plain; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('content-disposition', `attachment; filename="transcript-${meeting.id}.txt"`)
        .send(Readable.from(lines()));
    },
  );

  // The bot pushes transcript segments for the occurrence its claim is in.
  app.post<{ Params: { occurrenceId: string } }>('/meetings/:occurrenceId/transcript', async (req, reply) => {
    const botId = await requireCaller(pool, 'bot', req, reply);
    if (!botId) return reply;
    const occurrence = Occurrence.safeParse(req.params.occurrenceId);
    const body = TranscriptPush.safeParse(req.body);
    if (!occurrence.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await storeTranscript(pool, { botId, occurrence: occurrence.data, ...body.data });
    if (result.status !== 'stored') {
      req.log.info({ event: `transcript.${result.status}`, bot_id: botId }, 'transcript push refused');
      return reply.code(409).send({ error: result.status });
    }
    req.log.info(
      { event: 'transcript.stored', meeting_id: result.meetingId, epoch: body.data.epoch, stored: result.stored, complete: body.data.complete,
        ...(result.segments ? {
          identified_speakers: new Set(result.segments.filter((s) => s.speaker_zoom_id).map((s) => s.speaker_zoom_id)).size,
          unresolved_speakers: new Set(result.segments.filter((s) => s.speaker_zoom_id && !s.speaker_member_id).map((s) => s.speaker_zoom_id)).size,
        } : {}) },
      'transcript stored',
    );
    return result.segments ? { segments: result.segments } : reply.code(204).send();
  });
}
