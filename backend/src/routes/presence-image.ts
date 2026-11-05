import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { audit } from '../audit.ts';
import { asAdminWrite } from '../members.ts';
import { requireAdmin, requireOnboardedPerson, type AuthenticatePerson } from '../people-auth.ts';
import {
  imageShape,
  isSixteenByNine,
  presenceImageTag,
  lockedSummary,
  PRESENCE_IMAGE_MAX_BYTES,
  readPresenceImage,
} from '../settings/presence-image.ts';
import { matches } from './bot-settings.ts';
import { requireCaller } from './bots.ts';

const PATH = '/console/settings/presence-image';
const tagOf = (sha256: string) => `"${sha256}"`;

/**
 * The picture the bot shows as its video (D196): an owner's or admin's upload, or, with
 * none, the logo the bot ships with. The console routes are admin only, reading included;
 * a bot reads it with its own bot token before each join. No route logs the bytes.
 */
export function presenceImageRoutes(
  app: FastifyInstance,
  { pool, authenticatePerson }: { pool: pg.Pool; authenticatePerson: AuthenticatePerson },
): void {
  app.register(async (panel) => {
    panel.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));
    // The upload is the raw picture, in this scope only; any other type is 415.
    panel.addContentTypeParser(['image/png', 'image/jpeg'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    panel.get(PATH, async (req, reply) => {
      if (!(await requireAdmin(pool, req, reply))) return reply;
      const image = await readPresenceImage(pool);
      reply.header('cache-control', 'no-store');
      if (!image) return reply.code(204).send();
      return reply.header('content-type', image.contentType).header('etag', tagOf(image.sha256)).send(image.bytes);
    });

    panel.put(PATH, { bodyLimit: PRESENCE_IMAGE_MAX_BYTES }, async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      // Only the parser above yields a Buffer: JSON or text, parsed by the app's own, is 415 too.
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'unsupported_media_type' });
      const bytes = req.body;
      const shape = imageShape(bytes);
      if (!shape) return reply.code(400).send({ error: 'not_an_image' });
      if (!isSixteenByNine(shape.width, shape.height)) return reply.code(400).send({ error: 'not_16_9' });
      // Larger than 4K is never needed for a 1280x720 tile, and a bot would spend long rendering it.
      if (shape.width > 3840 || shape.height > 2160) return reply.code(400).send({ error: 'too_many_pixels' });
      const after = { sha256: createHash('sha256').update(bytes).digest('hex'), content_type: shape.contentType, bytes: bytes.length };

      const saved = await asAdminWrite(pool, admin.id, async (client) => {
        const before = await lockedSummary(client);
        await client.query(
          `INSERT INTO presence_image (id, content_type, bytes, sha256, updated_by, updated_at) VALUES (true, $1, $2, $3, $4, now())
           ON CONFLICT (id) DO UPDATE SET content_type = $1, bytes = $2, sha256 = $3, updated_by = $4, updated_at = now()`,
          [shape.contentType, bytes, after.sha256, admin.id],
        );
        await audit(client, { actor: admin.id, action: 'presence_image.set', target: 'presence_image', before, after });
      });
      if (saved === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      req.log.info({ event: 'presence_image.saved', content_type: shape.contentType, bytes: bytes.length }, 'presence image saved');
      return reply.code(204).send();
    });

    panel.delete(PATH, async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      const removed = await asAdminWrite(pool, admin.id, async (client) => {
        const before = await lockedSummary(client);
        if (before) {
          await client.query('DELETE FROM presence_image');
          await audit(client, { actor: admin.id, action: 'presence_image.removed', target: 'presence_image', before, after: null });
        }
      });
      if (removed === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      req.log.info({ event: 'presence_image.removed' }, 'presence image back to the default');
      return reply.code(204).send();
    });
  });

  // Read before each join. 204: show the default; 304: the picture the bot holds is current.
  app.get('/bot/presence-image', async (req, reply) => {
    const botId = await requireCaller(pool, 'bot', req, reply);
    if (!botId) return reply;
    reply.header('cache-control', 'no-store');
    // The tag first: a bot that holds the picture already gets 304 without the bytes being read.
    const sha256 = await presenceImageTag(pool);
    if (!sha256) return reply.code(204).send();
    if (matches(req.headers['if-none-match'], tagOf(sha256))) return reply.header('etag', tagOf(sha256)).code(304).send();
    const image = await readPresenceImage(pool);
    if (!image) return reply.code(204).send();
    const tag = tagOf(image.sha256);
    reply.header('etag', tag);
    req.log.info({ event: 'bot.presence_image_read', bot_id: botId }, 'bot read the presence image');
    return reply.header('content-type', image.contentType).send(image.bytes);
  });
}
