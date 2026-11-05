import type { GlobalSetupContext } from 'vitest/node';
import { migrateDatabase } from '../../src/db/migrate.ts';
import { baseUrl, createDatabase, ensureRoles } from './postgres.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The migrated database that test databases are copied from. */
    bwatTemplateDb: string;
  }
}

/**
 * Once per run: creates the two roles and one database with every migration applied
 * (as the owner), which test files then copy with CREATE DATABASE ... TEMPLATE.
 * Does nothing when BWAT_TEST_DB_URL is unset: the database tests skip.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<(() => Promise<void>) | undefined> {
  if (!baseUrl) return undefined;
  await ensureRoles();
  const template = await createDatabase();
  try {
    await migrateDatabase(template.url('owner'));
  } catch (err) {
    await template.drop();
    throw err;
  }
  provide('bwatTemplateDb', template.name);
  return () => template.drop();
}
