import type pg from 'pg';
import { afterAll, beforeAll, describe, inject } from 'vitest';
import { baseUrl, createDatabase, SKIP_REASON, type TestDb } from './postgres.ts';

/**
 * A fresh Postgres database per test file. global-setup.ts creates the roles and
 * migrates one template database once per run; each migrated test database is a copy
 * of it. The database plumbing lives in postgres.ts.
 */
export { asSuperuser, ROLE_NAMES, superuserUrl, testDbUrl, type TestDb } from './postgres.ts';

// vitest prints no reason for a skipped file, so say why here.
if (!baseUrl) console.warn(`database tests ${SKIP_REASON}`);

/** describe() for tests that need a real database; skipped (reason above) when it is unset. */
export const describeDb = baseUrl ? describe : describe.skip;

/**
 * A new database owned by the owner role: by default a copy of the migrated template,
 * with `migrate: false` an empty one.
 */
function createTestDatabase({ migrate = true } = {}): Promise<TestDb> {
  return migrate ? createDatabase({ template: inject('bwatTemplateDb') }) : createDatabase();
}

/**
 * One test database for the enclosing suite: created before its tests, dropped after
 * them. The handle works once the suite's beforeAll has run.
 */
export function useTestDb(options: { migrate?: boolean } = {}): TestDb {
  let db: TestDb | undefined;
  beforeAll(async () => {
    db = await createTestDatabase(options);
  }, 30_000);
  afterAll(async () => {
    await db?.drop();
  });
  const current = () => {
    if (!db) throw new Error('useTestDb: the database is created in beforeAll');
    return db;
  };
  return {
    get name() {
      return current().name;
    },
    url: (role) => current().url(role),
    connect: (role) => current().connect(role),
    drop: () => current().drop(),
  };
}

/** The SQLSTATE a statement fails with, or 'ok' when it succeeds. */
export async function sqlstate(client: pg.ClientBase, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await client.query(sql, params);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

export const INSUFFICIENT_PRIVILEGE = '42501';
export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';
export const FOREIGN_KEY_VIOLATION = '23503';
export const UNDEFINED_COLUMN = '42703';
