import { expect, it } from 'vitest';
import { occurrenceUuid, resetAllocationsBeforeEach, signedIn, useApp, type TestApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting, pushTranscript, segment } from './meetings.ts';
import { ADMIN, useRoles } from './people.ts';
import { client, putSession, sessionId } from './sessions.ts';

/**
 * JSON carries a NUL (\u0000); Postgres text and jsonb refuse it (22021, 22P05). Whatever
 * route stores it, that is the caller's bad body: 400 invalid_body, nothing stored, and
 * the log names the code, never the value (QOR-4589).
 */
const NUL = String.fromCharCode(0);
const LEAK = 'leakynul';

function capturedLogs() {
  const lines: string[] = [];
  return { lines, logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } } };
}

/** `send`'s answer is 400 invalid_body, and what it logged names a 22xxx code, never the value. */
async function expectRefusedAndLoggedByCode(lines: string[], send: () => Promise<{ statusCode: number; json: () => unknown }>) {
  const from = lines.length;
  const res = await send();
  lines = lines.slice(from);
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'invalid_body' });
  const logged = lines.join('\n');
  expect(logged).not.toContain(LEAK);
  const rejected = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'request.rejected');
  expect(rejected.map((l) => l.code)).toEqual(expect.arrayContaining([expect.stringMatching(/^(22021|22P05)$/)]));
  expect(lines.some((l) => JSON.parse(l).event === 'request.failed')).toBe(false);
}

describeDb('a NUL in text a route stores (QOR-4589): transcript text', () => {
  const logs = capturedLogs();
  const t: TestApp = useApp({ authenticatePerson: signedIn, logger: logs.logger });
  resetAllocationsBeforeEach(t);

  it('refuses a transcript segment whose text holds a NUL', async () => {
    const occurrence = occurrenceUuid();
    const bot = await botInMeeting(t, occurrence, '933111222');
    await expectRefusedAndLoggedByCode(logs.lines, () =>
      pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0, { text: `${LEAK}${NUL}` })] }),
    );
    expect((await t.pool.query(`SELECT 1 FROM transcript_segments s JOIN meetings m ON m.id = s.meeting_id WHERE m.occurrence_uuid = $1`, [occurrence])).rows).toHaveLength(0);
  });
});

describeDb('a NUL in text a route stores (QOR-4589): members and sessions', () => {
  const logs = capturedLogs();
  const t = useRoles({ allowedDomains: ['example.com'], logger: logs.logger });

  it('refuses an invite whose display_name holds a NUL', async () => {
    await expectRefusedAndLoggedByCode(logs.lines, () =>
      t.app.inject({ method: 'POST', url: '/members', headers: ADMIN, payload: { email: 'nul@example.com', display_name: `${LEAK}${NUL}` } }),
    );
    expect((await t.pool.query(`SELECT 1 FROM members WHERE email = 'nul@example.com'`)).rows).toHaveLength(0);
  });

  it("refuses a session whose descriptor holds a NUL (jsonb's 22P05)", async () => {
    const id = sessionId();
    await expectRefusedAndLoggedByCode(logs.lines, () => putSession(t, id, { client: client({ machine: `${LEAK}${NUL}` }), instance_id: 'i-1' }));
    expect((await t.pool.query(`SELECT 1 FROM sessions WHERE session_id = $1`, [id])).rows).toHaveLength(0);
  });
});
