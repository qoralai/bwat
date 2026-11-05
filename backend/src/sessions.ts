import type pg from 'pg';
import { withTransaction } from './db/pool.ts';

/**
 * Client sessions (QOR-4589): the member's local agent sessions a plugin router
 * registers and heartbeats (D144). Each member has their own namespace of session ids
 * (migration 0008), so every read and write here is by member and session id together.
 */

/**
 * Whether a session (a row of bwat.sessions) is reachable: not ended, and heard from
 * within 180 s (3 missed 60 s beats). The one rule GET /sessions and POST /handoffs judge
 * by, on the clock (clock_timestamp(), not the transaction's start), so a session the list
 * shows is one a hand-off accepts at the same instant, and a hand-off that waited on the
 * session's lock judges it as of now.
 */
export const LIVE_SESSION = `(ended_at IS NULL AND last_seen_at > clock_timestamp() - interval '180 seconds')`;

/** The descriptor a router sends, as stored. */
interface SessionClient {
  kind: 'claude-code' | 'codex' | 'mcp';
  wake: 'push' | 'mailbox' | 'pull';
  machine: string;
  platform: string;
  plugin_version: string;
  name?: string | undefined;
  cwd?: string | undefined;
  /** Words the plugin works out from what the session is working on. */
  keywords?: string[] | undefined;
}

interface Session {
  session_id: string;
  client: SessionClient;
  last_seen_at: Date;
}

const COLUMNS = 'session_id, client, last_seen_at';

/**
 * Registers or heartbeats a session, or ends it. One statement, so its rules are judged
 * on the row as it is when the statement takes it, after any change in flight commits:
 * - a heartbeat from the current instance renews it and replaces its descriptor;
 * - one from another instance takes it over (a new client process), reopening it if ended;
 * - an ended from the current instance ends it; one from any other instance is ignored;
 * - anything from the instance that ended it is ignored: that process said it is gone.
 * The session as it now stands, and whether this call ended it.
 */
export async function putSession(
  pool: pg.Pool,
  memberId: string,
  sessionId: string,
  { client, instance_id, ended }: { client: SessionClient; instance_id: string; ended: boolean },
): Promise<{ session: Session; ended: boolean; registered: boolean }> {
  const { rows } = await pool.query<Session & { registered: boolean }>(
    `INSERT INTO sessions AS s (member_id, session_id, instance_id, client, ended_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)
     ON CONFLICT (member_id, session_id) DO UPDATE
        SET instance_id = EXCLUDED.instance_id, client = EXCLUDED.client, last_seen_at = now(), ended_at = EXCLUDED.ended_at
      WHERE (s.instance_id <> EXCLUDED.instance_id AND NOT $5) OR (s.instance_id = EXCLUDED.instance_id AND s.ended_at IS NULL)
     RETURNING ${COLUMNS}, xmax = 0 AS registered`,
    [memberId, sessionId, instance_id, client, ended],
  );
  if (rows[0]) {
    const { registered, ...session } = rows[0];
    return { session, ended, registered };
  }
  // Ignored: answer the session as it stands.
  const current = await pool.query<Session>(`SELECT ${COLUMNS} FROM sessions WHERE member_id = $1 AND session_id = $2`, [memberId, sessionId]);
  return { session: current.rows[0]!, ended: false, registered: false };
}

/** The member's reachable sessions, most recently heard from first. */
export async function liveSessions(pool: pg.Pool, memberId: string): Promise<Session[]> {
  const { rows } = await pool.query<Session>(
    `SELECT ${COLUMNS} FROM sessions
      WHERE member_id = $1 AND ${LIVE_SESSION}
      ORDER BY last_seen_at DESC, session_id`,
    [memberId],
  );
  return rows;
}

/** Whether the member has a reachable session, by the same rule as liveSessions. */
export async function hasLiveSession(pool: pg.Pool, memberId: string): Promise<boolean> {
  const { rows } = await pool.query<{ live: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM sessions WHERE member_id = $1 AND ${LIVE_SESSION}) AS live`,
    [memberId],
  );
  return rows[0]!.live;
}

/** Makes one of the member's sessions their default, moving it from any other; false if the session is not theirs. */
export function setDefaultSession(pool: pg.Pool, memberId: string, sessionId: string): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    // Lock all the member's sessions, so two changes at once take turns instead of colliding
    // on the one-default index.
    const own = await client.query<{ session_id: string }>('SELECT session_id FROM sessions WHERE member_id = $1 FOR UPDATE', [memberId]);
    if (!own.rows.some((r) => r.session_id === sessionId)) return false;
    await client.query('UPDATE sessions SET is_default = false WHERE member_id = $1 AND is_default AND session_id <> $2', [memberId, sessionId]);
    await client.query('UPDATE sessions SET is_default = true WHERE member_id = $1 AND session_id = $2', [memberId, sessionId]);
    return true;
  });
}

/** Clears the member's default if it is this session; false if the session is not theirs. */
export async function clearDefaultSession(pool: pg.Pool, memberId: string, sessionId: string): Promise<boolean> {
  const { rowCount } = await pool.query('UPDATE sessions SET is_default = false WHERE member_id = $1 AND session_id = $2', [memberId, sessionId]);
  return Boolean(rowCount);
}

/** The member's default session, live or not, or null when none is set. */
export async function defaultSession(pool: pg.Pool, memberId: string): Promise<{ session_id: string; client: SessionClient; live: boolean } | null> {
  const { rows } = await pool.query<{ session_id: string; client: SessionClient; live: boolean }>(
    `SELECT session_id, client, ${LIVE_SESSION} AS live FROM sessions WHERE member_id = $1 AND is_default`,
    [memberId],
  );
  return rows[0] ?? null;
}
