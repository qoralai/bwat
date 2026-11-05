import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { audit } from '../../audit.ts';
import { withTransaction } from '../../db/pool.ts';
import { CardIdsQuery, chars, idParam } from '../../http.ts';
import { adminForWrite, isAdmin, memberById, UUID } from '../../members.ts';
import { requireOnboardedPerson, signedInPerson } from '../../people-auth.ts';
import { perMinute } from '../../rate-limit.ts';
import type { BwatPlugin } from '../plugin.ts';
import { CADENCES, dayIn, isIsoDate, isMonday, isTimezone, periodOf, type Cadence, type Period } from './periods.ts';

/**
 * Goals (QOR-4921): a company's goals for a period (a week by default), linked to the cards that
 * serve them. Rebuilt as a plugin from the core goals of QOR-4891 (taken out by QOR-4906/QOR-4924).
 * Any member reads, adds drafts, edits and links cards; an owner or admin promotes, dismisses,
 * decides outcomes and sets the rhythm, checked in the write's own transaction. Its data is the
 * goals schema (migrations/plugins/goals). Routes under /v1/plugins/goals; README.md lists them.
 */
export const NAME = 'goals';

type Db = pg.Pool | pg.ClientBase;

/** The one goal list (option A): its rhythm. */
export interface GoalList {
  id: string;
  name: string;
  cadence: Cadence;
  timezone: string;
  anchor: string;
  revision: number;
}

export type GoalState = 'draft' | 'goal' | 'dismissed';
export type Outcome = 'met' | 'missed' | 'carried';

/** A goal as every route answers it. Names the last editor by display name, never by email. */
export interface Goal {
  id: string;
  list_id: string;
  period_start: string;
  title: string;
  summary: string;
  details: string;
  state: GoalState;
  position: number;
  outcome: Outcome | null;
  carried_from: string | null;
  revision: number;
  updated_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  /** "G1", "G2", ...: its place among its period's goals (state goal) in board order; null for a draft or a dismissed goal. */
  label: string | null;
}

const LIST_SELECT = `SELECT id, name, cadence, timezone, anchor::text AS anchor, revision FROM goals.lists`;
const GOAL_SELECT = `
  SELECT g.id, g.list_id, g.period_start::text AS period_start, g.title, g.summary, g.details, g.state, g.position,
         g.outcome, g.carried_from, g.revision, m.display_name AS updated_by_name, g.created_at, g.updated_at, NULL AS label
    FROM goals.goals g LEFT JOIN bwat.members m ON m.id = g.updated_by`;
// By the day each was set for first, so a period that spans several of an earlier rhythm's keeps their order.
const BOARD_ORDER = `ORDER BY g.period_start, g.position, g.created_at, g.id`;

/** The one list. Seeded by the migration, never deleted. */
export async function theList(db: Db): Promise<GoalList> {
  return (await db.query<GoalList>(`${LIST_SELECT} ORDER BY created_at, id LIMIT 1`)).rows[0]!;
}

/** Labels a period's goals, in board order: G1, G2, ... for its goals, null for the rest. */
function labelled<G extends { state: GoalState }>(goals: G[]): (G & { label: string | null })[] {
  let n = 0;
  return goals.map((g) => ({ ...g, label: g.state === 'goal' ? `G${++n}` : null }));
}

/** The goals of [from, to) in board order; dismissed ones only when asked. Unlabelled. */
async function goalsIn(db: Db, list: GoalList, from: string, to: string, dismissed: boolean): Promise<Goal[]> {
  const { rows } = await db.query<Goal>(
    `${GOAL_SELECT} WHERE g.list_id = $1 AND g.period_start >= $2 AND g.period_start < $3 AND ($4 OR g.state <> 'dismissed') ${BOARD_ORDER}`,
    [list.id, from, to, dismissed],
  );
  return rows;
}

/** A period's goals in board order, labelled; dismissed ones only when asked. */
export async function periodGoals(db: Db, list: GoalList, period: Period, { dismissed = false } = {}): Promise<Goal[]> {
  return labelled(await goalsIn(db, list, period.start, period.end, dismissed));
}

/** Two periods back to back (this one and the next), in one read, each labelled. */
async function twoPeriods(db: Db, list: GoalList, first: Period, second: Period): Promise<[Goal[], Goal[]]> {
  const all = await goalsIn(db, list, first.start, second.end, false);
  return [labelled(all.filter((g) => g.period_start < first.end)), labelled(all.filter((g) => g.period_start >= first.end))];
}

/** One goal by id, labelled within the period its date falls in under the list's rhythm, or null. */
export async function goalById(db: Db, id: string, list?: GoalList): Promise<Goal | null> {
  const { rows } = await db.query<Goal>(`${GOAL_SELECT} WHERE g.id = $1`, [id]);
  const goal = rows[0];
  if (!goal || goal.state !== 'goal') return goal ?? null;
  const l = list ?? (await theList(db));
  const period = periodOf(goal.period_start, l.cadence, l.anchor);
  // its place among the period's goals, in board order
  const { rows: before } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM goals.goals o
      WHERE o.list_id = $1 AND o.period_start >= $2 AND o.period_start < $3 AND o.state = 'goal'
        AND (o.period_start, o.position, o.created_at, o.id) < ($4::date, $5::int, $6::timestamptz, $7::uuid)`,
    [l.id, period.start, period.end, goal.period_start, goal.position, goal.created_at, goal.id],
  );
  return { ...goal, label: `G${before[0]!.n + 1}` };
}

/** The position after a period's last goal. */
async function nextPosition(db: Db, list: GoalList, period: Period): Promise<number> {
  const { rows } = await db.query<{ p: number }>(
    `SELECT coalesce(max(position) + 1, 0)::int AS p FROM goals.goals WHERE list_id = $1 AND period_start >= $2 AND period_start < $3`,
    [list.id, period.start, period.end],
  );
  return rows[0]!.p;
}

// A Postgres integer: a larger number would be a cast error (a 500).
const Revision = z.number().int().min(1).max(2_147_483_647);
const Title = z
  .string()
  .transform((s) => s.trim())
  .pipe(chars(80).refine((s) => s.length >= 1, 'a title'));
const Summary = chars(280);
const Details = chars(10_000);
// Years 2000-2999: a period's end must stay a four-digit year Postgres reads.
const IsoDate = z.string().regex(/^2\d{3}-\d{2}-\d{2}$/).refine(isIsoDate, 'a date');
const Position = z.number().int().min(-1_000_000).max(1_000_000);

const GoalsQuery = z.object({ date: IsoDate.optional(), include: z.literal('dismissed').optional() }).strict();
const NewGoal = z
  .object({ title: Title, summary: Summary.default(''), details: Details.default(''), date: IsoDate.optional() })
  .strict();
const GoalChange = z
  .object({ revision: Revision, title: Title.optional(), summary: Summary.optional(), details: Details.optional(), position: Position.optional() })
  .strict()
  .refine((b) => b.title !== undefined || b.summary !== undefined || b.details !== undefined || b.position !== undefined, 'a change');
const AtRevision = z.object({ revision: Revision }).strict();
const OutcomeChange = z.object({ revision: Revision, outcome: z.enum(['met', 'missed', 'carried']).nullable() }).strict();
const CardGoal = z.object({ goal_id: z.string().regex(UUID) }).strict();
const ListChange = z
  .object({
    revision: Revision,
    name: z.string().transform((s) => s.trim()).pipe(chars(80).refine((s) => s.length >= 1, 'a name')).optional(),
    cadence: z.enum(CADENCES).optional(),
    timezone: z.string().refine(isTimezone, 'a timezone').optional(),
    anchor: IsoDate.refine(isMonday, 'a Monday').optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'a change');


type Refusal = { status: number; error: string; goal?: Goal };
const refuse = (reply: FastifyReply, r: Refusal) => reply.code(r.status).send({ error: r.error, ...(r.goal && { goal: r.goal }) });
const FORBIDDEN: Refusal = { status: 403, error: 'forbidden' };
const NOT_FOUND: Refusal = { status: 404, error: 'not_found' };
const isRefusal = <T extends object>(v: T | Refusal): v is Refusal => 'error' in v;

/** The goal locked for this write, or the refusal: unknown, or read at another revision. */
async function lockedAt(client: pg.ClientBase, id: string, revision: number): Promise<Goal | Refusal> {
  const { rows } = await client.query<{ revision: number }>(`SELECT revision FROM goals.goals WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) return NOT_FOUND;
  const goal = (await goalById(client, id))!;
  return rows[0].revision === revision ? goal : { status: 409, error: 'stale_revision', goal };
}

const FOREIGN_KEY_VIOLATION = '23503';
/** Goals a member may add a minute: a person adds a few; a runaway client is stopped. */
export const ADDS_PER_MEMBER_PER_MIN = 30;
/** A write's body: a goal's text (details up to 10 000 characters) with room for its encoding. */
const WRITE_BODY_LIMIT = 64 * 1024;

export const goals: BwatPlugin = {
  name: NAME,
  displayName: 'Goals',
  description: "Set the team's goals for the week and tie cards to them.",
  routes(api, { pool, authenticatePerson, now }) {
    // Keyed by member: a product calling for many people may come from one address.
    const adds = perMinute('plugin_write', ADDS_PER_MEMBER_PER_MIN, { now });
    /** The list and the period holding today in its timezone, by the server's clock. */
    const today = async (db: Db = pool) => {
      const list = await theList(db);
      return { list, current: periodOf(dayIn(now(), list.timezone), list.cadence, list.anchor) };
    };

    api.register(async (people) => {
      people.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

      /**
       * GET /current: the list, this period's goals and the next period's (what the board and any product reading goals show),
       * and whether the reader may promote, dismiss and decide outcomes (`can_decide`), so the board offers only what they may do.
       */
      people.get('/current', async (req) => {
        const { list, current } = await today();
        const next = periodOf(current.end, list.cadence, list.anchor);
        const [[goals, upcoming], member] = await Promise.all([twoPeriods(pool, list, current, next), memberById(pool, signedInPerson(req).id)]);
        return { list, period: current, goals, next: { period: next, goals: upcoming }, can_decide: !!member && isAdmin(member) };
      });

      /** GET /goals?date=&include=dismissed: the goals of the period holding `date` (default today). */
      people.get('/goals', async (req, reply) => {
        const query = GoalsQuery.safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
        const { list, current } = await today();
        const period = query.data.date ? periodOf(query.data.date, list.cadence, list.anchor) : current;
        return { period, goals: await periodGoals(pool, list, period, { dismissed: query.data.include === 'dismissed' }) };
      });

      people.get('/goals/:id', async (req, reply) => {
        const id = idParam(req);
        const goal = id ? await goalById(pool, id) : null;
        return goal ?? refuse(reply, NOT_FOUND);
      });

      /** GET /goals/:id/cards: the cards serving the goal, for the board narrowed to it: {goal: {id, label, title}, card_ids}. */
      people.get('/goals/:id/cards', async (req, reply) => {
        const id = idParam(req);
        if (!id) return refuse(reply, NOT_FOUND);
        const [goal, { rows }] = await Promise.all([
          goalById(pool, id),
          pool.query<{ card_id: string }>(`SELECT card_id FROM goals.card_links WHERE goal_id = $1`, [id]),
        ]);
        if (!goal) return refuse(reply, NOT_FOUND);
        return { goal: { id: goal.id, label: goal.label, title: goal.title }, card_ids: rows.map((r) => r.card_id) };
      });

      /** POST /goals {title, summary?, details?, date?}: a draft in the period holding `date` (default today); never a past period. */
      people.post('/goals', { bodyLimit: WRITE_BODY_LIMIT }, async (req, reply) => {
        const member = signedInPerson(req).id;
        adds.check(req, member);
        const body = NewGoal.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
        adds.count(req, member);
        const { title, summary, details, date } = body.data;
        const id = await withTransaction(pool, async (client): Promise<string | Refusal> => {
          const { list, current } = await today(client);
          const period = date ? periodOf(date, list.cadence, list.anchor) : current;
          if (period.start < current.start) return { status: 400, error: 'past_period' };
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO goals.goals (list_id, period_start, title, summary, details, state, position, touched, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, 'draft', $6, true, $7, $7) RETURNING id`,
            [list.id, period.start, title, summary, details, await nextPosition(client, list, period), member],
          );
          return rows[0]!.id;
        });
        if (typeof id !== 'string') return refuse(reply, id);
        req.log.info({ event: 'goal.added', goal_id: id }, 'goal added');
        return reply.code(201).send(await goalById(pool, id));
      });

      people.patch('/goals/:id', { bodyLimit: WRITE_BODY_LIMIT }, async (req, reply) => {
        const id = idParam(req);
        if (!id) return refuse(reply, NOT_FOUND);
        const body = GoalChange.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
        const member = signedInPerson(req).id;
        const { revision, title, summary, details, position } = body.data;
        const result = await withTransaction(pool, async (client): Promise<Goal | Refusal> => {
          const goal = await lockedAt(client, id, revision);
          if (isRefusal(goal)) return goal;
          if (goal.state === 'dismissed') return { status: 409, error: 'dismissed' };
          await client.query(
            `UPDATE goals.goals SET title = coalesce($2, title), summary = coalesce($3, summary), details = coalesce($4, details),
                    position = coalesce($5, position), touched = true, revision = revision + 1, updated_by = $6, updated_at = now()
              WHERE id = $1`,
            [id, title ?? null, summary ?? null, details ?? null, position ?? null, member],
          );
          return (await goalById(client, id))!;
        });
        if (isRefusal(result)) return refuse(reply, result);
        req.log.info({ event: 'goal.edited', goal_id: id }, 'goal edited');
        return result;
      });

      /** An owner/admin action on one goal, in one transaction with the actor's role read under it; audited. */
      const adminAction =
        <B extends { revision: number }>(
          action: string,
          schema: z.ZodType<B, z.ZodTypeDef, unknown>,
          apply: (client: pg.PoolClient, goal: Goal, body: B, actor: string) => Promise<Refusal | null>,
        ) =>
        async (req: FastifyRequest, reply: FastifyReply) => {
          const id = idParam(req);
          if (!id) return refuse(reply, NOT_FOUND);
          const body = schema.safeParse(req.body);
          if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
          const actor = signedInPerson(req).id;
          const result = await withTransaction(pool, async (client): Promise<Goal | Refusal> => {
            if (!(await adminForWrite(client, actor))) return FORBIDDEN;
            const goal = await lockedAt(client, id, body.data.revision);
            if (isRefusal(goal)) return goal;
            const refused = await apply(client, goal, body.data, actor);
            if (refused) return refused;
            const after = (await goalById(client, id))!;
            await audit(client, {
              actor,
              action,
              target: 'goal',
              targetId: id,
              before: { state: goal.state, outcome: goal.outcome },
              after: { state: after.state, outcome: after.outcome },
            });
            return after;
          });
          if (isRefusal(result)) return refuse(reply, result);
          req.log.info({ event: action, goal_id: id }, action);
          return result;
        };

      /** The goal's new state, from a draft only. */
      const fromDraft = (state: 'goal' | 'dismissed') => async (client: pg.PoolClient, goal: Goal, _body: unknown, actor: string): Promise<Refusal | null> => {
        if (goal.state !== 'draft') return { status: 409, error: 'not_a_draft' };
        await client.query(`UPDATE goals.goals SET state = $2, touched = true, revision = revision + 1, updated_by = $3, updated_at = now() WHERE id = $1`, [
          goal.id,
          state,
          actor,
        ]);
        return null;
      };

      people.post('/goals/:id/promote', adminAction('goal.promoted', AtRevision, fromDraft('goal')));
      people.post('/goals/:id/dismiss', adminAction('goal.dismissed', AtRevision, fromDraft('dismissed')));

      // Carried makes a goal copy in the next period; moving away from carried dismisses that copy,
      // unless a person has touched it (409 carried_copy_edited, nothing changed).
      people.post(
        '/goals/:id/outcome',
        adminAction('goal.outcome_set', OutcomeChange, async (client, goal, body, actor) => {
          if (goal.state !== 'goal') return { status: 409, error: 'not_a_goal' };
          const before = goal.outcome;
          const after = body.outcome;
          if (before === 'carried' && after !== 'carried') {
            const { rows } = await client.query<{ id: string; state: string; touched: boolean }>(
              `SELECT id, state, touched FROM goals.goals WHERE carried_from = $1 FOR UPDATE`,
              [goal.id],
            );
            const copy = rows[0];
            if (copy && copy.state !== 'dismissed') {
              if (copy.touched) return { status: 409, error: 'carried_copy_edited' };
              await client.query(`UPDATE goals.goals SET state = 'dismissed', revision = revision + 1, updated_at = now() WHERE id = $1`, [copy.id]);
            }
          }
          if (after === 'carried' && before !== 'carried') {
            const list = await theList(client);
            const next = periodOf(periodOf(goal.period_start, list.cadence, list.anchor).end, list.cadence, list.anchor);
            // A copy dismissed by an earlier un-carry (never touched) comes back rather than a second copy, in
            // the next period as the rhythm now has it and with the goal's text as it is now.
            await client.query(
              `INSERT INTO goals.goals (list_id, period_start, title, summary, details, state, position, carried_from, created_by)
               VALUES ($2, $3, $4, $5, $6, 'goal', $7, $1, $8)
               ON CONFLICT (carried_from) DO UPDATE SET state = 'goal', period_start = EXCLUDED.period_start, position = EXCLUDED.position,
                 title = EXCLUDED.title, summary = EXCLUDED.summary, details = EXCLUDED.details,
                 revision = goals.revision + 1, updated_at = now()
                WHERE goals.state = 'dismissed'`,
              [goal.id, list.id, next.start, goal.title, goal.summary, goal.details, await nextPosition(client, list, next), actor],
            );
          }
          await client.query(`UPDATE goals.goals SET outcome = $2, touched = true, revision = revision + 1, updated_by = $3, updated_at = now() WHERE id = $1`, [
            goal.id,
            after,
            actor,
          ]);
          return null;
        }),
      );

      /**
       * GET /links?cards=<id>,<id>: the goal each of these cards serves (cards without one are left
       * out), for the board's tags and any product reading goals: {links: [{card_id, goal: {id, label, title, state}}]}.
       * Every member reads every card (one company), so every link.
       */
      people.get('/links', async (req, reply) => {
        const cards = CardIdsQuery.safeParse(req.query);
        if (!cards.success) return reply.code(400).send({ error: 'invalid_query' });
        const [list, { rows }] = await Promise.all([
          theList(pool),
          pool.query<{ card_id: string; goal_id: string; period_start: string }>(
            `SELECT l.card_id, l.goal_id, g.period_start::text AS period_start
               FROM goals.card_links l JOIN goals.goals g ON g.id = l.goal_id WHERE l.card_id = ANY($1::uuid[])`,
            [cards.data],
          ),
        ]);
        if (rows.length === 0) return { links: [] };
        // Labels are per period: every period the linked goals fall in, in one read of the few columns a label needs.
        const periods = [...new Map(rows.map((r) => {
          const p = periodOf(r.period_start, list.cadence, list.anchor);
          return [p.start, p] as const;
        })).values()];
        const { rows: goalRows } = await pool.query<{ period: string; id: string; title: string; state: GoalState }>(
          `SELECT p.s::text AS period, g.id, g.title, g.state
             FROM unnest($2::date[], $3::date[]) AS p(s, e)
             JOIN goals.goals g ON g.list_id = $1 AND g.period_start >= p.s AND g.period_start < p.e
            ORDER BY p.s, g.period_start, g.position, g.created_at, g.id`,
          [list.id, periods.map((p) => p.start), periods.map((p) => p.end)],
        );
        const goalOf = new Map<string, { id: string; title: string; state: GoalState; label: string | null }>();
        for (const p of periods) {
          for (const g of labelled(goalRows.filter((r) => r.period === p.start))) goalOf.set(g.id, { id: g.id, label: g.label, title: g.title, state: g.state });
        }
        return {
          links: rows.flatMap((r) => {
            const goal = goalOf.get(r.goal_id);
            return goal ? [{ card_id: r.card_id, goal }] : [];
          }),
        };
      });

      /** PUT /cards/:cardId/goal {goal_id}: the card now serves this goal (not a dismissed one). 404 for an unknown card or goal. */
      people.put('/cards/:cardId/goal', async (req, reply) => {
        const cardId = idParam(req, 'cardId');
        const body = CardGoal.safeParse(req.body);
        if (!cardId) return refuse(reply, NOT_FOUND);
        if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
        const member = signedInPerson(req).id;
        const { goal_id } = body.data;
        const result = await withTransaction(pool, async (client): Promise<Refusal | null> => {
          const { rows } = await client.query<{ state: GoalState }>(`SELECT state FROM goals.goals WHERE id = $1 FOR SHARE`, [goal_id]);
          if (!rows[0]) return NOT_FOUND;
          if (rows[0].state === 'dismissed') return { status: 409, error: 'dismissed' };
          try {
            await client.query(
              `INSERT INTO goals.card_links (card_id, goal_id, set_by) VALUES ($1, $2, $3)
               ON CONFLICT (card_id) DO UPDATE SET goal_id = EXCLUDED.goal_id, set_by = EXCLUDED.set_by, updated_at = now()`,
              [cardId, goal_id, member],
            );
          } catch (err) {
            if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) return NOT_FOUND;
            throw err;
          }
          return null;
        });
        if (result) return refuse(reply, result);
        req.log.info({ event: 'goal.card_linked', card_id: cardId, goal_id }, 'card linked to a goal');
        return { card_id: cardId, goal: await goalById(pool, goal_id) };
      });

      /** DELETE /cards/:cardId/goal: the card serves no goal; 204 whether or not it did. */
      people.delete('/cards/:cardId/goal', async (req, reply) => {
        const cardId = idParam(req, 'cardId');
        if (!cardId) return refuse(reply, NOT_FOUND);
        const { rowCount } = await pool.query(`DELETE FROM goals.card_links WHERE card_id = $1`, [cardId]);
        if (rowCount) req.log.info({ event: 'goal.card_unlinked', card_id: cardId }, 'card unlinked from its goal');
        return reply.code(204).send();
      });

      people.get('/settings', async () => theList(pool));

      /** PUT /settings {revision, name?, cadence?, timezone?, anchor?}: the list's rhythm; owner or admin; audited. */
      people.put('/settings', async (req, reply) => {
        const body = ListChange.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
        const actor = signedInPerson(req).id;
        const { revision, name, cadence, timezone, anchor } = body.data;
        const result = await withTransaction(pool, async (client): Promise<GoalList | Refusal> => {
          if (!(await adminForWrite(client, actor))) return FORBIDDEN;
          const list = await theList(client);
          const { rows } = await client.query<{ revision: number }>(`SELECT revision FROM goals.lists WHERE id = $1 FOR UPDATE`, [list.id]);
          if (rows[0]!.revision !== revision) return { status: 409, error: 'stale_revision' };
          await client.query(
            `UPDATE goals.lists SET name = coalesce($2, name), cadence = coalesce($3, cadence), timezone = coalesce($4, timezone),
                    anchor = coalesce($5::date, anchor), revision = revision + 1, updated_by = $6, updated_at = now()
              WHERE id = $1`,
            [list.id, name ?? null, cadence ?? null, timezone ?? null, anchor ?? null, actor],
          );
          const after = await theList(client);
          await audit(client, {
            actor,
            action: 'goals.settings_set',
            target: 'settings:goals',
            before: { cadence: list.cadence, timezone: list.timezone, anchor: list.anchor },
            after: { cadence: after.cadence, timezone: after.timezone, anchor: after.anchor },
          });
          return after;
        });
        if (isRefusal(result)) return refuse(reply, result);
        req.log.info({ event: 'goals.settings_set' }, 'goals settings set');
        return result;
      });
    });
  },
};
