import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CHECK_VIOLATION, describeDb, INSUFFICIENT_PRIVILEGE, sqlstate, UNDEFINED_COLUMN, UNIQUE_VIOLATION, useTestDb } from './harness.ts';

describeDb('identity tables and what the runtime role may do with them (QOR-4575)', () => {
  const db = useTestDb();
  let runtime: pg.Client;

  beforeAll(async () => {
    runtime = await db.connect('runtime');
    await runtime.query('SET search_path = bwat');
  });

  afterAll(async () => {
    await runtime?.end();
  });

  it('can add, read, change and remove members', async () => {
    const { rows } = await runtime.query<{ id: string; role: string }>(
      `INSERT INTO members (email, role) VALUES ('ada@example.com', 'owner') RETURNING id, role`,
    );
    const id = rows[0]!.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await sqlstate(runtime, `UPDATE members SET display_name = 'A' WHERE id = $1`, [id])).toBe('ok');
    expect(await sqlstate(runtime, `UPDATE members SET zoom_user_id = 'z-1' WHERE id = $1`, [id])).toBe('ok');
    expect(await sqlstate(runtime, `INSERT INTO members (email) VALUES ('gone@example.com')`)).toBe('ok');
    expect(await sqlstate(runtime, `DELETE FROM members WHERE email = 'gone@example.com'`)).toBe('ok');
  });

  it('holds one member per email, stored lower-cased, and only the three roles', async () => {
    expect(await sqlstate(runtime, `INSERT INTO members (email) VALUES ('ada@example.com')`)).toBe(UNIQUE_VIOLATION);
    expect(await sqlstate(runtime, `INSERT INTO members (email) VALUES ('Bob@example.com')`)).toBe(CHECK_VIOLATION);
    expect(await sqlstate(runtime, `INSERT INTO members (email, role) VALUES ('c@example.com', 'root')`)).toBe(
      CHECK_VIOLATION,
    );
    const { rows } = await runtime.query(`INSERT INTO members (email) VALUES ('d@example.com') RETURNING role`);
    expect(rows[0].role).toBe('member');
  });

  it("binds a member to at most one Google account (its sub), and records when it was activated", async () => {
    expect(
      await sqlstate(runtime, `UPDATE members SET google_sub = 'sub-1', activated_at = now() WHERE email = 'ada@example.com'`),
    ).toBe('ok');
    expect(await sqlstate(runtime, `UPDATE members SET google_sub = 'sub-1' WHERE email = 'd@example.com'`)).toBe(
      UNIQUE_VIOLATION,
    );
    expect(await sqlstate(runtime, `UPDATE members SET google_sub = '' WHERE email = 'd@example.com'`)).toBe(CHECK_VIOLATION);
    expect(
      await sqlstate(runtime, `UPDATE members SET google_sub = repeat('1', 256) WHERE email = 'd@example.com'`),
    ).toBe(CHECK_VIOLATION);
    const { rows } = await runtime.query(`SELECT google_sub, activated_at FROM members WHERE email = 'd@example.com'`);
    expect(rows).toEqual([{ google_sub: null, activated_at: null }]);
  });

  it('maps a Zoom user to at most one member', async () => {
    expect(await sqlstate(runtime, `UPDATE members SET zoom_user_id = 'z-1' WHERE email = 'd@example.com'`)).toBe(
      UNIQUE_VIOLATION,
    );
  });

  it('keeps no hand-typed Zoom email: signing in through the Zoom app links a member (QOR-4961)', async () => {
    expect(await sqlstate(runtime, `SELECT zoom_email FROM members`)).toBe(UNDEFINED_COLUMN);
  });

  it('can append to the audit and read it, but never change or delete an entry', async () => {
    const insert = `INSERT INTO audit (actor_id, action, target_type, target_id, before, after)
                    VALUES (gen_random_uuid(), 'member.role_changed', 'member', gen_random_uuid(),
                            '{"role":"member"}', '{"role":"admin"}')`;
    expect(await sqlstate(runtime, insert)).toBe('ok');
    expect(await sqlstate(runtime, `SELECT * FROM audit`)).toBe('ok');
    expect(await sqlstate(runtime, `UPDATE audit SET action = 'member.edited'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DELETE FROM audit`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `TRUNCATE audit`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('keeps the audit when its actor or target member is removed', async () => {
    const { rows } = await runtime.query<{ id: string }>(
      `INSERT INTO members (email) VALUES ('leaver@example.com') RETURNING id`,
    );
    const id = rows[0]!.id;
    await runtime.query(
      `INSERT INTO audit (actor_id, action, target_type, target_id) VALUES ($1, 'member.invited', 'member', $1)`,
      [id],
    );
    expect(await sqlstate(runtime, `DELETE FROM members WHERE id = $1`, [id])).toBe('ok');
    const left = await runtime.query(`SELECT 1 FROM audit WHERE target_id = $1`, [id]);
    expect(left.rowCount).toBe(1);
  });

  it('cannot change the tables themselves', async () => {
    expect(await sqlstate(runtime, `ALTER TABLE members ADD COLUMN x int`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DROP TABLE audit`)).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
