import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CHECK_VIOLATION, describeDb, INSUFFICIENT_PRIVILEGE, sqlstate, UNIQUE_VIOLATION, useTestDb } from './harness.ts';

describeDb('Zoom webhook tables and what the runtime role may do with them (QOR-4576)', () => {
  const db = useTestDb();
  let runtime: pg.Client;

  beforeAll(async () => {
    runtime = await db.connect('runtime');
    await runtime.query('SET search_path = bwat');
  });

  afterAll(async () => {
    await runtime?.end();
  });

  it('records a delivery once by its digest, and may forget one, but never edit one', async () => {
    expect(await sqlstate(runtime, `INSERT INTO zoom_deliveries (body_sha256) VALUES (sha256('d1'))`)).toBe('ok');
    expect(await sqlstate(runtime, `INSERT INTO zoom_deliveries (body_sha256) VALUES (sha256('d1'))`)).toBe(
      UNIQUE_VIOLATION,
    );
    expect(await sqlstate(runtime, `INSERT INTO zoom_deliveries (body_sha256) VALUES ('\\x00')`)).toBe(CHECK_VIOLATION);
    expect(await sqlstate(runtime, `SELECT body_sha256, received_at FROM zoom_deliveries`)).toBe('ok');
    expect(await sqlstate(runtime, `UPDATE zoom_deliveries SET received_at = now()`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DELETE FROM zoom_deliveries WHERE body_sha256 = sha256('d1')`)).toBe('ok');
  });

  it('keeps no settings table of its own: the auto-join switch lives in settings (QOR-4578)', async () => {
    const { rows } = await runtime.query(`SELECT to_regclass('bwat.app_settings') AS t`);
    expect(rows[0].t).toBeNull();
  });

  it('records an ended occurrence once, may sweep one, but never edit one', async () => {
    const add = `INSERT INTO zoom_ended_occurrences (meeting_number, occurrence_uuid) VALUES ('123456789', 'occ-1')`;
    expect(await sqlstate(runtime, add)).toBe('ok');
    expect(await sqlstate(runtime, add)).toBe(UNIQUE_VIOLATION);
    expect(
      await sqlstate(runtime, `INSERT INTO zoom_ended_occurrences (meeting_number, occurrence_uuid) VALUES ('12', 'occ-2')`),
    ).toBe(CHECK_VIOLATION);
    expect(await sqlstate(runtime, `SELECT meeting_number, occurrence_uuid, ended_at FROM zoom_ended_occurrences`)).toBe('ok');
    expect(await sqlstate(runtime, `UPDATE zoom_ended_occurrences SET ended_at = now()`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DELETE FROM zoom_ended_occurrences WHERE ended_at < now()`)).toBe('ok');
  });

  it("serves a meeting's claims, ended or open, from an index", async () => {
    const { rows } = await runtime.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'bwat' AND tablename = 'claims' AND indexname = 'claims_by_meeting'`,
    );
    expect(rows[0]?.indexdef).toMatch(/\(meeting_number, created_at\)$/);
  });

  it('cannot change the tables themselves', async () => {
    for (const table of ['zoom_deliveries', 'zoom_ended_occurrences']) {
      expect(await sqlstate(runtime, `ALTER TABLE ${table} ADD COLUMN x int`), table).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(runtime, `TRUNCATE ${table}`), table).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });
});
