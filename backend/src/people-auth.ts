import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { digest } from './credentials.ts';
import { verifyGoogleIdToken, type SigningKeys } from './google-id-token.ts';
import { jwksKeys } from './jwks.ts';
import { devMember, hasOwner, isAdmin, memberById, signIn, testMember, type Member, type Role } from './members.ts';

/**
 * A signed-in person: their member id, and their member row when the seam already read
 * it (so a route need not read it again). Their role is read fresh, under the members
 * lock, wherever it decides a change.
 */
export interface Person {
  id: string;
  member?: Member;
}

/**
 * A person's bearer checked for the card service (QOR-4749): the Authorization header they
 * sent it, and the client address it saw them at, which their failures are counted against.
 */
export interface OnBehalf {
  authorization: string;
  ip: string;
}

/**
 * The seam for people's routes: who is signed in, or null. With `onBehalf`, who that
 * bearer is, the request itself being the card service's.
 */
export type AuthenticatePerson = (req: FastifyRequest, onBehalf?: OnBehalf) => Promise<Person | null>;

/** Nobody is signed in: every people's route answers 401. */
export const nobodySignedIn: AuthenticatePerson = async () => null;

export interface PeopleAuthConfig {
  /** BWAT_DEV_PERSON_TOKEN: local stacks only. */
  devToken?: string | undefined;
  /** BWAT_TEST_PEOPLE: local stacks and tests only. */
  testPeople?: TestPerson[] | undefined;
  /** BWAT_GOOGLE_CLIENT_IDS: the OAuth client ids a Google ID token may be issued to. */
  googleClientIds: string[];
  /** BWAT_ALLOWED_DOMAINS (lower-cased): the Google Workspace domains that may sign in (D146). */
  allowedDomains: string[];
  /** BWAT_FIRST_OWNER_EMAIL (lower-cased): the only address that may claim the owner role (QOR-4749). */
  firstOwnerEmail?: string | undefined;
  /** BWAT_TIER (D202): local, team, zoom-board or production; unset on an install made before tiers. */
  tier?: Tier | undefined;
  /** BWAT_SIGNIN_CODE_SHA256, on a local install only: the sha256 of the code people sign in with (code-signin.ts). */
  codeDigest?: Buffer | undefined;
}

/** The install's tiers (D202): each adds steps to the one before. */
export const TIERS = ['local', 'team', 'zoom-board', 'production'] as const;
export type Tier = (typeof TIERS)[number];

/** One BWAT_TEST_PEOPLE entry: who presenting `token` signs in as. */
interface TestPerson {
  name: string;
  role: Role;
  token: string;
}

const TEST_PERSON = /^([a-z][a-z0-9-]{0,31}):(owner|admin|member):([A-Za-z0-9._~-]{32,})$/;

/**
 * BWAT_TEST_PEOPLE's entries. An error names an entry by its position, never its text:
 * the entry holds a token.
 */
function testPeopleFrom(value: string | undefined, devToken: string | undefined): TestPerson[] {
  const people: TestPerson[] = [];
  for (const [i, entry] of (value ?? '').split(',').map((e) => e.trim()).filter(Boolean).entries()) {
    const at = `BWAT_TEST_PEOPLE entry ${i + 1}`;
    const [, name, role, token] = entry.match(TEST_PERSON) ?? [];
    if (!name || !role || !token) throw new Error(`${at} is malformed: want name:role:token, see backend/README.md`);
    if (people.some((p) => p.name === name)) throw new Error(`${at} repeats a name`);
    // The dev token is checked first, so a test token equal to it would never sign in.
    if (token === devToken || people.some((p) => p.token === token)) throw new Error(`${at} repeats a token`);
    people.push({ name, role: role as Role, token });
  }
  return people;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The only NODE_ENV values under which a stand-in sign-in (dev token, test people) may run. */
const LOCAL_NODE_ENVS = new Set(['development', 'test']);

/**
 * Reads and checks the sign-in settings, before anything connects.
 *
 * BWAT_GOOGLE_CLIENT_IDS (comma-separated): a person signs in with a Google ID token as
 * `Authorization: Bearer <it>`. Unset, Google sign-in is off.
 *
 * BWAT_ALLOWED_DOMAINS (comma-separated): the Google Workspace domains (the token's `hd`)
 * that may sign in (D146). Unset, every Google sign-in is refused.
 *
 * BWAT_FIRST_OWNER_EMAIL: the one address that may claim the owner role while the install
 * has no activated owner (D149, QOR-4749); anyone else signing in first joins as a member.
 * Unset, the first sign-in from an allowed domain claims it. Must be in an allowed domain.
 *
 * BWAT_DEV_PERSON_TOKEN: a stand-in for sign-in on a local stack (docker compose). A
 * caller presenting `Authorization: Bearer <it>` is the dev member. Refused unless
 * NODE_ENV is development or test, and shorter than 32 characters.
 *
 * BWAT_TEST_PEOPLE (`name:role:token,...`): more stand-ins, one member each, for tests that
 * need several people on a local stack. Refused unless NODE_ENV is development or test; a malformed entry,
 * or a repeated name or token, refuses startup.
 */
export function peopleAuthConfig(env: NodeJS.ProcessEnv): PeopleAuthConfig {
  // A stand-in sign-in on a deployed install, whose endpoints are public, would be a back
  // door. So it fails closed: only an explicitly local NODE_ENV turns one on, and a missing,
  // misspelt or unexpected value (staging, Production, "production ") refuses startup.
  const local = LOCAL_NODE_ENVS.has(env.NODE_ENV ?? '');
  const devToken = env.BWAT_DEV_PERSON_TOKEN || undefined;
  if (devToken) {
    if (!local) throw new Error('BWAT_DEV_PERSON_TOKEN is refused unless NODE_ENV is development or test');
    if (devToken.length < 32) throw new Error('BWAT_DEV_PERSON_TOKEN must be at least 32 characters');
  }
  // The same back door as the dev token, so the same refusal, before the value is even read.
  if (env.BWAT_TEST_PEOPLE && !local) {
    throw new Error('BWAT_TEST_PEOPLE is refused unless NODE_ENV is development or test');
  }
  const testPeople = testPeopleFrom(env.BWAT_TEST_PEOPLE, devToken);
  const list = (value: string | undefined) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const googleClientIds = list(env.BWAT_GOOGLE_CLIENT_IDS);
  const allowedDomains = list(env.BWAT_ALLOWED_DOMAINS?.toLowerCase());
  // The local tier was called t0 before QOR-5117: an install saved then still starts.
  const givenTier = env.BWAT_TIER?.trim() || undefined;
  const rawTier = givenTier === 't0' ? 'local' : givenTier;
  if (rawTier !== undefined && !(TIERS as readonly string[]).includes(rawTier)) {
    throw new Error(`BWAT_TIER must be one of ${TIERS.join(', ')}`);
  }
  const tier = rawTier as Tier | undefined;
  const rawCode = env.BWAT_SIGNIN_CODE_SHA256?.trim().toLowerCase() || undefined;
  if (rawCode !== undefined && !/^[0-9a-f]{64}$/.test(rawCode)) throw new Error('BWAT_SIGNIN_CODE_SHA256 must be 64 hex characters');
  // The sha256 of nothing: setup made no code (its random source failed), so any input would match.
  if (rawCode === EMPTY_SHA256) throw new Error('BWAT_SIGNIN_CODE_SHA256 is the digest of an empty code: run ./bwat setup --new-code');
  // The code is the sign-in of the local tier, and only of that tier (D202): never a second way into an install with
  // Google, which a misconfigured team install would otherwise open to anyone holding it.
  if (tier === 'local') {
    if (!rawCode) throw new Error('BWAT_SIGNIN_CODE_SHA256 is required when BWAT_TIER=local');
    if (googleClientIds.length > 0 || allowedDomains.length > 0) {
      throw new Error('BWAT_TIER=local signs in with the code only: unset BWAT_GOOGLE_CLIENT_IDS and BWAT_ALLOWED_DOMAINS, or move to BWAT_TIER=team');
    }
  } else if (rawCode) {
    throw new Error('BWAT_SIGNIN_CODE_SHA256 is refused unless BWAT_TIER=local');
  }
  // Google is a deployed install's only sign-in past the local tier (D146, D202): without both, nobody could ever sign in.
  if (env.NODE_ENV === 'production' && tier !== 'local') {
    if (allowedDomains.length === 0) throw new Error('BWAT_ALLOWED_DOMAINS is required when NODE_ENV=production');
    if (googleClientIds.length === 0) throw new Error('BWAT_GOOGLE_CLIENT_IDS is required when NODE_ENV=production');
  }
  const firstOwnerEmail = env.BWAT_FIRST_OWNER_EMAIL?.trim().toLowerCase() || undefined;
  if (firstOwnerEmail !== undefined) {
    // Errors name the variable only, as for every other setting.
    if (!/^[^\s@,]+@[^\s@,]+$/.test(firstOwnerEmail)) throw new Error('BWAT_FIRST_OWNER_EMAIL must be one email address');
    // Nobody outside the allowed domains ever signs in, so that owner could never claim.
    const domain = firstOwnerEmail.slice(firstOwnerEmail.indexOf('@') + 1);
    if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
      throw new Error('BWAT_FIRST_OWNER_EMAIL must be in one of BWAT_ALLOWED_DOMAINS');
    }
  }
  return {
    devToken,
    testPeople,
    googleClientIds,
    allowedDomains,
    firstOwnerEmail,
    ...(tier && { tier }),
    ...(rawCode && { codeDigest: Buffer.from(rawCode, 'hex') }),
  };
}

/**
 * Who is signed in: the dev member for the dev token, else the test member for a
 * BWAT_TEST_PEOPLE token, else the member the bearer token's verified Google account, from
 * an allowed domain, is (bound by its `sub`; see signIn), else nobody. The local tokens are
 * compared first, by digest in constant time: that needs nothing from Google. Logs member
 * ids and events only, never an email, a sub or a token.
 */
export function peopleAuth(
  pool: pg.Pool,
  { devToken, testPeople = [], googleClientIds, allowedDomains, firstOwnerEmail }: PeopleAuthConfig,
  {
    keys = jwksKeys(),
    // The domains in force at each sign-in: an admin's saved list over the env's (QOR-5070).
    domains = async () => allowedDomains,
  }: { keys?: SigningKeys; domains?: () => Promise<readonly string[]> } = {},
): AuthenticatePerson {
  const devDigest = devToken ? digest(`Bearer ${devToken}`) : null;
  // Only digests are kept: the tokens themselves go no further than the config.
  const testDigests = testPeople.map(({ name, role, token }) => ({ name, role, digest: digest(`Bearer ${token}`) }));
  return async (req, onBehalf) => {
    const presented = onBehalf ? onBehalf.authorization : req.headers.authorization;
    if (!presented) return null;
    const presentedDigest = digest(presented);
    if (devDigest && timingSafeEqual(presentedDigest, devDigest)) {
      const member = await devMember(pool);
      return { id: member.id, member };
    }
    const test = testDigests.find((p) => timingSafeEqual(presentedDigest, p.digest));
    if (test) {
      const member = await testMember(pool, test.name, test.role);
      return { id: member.id, member };
    }

    const token = presented.match(/^Bearer (\S+)$/)?.[1];
    if (!token || googleClientIds.length === 0) return null;
    const allowed = await domains();
    if (allowed.length === 0) return null;
    // QOR-4625: an IP that has spent its failed sign-ins is refused before verifying, so a
    // flood of bad tokens never reaches Google's keys. Only a failure below is counted.
    const failures = req.server.signInFailures;
    const ip = onBehalf?.ip;
    failures.check(req, ip);
    const verified = await verifyGoogleIdToken(token, { clientIds: googleClientIds, keys });
    if (!verified) {
      failures.count(req, ip);
      return null;
    }
    // D146: a Workspace account of an allowed domain, and an email inside that domain.
    const { hd } = verified;
    if (!hd || !allowed.includes(hd) || verified.email.split('@')[1] !== hd) {
      req.log.info({ event: 'auth.domain_refused' }, 'signed in from a domain that is not allowed');
      failures.count(req, ip);
      return null;
    }
    const signedIn = await signIn(pool, verified, { firstOwnerEmail });
    if (typeof signedIn === 'string') {
      // subject_mismatch: the address is bound to another Google account; removed: an admin
      // removed this person and has not invited them again.
      req.log.info({ event: `auth.${signedIn}` }, 'signed in, but not as a member');
      failures.count(req, ip);
      return null;
    }
    const { member, event } = signedIn;
    if (event) req.log.info({ event, member_id: member.id }, event);
    return { id: member.id, member };
  };
}

/** Who requirePerson let through, by request. */
const admitted = new WeakMap<FastifyRequest, Person>();

/** A preHandler for people's routes: 401 unless someone is signed in. */
export function requirePerson(authenticatePerson: AuthenticatePerson) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const person = await authenticatePerson(req);
    if (!person) return reply.code(401).send({ error: 'unauthorized' });
    admitted.set(req, person);
  };
}

/** The panel stays closed until onboarding (D149): 403 not_onboarded while the install has no activated owner. */
export const notOnboarded =
  (pool: pg.Pool) =>
  async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!(await hasOwner(pool))) return reply.code(403).send({ error: 'not_onboarded' });
  };

/** A preHandler for people's routes on an onboarded install: requirePerson's 401 first, then notOnboarded's 403. */
export function requireOnboardedPerson(pool: pg.Pool, authenticatePerson: AuthenticatePerson) {
  const person = requirePerson(authenticatePerson);
  const onboarded = notOnboarded(pool);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await person(req, reply);
    if (reply.sent) return reply;
    await onboarded(req, reply);
  };
}

/** The person requirePerson let through, on a route behind it. */
export const signedInPerson = (req: FastifyRequest): Person => admitted.get(req)!;

/**
 * The signed-in member when they are an admin (the owner or an admin, D141), their role
 * read fresh; otherwise null after answering 403. For routes behind requirePerson.
 */
export async function requireAdmin(pool: pg.Pool, req: FastifyRequest, reply: FastifyReply): Promise<Member | null> {
  const member = await memberById(pool, signedInPerson(req).id);
  if (member && isAdmin(member)) return member;
  await reply.code(403).send({ error: 'forbidden' });
  return null;
}
