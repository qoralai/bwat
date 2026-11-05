import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import {
  inviteMember,
  listMembers,
  memberById,
  removeMember,
  setRole,
  type Change,
  type Member,
  type Refusal,
} from '../members.ts';
import { notOnboarded, type AuthenticatePerson, type Person } from '../people-auth.ts';
import { hasLiveSession } from '../sessions.ts';
import { requireCaller } from './bots.ts';

/**
 * Members of the company (one per install, D140). Every route needs a signed-in person
 * who is still a member, and every route but GET /me an install with an owner (D149);
 * POST /card-service/person, GET /me for the card service, needs its credential instead.
 * Logs record events and member ids, never an email or a name.
 */
const Role = z.enum(['owner', 'admin', 'member']);
const Invite = z
  .object({
    email: z.string().max(320).email(),
    display_name: z.string().trim().min(1).max(200).nullable().optional(),
    role: Role.default('member'),
  })
  .strict();

const RoleChange = z.object({ role: Role }).strict();
const MemberPath = z.object({ id: z.string() });

/**
 * A board's bearer, as the card service received it, and the client address it saw: the
 * right-most X-Forwarded-For entry its edge appended (QOR-4749). A Google ID token is about 1 KB.
 */
const PersonCheck = z
  .object({
    bearer: z.string().regex(/^\S{1,8192}$/),
    client_ip: z.string().ip(),
  })
  .strict();

/** Exactly these four fields (D144 gap 8); the panel reads the role from here. */
const meView = ({ id, email, display_name, role }: Member) => ({ id, email, display_name, role });

const REFUSAL_STATUS: Record<Refusal, number> = {
  forbidden: 403,
  owner_required: 403,
  not_found: 404,
  member_exists: 409,
  last_owner: 409,
  domain_not_allowed: 409,
};

export function memberRoutes(
  app: FastifyInstance,
  {
    pool,
    authenticatePerson,
    allowedDomains,
  }: { pool: pg.Pool; authenticatePerson: AuthenticatePerson; allowedDomains: () => Promise<readonly string[]> },
): void {
  const signedIn = new WeakMap<FastifyRequest, Member>();
  /** The person's member row: the seam's own read when it made one, otherwise read here. */
  const memberOf = async (person: Person | null) => person && (person.member ?? (await memberById(pool, person.id)));

  app.register(async (people) => {
    people.addHook('preHandler', async (req, reply) => {
      const member = await memberOf(await authenticatePerson(req));
      if (!member) return reply.code(401).send({ error: 'unauthorized' });
      signedIn.set(req, member);
    });

    people.get('/me', async (req) => meView(signedIn.get(req)!));

    people.register(async (onboarded) => {
      onboarded.addHook('preHandler', notOnboarded(pool));
      // The links the board asks the person to connect: a live Claude session, and their Zoom login.
      onboarded.get('/me/connections', async (req) => {
        const member = signedIn.get(req)!;
        return { claude_session: await hasLiveSession(pool, member.id), zoom: member.zoom_user_id !== null };
      });
      memberAdminRoutes(onboarded, pool, signedIn, allowedDomains);
    });
  });

  // QOR-4749: who a board's bearer is, for the card service, which calls with its own
  // credential (bwc_) and names the client address it saw. That address is trusted here
  // only, behind the credential: a failed sign-in is counted against the person's address,
  // never the card service's own. The answer is GET /me's, or null for nobody; like GET /me
  // it is open before onboarding.
  app.post('/card-service/person', async (req, reply) => {
    if (!(await requireCaller(pool, 'cards', req, reply))) return reply;
    const body = PersonCheck.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const { bearer, client_ip: ip } = body.data;
    const member = await memberOf(await authenticatePerson(req, { authorization: `Bearer ${bearer}`, ip }));
    return { person: member ? meView(member) : null };
  });
}

/** Who is a member, and with what role: open only on an onboarded install. */
function memberAdminRoutes(
  people: FastifyInstance,
  pool: pg.Pool,
  signedIn: WeakMap<FastifyRequest, Member>,
  allowedDomains: () => Promise<readonly string[]>,
): void {
  people.get('/members', async () => ({ members: await listMembers(pool) }));

  /** Sends a change's outcome: `status` with the member, or the refusal. Logs ids only. */
  const answer = (reply: FastifyReply, change: Change<{ id: string }>, event: string, status = 200) => {
    if ('refused' in change) {
      reply.log.info({ event: 'member.change_refused', code: change.refused }, 'member change refused');
      return reply.code(REFUSAL_STATUS[change.refused]).send({ error: change.refused });
    }
    reply.log.info({ event, member_id: change.ok.id }, event);
    return status === 204 ? reply.code(204).send() : reply.code(status).send(change.ok);
  };

  // Invite by email (admin), in an allowed domain only (D146). Bound to a Google account at its first sign-in.
  people.post('/members', async (req, reply) => {
    const body = Invite.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    return answer(reply, await inviteMember(pool, signedIn.get(req)!.id, body.data, await allowedDomains()), 'member.invited', 201);
  });

  // Change a role (admin; ownership by an owner only, to an allowed domain only; never the last activated owner).
  people.patch('/members/:id', async (req, reply) => {
    const { id } = MemberPath.parse(req.params);
    const body = RoleChange.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const change = await setRole(pool, signedIn.get(req)!.id, id, body.data.role, await allowedDomains());
    return answer(reply, change, 'member.role_changed');
  });

  // Remove a member (admin; an owner by an owner only; never the last activated owner).
  people.delete('/members/:id', async (req, reply) => {
    const { id } = MemberPath.parse(req.params);
    return answer(reply, await removeMember(pool, signedIn.get(req)!.id, id), 'member.removed', 204);
  });
}
