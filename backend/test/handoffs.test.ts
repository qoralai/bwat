import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runRetention } from '../src/retention.ts';
import { describeDb } from './db/harness.ts';
import { ADMIN, MEMBER, MEMBER_ID, useRoles } from './people.ts';
import { brief, heldMeeting, client, listSessions, liveSession, notOnboardedDuring, postHandoff, putSession, sessionId } from './sessions.ts';
import type { TestApp } from './app.ts';

const messagesFor = async (t: TestApp, target: string) =>
  (await t.pool.query(`SELECT * FROM inbox_messages WHERE target_client_session = $1 ORDER BY created_at`, [target])).rows;

describeDb('POST /handoffs (QOR-4589)', () => {
  const t = useRoles();

  it("queues one unread message for the caller's live session, and answers queued, nothing more", async () => {
    const target = await liveSession(t);
    const sent = brief(target, { occurrence_id: await heldMeeting(t) });
    const res = await postHandoff(t, sent);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ handoff_id: expect.any(String), status: 'queued' });
    const rows = await messagesFor(t, target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_member_id: MEMBER_ID,
      sender_member_id: MEMBER_ID,
      message_type: 'handoff',
      handoff_id: res.json().handoff_id,
      source_kind: 'card',
      source_id: sent.source_id,
      occurrence_id: sent.occurrence_id,
      subject: sent.subject,
      body: sent.body,
      read_at: null,
    });
  });

  it('answers a repeated request_key with the first hand-off and queues no second message', async () => {
    const target = await liveSession(t);
    const sent = brief(target);
    const first = await postHandoff(t, sent);
    const again = await postHandoff(t, { ...sent, subject: 'changed' });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    expect(await messagesFor(t, target)).toHaveLength(1);
  });

  it('answers a repeat with the first hand-off even once its session has ended', async () => {
    const target = await liveSession(t);
    const sent = brief(target);
    const first = await postHandoff(t, sent);
    await putSession(t, target, { client: client(), instance_id: 'i-1', ended: true });
    const again = await postHandoff(t, sent);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
  });

  it("keeps request keys per sender: another member's same key is their own hand-off", async () => {
    const mine = await liveSession(t, MEMBER);
    const theirs = await liveSession(t, ADMIN);
    const key = randomUUID();
    const a = await postHandoff(t, brief(mine, { request_key: key }), MEMBER);
    const b = await postHandoff(t, brief(theirs, { request_key: key }), ADMIN);
    expect(b.statusCode).toBe(202);
    expect(b.json().handoff_id).not.toBe(a.json().handoff_id);
  });

  it('accepts exactly the sessions GET /sessions lists: one rule for both, either side of 180 s', async () => {
    for (const [age, live] of [
      [170, true],
      [190, false],
    ] as const) {
      const id = await liveSession(t);
      await t.pool.query(`UPDATE sessions SET last_seen_at = clock_timestamp() - make_interval(secs => $2) WHERE session_id = $1`, [id, age]);
      const listed = (await listSessions(t)).json().some((s: { session_id: string }) => s.session_id === id);
      const sent = await postHandoff(t, brief(id));
      expect([listed, sent.statusCode], `${age} s`).toEqual(live ? [true, 202] : [false, 409]);
    }
  });

  it("goes with the meeting it names: an admin's delete of the meeting deletes the copy, read or not", async () => {
    const meeting = await heldMeeting(t);
    const target = await liveSession(t);
    expect((await postHandoff(t, brief(target, { occurrence_id: meeting }))).statusCode).toBe(202);
    await t.pool.query(`UPDATE inbox_messages SET read_at = now() WHERE target_client_session = $1`, [target]);
    expect((await t.app.inject({ method: 'DELETE', url: `/meetings/${meeting}`, headers: ADMIN })).statusCode).toBe(200);
    expect(await messagesFor(t, target)).toHaveLength(0);
  });

  describe('refuses, queuing nothing', () => {
    it("a target that is not one of the caller's sessions, 403 forbidden: another member's or none at all", async () => {
      const theirs = await liveSession(t, ADMIN);
      for (const target of [theirs, sessionId()]) {
        const res = await postHandoff(t, brief(target));
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden' });
        expect(await messagesFor(t, target)).toHaveLength(0);
      }
    });

    it("the caller's own session once it ended or went quiet for 180 s, 409 session_unreachable", async () => {
      const ended = await liveSession(t);
      await putSession(t, ended, { client: client(), instance_id: 'i-1', ended: true });
      const quiet = await liveSession(t);
      await t.pool.query(`UPDATE sessions SET last_seen_at = now() - interval '181 seconds' WHERE session_id = $1`, [quiet]);
      for (const target of [ended, quiet]) {
        const res = await postHandoff(t, brief(target));
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: 'session_unreachable' });
        expect(await messagesFor(t, target)).toHaveLength(0);
      }
    });

    it('a refused send keeps no request_key: the same click succeeds once the session is back', async () => {
      const target = await liveSession(t);
      await putSession(t, target, { client: client(), instance_id: 'i-1', ended: true });
      const sent = brief(target);
      expect((await postHandoff(t, sent)).statusCode).toBe(409);
      await putSession(t, target, { client: client(), instance_id: 'i-2' });
      expect((await postHandoff(t, sent)).statusCode).toBe(202);
    });

    it('a meeting bwat no longer holds, 409 meeting_deleted: one an admin deleted, or one never held; and keeps no request_key', async () => {
      const old = await heldMeeting(t, 40);
      expect((await t.app.inject({ method: 'DELETE', url: `/meetings/${old}`, headers: ADMIN })).statusCode).toBe(200);
      for (const meeting of [old, randomUUID()]) {
        const target = await liveSession(t);
        const sent = brief(target, { occurrence_id: meeting });
        const res = await postHandoff(t, sent);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: 'meeting_deleted' });
        expect(await messagesFor(t, target)).toHaveLength(0);
        expect((await postHandoff(t, { ...sent, occurrence_id: undefined })).statusCode).toBe(202);
        expect(await messagesFor(t, target)).toHaveLength(1);
      }
    });

    it("a meeting whose transcript retention expired is still held (D163): its cards stay, so a brief from one queues", async () => {
      const old = await heldMeeting(t, 40);
      expect(await runRetention(t.pool, 30)).toMatchObject({ transcripts_expired: 1 });
      const target = await liveSession(t);
      expect((await postHandoff(t, brief(target, { occurrence_id: old }))).statusCode).toBe(202);
      expect(await messagesFor(t, target)).toHaveLength(1);
    });

    it.each([
      ['no target', { target_session_id: undefined }],
      ['a malformed target', { target_session_id: 'x' }],
      ['a target starting with a dot', { target_session_id: '.abcdefg' }],
      ['a target starting with a hyphen', { target_session_id: '-abcdefg' }],
      ['a target starting with an underscore', { target_session_id: '_abcdefg' }],
      ['no request_key', { request_key: undefined }],
      ['an empty request_key', { request_key: '' }],
      ['an unknown source_kind', { source_kind: 'meeting' }],
      ['a source_id that is not a uuid', { source_id: '42' }],
      ['an occurrence_id that is not a uuid', { occurrence_id: 'abc' }],
      ['no subject', { subject: undefined }],
      ['an empty body', { body: '' }],
      ['a NUL in the subject', { subject: 'a\u0000b' }],
      ['a NUL in the body', { body: 'a\u0000b' }],
      ['a NUL in the request_key', { request_key: 'a\u0000b' }],
    ])('%s, 400 invalid_body', async (_name, change) => {
      const target = await liveSession(t);
      const res = await postHandoff(t, brief(target, change));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_body' });
      expect(await messagesFor(t, target)).toHaveLength(0);
    });

    it.each([
      ['a subject over 500 characters', { subject: 's'.repeat(501) }],
      ['a body over 10000 characters', { body: 'b'.repeat(10_001) }],
      ['a request over 64 KB', { body: 'b'.repeat(70_000) }],
    ])('%s, 413 too_large', async (_name, change) => {
      const target = await liveSession(t);
      const res = await postHandoff(t, brief(target, change));
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: 'too_large' });
      expect(await messagesFor(t, target)).toHaveLength(0);
    });

    it('takes a subject of 500 and a body of 10000 characters', async () => {
      const target = await liveSession(t);
      expect((await postHandoff(t, brief(target, { subject: 's'.repeat(500), body: 'b'.repeat(10_000) }))).statusCode).toBe(202);
    });

    it('anyone not signed in, 401; everything before onboarding, 403 not_onboarded', async () => {
      const target = await liveSession(t);
      expect((await postHandoff(t, brief(target), {})).statusCode).toBe(401);
      await notOnboardedDuring(t, async () => {
        expect((await postHandoff(t, brief(target))).json()).toEqual({ error: 'not_onboarded' });
      });
      expect(await messagesFor(t, target)).toHaveLength(0);
    });
  });
});
