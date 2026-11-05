import { expect, it } from 'vitest';
import { migrateDatabase } from '../../src/db/migrate.ts';
import { asSuperuser, describeDb, ROLE_NAMES, useTestDb } from './harness.ts';

// Every privilege `role` holds in the current database (its own grants and PUBLIC's),
// on the database itself and on every object outside the system schemas.
const PRIVILEGES = `
  WITH s AS (SELECT oid, nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema')
  SELECT 'database ' || p AS privilege FROM unnest(ARRAY['CREATE', 'CONNECT', 'TEMPORARY']) p
   WHERE has_database_privilege($1, current_database(), p)
  UNION ALL
  SELECT format('schema %s %s', s.nspname, p) FROM s, unnest(ARRAY['CREATE', 'USAGE']) p
   WHERE has_schema_privilege($1, s.oid, p)
  UNION ALL
  SELECT format('table %s.%s %s', s.nspname, c.relname, p)
    FROM pg_class c JOIN s ON s.oid = c.relnamespace,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_table_privilege($1, c.oid, p)
  UNION ALL
  -- A column grant the table-level check above would miss.
  SELECT format('column %s.%s.%s %s', s.nspname, c.relname, a.attname, p)
    FROM pg_class c JOIN s ON s.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege($1, c.oid, a.attnum, p) AND NOT has_table_privilege($1, c.oid, p)
  UNION ALL
  SELECT format('sequence %s.%s %s', s.nspname, c.relname, p)
    FROM pg_class c JOIN s ON s.oid = c.relnamespace, unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) p
   WHERE c.relkind = 'S' AND has_sequence_privilege($1, c.oid, p)
  UNION ALL
  SELECT format('function %s', f.oid::regprocedure) FROM pg_proc f JOIN s ON s.oid = f.pronamespace
   WHERE has_function_privilege($1, f.oid, 'EXECUTE')
  ORDER BY 1`;

const privileges = (database: string, role = ROLE_NAMES.runtime) =>
  asSuperuser(async (su) => (await su.query(PRIVILEGES, [role])).rows.map((r) => r.privilege), database);

describeDb('the test template (QOR-4572)', () => {
  const fresh = useTestDb({ migrate: false });
  const clone = useTestDb();

  it("gives the runtime role exactly the privileges a freshly migrated database does", async () => {
    await migrateDatabase(fresh.url('owner'));
    const expected = await privileges(fresh.name);
    expect(expected).toContain('database CONNECT');
    expect(expected).not.toContain('database TEMPORARY');
    expect(await privileges(clone.name)).toEqual(expected);
  });

  // QOR-4604: the card service's login, the same way.
  it('gives the card login exactly the privileges a freshly migrated database does', async () => {
    const expected = await privileges(fresh.name, ROLE_NAMES.cards);
    expect(expected).toContain('database CONNECT');
    expect(expected).toContain('table cards.cards SELECT');
    // QOR-4601: of the backend's objects, only its two read views; and no bwat function,
    // which the schema's USAGE would otherwise open to it through PUBLIC's EXECUTE.
    // Schema, table, column, sequence and function privileges all count: only USAGE (no
    // CREATE) and SELECT on the two views.
    expect(expected.filter((p) => /\bbwat\b/.test(p))).toEqual([
      'schema bwat USAGE',
      'table bwat.v_cards_members SELECT',
      'table bwat.v_cards_occurrences SELECT',
      'table bwat.v_transcript_speakers SELECT',
    ]);
    expect(await privileges(clone.name, ROLE_NAMES.cards)).toEqual(expected);
  });
});
