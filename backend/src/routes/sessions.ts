import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { requireOnboardedPerson, signedInPerson, type AuthenticatePerson } from '../people-auth.ts';
import { clearDefaultSession, defaultSession, liveSessions, putSession, setDefaultSession } from '../sessions.ts';

/**
 * A client session id: not a UUID (Codex thread ids are not confirmed UUIDs). 8-128
 * characters from `A-Za-z0-9._-`, starting with a letter or digit (QOR-4598). Stricter
 * than the column's CHECK (migration 0008), which is left as it is.
 */
export const SessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/);

/** The contract's cap on a session PUT. A larger body is 413 too_large. */
const SESSION_BODY_LIMIT_BYTES = 4 * 1024;

/** A session keyword: a plain lowercase token. */
const KEYWORD = /^[a-z0-9][a-z0-9.-]{1,31}$/;

/** Unknown keys are dropped, never stored. cwd is the last path segment only. */
const SessionClient = z.object({
  kind: z.enum(['claude-code', 'codex', 'mcp']),
  wake: z.enum(['push', 'mailbox', 'pull']),
  machine: z.string().min(1).max(200),
  platform: z.string().min(1).max(64),
  plugin_version: z.string().min(1).max(64),
  name: z.string().max(200).optional(),
  cwd: z
    .string()
    .max(255)
    .refine((cwd) => !/[/\\]/.test(cwd))
    .optional(),
  /** What the session is working on, worked out by the plugin: plain lowercase tokens, shown only to its owner. */
  // A keyword that is not one is dropped, never the heartbeat: a plugin newer than this server
  // must not knock its session off the list.
  keywords: z
    .array(z.unknown())
    .optional()
    .transform((list) => list?.filter((k): k is string => typeof k === 'string' && KEYWORD.test(k)).slice(0, 24)),
});

const SessionPut = z.object({
  client: SessionClient,
  instance_id: z.string().min(1).max(128),
  ended: z.boolean().default(false),
});

/**
 * Client sessions (QOR-4589, D144). People's routes (D149), the caller's own sessions
 * only. Logs carry event names and ids, never a descriptor (machine, cwd, name).
 */
export function sessionRoutes(app: FastifyInstance, { pool, authenticatePerson }: { pool: pg.Pool; authenticatePerson: AuthenticatePerson }): void {
  app.register(async (people) => {
    people.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    people.put<{ Params: { sessionId: string } }>('/sessions/:sessionId', { bodyLimit: SESSION_BODY_LIMIT_BYTES }, async (req, reply) => {
      const id = SessionId.safeParse(req.params.sessionId);
      const body = SessionPut.safeParse(req.body);
      if (!id.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      const person = signedInPerson(req);
      const result = await putSession(pool, person.id, id.data, body.data);
      if (result.registered) req.log.info({ event: 'session.registered', member_id: person.id, session_id: id.data }, 'session registered');
      if (result.ended) req.log.info({ event: 'session.ended', member_id: person.id, session_id: id.data }, 'session ended');
      return result.session;
    });

    people.get('/sessions', async (req) => liveSessions(pool, signedInPerson(req).id));

    // The member's default session for Send to Claude: their own sessions only.
    people.put<{ Params: { sessionId: string } }>('/sessions/:sessionId/default', async (req, reply) => {
      const id = SessionId.safeParse(req.params.sessionId);
      if (!id.success || !(await setDefaultSession(pool, signedInPerson(req).id, id.data))) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    });
    people.delete<{ Params: { sessionId: string } }>('/sessions/:sessionId/default', async (req, reply) => {
      const id = SessionId.safeParse(req.params.sessionId);
      if (!id.success || !(await clearDefaultSession(pool, signedInPerson(req).id, id.data))) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    });
    people.get('/me/default-session', async (req) => (await defaultSession(pool, signedInPerson(req).id)) ?? {});
  });
}
