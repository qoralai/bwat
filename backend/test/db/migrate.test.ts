import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checksum, MIGRATIONS_DIR, migrate, migrateAll, migrateDatabase } from '../../src/db/migrate.ts';
import { describeDb, ROLE_NAMES, superuserUrl, useTestDb } from './harness.ts';

const LEDGER = 'SELECT name, checksum, applied_at FROM public.schema_migrations ORDER BY name';

/** A temporary migrations directory holding exactly these files (a name may be `plugins/<p>/NNNN_x.sql`). */
function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bwat-migrations-'));
  for (const [name, sql] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), sql);
  }
  return dir;
}

describe('migration checksum (QOR-4568)', () => {
  it('is the same for CRLF and LF checkouts of one file', () => {
    expect(checksum('CREATE TABLE a (id int);\r\nSELECT 1;\r\n')).toBe(checksum('CREATE TABLE a (id int);\nSELECT 1;\n'));
  });

  it('changes when the SQL changes', () => {
    expect(checksum('SELECT 1;\n')).not.toBe(checksum('SELECT 2;\n'));
  });
});

describeDb('the repository migrations (QOR-4568)', () => {
  const db = useTestDb({ migrate: false });
  let owner: pg.Client;

  beforeAll(async () => {
    owner = await db.connect('owner');
  });

  afterAll(async () => {
    await owner?.end();
  });

  it('apply in order as the owner role, are recorded with checksums, and a second run is a no-op', async () => {
    const core = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(core[0]).toMatch(/^0001_/);
    // QOR-4806: then each plugin's, under its own namespace
    const pluginsDir = join(MIGRATIONS_DIR, 'plugins');
    const plugins = readdirSync(pluginsDir).sort().flatMap((p) =>
      readdirSync(join(pluginsDir, p)).filter((f) => f.endsWith('.sql')).sort().map((f) => `plugins/${p}/${f}`),
    );
    const files = [...core, ...plugins];

    expect(await migrateDatabase(db.url('owner'))).toEqual(files);

    const before = (await owner.query(LEDGER)).rows;
    expect(before.map((r) => r.name)).toEqual(files);
    for (const row of before) expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);

    const schema = await owner.query(`SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'bwat'`);
    expect(schema.rows).toEqual([{ owner: ROLE_NAMES.owner }]);
    const ledger = await owner.query(`SELECT tableowner FROM pg_tables WHERE tablename = 'schema_migrations'`);
    expect(ledger.rows).toEqual([{ tableowner: ROLE_NAMES.owner }]);

    expect(await migrateDatabase(db.url('owner'))).toEqual([]);
    expect((await owner.query(LEDGER)).rows).toEqual(before);
  });

  it('refuses to run as a superuser, which would own what it creates', async () => {
    await expect(migrateDatabase(superuserUrl(db.name))).rejects.toThrow('migrations must run as the owner role, not a superuser');
  });
});

describeDb('the migrations login (QOR-4572)', () => {
  const db = useTestDb({ migrate: false });

  it('refuses a role that is not the database owner, even one that can act as it (the RDS master)', async () => {
    await expect(migrateDatabase(db.url('master'))).rejects.toThrow(
      `migrations must run as the database owner ${ROLE_NAMES.owner}, not ${ROLE_NAMES.master}`,
    );
    const owner = await db.connect('owner');
    try {
      expect((await owner.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'bwat'`)).rows).toEqual([]);
    } finally {
      await owner.end();
    }
  });
});

describeDb('the migrations runner (QOR-4568)', () => {
  const db = useTestDb({ migrate: false });
  let owner: pg.Client;
  const dirs: string[] = [];
  const dir = (files: Record<string, string>) => {
    const d = migrationsDir(files);
    dirs.push(d);
    return d;
  };

  beforeAll(async () => {
    owner = await db.connect('owner');
  });

  // Each test starts from an empty database: drop whatever the last one migrated.
  beforeEach(async () => {
    await owner.query(`DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP TABLE public.%I CASCADE', t);
      END LOOP;
    END $$`);
  });

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  afterAll(async () => {
    await owner?.end();
  });

  const tables = async () =>
    (await owner.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map(
      (r) => r.tablename,
    );

  it('applies files in name order, so a later file can use an earlier one', async () => {
    const d = dir({
      '0010_later.sql': 'INSERT INTO first (id) VALUES (1);',
      '0002_first.sql': 'CREATE TABLE first (id int);',
    });
    expect(await migrate(owner, d)).toEqual(['0002_first.sql', '0010_later.sql']);
    expect((await owner.query('SELECT id FROM first')).rows).toEqual([{ id: 1 }]);
  });

  it('applies each file in its own transaction: a failing file leaves the earlier ones applied and itself not at all', async () => {
    const d = dir({
      '0001_ok.sql': 'CREATE TABLE ok (id int);',
      '0002_bad.sql': 'CREATE TABLE half (id int);\nSELECT 1 / 0;',
    });
    await expect(migrate(owner, d)).rejects.toThrow('migration 0002_bad.sql failed: division by zero');
    expect(await tables()).toEqual(['ok', 'schema_migrations']);
    expect((await owner.query(LEDGER)).rows.map((r) => r.name)).toEqual(['0001_ok.sql']);
  });

  it('refuses an applied file that was edited afterwards, and applies nothing after it', async () => {
    const d = dir({ '0001_a.sql': 'CREATE TABLE a (id int);' });
    await migrate(owner, d);
    writeFileSync(join(d, '0001_a.sql'), 'CREATE TABLE a (id int, sneaky text);');
    writeFileSync(join(d, '0002_b.sql'), 'CREATE TABLE b (id int);');
    await expect(migrate(owner, d)).rejects.toThrow('migration 0001_a.sql was edited after it was applied');
    expect(await tables()).toEqual(['a', 'schema_migrations']);
  });

  it('accepts the same applied file checked out with CRLF line endings', async () => {
    const d = dir({ '0001_a.sql': 'CREATE TABLE a (id int);\nCREATE TABLE b (id int);\n' });
    await migrate(owner, d);
    writeFileSync(join(d, '0001_a.sql'), 'CREATE TABLE a (id int);\r\nCREATE TABLE b (id int);\r\n');
    expect(await migrate(owner, d)).toEqual([]);
  });

  it('refuses a .sql file that is not named NNNN_name.sql rather than silently skipping it', async () => {
    const d = dir({ '0001_a.sql': 'CREATE TABLE a (id int);', '2_b.sql': 'CREATE TABLE b (id int);' });
    await expect(migrate(owner, d)).rejects.toThrow('2_b.sql is not named NNNN_name.sql');
    expect(await tables()).toEqual([]);
  });

  it('refuses an applied migration whose file is missing, and applies nothing (QOR-4572)', async () => {
    const d = dir({ '0001_a.sql': 'CREATE TABLE a (id int);', '0002_b.sql': 'CREATE TABLE b (id int);' });
    await migrate(owner, d);
    rmSync(join(d, '0002_b.sql'));
    writeFileSync(join(d, '0003_c.sql'), 'CREATE TABLE c (id int);');
    await expect(migrate(owner, d)).rejects.toThrow('migration 0002_b.sql was applied but its file is missing');
    expect(await tables()).toEqual(['a', 'b', 'schema_migrations']);
  });

  it('refuses two files with the same number, and applies nothing (QOR-4572)', async () => {
    const d = dir({ '0001_a.sql': 'CREATE TABLE a (id int);', '0001_b.sql': 'CREATE TABLE b (id int);' });
    await expect(migrate(owner, d)).rejects.toThrow('migrations 0001_a.sql and 0001_b.sql share the number 0001');
    expect(await tables()).toEqual([]);
  });

  it('refuses a pending file numbered before one already applied, and applies nothing (QOR-4572)', async () => {
    const d = dir({ '0001_a.sql': 'CREATE TABLE a (id int);', '0003_c.sql': 'CREATE TABLE c (id int);' });
    await migrate(owner, d);
    writeFileSync(join(d, '0002_b.sql'), 'CREATE TABLE b (id int);');
    await expect(migrate(owner, d)).rejects.toThrow('migration 0002_b.sql is numbered before 0003_c.sql, which is already applied');
    expect(await tables()).toEqual(['a', 'c', 'schema_migrations']);
  });

  it('lets two runs started at once take turns: each file is applied exactly once', async () => {
    const d = dir({ '0001_a.sql': 'CREATE TABLE a (id int);', '0002_b.sql': 'CREATE TABLE b (id int);' });
    const runs = await Promise.all([migrateDatabase(db.url('owner'), d), migrateDatabase(db.url('owner'), d)]);
    expect(runs.flat().sort()).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  // QOR-4806: a plugin's migrations are numbered on their own, under plugins/<name>/ in the ledger.
  it("applies core first, then each plugin's own files, numbered apart: a plugin's 0001 never collides with core's", async () => {
    const d = dir({
      '0001_core.sql': 'CREATE TABLE core (id int PRIMARY KEY);',
      'plugins/zeta/0001_z.sql': 'CREATE TABLE z (id int REFERENCES core (id));',
      'plugins/alpha/0001_a.sql': 'CREATE TABLE a (id int);',
    });
    expect(await migrateAll(owner, d)).toEqual(['0001_core.sql', 'plugins/alpha/0001_a.sql', 'plugins/zeta/0001_z.sql']);
    expect(await migrateAll(owner, d)).toEqual([]);
    expect(await tables()).toEqual(['a', 'core', 'schema_migrations', 'z']);
  });

  it("checks each namespace against its own folder only: core's order and missing-file rules ignore plugin rows", async () => {
    const d = dir({ '0002_core.sql': 'CREATE TABLE core (id int);', 'plugins/p/0005_p.sql': 'CREATE TABLE p (id int);' });
    await migrateAll(owner, d);
    // a later core file numbered before the plugin's 0005 is still in order: the plugin row is not core's
    writeFileSync(join(d, '0003_more.sql'), 'CREATE TABLE more (id int);');
    expect(await migrateAll(owner, d)).toEqual(['0003_more.sql']);
  });

  it("refuses a plugin's applied file that went missing, naming it by its ledger key", async () => {
    const d = dir({ '0001_core.sql': 'CREATE TABLE core (id int);', 'plugins/p/0001_p.sql': 'CREATE TABLE p (id int);' });
    await migrateAll(owner, d);
    rmSync(join(d, 'plugins', 'p', '0001_p.sql'));
    writeFileSync(join(d, 'plugins', 'p', '0002_q.sql'), 'CREATE TABLE q (id int);');
    await expect(migrateAll(owner, d)).rejects.toThrow('migration plugins/p/0001_p.sql was applied but its file is missing');
    expect(await tables()).toEqual(['core', 'p', 'schema_migrations']);
  });

  it('refuses a plugins folder that is not a plugin name', async () => {
    const d = dir({ '0001_core.sql': 'SELECT 1;', 'plugins/Bad_Name/0001_x.sql': 'SELECT 1;' });
    await expect(migrateAll(owner, d)).rejects.toThrow('plugin migrations folder Bad_Name is not a plugin name');
  });

  it('cannot be run by the runtime role', async () => {
    await expect(migrateDatabase(db.url('runtime'))).rejects.toThrow();
    expect(await tables()).toEqual([]);
  });
});
