import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertRuntimeRole } from '../../src/db/runtime-role.ts';
import { describeDb, INSUFFICIENT_PRIVILEGE, ROLE_NAMES, sqlstate, useTestDb } from './harness.ts';

describeDb('the runtime role (QOR-4568)', () => {
  const db = useTestDb();
  let owner: pg.Client;
  let runtime: pg.Client;

  beforeAll(async () => {
    owner = await db.connect('owner');
    // What a later migration does: a table in the app schema, with explicit grants.
    // An append-only table is granted SELECT and INSERT only.
    await owner.query(`CREATE TABLE bwat.notes (id int PRIMARY KEY, body text)`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.notes TO ${ROLE_NAMES.runtime}`);
    await owner.query(`CREATE TABLE bwat.events (id int PRIMARY KEY, kind text)`);
    await owner.query(`GRANT SELECT, INSERT ON bwat.events TO ${ROLE_NAMES.runtime}`);
    await owner.query(`CREATE TABLE bwat.ungranted (id int)`);
    runtime = await db.connect('runtime');
  });

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
  });

  it('is not a superuser and cannot bypass row-level security', async () => {
    const { rows } = await runtime.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false }]);
  });

  it('cannot create tables anywhere, temporary ones included', async () => {
    expect(await sqlstate(runtime, `CREATE TABLE bwat.sneaky (id int)`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `CREATE TABLE public.sneaky (id int)`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `CREATE TEMP TABLE sneaky (id int)`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `CREATE SCHEMA sneaky`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot alter the schema or its tables', async () => {
    expect(await sqlstate(runtime, `ALTER SCHEMA bwat RENAME TO sneaky`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `ALTER TABLE bwat.notes ADD COLUMN sneaky text`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DROP TABLE bwat.notes`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `TRUNCATE bwat.notes`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `CREATE INDEX sneaky ON bwat.notes (body)`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot read or rewrite the migrations ledger', async () => {
    expect(await sqlstate(runtime, `SELECT * FROM public.schema_migrations`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DELETE FROM public.schema_migrations`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('gets exactly the DML a table grants it, and sees the app schema without qualifying names', async () => {
    await runtime.query(`SET search_path = bwat`);
    expect(await sqlstate(runtime, `INSERT INTO notes VALUES (1, 'a')`)).toBe('ok');
    expect(await sqlstate(runtime, `UPDATE notes SET body = 'b' WHERE id = 1`)).toBe('ok');
    expect(await sqlstate(runtime, `DELETE FROM notes WHERE id = 1`)).toBe('ok');
    expect(await sqlstate(runtime, `INSERT INTO events VALUES (1, 'joined')`)).toBe('ok');
    expect(await sqlstate(runtime, `SELECT * FROM events`)).toBe('ok');
    expect(await sqlstate(runtime, `UPDATE events SET kind = 'left'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DELETE FROM events`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `SELECT * FROM ungranted`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('passes the startup check the server runs before it listens', async () => {
    await expect(assertRuntimeRole(runtime)).resolves.toBeUndefined();
  });

  it('fails that check for the owner role, so the server never runs as the owner', async () => {
    await expect(assertRuntimeRole(owner)).rejects.toThrow(
      `database role check failed: ${ROLE_NAMES.owner} owns the database or the app schema`,
    );
  });
});
