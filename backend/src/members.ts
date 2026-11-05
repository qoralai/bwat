import type pg from 'pg';
import { audit } from './audit.ts';
import { withTransaction } from './db/pool.ts';

type Db = pg.Pool | pg.ClientBase;

/** The member BWAT_DEV_PERSON_TOKEN signs in as, on a local stack only. `.invalid` never resolves. */
export const DEV_MEMBER_EMAIL = 'dev-person@bwat.invalid';

/**
 * Taken (transaction-scoped) by every change to who is a member or what role they have,
 * so the checks that keep an owner (D149: exactly one first owner; never zero owners)
 * read a membership nobody else is changing. Any fixed number unique to this purpose.
 */
export const MEMBERS_LOCK_KEY = 45750001;

const lockMembers = (client: pg.ClientBase) => client.query('SELECT pg_advisory_xact_lock($1)', [MEMBERS_LOCK_KEY]);

/**
 * An owner who has signed in (activated). Only such an owner keeps the install owned: an
 * owner row nobody ever signed in as neither onboards it nor blocks the first-owner claim
 * (D149), and never counts as another owner for the last-owner guard.
 */
const ACTIVATED_OWNER = `role = 'owner' AND activated_at IS NOT NULL`;

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
/** The email as stored (lower-cased), or null when it is not one address. */
export function normalEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL.test(email) ? email : null;
}

/** Whether an allowed domain (D146) holds this email; one outside them can never sign in. */
export const inAllowedDomain = (email: string, allowedDomains: readonly string[]) =>
  allowedDomains.includes(email.slice(email.lastIndexOf('@') + 1).toLowerCase());

/**
 * The domains of activated owners none of `allowedDomains` holds, when that is every one of them:
 * a list that leaves no owner able to sign in. Empty when an owner can, or there is none yet.
 */
export async function ownersLockedOut(db: Db, allowedDomains: readonly string[]): Promise<string[]> {
  const { rows } = await db.query<{ email: string }>(`SELECT email FROM members WHERE ${ACTIVATED_OWNER} ORDER BY email`);
  if (rows.some((r) => inAllowedDomain(r.email, allowedDomains))) return [];
  return [...new Set(rows.map((r) => r.email.slice(r.email.lastIndexOf('@') + 1).toLowerCase()))];
}

/** The member with this email, which the caller has already lower-cased. */
async function memberByEmail(db: Db, email: string): Promise<Member | null> {
  const { rows } = await db.query<Member>(`SELECT ${MEMBER_COLUMNS} FROM members WHERE email = $1`, [email]);
  return rows[0] ?? null;
}

/** What one look at members shows a sign-in: the member bound to its Google account, the member invited at its email (with the account that one is bound to), and whether the install is owned. */
interface Found {
  bySub: Member | null;
  byEmail: { member: Member; googleSub: string | null } | null;
  hasOwner: boolean;
}

/** One query, so a sign-in on an owned install is settled without the lock. */
async function lookUp(db: Db, sub: string, email: string): Promise<Found> {
  const { rows } = await db.query<Member & { google_sub: string | null; has_owner: boolean }>(
    `SELECT m.*, EXISTS (SELECT 1 FROM members WHERE ${ACTIVATED_OWNER}) AS has_owner
     FROM (SELECT 1) one
     LEFT JOIN (SELECT ${MEMBER_COLUMNS}, google_sub FROM members WHERE google_sub = $1 OR email = $2) m ON true`,
    [sub, email],
  );
  // google_sub is kept out of the member: it is never answered or logged.
  const found = rows
    .filter((row) => row.id)
    .map(({ google_sub, ...member }) => {
      delete (member as Partial<typeof member>).has_owner;
      return { member: member as Member, googleSub: google_sub };
    });
  return {
    bySub: found.find((f) => f.googleSub === sub)?.member ?? null,
    byEmail: found.find((f) => f.member.email === email) ?? null,
    hasOwner: rows[0]!.has_owner,
  };
}

/** How a sign-in ends: as a member (with the event it caused, if any), or refused with a code. */
type SignIn =
  | { member: Member; event?: 'member.owner_claimed' | 'member.activated' | 'member.joined' }
  | 'subject_mismatch'
  | 'removed';

/**
 * The look as this sign-in must take it: while BWAT_FIRST_OWNER_EMAIL (`firstOwnerEmail`,
 * lower-cased) names someone else, an install with no owner is one this address cannot
 * claim, so it signs in as on an owned one (QOR-4749).
 */
const asClaimable = (found: Found, address: string, firstOwnerEmail: string | undefined): Found =>
  firstOwnerEmail === undefined || address === firstOwnerEmail ? found : { ...found, hasOwner: true };

/** What a look settles without a write; undefined when the member must be bound, joined or the owner claimed. */
function settled({ bySub, byEmail, hasOwner }: Found): SignIn | undefined {
  if (bySub) return hasOwner ? { member: bySub } : undefined;
  // The address was bound to another Google account: someone else holds it now.
  if (byEmail?.googleSub) return 'subject_mismatch';
  return undefined;
}

/**
 * The member a verified Google account (its email already checked against the allowed
 * domains) signs in as. A member is bound to the Google account (`sub`) of its first
 * sign-in and is that account from then on: found by it even if its email changed (the
 * stored email is kept), and its address from another account is refused. An invited
 * member's first sign-in binds it (member.activated); anyone else from an allowed domain
 * joins as a member (member.joined), unless an admin removed that email or account and
 * has not invited it again ('removed'). While the install has no owner,
 * the first such sign-in makes that person its owner (D149), joining as one or promoting
 * their membership, and binds it; nobody is named in advance unless
 * BWAT_FIRST_OWNER_EMAIL is set (below). The first look settles an
 * onboarded sign-in without the lock; every write re-checks under it, so exactly one
 * owner is made however many first sign-ins race. A member with no display name takes the
 * account's `name` (the owner's claim, a join, an activation, or any later sign-in); a name
 * already set, by an admin or an earlier sign-in, is never replaced.
 *
 * With `firstOwnerEmail` (BWAT_FIRST_OWNER_EMAIL, lower-cased) only that address claims
 * the owner; anyone else signs in as on an owned install, joining or activating as a
 * member, and the panel stays closed (not_onboarded) until that person signs in.
 */
export async function signIn(
  pool: pg.Pool,
  { email, sub, name }: { email: string; sub: string; name?: string | undefined },
  { firstOwnerEmail }: { firstOwnerEmail?: string | undefined } = {},
): Promise<SignIn> {
  const address = email.toLowerCase();
  const first = settled(asClaimable(await lookUp(pool, sub, address), address, firstOwnerEmail));
  if (first) {
    if (typeof first === 'string' || first.member.display_name !== null || !name) return first;
    const { rows } = await pool.query<Member>(
      `UPDATE members SET display_name = coalesce(display_name, $2), updated_at = now() WHERE id = $1
       RETURNING ${MEMBER_COLUMNS}`,
      [first.member.id, name],
    );
    return { member: rows[0] ?? first.member };
  }
  const displayName = name ?? null;
  return withTransaction(pool, async (client) => {
    await lockMembers(client);
    const found = asClaimable(await lookUp(client, sub, address), address, firstOwnerEmail);
    const done = settled(found);
    if (done) return done;
    const known = found.bySub ?? found.byEmail?.member ?? null;
    if (found.hasOwner && !known) {
      const removed = await client.query(`SELECT 1 FROM removed_members WHERE email = $1 OR google_sub = $2`, [address, sub]);
      if (removed.rowCount) return 'removed';
      const { rows } = await client.query<Member>(
        `INSERT INTO members (email, display_name, role, google_sub, activated_at) VALUES ($1, $3, 'member', $2, now())
         RETURNING ${MEMBER_COLUMNS}`,
        [address, sub, displayName],
      );
      const member = rows[0]!;
      await audit(client, { actor: null, action: 'member.joined', target: 'member', targetId: member.id, after: { role: 'member' } });
      return { member, event: 'member.joined' };
    }
    if (found.hasOwner) {
      const { rows } = await client.query<Member>(
        `UPDATE members SET google_sub = $2, display_name = coalesce(display_name, $3), activated_at = now(),
         updated_at = now() WHERE id = $1 RETURNING ${MEMBER_COLUMNS}`,
        [known!.id, sub, displayName],
      );
      await audit(client, { actor: known!.id, action: 'member.activated', target: 'member', targetId: known!.id });
      return { member: rows[0]!, event: 'member.activated' };
    }
    const { rows } = known
      ? await client.query<Member>(
          `UPDATE members SET role = 'owner', google_sub = $2, display_name = coalesce(display_name, $3),
           activated_at = coalesce(activated_at, now()), updated_at = now() WHERE id = $1 RETURNING ${MEMBER_COLUMNS}`,
          [known.id, sub, displayName],
        )
      : await client.query<Member>(
          `INSERT INTO members (email, display_name, role, google_sub, activated_at) VALUES ($1, $3, 'owner', $2, now())
           RETURNING ${MEMBER_COLUMNS}`,
          [address, sub, displayName],
        );
    const member = rows[0]!;
    await audit(client, {
      actor: null,
      action: 'member.owner_claimed',
      target: 'member',
      targetId: member.id,
      ...(known && { before: { role: known.role } }),
      after: { role: 'owner' },
    });
    return { member, event: 'member.owner_claimed' };
  });
}

/** Whether the install is onboarded: it has an activated owner (D149). Until then the panel stays closed. */
export async function hasOwner(db: Db): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM members WHERE ${ACTIVATED_OWNER} LIMIT 1`)).rowCount === 1;
}

/**
 * The member a local sign-in stands for, found by `email` or, the first time, created
 * (activated: it signs in by a token, never by Google, so it has no google_sub) under the
 * members lock in the role `roleFor` decides there, and audited as `action`.
 */
async function localMember(
  pool: pg.Pool,
  { email, displayName, action, roleFor }: { email: string; displayName: string; action: string; roleFor: (client: pg.ClientBase) => Promise<Role> },
): Promise<Member> {
  const known = await memberByEmail(pool, email);
  if (known) return known;
  return withTransaction(pool, async (client) => {
    await lockMembers(client);
    const raced = await memberByEmail(client, email);
    if (raced) return raced;
    const role = await roleFor(client);
    const { rows } = await client.query<Member>(
      `INSERT INTO members (email, display_name, role, activated_at) VALUES ($1, $2, $3, now())
       RETURNING ${MEMBER_COLUMNS}`,
      [email, displayName, role],
    );
    const member = rows[0]!;
    await audit(client, { actor: null, action, target: 'member', targetId: member.id, after: { role } });
    return member;
  });
}

/**
 * The dev member, created the first time BWAT_DEV_PERSON_TOKEN is used: as owner on a stack
 * with no activated owner, else as a plain member, so it never mints a second owner past
 * D149's claim.
 */
export const devMember = (pool: pg.Pool): Promise<Member> =>
  localMember(pool, {
    email: DEV_MEMBER_EMAIL,
    displayName: 'Dev person',
    action: 'member.dev_member_created',
    roleFor: async (client) => ((await hasOwner(client)) ? 'member' : 'owner'),
  });

/**
 * A BWAT_TEST_PEOPLE member, `<name>@test.bwat.invalid`, created the first time its token is
 * used, in its entry's role: an owner entry is an activated owner even on an owned stack.
 * Once created its stored role stands, so a test can change it through the API.
 */
export const testMember = (pool: pg.Pool, name: string, role: Role): Promise<Member> =>
  localMember(pool, {
    email: `${name}@test.bwat.invalid`,
    displayName: name,
    action: 'member.test_member_created',
    roleFor: async () => role,
  });

export type Role = 'owner' | 'admin' | 'member';

export interface Member {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
  zoom_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export const MEMBER_COLUMNS = 'id, email, display_name, role, zoom_user_id, created_at, updated_at';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The member with this id, or null (also for anything that is not a uuid). */
export async function memberById(db: Db, id: string): Promise<Member | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<Member>(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * The member, when an admin, read in the caller's write transaction; otherwise null. FOR
 * SHARE serialises with identity: a role change or removal in flight (an UPDATE or DELETE
 * of the row, made under the members lock) is waited for and its outcome read, and none
 * can start until the caller commits. So the role that decides the write is the one
 * committed, and stays so until the write is.
 */
export async function adminForWrite(client: pg.ClientBase, id: string): Promise<Member | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<Member>(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = $1 FOR SHARE`, [id]);
  return rows[0] && isAdmin(rows[0]) ? rows[0] : null;
}

/**
 * Runs `fn` in one write transaction for an actor still an admin in it (adminForWrite);
 * 'forbidden', with nothing written, when they are not.
 */
export function asAdminWrite<T>(
  pool: pg.Pool,
  actorId: string,
  fn: (client: pg.PoolClient, actor: Member) => Promise<T>,
): Promise<T | 'forbidden'> {
  return withTransaction(pool, async (client) => {
    const actor = await adminForWrite(client, actorId);
    return actor ? fn(client, actor) : 'forbidden';
  });
}

export async function listMembers(db: Db): Promise<Member[]> {
  return (await db.query<Member>(`SELECT ${MEMBER_COLUMNS} FROM members ORDER BY email`)).rows;
}

/** Why a change to members was refused. */
export type Refusal =
  | 'forbidden'
  | 'owner_required'
  | 'member_exists'
  | 'not_found'
  | 'last_owner'
  | 'domain_not_allowed';

export type Change<T> = { ok: T } | { refused: Refusal };

/** Admin means the owner or an admin (D141). */
export const isAdmin = (m: Pick<Member, 'role'>) => m.role === 'owner' || m.role === 'admin';

/**
 * Runs `fn` for an admin (or owner) inside one transaction holding the members lock,
 * with the actor's role read fresh under it; anyone else is refused.
 */
async function asAdmin<T>(
  pool: pg.Pool,
  actorId: string,
  fn: (client: pg.PoolClient, actor: Member) => Promise<Change<T>>,
): Promise<Change<T>> {
  return withTransaction(pool, async (client) => {
    await lockMembers(client);
    const actor = await memberById(client, actorId);
    if (!actor || !isAdmin(actor)) return { refused: 'forbidden' };
    return fn(client, actor);
  });
}

/**
 * Invites a member by email (admin). Only an owner may invite an owner, and only an email
 * in an allowed domain (`allowedDomains`, D146) is invited: no other could ever sign in.
 */
export function inviteMember(
  pool: pg.Pool,
  actorId: string,
  invite: { email: string; display_name?: string | null | undefined; role: Role },
  allowedDomains: readonly string[],
): Promise<Change<Member>> {
  return asAdmin(pool, actorId, async (client, actor) => {
    if (invite.role === 'owner' && actor.role !== 'owner') return { refused: 'owner_required' };
    if (!inAllowedDomain(invite.email, allowedDomains)) return { refused: 'domain_not_allowed' };
    const { rows } = await client.query<Member>(
      `INSERT INTO members (email, display_name, role) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING RETURNING ${MEMBER_COLUMNS}`,
      [invite.email.toLowerCase(), invite.display_name ?? null, invite.role],
    );
    const member = rows[0];
    if (!member) return { refused: 'member_exists' };
    // Inviting is how an admin lets a removed person back in.
    await client.query(`DELETE FROM removed_members WHERE email = $1`, [member.email]);
    await audit(client, { actor: actor.id, action: 'member.invited', target: 'member', targetId: member.id, after: { role: member.role } });
    return { ok: member };
  });
}

/** Whether an activated owner other than `id` exists: only then may `id` stop being an owner. */
async function anotherOwner(client: pg.ClientBase, id: string): Promise<boolean> {
  return (await client.query(`SELECT 1 FROM members WHERE ${ACTIVATED_OWNER} AND id <> $1 LIMIT 1`, [id])).rowCount === 1;
}

/**
 * Changes a member's role (admin). Only an owner grants or takes away ownership, only to an
 * email in an allowed domain (D146), and an owner is demoted only while another activated
 * owner remains: an owner who can sign in always exists, so an admin always does too.
 */
export function setRole(
  pool: pg.Pool,
  actorId: string,
  targetId: string,
  role: Role,
  allowedDomains: readonly string[],
): Promise<Change<Member>> {
  return asAdmin(pool, actorId, async (client, actor) => {
    const target = await memberById(client, targetId);
    if (!target) return { refused: 'not_found' };
    if ((role === 'owner' || target.role === 'owner') && actor.role !== 'owner') return { refused: 'owner_required' };
    if (target.role === role) return { ok: target };
    if (role === 'owner' && !inAllowedDomain(target.email, allowedDomains)) return { refused: 'domain_not_allowed' };
    if (target.role === 'owner' && !(await anotherOwner(client, target.id))) return { refused: 'last_owner' };
    const { rows } = await client.query<Member>(
      `UPDATE members SET role = $2, updated_at = now() WHERE id = $1 RETURNING ${MEMBER_COLUMNS}`,
      [target.id, role],
    );
    await audit(client, {
      actor: actor.id,
      action: 'member.role_changed',
      target: 'member',
      targetId: target.id,
      before: { role: target.role },
      after: { role },
    });
    return { ok: rows[0]! };
  });
}

/**
 * Removes a member (admin). Only an owner removes an owner, and only while another activated
 * owner remains. The email and Google account are kept in removed_members, so the person
 * cannot join again by signing in until an admin invites the email again.
 */
export function removeMember(pool: pg.Pool, actorId: string, targetId: string): Promise<Change<{ id: string }>> {
  return asAdmin(pool, actorId, async (client, actor) => {
    const target = await memberById(client, targetId);
    if (!target) return { refused: 'not_found' };
    if (target.role === 'owner') {
      if (actor.role !== 'owner') return { refused: 'owner_required' };
      if (!(await anotherOwner(client, target.id))) return { refused: 'last_owner' };
    }
    await client.query(
      `INSERT INTO removed_members (email, google_sub) SELECT email, google_sub FROM members WHERE id = $1
       ON CONFLICT (email) DO UPDATE SET google_sub = EXCLUDED.google_sub, removed_at = now()`,
      [target.id],
    );
    await client.query(`DELETE FROM members WHERE id = $1`, [target.id]);
    await audit(client, { actor: actor.id, action: 'member.removed', target: 'member', targetId: target.id, before: { role: target.role } });
    return { ok: { id: target.id } };
  });
}
