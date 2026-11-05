import { expect, it } from 'vitest';
import { asSuperuser, describeDb, ROLE_NAMES, useTestDb } from './harness.ts';

// What the runtime role may do on each table of migration 0008, exactly.
const TABLE_PRIVILEGES = `
  SELECT c.relname AS table, array_agg(p ORDER BY p) AS privileges
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   WHERE n.nspname = 'bwat' AND c.relname = ANY($2) AND has_table_privilege($1, c.oid, p)
   GROUP BY c.relname ORDER BY c.relname`;

describeDb('migration 0008: sessions, hand-offs, inbox (QOR-4589)', () => {
  const db = useTestDb();

  it('grants the runtime role exactly the DML each table needs: DELETE on the inbox, whose delete is a feature, and on hand-off keys, which retention prunes (QOR-4600)', async () => {
    const tables = ['sessions', 'handoffs', 'inbox_messages'];
    const rows = await asSuperuser(async (su) => (await su.query(TABLE_PRIVILEGES, [ROLE_NAMES.runtime, tables])).rows, db.name);
    expect(Object.fromEntries(rows.map((r) => [r.table, r.privileges]))).toEqual({
      handoffs: ['DELETE', 'INSERT', 'SELECT'],
      inbox_messages: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      sessions: ['INSERT', 'SELECT', 'UPDATE'],
    });
  });

  it('indexes the lookups that run on every poll: live sessions by member, the inbox by recipient (and session) in cursor order', async () => {
    const rows = await asSuperuser(
      async (su) =>
        (
          await su.query(
            `SELECT regexp_replace(indexdef, '^.* USING ', '') AS def FROM pg_indexes
              WHERE schemaname = 'bwat' AND tablename IN ('sessions', 'inbox_messages') ORDER BY 1`,
          )
        ).rows.map((r) => r.def),
      db.name,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        'btree (member_id, last_seen_at) WHERE (ended_at IS NULL)',
        'btree (recipient_member_id, created_at, id)',
        'btree (recipient_member_id, target_client_session, created_at, id)',
        'btree (occurrence_id)',
        'btree (created_at)',
      ]),
    );
  });
});
