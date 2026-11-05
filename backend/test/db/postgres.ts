import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { RUNTIME_ROLE } from '../../src/db/runtime-role.ts';

/**
 * Test databases, the way the app will meet one: the migrations run as the owner
 * role, and the app logs in as the runtime role. No vitest import here: global-setup.ts
 * runs outside the test runner and uses this too; tests use harness.ts.
 *
 * BWAT_TEST_DB_URL is a superuser URL for a throwaway Postgres 16. It is used only
 * here, to create the two roles and the databases, and to drop them again. Locally it
 * comes from backend/.env.test (git-ignored); CI sets it in ci.yml.
 */
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '.env.test'));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

export const SKIP_REASON =
  'skipped: BWAT_TEST_DB_URL is unset (a Postgres 16 superuser URL; see backend/README.md)';

/**
 * The superuser URL, or undefined to skip. CI must run the database tests, never
 * skip them, so a missing URL there is an error. Empty counts as unset.
 */
export function testDbUrl(env: NodeJS.ProcessEnv): string | undefined {
  const url = env.BWAT_TEST_DB_URL || undefined;
  if (!url && env.CI && env.CI !== 'false') {
    throw new Error('BWAT_TEST_DB_URL must be set in CI: the database tests must run there');
  }
  return url;
}

export const baseUrl = testDbUrl(process.env);

/** The superuser URL, pointed at `database` when given. Setup and checks only. */
export function superuserUrl(database?: string): string {
  if (!baseUrl) throw new Error(SKIP_REASON);
  const url = new URL(baseUrl);
  if (database) url.pathname = `/${database}`;
  return url.toString();
}

export type Role = 'owner' | 'runtime' | 'cards' | 'master' | 'stranger';

// Roles are cluster-wide. The owner owns the schema and runs migrations; the runtime
// role logs in for the app, owns nothing and cannot bypass row-level security. The cards
// role is the card service's login (QOR-4604): it may touch the cards schema only. The other
// two are wrong logins the code must refuse: `master` stands in for the RDS master user
// (not a superuser, but a member of the owner), `stranger` is any other plain login.
export const ROLE_NAMES: Record<Role, string> = {
  owner: 'bwat_owner',
  runtime: RUNTIME_ROLE,
  cards: 'bwat_cards',
  master: 'bwat_master',
  stranger: 'bwat_stranger',
};

export interface TestDb {
  name: string;
  /** Connection string that logs in as that role (a real login, not SET ROLE). */
  url(role: Role): string;
  /** A client logged in as that role. The caller ends it. */
  connect(role: Role): Promise<pg.Client>;
  drop(): Promise<void>;
}

/** Runs fn on a superuser connection, to `database` when given. Setup and checks only. */
export async function asSuperuser<T>(fn: (client: pg.Client) => Promise<T>, database?: string): Promise<T> {
  const client = new pg.Client({ connectionString: superuserUrl(database) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Two runs at once altering one role fail with "tuple concurrently updated", so the
// caller holds an advisory lock. The roles take the superuser's password: no new secret.
async function ensureRole(client: pg.Client, name: string, attributes: string, password: string) {
  const pw = client.escapeLiteral(password);
  await client.query(`DO $$ BEGIN
    CREATE ROLE ${name} ${attributes} PASSWORD ${pw};
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    ALTER ROLE ${name} ${attributes} PASSWORD ${pw};
  END $$`);
}

/** Creates the roles, or resets their attributes and password if they exist. */
export async function ensureRoles(): Promise<void> {
  const password = decodeURIComponent(new URL(superuserUrl()).password);
  await asSuperuser(async (client) => {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(4568)');
    await ensureRole(client, ROLE_NAMES.owner, 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE', password);
    await ensureRole(client, ROLE_NAMES.runtime, 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', password);
    await ensureRole(client, ROLE_NAMES.cards, 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', password);
    await ensureRole(client, ROLE_NAMES.master, 'LOGIN NOSUPERUSER CREATEDB CREATEROLE NOBYPASSRLS', password);
    await client.query(`GRANT ${ROLE_NAMES.owner} TO ${ROLE_NAMES.master}`);
    await ensureRole(client, ROLE_NAMES.stranger, 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', password);
    await client.query('COMMIT');
  });
}

/**
 * A new database owned by the owner role (the roles must exist): a copy of `template`
 * when given, else empty.
 */
export async function createDatabase({ template }: { template?: string } = {}): Promise<TestDb> {
  const name = `bwat_test_${randomBytes(6).toString('hex')}`;

  await asSuperuser(async (client) => {
    await client.query(`CREATE DATABASE ${name}${template ? ` TEMPLATE ${template}` : ''} OWNER ${ROLE_NAMES.owner}`);
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO ${ROLE_NAMES.runtime}`);
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO ${ROLE_NAMES.cards}`);
    // A copy does not inherit the template's database privileges, so repeat what
    // migration 0001 does at the database level.
    if (template) await client.query(`REVOKE TEMPORARY ON DATABASE ${name} FROM PUBLIC`);
  });

  const url = (role: Role) => {
    const u = new URL(superuserUrl(name));
    u.username = ROLE_NAMES[role];
    return u.toString();
  };

  return {
    name,
    url,
    async connect(role) {
      const client = new pg.Client({ connectionString: url(role) });
      await client.connect();
      return client;
    },
    async drop() {
      await asSuperuser((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
