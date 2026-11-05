import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TestApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { ADMIN, MEMBER, MEMBER_ID, useRoles } from './people.ts';
import { brief, heldMeeting, liveSession, notOnboardedDuring, postHandoff, sessionId } from './sessions.ts';

const inbox = (t: TestApp, query = '', headers: Record<string, string> = MEMBER) =>
  t.app.inject({ method: 'GET', url: `/me/inbox${query}`, headers });
const message = (t: TestApp, method: 'GET' | 'PATCH' | 'DELETE', id: string, headers: Record<string, string> = MEMBER) =>
  t.app.inject({ method, url: `/me/inbox/${id}`, headers });

/** Queues a hand-off to a fresh live session of the caller's; the message's id and what was sent. */
async function handedOff(t: TestApp, headers: Record<string, string> = MEMBER) {
  const target = await liveSession(t, headers);
  const sent = brief(target, { occurrence_id: await heldMeeting(t) });
  await postHandoff(t, sent, headers);
  const id = (await t.pool.query<{ id: string }>(`SELECT id FROM inbox_messages WHERE target_client_session = $1`, [target])).rows[0]!.id;
  return { id, target, sent };
}

/** `count` messages straight into the member's inbox for `target`, a second apart, oldest first; their ids. */
async function seeded(t: TestApp, target: string, count: number, memberId = MEMBER_ID): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO inbox_messages (recipient_member_id, sender_member_id, handoff_id, target_client_session, source_kind, source_id, subject, body, created_at)
       VALUES ($1, $1, gen_random_uuid(), $2, 'todo', gen_random_uuid(), 's', 'b', now() - make_interval(secs => $3)) RETURNING id`,
      [memberId, target, count - i],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

const ids = (res: { json: () => { messages: { id: string }[] } }) => res.json().messages.map((m) => m.id);

describeDb('the hand-off inbox (QOR-4589, D148)', () => {
  const t = useRoles();

  describe('GET /me/inbox', () => {
    it("lists the caller's messages without their body, read_at null while unread", async () => {
      const { id, target, sent } = await handedOff(t);
      const res = await inbox(t, `?scope=session&client_session=${target}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        messages: [
          {
            id,
            message_type: 'handoff',
            created_at: expect.any(String),
            read_at: null,
            target_client_session: target,
            source: { kind: 'card', id: sent.source_id, occurrence_id: sent.occurrence_id },
            handoff_id: expect.any(String),
            subject: sent.subject,
          },
        ],
      });
    });

    it('lists oldest first and pages by an opaque cursor, with no next_cursor on the last page', async () => {
      const target = sessionId();
      const all = await seeded(t, target, 5);
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const res = await inbox(t, `?scope=session&client_session=${target}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        pages.push(ids(res));
        cursor = res.json().next_cursor;
      } while (cursor);
      expect(pages).toEqual([all.slice(0, 2), all.slice(2, 4), all.slice(4)]);
    });

    it('lists 20 by default', async () => {
      const target = sessionId();
      await seeded(t, target, 21);
      const res = await inbox(t, `?scope=session&client_session=${target}`);
      expect(ids(res)).toHaveLength(20);
      expect(res.json().next_cursor).toEqual(expect.any(String));
    });

    it('scope=session lists one session; scope=all, or none, every session of the caller, ignoring client_session', async () => {
      const a = sessionId();
      const b = sessionId();
      const [inA] = await seeded(t, a, 1);
      const [inB] = await seeded(t, b, 1);
      expect(ids(await inbox(t, `?scope=session&client_session=${a}`))).toEqual([inA]);
      for (const query of [`?scope=all&client_session=${a}&limit=100`, '?limit=100']) {
        expect(ids(await inbox(t, query))).toEqual(expect.arrayContaining([inA, inB]));
      }
    });

    it('unread_only=true leaves read messages out; false keeps them', async () => {
      const target = sessionId();
      const [read, unread] = await seeded(t, target, 2);
      await message(t, 'PATCH', read!);
      expect(ids(await inbox(t, `?scope=session&client_session=${target}&unread_only=true`))).toEqual([unread]);
      expect(ids(await inbox(t, `?scope=session&client_session=${target}&unread_only=false`))).toEqual([read, unread]);
    });

    it("never lists another member's messages, even by their session id", async () => {
      const theirs = await handedOff(t, ADMIN);
      expect(ids(await inbox(t, `?scope=session&client_session=${theirs.target}`))).toEqual([]);
      expect(ids(await inbox(t, '?limit=100'))).not.toContain(theirs.id);
    });

    it.each(['?scope=session', '?limit=0', '?limit=101', '?limit=x', '?cursor=nope', '?unread_only=yes', '?scope=mine', '?scope=session&client_session=x', '?scope=session&client_session=.abcdefg', '?scope=session&client_session=-abcdefg', '?scope=session&client_session=_abcdefg'])(
      'refuses %s, 400 invalid_query',
      async (query) => {
        const res = await inbox(t, query);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_query' });
      },
    );
  });

  describe('GET, PATCH and DELETE /me/inbox/{id}', () => {
    it('reads the full message, body included', async () => {
      const { id, sent } = await handedOff(t);
      const res = await message(t, 'GET', id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, read_at: null, subject: sent.subject, body: sent.body });
    });

    it('marks one message read, and a second PATCH keeps the first read_at', async () => {
      const { id } = await handedOff(t);
      const first = await message(t, 'PATCH', id);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ id, read_at: expect.any(String) });
      const again = await message(t, 'PATCH', id);
      expect(again.json()).toEqual(first.json());
      expect((await message(t, 'GET', id)).json().read_at).toBe(first.json().read_at);
    });

    it('deletes a message, 204, and again 204', async () => {
      const { id } = await handedOff(t);
      expect((await message(t, 'DELETE', id)).statusCode).toBe(204);
      expect((await message(t, 'GET', id)).statusCode).toBe(404);
      expect((await message(t, 'DELETE', id)).statusCode).toBe(204);
    });

    it("answers another member's message as one that does not exist, and leaves it as it was", async () => {
      const theirs = await handedOff(t, ADMIN);
      for (const method of ['GET', 'PATCH'] as const) {
        const res = await message(t, method, theirs.id);
        expect(res.statusCode, method).toBe(404);
        expect(res.json()).toEqual({ error: 'not_found' });
      }
      // A delete answers 204 for any id the caller does not own, so it never tells whether one exists.
      const deleted = await message(t, 'DELETE', theirs.id);
      expect(deleted.statusCode).toBe(204);
      expect(deleted.statusCode).toBe((await message(t, 'DELETE', randomUUID())).statusCode);
      const row = (await t.pool.query(`SELECT read_at FROM inbox_messages WHERE id = $1`, [theirs.id])).rows;
      expect(row).toEqual([{ read_at: null }]);
    });

    it('answers an unknown or malformed id 404 for a read or a mark', async () => {
      for (const id of [randomUUID(), 'not-a-uuid']) {
        expect((await message(t, 'GET', id)).statusCode).toBe(404);
        expect((await message(t, 'PATCH', id)).statusCode).toBe(404);
      }
      expect((await message(t, 'DELETE', randomUUID())).statusCode).toBe(204);
      expect((await message(t, 'DELETE', 'not-a-uuid')).statusCode).toBe(404);
    });
  });

  it('refuses anyone not signed in, 401, and everything before onboarding, 403 not_onboarded', async () => {
    const { id } = await handedOff(t);
    const calls = [() => inbox(t, '', {}), ...(['GET', 'PATCH', 'DELETE'] as const).map((m) => () => message(t, m, id, {}))];
    for (const call of calls) expect((await call()).statusCode).toBe(401);
    await notOnboardedDuring(t, async () => {
      const signedIn = [() => inbox(t), ...(['GET', 'PATCH', 'DELETE'] as const).map((m) => () => message(t, m, id))];
      for (const call of signedIn) expect((await call()).json()).toEqual({ error: 'not_onboarded' });
    });
    expect((await message(t, 'GET', id)).json().read_at).toBeNull();
  });
});

describeDb("a member's removal takes their sessions, hand-offs and inbox (QOR-4589)", () => {
  const t = useRoles();

  it('DELETE /members/{id} answers 204 and leaves no session, hand-off or message of theirs', async () => {
    const { target } = await handedOff(t);
    expect((await t.pool.query(`SELECT 1 FROM sessions WHERE session_id = $1`, [target])).rows).toHaveLength(1);
    expect((await t.app.inject({ method: 'DELETE', url: `/members/${MEMBER_ID}`, headers: ADMIN })).statusCode).toBe(204);
    const left = await t.pool.query(
      `SELECT (SELECT count(*) FROM sessions WHERE member_id = $1)::int AS sessions,
              (SELECT count(*) FROM handoffs WHERE sender_member_id = $1)::int AS handoffs,
              (SELECT count(*) FROM inbox_messages WHERE recipient_member_id = $1)::int AS messages`,
      [MEMBER_ID],
    );
    expect(left.rows[0]).toEqual({ sessions: 0, handoffs: 0, messages: 0 });
  });
});
