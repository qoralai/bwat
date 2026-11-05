import { expect, it } from 'vitest';
import { describeDb } from './db/harness.ts';
import { ADMIN, MEMBER, useRoles } from './people.ts';
import { client, listSessions, putSession, sessionId } from './sessions.ts';

describeDb('session keywords and the default session (QOR-4843)', () => {
  const t = useRoles();
  const setDefault = (id: string, headers = MEMBER) => t.app.inject({ method: 'PUT', url: `/sessions/${id}/default`, headers });
  const clearDefault = (id: string, headers = MEMBER) => t.app.inject({ method: 'DELETE', url: `/sessions/${id}/default`, headers });
  const theDefault = async (headers = MEMBER) => (await t.app.inject({ method: 'GET', url: '/me/default-session', headers })).json();
  const live = async (overrides = {}, headers = MEMBER) => {
    const id = sessionId();
    await putSession(t, id, { client: client(overrides), instance_id: 'i-1' }, headers);
    return id;
  };

  it("stores a session's keywords with its descriptor and lists them", async () => {
    const keywords = ['bwat', 'auto-apply', 'qor-4840', 'window.py'];
    const id = await live({ keywords });
    const listed = (await listSessions(t)).json().find((s: { session_id: string }) => s.session_id === id);
    expect(listed.client.keywords).toEqual(keywords);
  });

  it('keeps only plain lowercase keywords, at most 24, and never refuses the heartbeat for them', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const id = sessionId();
    const res = await putSession(t, id, { client: client({ keywords: ['bwat', 'Has Space', '<b>x</b>', 'x'.repeat(33), 'c++', ...many] }), instance_id: 'i-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().client.keywords).toEqual(['bwat', ...many.slice(0, 23)]);
  });

  it('sets one default when two sessions are made the default at once', async () => {
    const a = await live();
    const b = await live();
    const [ra, rb] = await Promise.all([setDefault(a), setDefault(b)]);
    expect([ra.statusCode, rb.statusCode]).toEqual([204, 204]);
    const member = (await t.pool.query(`SELECT member_id FROM sessions WHERE session_id = $1`, [a])).rows[0].member_id;
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM sessions WHERE member_id = $1 AND is_default`, [member])).rows[0].n).toBe(1);
  });

  it("sets the member's default session and answers it with its descriptor and whether it is live", async () => {
    const id = await live({ name: 'bwat work' });
    expect((await setDefault(id)).statusCode).toBe(204);
    expect(await theDefault()).toEqual({ session_id: id, client: expect.objectContaining({ name: 'bwat work' }), live: true });
  });

  it('moves the default when another session is made the default', async () => {
    const first = await live();
    const second = await live();
    await setDefault(first);
    await setDefault(second);
    expect((await theDefault()).session_id).toBe(second);
  });

  it("refuses another member's session as the default", async () => {
    const theirs = await live({}, ADMIN);
    expect((await setDefault(theirs)).statusCode).toBe(404);
    expect((await theDefault()).session_id).not.toBe(theirs);
  });

  it('keeps the default when the session ends, answering it as not live, and the list leaves it out', async () => {
    const id = await live();
    await setDefault(id);
    await putSession(t, id, { client: client(), instance_id: 'i-1', ended: true });
    expect(await theDefault()).toMatchObject({ session_id: id, live: false });
    expect((await listSessions(t)).json().map((s: { session_id: string }) => s.session_id)).not.toContain(id);
  });

  it('keeps the default when a new instance of the session takes it over', async () => {
    const id = await live();
    await setDefault(id);
    await putSession(t, id, { client: client(), instance_id: 'i-2' });
    expect(await theDefault()).toMatchObject({ session_id: id, live: true });
  });

  it('clears the default, leaving none', async () => {
    const id = await live();
    await setDefault(id);
    expect((await clearDefault(id)).statusCode).toBe(204);
    expect(await theDefault()).toEqual({});
  });

  it('never holds two defaults for one member', async () => {
    const first = await live();
    const second = await live();
    await setDefault(first);
    const member = (await t.pool.query(`SELECT member_id FROM sessions WHERE session_id = $1`, [first])).rows[0].member_id;
    await expect(t.pool.query(`UPDATE sessions SET is_default = true WHERE member_id = $1 AND session_id = $2`, [member, second])).rejects.toThrow();
  });
});
