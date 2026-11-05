import { randomUUID } from 'node:crypto';
import type { TestApp } from './app.ts';
import { MEMBER } from './people.ts';

/** A plugin router's descriptor of its client (D144). */
export const client = (overrides: Record<string, unknown> = {}) => ({
  kind: 'claude-code',
  wake: 'push',
  machine: 'laptop-1',
  platform: 'win32',
  plugin_version: '0.1.0',
  name: 'sessions work',
  cwd: 'bwat',
  ...overrides,
});

export const putSession = (t: TestApp, id: string, payload: object, headers: Record<string, string> = MEMBER) =>
  t.app.inject({ method: 'PUT', url: `/sessions/${id}`, headers, payload });

export const listSessions = (t: TestApp, headers: Record<string, string> = MEMBER) => t.app.inject({ method: 'GET', url: '/sessions', headers });

/** A fresh session id, so no two tests share one. */
export const sessionId = () => `sess-${randomUUID()}`;

/** A session of the caller's, live now. */
export async function liveSession(t: TestApp, headers: Record<string, string> = MEMBER): Promise<string> {
  const id = sessionId();
  await putSession(t, id, { client: client(), instance_id: 'i-1' }, headers);
  return id;
}

interface Brief {
  source_kind: string;
  source_id: string;
  occurrence_id?: string;
  target_session_id: string;
  request_key: string;
  subject: string;
  body: string;
}

/** A brief for one of the caller's sessions; each call its own request_key. */
export const brief = (target: string, overrides: Record<string, unknown> = {}): Brief => ({
  source_kind: 'card',
  source_id: randomUUID(),
  target_session_id: target,
  request_key: randomUUID(),
  subject: 'Write the release notes',
  body: 'Owner: Sam. "Can you write the release notes by Friday?" Card: https://bwat.invalid/cards/1',
  ...overrides,
});

/** A meeting bwat holds, ended `daysAgo` days ago: its id, the occurrence_id a brief names. */
export async function heldMeeting(t: TestApp, daysAgo = 0): Promise<string> {
  const { rows } = await t.pool.query<{ id: string }>(
    `INSERT INTO meetings (occurrence_uuid, meeting_number, started_at, ended_at)
     VALUES (gen_random_uuid()::text, '944000111', now() - make_interval(days => $1, hours => 1), now() - make_interval(days => $1))
     RETURNING id`,
    [daysAgo],
  );
  return rows[0]!.id;
}

export const postHandoff = (t: TestApp, payload: object, headers: Record<string, string> = MEMBER) =>
  t.app.inject({ method: 'POST', url: '/handoffs', headers, payload });

/** Closes the install for the duration of `fn`: no activated owner, so people's routes answer not_onboarded (D149). */
export async function notOnboardedDuring(t: TestApp, fn: () => Promise<void>): Promise<void> {
  const owners = (await t.pool.query<{ id: string }>(`UPDATE members SET role = 'admin' WHERE role = 'owner' RETURNING id`)).rows.map((r) => r.id);
  try {
    await fn();
  } finally {
    await t.pool.query(`UPDATE members SET role = 'owner' WHERE id = ANY($1::uuid[])`, [owners]);
  }
}
