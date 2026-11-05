import { expect, it } from 'vitest';
import { asSuperuser, describeDb, ROLE_NAMES, useTestDb } from './harness.ts';

// What the runtime role may do on each table of migration 0007, exactly.
const TABLE_PRIVILEGES = `
  SELECT c.relname AS table, array_agg(p ORDER BY p) AS privileges
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   WHERE n.nspname = 'bwat' AND c.relname = ANY($2) AND has_table_privilege($1, c.oid, p)
   GROUP BY c.relname ORDER BY c.relname`;

describeDb('migration 0007: settings, dictionary, secrets (QOR-4578)', () => {
  const db = useTestDb();

  it('grants the runtime role exactly the DML each table needs: no DELETE on settings; no settings_audit (bwat.audit holds it)', async () => {
    const tables = ['settings', 'settings_version', 'dictionary', 'secrets', 'settings_audit'];
    const rows = await asSuperuser(
      async (su) => (await su.query(TABLE_PRIVILEGES, [ROLE_NAMES.runtime, tables])).rows,
      db.name,
    );
    expect(Object.fromEntries(rows.map((r) => [r.table, r.privileges]))).toEqual({
      dictionary: ['INSERT', 'SELECT', 'UPDATE'],
      secrets: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      settings: ['INSERT', 'SELECT', 'UPDATE'],
      settings_version: ['SELECT', 'UPDATE'],
    });
  });

  it('holds one settings_version row, starting at 0, and refuses a second', async () => {
    const runtime = await db.connect('runtime');
    try {
      expect((await runtime.query('SELECT version FROM bwat.settings_version')).rows).toEqual([{ version: 0 }]);
      await expect(asSuperuser((su) => su.query('INSERT INTO bwat.settings_version (version) VALUES (5)'), db.name)).rejects.toThrow(
        /duplicate key/,
      );
    } finally {
      await runtime.end();
    }
  });

  it('stores an unset setting as JSON null, never SQL NULL', async () => {
    const runtime = await db.connect('runtime');
    try {
      await runtime.query(`INSERT INTO bwat.settings (key, value, revision, updated_by) VALUES ('display_name', 'null'::jsonb, 1, gen_random_uuid())`);
      await expect(runtime.query(`INSERT INTO bwat.settings (key, value, revision) VALUES ('jev_enabled', NULL, 1)`)).rejects.toThrow(
        /null value/,
      );
    } finally {
      await runtime.end();
    }
  });
});
