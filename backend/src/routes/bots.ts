import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { BusyProtection } from '../busy.ts';
import { digest, newToken, presentedToken, resolveBotCaller, type BotCaller } from '../credentials.ts';
import { assignmentForToken, claimView } from '../claims.ts';
import { allocateAndLog } from './allocations.ts';

const RegisterBody = z
  .object({
    version: z.string().max(64).optional(),
    // The bot's own ECS task, which the fleet protects while it holds a meeting (QOR-4888).
    task_arn: z.string().regex(/^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task\/[A-Za-z0-9_-]+\/[A-Za-z0-9]+$/).optional(),
  })
  .passthrough();

const ReadyBody = z.object({ ready: z.boolean().default(true) }).passthrough();

/**
 * The id of the `kind` of caller behind this request, or null after answering: 401
 * without a credential we know, and 409 unregistered_bot for a fleet credential on a
 * bot route (the bot must register first).
 */
export async function requireCaller(
  pool: pg.Pool,
  kind: BotCaller['kind'],
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const found = await resolveBotCaller(pool, req.headers.authorization);
  if (found?.kind === kind) return found.id;
  if (kind === 'bot' && found?.kind === 'fleet') await reply.code(409).send({ error: 'unregistered_bot' });
  else await reply.code(401).send({ error: 'unauthorized' });
  return null;
}

/** Bot routes. Bots poll; the backend never calls a bot. */
export function botRoutes(
  app: FastifyInstance,
  { pool, busy, feedKey }: { pool: pg.Pool; busy: BusyProtection; feedKey: Buffer | undefined },
): void {
  // A bot presents its fleet credential and gets back its own id and bot token, once.
  app.post('/bots/register', async (req, reply) => {
    const fleetCredentialId = await requireCaller(pool, 'fleet', req, reply);
    if (!fleetCredentialId) return reply;
    const body = RegisterBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const token = newToken('bwb');
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO bots (fleet_credential_id, token_sha256, version, task_arn)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [fleetCredentialId, digest(token), body.data.version ?? null, body.data.task_arn ?? null],
    );
    const botId = rows[0]!.id;
    req.log.info({ event: 'bot.registered', bot_id: botId }, 'bot registered');
    return { bot_id: botId, bot_token: token };
  });

  // The bot asserts it can take a meeting (bridge listening, SDK authed); only the bot
  // can know this. `ready: false` withdraws it without deregistering.
  app.post('/bots/ready', async (req, reply) => {
    const botId = await requireCaller(pool, 'bot', req, reply);
    if (!botId) return reply;
    const body = ReadyBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const { ready } = body.data;
    await pool.query(
      `UPDATE bots SET ready_at = CASE WHEN $2 THEN now() END, last_heartbeat = now() WHERE id = $1`,
      [botId, ready],
    );
    req.log.info({ event: ready ? 'bot.ready' : 'bot.withdrawn', bot_id: botId }, 'bot readiness');
    if (ready) await allocateAndLog(pool, req.log, busy);
    return { bot_id: botId, ready };
  });

  // The bot polls for its claim: the Claim, or null when it has none. A bot token is
  // resolved together with its claim in one query; anything else is refused (409/401).
  app.get('/assignment', async (req, reply) => {
    const token = presentedToken(req.headers.authorization);
    if (token?.kind !== 'bot') return (await requireCaller(pool, 'bot', req, reply), reply);
    const claim = await assignmentForToken(pool, token.digest);
    if (claim === undefined) return reply.code(401).send({ error: 'unauthorized' });
    return claim && claimView(claim, feedKey);
  });
}
