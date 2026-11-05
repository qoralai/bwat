import { expect, it } from 'vitest';
import { createPool } from '../src/db/pool.ts';
import { buildServer } from '../src/server.ts';
import { apiBase } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { ADMIN, ADMIN_ID, MEMBER, MEMBER_ID, OWNER_ID, withRoles } from './people.ts';
import { brief, client, sessionId } from './sessions.ts';

describeDb('sessions, hand-offs and the inbox through the server, and what they log (QOR-4589)', () => {
  const db = useTestDb();

  it('logs event names and ids only: never a subject, body, cwd, machine or name', async () => {
    const lines: string[] = [];
    const pool = createPool(db.url('runtime'));
    const app = apiBase(
      buildServer({ pool, authenticatePerson: withRoles, logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } } }),
    );
    try {
      for (const [id, role] of [
        [ADMIN_ID, 'admin'],
        [MEMBER_ID, 'member'],
        [OWNER_ID, 'owner'],
      ]) {
        await pool.query(`INSERT INTO members (id, email, role, activated_at) VALUES ($1, $2, $3, now())`, [id, `${role}@test.invalid`, role]);
      }
      const leaky = client({ machine: 'leakymachine', name: 'leakyname', cwd: 'leakycwd' });
      const sent = brief('', { subject: 'leakysubject', body: 'leakybody' });
      const live = sessionId();
      const gone = sessionId();
      const call = (method: string, url: string, payload?: object, headers = MEMBER) =>
        app.inject({ method: method as 'GET', url, headers, ...(payload && { payload }) });

      const codes = [
        (await call('PUT', `/sessions/${live}`, { client: leaky, instance_id: 'i-1' })).statusCode,
        (await call('PUT', `/sessions/${gone}`, { client: leaky, instance_id: 'i-1' })).statusCode,
        (await call('PUT', `/sessions/${gone}`, { client: leaky, instance_id: 'i-1', ended: true })).statusCode,
        (await call('PUT', `/sessions/${live}`, { client: { ...leaky, cwd: 'leaky/cwd' }, instance_id: 'i-1' })).statusCode,
        (await call('PUT', `/sessions/${live}`, { client: { ...leaky, name: 'leakyname'.repeat(500) }, instance_id: 'i-1' })).statusCode,
        (await call('GET', '/sessions')).statusCode,
        (await call('POST', '/handoffs', { ...sent, target_session_id: live })).statusCode,
        (await call('POST', '/handoffs', { ...sent, request_key: 'k-2', target_session_id: gone })).statusCode,
        (await call('POST', '/handoffs', { ...sent, request_key: 'k-3', target_session_id: live }, ADMIN)).statusCode,
        (await call('POST', '/handoffs', { ...sent, request_key: 'k-4', target_session_id: live, body: 'leakybody'.repeat(2000) })).statusCode,
        (await call('POST', '/handoffs', { ...sent, request_key: 'k-5', target_session_id: live, subject: 7 })).statusCode,
      ];
      expect(codes).toEqual([200, 200, 200, 400, 413, 200, 202, 409, 403, 413, 400]);
      const listed = await call('GET', `/me/inbox?scope=session&client_session=${live}`);
      const id = listed.json().messages[0].id;
      expect([
        (await call('GET', `/me/inbox/${id}`)).statusCode,
        (await call('PATCH', `/me/inbox/${id}`)).statusCode,
        (await call('GET', `/me/inbox/${id}`, undefined, ADMIN)).statusCode,
        (await call('DELETE', `/me/inbox/${id}`)).statusCode,
      ]).toEqual([200, 200, 404, 204]);

      const logged = lines.join('\n');
      for (const content of ['leakymachine', 'leakyname', 'leakycwd', 'leaky/cwd', 'leakysubject', 'leakybody', 'test.invalid']) {
        expect(logged, content).not.toContain(content);
      }
      const events = lines.map((l) => JSON.parse(l).event).filter(Boolean);
      expect(events).toEqual(
        expect.arrayContaining(['session.registered', 'session.ended', 'handoff.queued', 'handoff.session_unreachable', 'inbox.message_deleted']),
      );
      expect(logged).toContain(live);
      expect(logged).toContain(id);
    } finally {
      await app.close();
      await pool.end();
    }
  });
});
