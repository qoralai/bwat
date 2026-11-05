import { describe, expect, it } from 'vitest';
import { deleteMeeting } from '../src/meetings.ts';
import { raceBehindLock, until, untilWaiting } from './app.ts';
import { LIVE_SESSION } from '../src/sessions.ts';
import { describeDb } from './db/harness.ts';
import { MEMBER, MEMBER_ID, useRoles } from './people.ts';
import { brief, client, heldMeeting, listSessions, liveSession, postHandoff, putSession } from './sessions.ts';

/**
 * Each race is made deterministic by raceBehindLock: the change under test is started
 * while another transaction holds the row, and that transaction's own change commits
 * first, so the call under test must judge the row as it stands after the wait.
 */
describeDb('session and inbox races (QOR-4589)', () => {
  const t = useRoles();
  const sessionRow = (id: string) => ({
    sql: `SELECT 1 FROM sessions WHERE member_id = $1 AND session_id = $2 FOR UPDATE`,
    params: [MEMBER_ID, id],
  });
  const listed = async (id: string) => (await listSessions(t, MEMBER)).json().some((s: { session_id: string }) => s.session_id === id);

  it('two marks read at once keep one read_at: the one that waited keeps the first', async () => {
    const target = await liveSession(t);
    await postHandoff(t, brief(target));
    const id = (await t.pool.query(`SELECT id FROM inbox_messages WHERE target_client_session = $1`, [target])).rows[0].id;
    const first = '2026-01-01T00:00:00.000Z';
    const res = await raceBehindLock(
      t,
      { sql: `SELECT 1 FROM inbox_messages WHERE id = $1 FOR UPDATE`, params: [id] },
      () => t.app.inject({ method: 'PATCH', url: `/me/inbox/${id}`, headers: MEMBER }),
      (holder) => holder.query(`UPDATE inbox_messages SET read_at = $2 WHERE id = $1`, [id, first]),
    );
    expect(res.json()).toEqual({ id, read_at: first });
    expect((await t.pool.query(`SELECT read_at FROM inbox_messages WHERE id = $1`, [id])).rows[0].read_at.toISOString()).toBe(first);
  });

  it("an ended from the old instance, behind a new instance's takeover, is ignored", async () => {
    const id = await liveSession(t);
    await putSession(t, id, { client: client(), instance_id: 'old' });
    const res = await raceBehindLock(
      t,
      sessionRow(id),
      () => putSession(t, id, { client: client(), instance_id: 'old', ended: true }),
      (holder) => holder.query(`UPDATE sessions SET instance_id = 'new', last_seen_at = now() WHERE member_id = $1 AND session_id = $2`, [MEMBER_ID, id]),
    );
    expect(res.statusCode).toBe(200);
    expect(await listed(id)).toBe(true);
  });

  it("a new instance's heartbeat, behind the old instance's end, takes the session over", async () => {
    const id = await liveSession(t);
    await putSession(t, id, { client: client(), instance_id: 'old' });
    await raceBehindLock(
      t,
      sessionRow(id),
      () => putSession(t, id, { client: client(), instance_id: 'new' }),
      (holder) => holder.query(`UPDATE sessions SET ended_at = now() WHERE member_id = $1 AND session_id = $2`, [MEMBER_ID, id]),
    );
    expect(await listed(id)).toBe(true);
  });

  it('a hand-off behind its session ending is refused session_unreachable, and queues nothing', async () => {
    const id = await liveSession(t);
    const res = await raceBehindLock(
      t,
      sessionRow(id),
      () => postHandoff(t, brief(id)),
      (holder) => holder.query(`UPDATE sessions SET ended_at = now() WHERE member_id = $1 AND session_id = $2`, [MEMBER_ID, id]),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'session_unreachable' });
    expect((await t.pool.query(`SELECT 1 FROM inbox_messages WHERE target_client_session = $1`, [id])).rows).toHaveLength(0);
  });

  describe('a hand-off racing the delete of the meeting it names leaves no copy behind', () => {
    const copies = async (target: string) => (await t.pool.query(`SELECT 1 FROM inbox_messages WHERE target_client_session = $1`, [target])).rows;

    it('behind the delete: refused meeting_deleted', async () => {
      const meeting = await heldMeeting(t);
      const target = await liveSession(t);
      const res = await raceBehindLock(
        t,
        { sql: `SELECT 1 FROM meetings WHERE id = $1 FOR UPDATE`, params: [meeting] },
        () => postHandoff(t, brief(target, { occurrence_id: meeting })),
        (holder) => holder.query(`DELETE FROM meetings WHERE id = $1`, [meeting]),
      );
      expect([res.statusCode, res.json()]).toEqual([409, { error: 'meeting_deleted' }]);
      expect(await copies(target)).toHaveLength(0);
    });

    it('ahead of the delete: queued, and its copy deleted with the meeting', async () => {
      const meeting = await heldMeeting(t);
      const target = await liveSession(t);
      let deleted: Promise<unknown> | undefined;
      // The send holds the meeting and waits on its session; the delete then waits on the send.
      const res = await raceBehindLock(t, sessionRow(target), () => postHandoff(t, brief(target, { occurrence_id: meeting })), async () => {
        deleted = deleteMeeting(t.pool, meeting, null);
        await untilWaiting(t, 2);
      });
      expect(res.statusCode).toBe(202);
      expect(await deleted).toMatchObject({ segments_deleted: 0 });
      expect(await copies(target)).toHaveLength(0);
    });
  });

  it('a replay queued behind the first send answers its hand-off, though the session ended before the replay reached it', async () => {
    const id = await liveSession(t);
    const meeting = await heldMeeting(t);
    const sent = brief(id);
    // `key` holds A once it judged the session live, until rolled back; `room` holds the
    // replay B (which names a meeting) short of the session, if it gets that far.
    const [key, room] = [await t.pool.connect(), await t.pool.connect()];
    try {
      await key.query('BEGIN');
      await key.query(`INSERT INTO handoffs (sender_member_id, request_key) VALUES ($1, $2)`, [MEMBER_ID, sent.request_key]);
      await room.query('BEGIN');
      await room.query(`SELECT 1 FROM meetings WHERE id = $1 FOR UPDATE`, [meeting]);
      const a = postHandoff(t, sent);
      await untilWaiting(t, 1);
      const b = postHandoff(t, { ...sent, occurrence_id: meeting });
      await untilWaiting(t, 2);
      await key.query('ROLLBACK');
      const first = await a;
      expect(first.statusCode).toBe(202);
      await t.pool.query(`UPDATE sessions SET ended_at = now() WHERE member_id = $1 AND session_id = $2`, [MEMBER_ID, id]);
      await room.query('COMMIT');
      const replay = await b;
      expect([replay.statusCode, replay.json()]).toEqual([202, first.json()]);
    } finally {
      for (const c of [key, room]) {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
  });

  it('a hand-off behind a lock-only holder, while the 180 s window lapses, is refused session_unreachable', async () => {
    const id = await liveSession(t);
    // Live for 3 s more: the send reaches the lock while live, and the window lapses as it waits.
    await t.pool.query(`UPDATE sessions SET last_seen_at = clock_timestamp() - interval '177 seconds' WHERE session_id = $1`, [id]);
    const live = async () => (await t.pool.query(`SELECT ${LIVE_SESSION} AS live FROM sessions WHERE session_id = $1`, [id])).rows[0].live;
    const res = await raceBehindLock(t, sessionRow(id), () => postHandoff(t, brief(id)), async () => {
      expect(await live(), 'still live as the send waits').toBe(true);
      expect(await until(async () => !(await live()), { tries: 400, ms: 25 })).toBe(true);
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'session_unreachable' });
    expect((await t.pool.query(`SELECT 1 FROM inbox_messages WHERE target_client_session = $1`, [id])).rows).toHaveLength(0);
  });
});
