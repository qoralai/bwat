import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { Cursor, encodeCursor } from '../http.ts';
import { CardsUnavailable, type CardsClient } from '../cards-client.ts';
import { repeatedHandoff, BODY_MAX, deleteMessage, inboxMessage, inboxPage, markRead, sendHandoff, SUBJECT_MAX, type MessageRow } from '../inbox.ts';
import { requireOnboardedPerson, signedInPerson, type AuthenticatePerson } from '../people-auth.ts';
import { SessionId } from './sessions.ts';

/** A request over this is 413 too_large before it is parsed; a brief over the contract's caps is 413 after. */
const HANDOFF_BODY_LIMIT_BYTES = 64 * 1024;

const NOTE_MAX = 1000;

const HandoffPost = z.object({
  source_kind: z.enum(['card', 'todo']),
  source_id: z.string().uuid(),
  occurrence_id: z.string().uuid().optional(),
  target_session_id: SessionId,
  request_key: z.string().min(1).max(128),
  // The brief: a card's comes from the card service when the install has one (QOR-4620);
  // otherwise the caller renders it.
  subject: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  // The sender's own words for the recipient, after a card's brief.
  note: z.string().max(NOTE_MAX).optional(),
});

const InboxQuery = z.object({
  // Not z.coerce.boolean(): that reads "false" as true.
  unread_only: z.enum(['true', 'false']).default('false'),
  scope: z.enum(['session', 'all']).default('all'),
  // Checked only for scope=session: scope=all ignores it.
  client_session: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: Cursor(z.tuple([z.string().datetime(), z.string().uuid()]).transform(([t, id]) => ({ created_at: new Date(t), id }))),
});

const MessageId = z.string().uuid();

/** A hand-off message as the inbox answers it: no sender or recipient, the caller is the recipient. */
const messageView = (m: MessageRow) => ({
  id: m.id,
  message_type: 'handoff',
  created_at: m.created_at,
  read_at: m.read_at,
  target_client_session: m.target_client_session,
  source: { kind: m.source_kind, id: m.source_id, ...(m.occurrence_id && { occurrence_id: m.occurrence_id }) },
  handoff_id: m.handoff_id,
  subject: m.subject,
  ...(m.body !== undefined && { body: m.body }),
});

/**
 * POST /handoffs and the caller's inbox (QOR-4589). People's routes (D149). Logs carry
 * event names and ids only, never a subject or a body.
 */
export function inboxRoutes(
  app: FastifyInstance,
  {
    pool,
    authenticatePerson,
    cards,
    boardUrl,
  }: { pool: pg.Pool; authenticatePerson: AuthenticatePerson; cards: CardsClient | undefined; boardUrl: string | undefined },
): void {
  app.register(async (people) => {
    people.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    // Queued is the only state any answer may claim: a hand-off is never started here.
    people.post('/handoffs', { bodyLimit: HANDOFF_BODY_LIMIT_BYTES }, async (req, reply) => {
      const body = HandoffPost.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const person = signedInPerson(req);
      // A card's brief, from the card service as this member (D162).
      const fromCard = body.data.source_kind === 'card' && cards !== undefined;
      let brief = { subject: body.data.subject, body: body.data.body };
      if (fromCard) {
        // A repeat answers the first hand-off without asking the card service again.
        const repeated = await repeatedHandoff(pool, person.id, body.data.request_key);
        if (repeated) return reply.code(202).send({ handoff_id: repeated, status: 'queued' });
        try {
          const card = await cards.brief(body.data.source_id, person.id);
          // The brief has no link back: the board's address goes at the end (BWAT_PUBLIC_URL).
          // The stored message is capped (migration 0008), so the cap below counts the link.
          const note = body.data.note?.trim();
          const text = note ? `${card.body}\n\nNote from the sender: ${note}` : card.body;
          brief = { subject: card.subject, body: boardUrl ? `${text}\n\nBoard: ${boardUrl.replace(/\/$/, '')}/` : text };
        } catch (err) {
          if (!(err instanceof CardsUnavailable)) throw err;
          req.log.warn({ event: 'cards.unavailable', card_id: body.data.source_id }, 'card brief unavailable');
          return reply.code(502).send({ error: 'cards_unavailable' });
        }
      }
      const { subject, body: text } = brief;
      if (subject === undefined || text === undefined) return reply.code(400).send({ error: 'invalid_body' });
      if (subject.length > SUBJECT_MAX || text.length > BODY_MAX) return reply.code(413).send({ error: 'too_large' });
      const result = await sendHandoff(pool, person.id, { ...body.data, subject, body: text });
      if (result === 'meeting_deleted') return reply.code(409).send({ error: 'meeting_deleted' });
      if (result === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      if (result === 'session_unreachable') {
        req.log.info({ event: 'handoff.session_unreachable', member_id: person.id, session_id: body.data.target_session_id }, 'hand-off refused');
        return reply.code(409).send({ error: 'session_unreachable' });
      }
      req.log.info({ event: 'handoff.queued', member_id: person.id, handoff_id: result.handoff_id, session_id: body.data.target_session_id }, 'hand-off queued');
      // The card shows "queued" once told. A failed call is logged and not retried (a repeat
      // answers from the first hand-off); the hand-off stands either way.
      if (fromCard && result.created) {
        const routed = { handoff_id: result.handoff_id, by_member_id: person.id, at: new Date().toISOString() };
        await cards.routed(body.data.source_id, routed).catch((err: unknown) => {
          if (!(err instanceof CardsUnavailable)) throw err;
          req.log.warn({ event: 'cards.routed_failed', card_id: body.data.source_id, handoff_id: result.handoff_id }, 'card not told it was routed');
        });
      }
      return reply.code(202).send({ handoff_id: result.handoff_id, status: 'queued' });
    });

    // The caller's messages, oldest first, keyset-paged; no body (read each by id).
    people.get('/me/inbox', async (req, reply) => {
      const query = InboxQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
      const { unread_only, scope, client_session, limit, cursor } = query.data;
      if (scope === 'session' && client_session === undefined) return reply.code(400).send({ error: 'invalid_query' });
      if (scope === 'session' && !SessionId.safeParse(client_session).success) return reply.code(400).send({ error: 'invalid_query' });
      const page = await inboxPage(pool, signedInPerson(req).id, {
        unreadOnly: unread_only === 'true',
        session: scope === 'session' ? client_session! : null,
        limit,
        after: cursor ?? null,
      });
      return {
        messages: page.messages.map(messageView),
        ...(page.next && { next_cursor: encodeCursor([page.next.created_at.toISOString(), page.next.id]) }),
      };
    });

    // Another member's message is answered as one that does not exist (D148): 404, never 403.
    people.get<{ Params: { id: string } }>('/me/inbox/:id', async (req, reply) => {
      const id = MessageId.safeParse(req.params.id);
      const message = id.success && (await inboxMessage(pool, signedInPerson(req).id, id.data));
      if (!message) return reply.code(404).send({ error: 'not_found' });
      return messageView(message);
    });

    people.patch<{ Params: { id: string } }>('/me/inbox/:id', async (req, reply) => {
      const id = MessageId.safeParse(req.params.id);
      const person = signedInPerson(req);
      const read = id.success && (await markRead(pool, person.id, id.data));
      if (!read) return reply.code(404).send({ error: 'not_found' });
      // The card shows "Read" once told, as it shows "Queued". Every mark tells it (the card
      // records a hand-off's read once), so marking again heals a call that failed; a failed
      // call is logged and the message is read either way.
      if (read.source_kind === 'card' && cards !== undefined) {
        const handoffRead = { handoff_id: read.handoff_id, by_member_id: person.id, at: read.read_at.toISOString() };
        await cards.handoffRead(read.source_id, handoffRead).catch((err: unknown) => {
          if (!(err instanceof CardsUnavailable)) throw err;
          req.log.warn({ event: 'cards.handoff_read_failed', card_id: read.source_id, handoff_id: read.handoff_id }, 'card not told its hand-off was read');
        });
      }
      return { id: read.id, read_at: read.read_at };
    });

    people.delete<{ Params: { id: string } }>('/me/inbox/:id', async (req, reply) => {
      const id = MessageId.safeParse(req.params.id);
      const person = signedInPerson(req);
      // Any well-formed id answers 204, whoever's it is: a delete never tells whether one exists (D148).
      if (!id.success) return reply.code(404).send({ error: 'not_found' });
      await deleteMessage(pool, person.id, id.data);
      req.log.info({ event: 'inbox.message_deleted', member_id: person.id, message_id: id.data }, 'inbox message deleted');
      return reply.code(204).send();
    });
  });
}
