import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CHECK_VIOLATION, describeDb, INSUFFICIENT_PRIVILEGE, sqlstate, UNIQUE_VIOLATION, useTestDb } from './harness.ts';

describeDb('meeting and transcript tables (QOR-4577)', () => {
  const db = useTestDb();
  let runtime: pg.Client;
  let meetingId: string;

  beforeAll(async () => {
    runtime = await db.connect('runtime');
    await runtime.query('SET search_path = bwat');
  });

  afterAll(async () => {
    await runtime?.end();
  });

  it('records a meeting once per occurrence, open until its transcript is complete', async () => {
    const { rows } = await runtime.query(
      `INSERT INTO meetings (occurrence_uuid, meeting_number) VALUES ('occ/A+1==', '123456789') RETURNING *`,
    );
    meetingId = rows[0].id;
    expect(meetingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]).toMatchObject({ finalization: 'open', title: null, ended_at: null, duration_seconds: null });
    expect(await sqlstate(runtime, `INSERT INTO meetings (occurrence_uuid, meeting_number) VALUES ('occ/A+1==', '123456789')`)).toBe(
      UNIQUE_VIOLATION,
    );
    expect(await sqlstate(runtime, `UPDATE meetings SET finalization = 'whatever'`)).toBe(CHECK_VIOLATION);
  });

  it('works out the duration from the start and end', async () => {
    await runtime.query(`UPDATE meetings SET ended_at = started_at + interval '42 minutes 5 seconds' WHERE id = $1`, [meetingId]);
    const { rows } = await runtime.query(`SELECT duration_seconds FROM meetings WHERE id = $1`, [meetingId]);
    expect(rows[0].duration_seconds).toBe(2525);
  });

  it('keeps one segment per (meeting, epoch, seq), from asr or chat only', async () => {
    const insert = `INSERT INTO transcript_segments (meeting_id, epoch, seq, speaker_label, text, start_ms, end_ms, source)
                    VALUES ($1, $2, $3, 'Speaker', 'hello', 0, 10, $4)`;
    expect(await sqlstate(runtime, insert, [meetingId, 1, 0, 'asr'])).toBe('ok');
    expect(await sqlstate(runtime, insert, [meetingId, 1, 0, 'asr'])).toBe(UNIQUE_VIOLATION);
    expect(await sqlstate(runtime, insert, [meetingId, 2, 0, 'asr'])).toBe('ok');
    expect(await sqlstate(runtime, insert, [meetingId, 1, 2, 'chat'])).toBe('ok');
    // Chat shares the epoch's seq space: one row per seq, whatever its source.
    expect(await sqlstate(runtime, insert, [meetingId, 1, 0, 'chat'])).toBe(UNIQUE_VIOLATION);
    expect(await sqlstate(runtime, insert, [meetingId, 1, 1, 'self'])).toBe(CHECK_VIOLATION);
  });

  it('lets the runtime role read, write and delete meetings and segments, add erasure records, and nothing more', async () => {
    expect(await sqlstate(runtime, `UPDATE transcript_segments SET speaker_label = 'Removed' WHERE meeting_id = $1`, [meetingId])).toBe('ok');
    expect(await sqlstate(runtime, `ALTER TABLE meetings ADD COLUMN sneaky text`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `TRUNCATE transcript_segments`)).toBe(INSUFFICIENT_PRIVILEGE);
    // Erasure records are written and read, never changed or removed by hand.
    expect(await sqlstate(runtime, `INSERT INTO erased_segments VALUES ($1, 1, 0)`, [meetingId])).toBe('ok');
    expect(await sqlstate(runtime, `UPDATE erased_segments SET seq = 5`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DELETE FROM erased_segments`)).toBe(INSUFFICIENT_PRIVILEGE);
    // Deleting a meeting takes its segments and erasure records with it.
    expect(await sqlstate(runtime, `DELETE FROM meetings WHERE id = $1`, [meetingId])).toBe('ok');
    const { rows } = await runtime.query(
      `SELECT (SELECT count(*) FROM transcript_segments)::int AS n, (SELECT count(*) FROM erased_segments)::int AS e`,
    );
    expect(rows[0]).toEqual({ n: 0, e: 0 });
  });

  it('keeps a deleted occurrence for good: the runtime role adds and reads one, never changes or removes it', async () => {
    const insert = `INSERT INTO deleted_occurrences (occurrence_uuid) VALUES ('gone/A+1==')`;
    expect(await sqlstate(runtime, insert)).toBe('ok');
    expect(await sqlstate(runtime, insert)).toBe(UNIQUE_VIOLATION);
    const { rows } = await runtime.query(`SELECT deleted_at FROM deleted_occurrences WHERE occurrence_uuid = 'gone/A+1=='`);
    expect(rows[0].deleted_at).toBeInstanceOf(Date);
    expect(await sqlstate(runtime, `UPDATE deleted_occurrences SET deleted_at = now()`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DELETE FROM deleted_occurrences`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('indexes claims by occurrence, for every transcript read and push (ended claims are kept forever)', async () => {
    const { rows } = await runtime.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'bwat' AND tablename = 'claims'`,
    );
    const defs = rows.map((r: { indexdef: string }) => r.indexdef.replace(/^.* USING /, 'USING '));
    expect(defs).toContain('USING btree (occurrence_uuid) WHERE (occurrence_uuid IS NOT NULL)');
  });
});
