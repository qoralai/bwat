import { randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { audit } from './audit.ts';
import { digest } from './credentials.ts';
import { withTransaction } from './db/pool.ts';
import { MEMBER_COLUMNS, MEMBERS_LOCK_KEY, type Member } from './members.ts';
import { CODE_SOURCE_PREFIX, codeSource, issueToken } from './zoom-board-signin.ts';

/**
 * Sign-in with the install's code (QOR-5007, D202): a local install, on one computer, has no
 * Google. Setup shows the code once and keeps only its sha256 (BWAT_SIGNIN_CODE_SHA256); the
 * person types it with any email and becomes a member under that email. Whoever holds the
 * code is trusted with every account: that is the local tier's bargain, said plainly wherever the code
 * is shown. Once Google is configured (T1) the code signs nobody in, and endCodeSignIn
 * removes the members it let in.
 */

/** The code as typed: any case, with or without its dashes and spaces. */
export const normaliseCode = (typed: string): string => typed.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * A name for the code that is safe to store beside its sessions: the first 16 hex of its
 * sha256. A new code has a new tag, so the old code's sessions and board tokens stop.
 */
export const codeTag = (codeDigest: Buffer): string => codeDigest.toString('hex').slice(0, 16);


/** Setup's codes are 32 characters; anything shorter is never the code, whatever was saved. */
export const CODE_LENGTH = 32;

/** Whether `typed` is the code whose sha256 is `codeDigest`, compared in constant time. */
export function codeMatches(codeDigest: Buffer, typed: string): boolean {
  const code = normaliseCode(typed);
  return timingSafeEqual(digest(code), codeDigest) && code.length >= CODE_LENGTH;
}

/** What a code sign-in answers: a board token, when it lapses, and the refresh token that mints the next. */
export interface CodeSession {
  member: Member;
  token: string;
  expiresAt: Date;
  refreshToken: string;
}

const REFRESH_PREFIX = 'bwr_';
/** How long a code session's refresh token mints board tokens; then the person signs in again. */
const REFRESH_DAYS = 30;

/**
 * The member `email` signs in as with the code: the member already at that email, or a new
 * one (joined_by_code). The owner role goes to BWAT_FIRST_OWNER_EMAIL (`firstOwnerEmail`), or,
 * when none is named, to the first sign-in of an install with no activated owner (D149). An
 * email an admin removed is refused until it is invited again, as with Google. Under the
 * members lock, so one owner is made however many first sign-ins race.
 */
export async function codeSignIn(
  pool: pg.Pool,
  email: string,
  { firstOwnerEmail, tag }: { firstOwnerEmail?: string | undefined; tag: string },
): Promise<CodeSession | 'removed'> {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MEMBERS_LOCK_KEY]);
    const removed = await client.query(`SELECT 1 FROM removed_members WHERE email = $1`, [email]);
    if (removed.rowCount) return 'removed';
    const owned = (await client.query(`SELECT 1 FROM members WHERE role = 'owner' AND activated_at IS NOT NULL LIMIT 1`)).rowCount === 1;
    const claims = !owned && (firstOwnerEmail === undefined || email === firstOwnerEmail);
    const known = (await client.query<Member>(`SELECT ${MEMBER_COLUMNS} FROM members WHERE email = $1`, [email])).rows[0];
    let member: Member;
    if (known) {
      // An invited member stays invited, not joined by code: the move to Google keeps them.
      member = (
        await client.query<Member>(
          `UPDATE members SET role = CASE WHEN $2 THEN 'owner' ELSE role END, activated_at = coalesce(activated_at, now()),
           updated_at = now() WHERE id = $1 RETURNING ${MEMBER_COLUMNS}`,
          [known.id, claims],
        )
      ).rows[0]!;
      if (claims) {
        await audit(client, { actor: null, action: 'member.owner_claimed', target: 'member', targetId: member.id, before: { role: known.role }, after: { role: 'owner' } });
      }
    } else {
      const role = claims ? 'owner' : 'member';
      member = (
        await client.query<Member>(
          `INSERT INTO members (email, role, activated_at, joined_by_code) VALUES ($1, $2, now(), true) RETURNING ${MEMBER_COLUMNS}`,
          [email, role],
        )
      ).rows[0]!;
      await audit(client, { actor: null, action: claims ? 'member.owner_claimed' : 'member.joined', target: 'member', targetId: member.id, after: { role, by: 'code' } });
    }
    const refreshToken = `${REFRESH_PREFIX}${randomBytes(32).toString('base64url')}`;
    // Every sign-in adds a row, and a session left to lapse is never signed out, so the
    // expired ones go here.
    await client.query(`DELETE FROM code_sessions WHERE created_at <= now() - make_interval(days => $1)`, [REFRESH_DAYS]);
    await sweepBoardTokens(client);
    await client.query(`INSERT INTO code_sessions (refresh_sha256, member_id, code_tag) VALUES ($1, $2, $3)`, [digest(refreshToken), member.id, tag]);
    const { token, expiresAt } = await issueToken(client, member.id, codeSource(tag));
    return { member, token, expiresAt, refreshToken };
  });
}

/**
 * A new board token for a code session made with the current code (`tag`), or null when
 * the refresh token is unknown, signed out, its member removed, from an older code, or
 * older than REFRESH_DAYS.
 */
export async function refreshCodeSession(pool: pg.Pool, refreshToken: string, tag: string): Promise<{ token: string; expiresAt: Date } | null> {
  const { rows } = await pool.query<{ member_id: string }>(
    `SELECT member_id FROM code_sessions WHERE refresh_sha256 = $1 AND code_tag = $2
     AND created_at > now() - make_interval(days => $3)`,
    [digest(refreshToken), tag, REFRESH_DAYS],
  );
  if (!rows[0]) return null;
  await sweepBoardTokens(pool);
  return issueToken(pool, rows[0].member_id, codeSource(tag));
}

/**
 * Deletes lapsed board tokens. Each code sign-in and refresh mints one, and a local install may
 * never open the board inside Zoom, whose sign-in sweeps them otherwise.
 */
async function sweepBoardTokens(db: pg.Pool | pg.PoolClient): Promise<void> {
  await db.query(`DELETE FROM zoom_board_sessions WHERE expires_at <= now()`);
}

/**
 * Ends a code session: its refresh token mints nothing more, and the member's live code board
 * tokens end too (a copy of the session's token stops at once). That is every one of them,
 * so signing out signs the member out of the board in every browser; a board token is not
 * tied to the session that minted it. The plugin, which refreshes, mints a new token at its
 * next refresh.
 */
export async function endCodeSession(pool: pg.Pool, refreshToken: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ member_id: string }>(
      `DELETE FROM code_sessions WHERE refresh_sha256 = $1 RETURNING member_id`,
      [digest(refreshToken)],
    );
    if (!rows[0]) return;
    await client.query(`DELETE FROM zoom_board_sessions WHERE member_id = $1 AND source LIKE '${CODE_SOURCE_PREFIX}%'`, [rows[0].member_id]);
  });
}

/**
 * On an install whose code sign-in is off (any tier but local): every code session and code
 * board token ends, and every member who joined by code is removed as Settings → People
 * removes someone (their email kept in removed_members, so they cannot sign in again until
 * an admin invites them; what they made stays). Spared: BWAT_FIRST_OWNER_EMAIL, and anyone not
 * joined by code (an invited member, a Google member); an owner too, unless the owner email
 * names someone else (setup asks for one Google can sign in, so a local owner outside the company's
 * domains is removed and that email claims the owner instead). The spared lose the mark, so
 * this runs once. Answers how many it removed.
 */
export async function endCodeSignIn(pool: pg.Pool, { firstOwnerEmail }: { firstOwnerEmail?: string | undefined } = {}): Promise<number> {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MEMBERS_LOCK_KEY]);
    await client.query(`DELETE FROM code_sessions`);
    await client.query(`DELETE FROM zoom_board_sessions WHERE source LIKE '${CODE_SOURCE_PREFIX}%'`);
    const { rows } = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM members WHERE joined_by_code AND email IS DISTINCT FROM $1 AND ($1::text IS NOT NULL OR role <> 'owner')`,
      [firstOwnerEmail ?? null],
    );
    for (const { id, role } of rows) {
      await client.query(
        `INSERT INTO removed_members (email, google_sub) SELECT email, google_sub FROM members WHERE id = $1
         ON CONFLICT (email) DO UPDATE SET google_sub = EXCLUDED.google_sub, removed_at = now()`,
        [id],
      );
      await client.query(`DELETE FROM members WHERE id = $1`, [id]);
      await audit(client, { actor: null, action: 'member.removed', target: 'member', targetId: id, before: { role }, after: { reason: 'code_signin_ended' } });
    }
    await client.query(`UPDATE members SET joined_by_code = false WHERE joined_by_code`);
    return rows.length;
  });
}
