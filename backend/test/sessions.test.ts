import { describe, expect, it } from 'vitest';
import { describeDb } from './db/harness.ts';
import { hasLiveSession } from '../src/sessions.ts';
import { ADMIN, ADMIN_ID, MEMBER, MEMBER_ID, OWNER, OWNER_ID, useRoles } from './people.ts';
import { client, listSessions, notOnboardedDuring, putSession, sessionId } from './sessions.ts';

describeDb('client sessions (QOR-4589)', () => {
  const t = useRoles();
  const ids = async (headers = MEMBER) => (await listSessions(t, headers)).json().map((s: { session_id: string }) => s.session_id);

  it('registers a session and lists it as {session_id, client, last_seen_at}', async () => {
    const id = sessionId();
    const put = await putSession(t, id, { client: client(), instance_id: 'i-1' });
    expect(put.statusCode).toBe(200);
    expect(Object.keys(put.json()).sort()).toEqual(['client', 'last_seen_at', 'session_id']);
    expect(put.json()).toMatchObject({ session_id: id, client: client() });
    const listed = (await listSessions(t)).json().find((s: { session_id: string }) => s.session_id === id);
    expect(listed).toEqual(put.json());
  });

  it('replaces the descriptor, never merges it, and keeps no key it does not know', async () => {
    const id = sessionId();
    await putSession(t, id, { client: client(), instance_id: 'i-1' });
    const bare = client({ name: undefined, cwd: undefined });
    const put = await putSession(t, id, { client: { ...bare, extra: 'x' }, instance_id: 'i-1' });
    expect(put.json().client).toEqual(JSON.parse(JSON.stringify(bare)));
  });

  it('lists only sessions heard from within 180 s and not ended', async () => {
    const live = sessionId();
    const stale = sessionId();
    const ended = sessionId();
    for (const id of [live, stale, ended]) await putSession(t, id, { client: client(), instance_id: 'i-1' });
    await t.pool.query(`UPDATE sessions SET last_seen_at = now() - interval '181 seconds' WHERE session_id = $1`, [stale]);
    await putSession(t, ended, { client: client(), instance_id: 'i-1', ended: true });
    const listed = await ids();
    expect(listed).toContain(live);
    expect(listed).not.toContain(stale);
    expect(listed).not.toContain(ended);
  });

  it('says whether the member has a live session, by the same rule as the list', async () => {
    expect(await hasLiveSession(t.pool, OWNER_ID)).toBe(false);
    const id = sessionId();
    await putSession(t, id, { client: client(), instance_id: 'i-1' }, OWNER);
    expect(await hasLiveSession(t.pool, OWNER_ID)).toBe(true);
    await t.pool.query(`UPDATE sessions SET last_seen_at = now() - interval '181 seconds' WHERE session_id = $1`, [id]);
    expect(await hasLiveSession(t.pool, OWNER_ID)).toBe(false);
    await putSession(t, id, { client: client(), instance_id: 'i-2' }, OWNER);
    await putSession(t, id, { client: client(), instance_id: 'i-2', ended: true }, OWNER);
    expect(await hasLiveSession(t.pool, OWNER_ID)).toBe(false);
  });

  it("ignores an ended from an instance that is not the session's current one", async () => {
    const id = sessionId();
    await putSession(t, id, { client: client(), instance_id: 'old' });
    await putSession(t, id, { client: client({ name: 'new' }), instance_id: 'new' });
    const res = await putSession(t, id, { client: client(), instance_id: 'old', ended: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().client.name).toBe('new');
    expect(await ids()).toContain(id);
  });

  it('lets a heartbeat from a new instance take an ended session over, but not its own ended instance', async () => {
    const id = sessionId();
    await putSession(t, id, { client: client(), instance_id: 'i-1', ended: true });
    await putSession(t, id, { client: client(), instance_id: 'i-1' });
    expect(await ids()).not.toContain(id);
    await putSession(t, id, { client: client(), instance_id: 'i-2' });
    expect(await ids()).toContain(id);
  });

  it("keeps each member's sessions apart: the same id is another member's own session", async () => {
    const id = sessionId();
    await putSession(t, id, { client: client({ name: 'mine' }), instance_id: 'a' }, MEMBER);
    const theirs = await putSession(t, id, { client: client({ name: 'theirs' }), instance_id: 'b', ended: true }, ADMIN);
    expect(theirs.statusCode).toBe(200);
    expect(await ids(MEMBER)).toContain(id);
    expect(await ids(ADMIN)).not.toContain(id);
    const rows = (await t.pool.query(`SELECT member_id, client->>'name' AS name FROM sessions WHERE session_id = $1 ORDER BY name`, [id])).rows;
    expect(rows).toEqual([
      { member_id: MEMBER_ID, name: 'mine' },
      { member_id: ADMIN_ID, name: 'theirs' },
    ]);
  });

  describe('refuses', () => {
    it('anyone not signed in, 401', async () => {
      expect((await putSession(t, sessionId(), { client: client(), instance_id: 'i' }, {})).statusCode).toBe(401);
      expect((await listSessions(t, {})).statusCode).toBe(401);
    });

    it.each([
      ['a short id', 'short', {}],
      ['an id with a slash encoded', 'abc%2Fdefgh', {}],
      ['an id starting with a dot', '.abcdefg', {}],
      ['an id starting with a hyphen', '-abcdefg', {}],
      ['an id starting with an underscore', '_abcdefg', {}],
      ['a cwd with a slash', null, { client: client({ cwd: 'a/b' }) }],
      ['a cwd with a backslash', null, { client: client({ cwd: 'a\\b' }) }],
      ['an unknown kind', null, { client: client({ kind: 'cursor' }) }],
      ['an unknown wake', null, { client: client({ wake: 'later' }) }],
      ['no machine', null, { client: client({ machine: undefined }) }],
      ['no instance', null, { instance_id: undefined }],
      ['a non-boolean ended', null, { ended: 'yes' }],
      ['a NUL in the machine', null, { client: client({ machine: 'a\u0000b' }) }],
      ['a NUL in the instance', null, { instance_id: 'a\u0000b' }],
    ])('%s, 400 invalid_body', async (_name, id, change) => {
      const res = await putSession(t, id ?? sessionId(), { client: client(), instance_id: 'i', ...change });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_body' });
    });

    it('takes an 8-character id that starts with a letter or digit (QOR-4598)', async () => {
      for (const id of ['a1234567', '7._-abcd']) {
        expect((await putSession(t, id, { client: client(), instance_id: 'i' })).statusCode).toBe(200);
      }
    });

    it('a body over 4 KB, 413 too_large', async () => {
      const res = await putSession(t, sessionId(), { client: client({ name: 'x'.repeat(4200) }), instance_id: 'i' });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: 'too_large' });
    });

    it('everything before onboarding, 403 not_onboarded', async () => {
      await notOnboardedDuring(t, async () => {
        expect((await putSession(t, sessionId(), { client: client(), instance_id: 'i' })).json()).toEqual({ error: 'not_onboarded' });
        expect((await listSessions(t)).json()).toEqual({ error: 'not_onboarded' });
      });
    });
  });
});
