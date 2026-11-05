import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.ts';
import type pg from 'pg';
import type { CardsClient } from '../cards-client.ts';
import { withTransaction } from '../db/pool.ts';
import { hasOwner } from '../members.ts';
import { notOnboarded, requireAdmin, requirePerson, type AuthenticatePerson } from '../people-auth.ts';
import { requireCaller } from './bots.ts';

type Readiness = { check(): Promise<{ ready: boolean; problems: string[] }> };

/**
 * The onboarding page's routes (QOR-4334, setup/onboard), behind its bwi_ credential only.
 * GET /install/status: the facts the page's checks tick its steps from. No secret value,
 * no name, no meeting content: whether an owner has signed in, whether a Claude Code session
 * signed in to bwat has registered (the plugin's PUT /sessions), whether Zoom is ready for
 * automatic joining (and what is missing), whether a meeting has been transcribed, and
 * how many cards bwat has written (null while the install has no card service).
 *
 * PUT /install/checklist: the page's unfinished steps, which replace the admin panel's
 * "Finish setting up" list (an item already ticked keeps its tick). The panel reads it
 * with GET /setup-checklist and ticks an item with POST /setup-checklist/{id}/done,
 * owners and admins only, each tick audited.
 */
export function installRoutes(
  app: FastifyInstance,
  { pool, autoJoinReadiness, cards, authenticatePerson }:
  { pool: pg.Pool; autoJoinReadiness: Readiness; cards: CardsClient | undefined; authenticatePerson: AuthenticatePerson },
): void {
  app.get('/install/status', async (req, reply) => {
    if (!(await requireCaller(pool, 'install', req, reply))) return reply;
    const [owner, connected, zoom, transcribed, count] = await Promise.all([
      hasOwner(pool),
      pool.query(`SELECT 1 FROM sessions LIMIT 1`),
      autoJoinReadiness.check(),
      pool.query(`SELECT 1 FROM transcript_segments LIMIT 1`),
      cards?.cardCount ? cards.cardCount().catch(() => null) : Promise.resolve(null),
    ]);
    return {
      owner_signed_in: owner,
      claude_connected: (connected.rowCount ?? 0) > 0,
      zoom: { ready: zoom.ready, problems: zoom.problems },
      meeting_transcribed: (transcribed.rowCount ?? 0) > 0,
      cards: count,
    };
  });

  // The page revokes its own credential once its installer deletes its records.
  app.post('/install/revoke', async (req, reply) => {
    const id = await requireCaller(pool, 'install', req, reply);
    if (!id) return reply;
    await pool.query(`UPDATE install_credentials SET revoked_at = now() WHERE id = $1`, [id]);
    return reply.code(204).send();
  });

  app.put('/install/checklist', { bodyLimit: 128 * 1024 }, async (req, reply) => {
    if (!(await requireCaller(pool, 'install', req, reply))) return reply;
    const items = checklist(req.body);
    if (!items) return reply.code(400).send({ error: 'invalid_body' });
    await withTransaction(pool, async (client) => {
      await client.query(`DELETE FROM setup_checklist_items WHERE NOT (id = ANY($1::text[]))`, [items.map((i) => i.id)]);
      for (const [position, item] of items.entries()) {
        await client.query(
          `INSERT INTO setup_checklist_items (id, position, title, detail, link) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET position = $2, title = $3, detail = $4, link = $5`,
          [item.id, position, item.title, item.detail, item.link],
        );
      }
      await audit(client, { actor: null, action: 'setup_checklist.replaced', target: 'setup_checklist', after: { ids: items.map((i) => i.id) } });
    });
    return reply.code(204).send();
  });

  app.register(async (panel) => {
    panel.addHook('preHandler', requirePerson(authenticatePerson));
    panel.addHook('preHandler', notOnboarded(pool));

    panel.get('/setup-checklist', async (req, reply) => {
      if (!(await requireAdmin(pool, req, reply))) return reply;
      const { rows } = await pool.query(
        `SELECT id, title, detail, link, done_at, done_by FROM setup_checklist_items ORDER BY position`,
      );
      return { items: rows };
    });

    panel.post<{ Params: { id: string } }>('/setup-checklist/:id/done', async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      // An unknown id updates nothing, so committing it is the same as rolling it back.
      const item = await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `UPDATE setup_checklist_items SET done_at = coalesce(done_at, now()), done_by = coalesce(done_by, $2)
           WHERE id = $1 RETURNING id, title, detail, link, done_at, done_by`,
          [req.params.id, admin.id],
        );
        if (!rows[0]) return null;
        await audit(client, { actor: admin.id, action: 'setup_checklist.done', target: 'setup_checklist', after: { id: req.params.id } });
        return rows[0];
      });
      return item ?? reply.code(404).send({ error: 'unknown_item' });
    });
  });
}

type Item = { id: string; title: string; detail: string; link: string | null };

/** The page's list, checked: at most 100 items, each as the table allows. */
function checklist(body: unknown): Item[] | null {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length > 100) return null;
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const raw of items) {
    const { id, title, detail = '', link = null } = (raw ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id) || seen.has(id)) return null;
    if (typeof title !== 'string' || title.length < 1 || title.length > 200) return null;
    if (typeof detail !== 'string' || detail.length > 2000) return null;
    if (link !== null && (typeof link !== 'string' || !/^https:\/\//.test(link) || link.length > 500)) return null;
    seen.add(id);
    out.push({ id, title, detail, link });
  }
  return out;
}
