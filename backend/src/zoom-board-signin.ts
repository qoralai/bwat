import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { audit } from './audit.ts';
import { digest } from './credentials.ts';
import { withTransaction } from './db/pool.ts';
import { inAllowedDomain, normalEmail } from './members.ts';
import type { AuthenticatePerson } from './people-auth.ts';

/** The board-token source of a sign-in code's tokens (zoom_board_sessions.source, ^[a-z][a-z0-9-]*$). */
export const CODE_SOURCE_PREFIX = 'signin-code-';
export const codeSource = (tag: string): string => `${CODE_SOURCE_PREFIX}${tag}`;

/**
 * Signing in on the board inside Zoom (QOR-4708). Zoom's signed app context names the
 * Zoom user; a member whose zoom_user_id it is gets a board token. Anyone else gets a
 * link code, which the web server keeps for the board, and pairs once: they sign in with
 * Google in a browser, which shows a pairing code, and type it into the board. Only
 * digests of tokens and codes are stored.
 */

/**
 * A board token lasts as long as the web session that holds it: the web server's
 * SESSION_TTL_MS (web/server/src/auth/session.ts) is the same 12 hours, and its board
 * cookies assume so. Change both together.
 */
export const BOARD_TOKEN_TTL_S = 12 * 60 * 60;
/** Long enough to sign in with Google in a browser and type the pairing code; then the codes are gone. */
export const LINK_CODE_TTL_S = 10 * 60;
/** Tries a link code takes; then it is retired and the board must be reopened in Zoom for a new one. */
export const WRONG_CODES_PER_LINK = 5;
/** Pairing codes are typed by hand: no 0, 1, I or O. Eight of them are 40 bits. */
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Board tokens are told apart from Google ID tokens by this prefix. */
const TOKEN_PREFIX = 'bwz_';

const random = () => randomBytes(32).toString('base64url');

/**
 * A board token (bwz_) for the member, lasting BOARD_TOKEN_TTL_S: the board inside Zoom, and
 * the board inside a plugin's product (from its embed ticket, QOR-4830), sign in with it.
 * `source` names that plugin (null: Zoom), so the plugin can end its own tokens at unlink.
 * Answers the token and when it lapses.
 */
export async function issueToken(
  db: pg.Pool | pg.PoolClient,
  memberId: string,
  source: string | null = null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = `${TOKEN_PREFIX}${random()}`;
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO zoom_board_sessions (token_sha256, member_id, expires_at, source) VALUES ($1, $2, now() + make_interval(secs => $3), $4)
     RETURNING expires_at`,
    [digest(token), memberId, BOARD_TOKEN_TTL_S, source],
  );
  return { token, expiresAt: rows[0]!.expires_at };
}

/** A board token for the member holding this Zoom user id, or a link code when none does. */
export async function boardSignIn(pool: pg.Pool, zoomUserId: string): Promise<{ token: string } | { linkCode: string }> {
  // Every board open adds a row; the expired ones go here, as there is nothing else to sweep them.
  await pool.query(`DELETE FROM zoom_board_sessions WHERE expires_at <= now()`);
  await pool.query(`DELETE FROM zoom_links WHERE expires_at <= now()`);
  await pool.query(`DELETE FROM zoom_pairings WHERE expires_at <= now()`);
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM members WHERE zoom_user_id = $1`, [zoomUserId]);
  if (rows[0]) return { token: (await issueToken(pool, rows[0].id)).token };
  const linkCode = random();
  await pool.query(`INSERT INTO zoom_links (code_sha256, zoom_user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`, [
    digest(linkCode),
    zoomUserId,
    LINK_CODE_TTL_S,
  ]);
  return { linkCode };
}

/**
 * A pairing code for the signed-in member, shown as XXXX-XXXX, redeemable only by
 * `audience` (QOR-4806): 'zoom', or a plugin's name.
 */
export async function startPairing(pool: pg.Pool, memberId: string, audience = 'zoom'): Promise<string> {
  const code = [...randomBytes(8)].map((b) => PAIR_ALPHABET[b & 31]).join('');
  await pool.query(
    `INSERT INTO zoom_pairings (code_sha256, member_id, expires_at, audience) VALUES ($1, $2, now() + make_interval(secs => $3), $4)`,
    [digest(code), memberId, LINK_CODE_TTL_S, audience],
  );
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Pairs a link code with a pairing code: the Zoom user id the link code was minted for
 * is saved on the pairing code's member, and that member gets a board token. Null when
 * either code is unknown, used or expired; then neither is used up, but the link code
 * has spent one of its tries.
 */
export async function pair(pool: pg.Pool, linkCode: string, pairCode: string): Promise<string | null> {
  // Every try counts before anything is compared, in one statement, so parallel tries
  // cannot share a count.
  const tried = await pool.query(
    `UPDATE zoom_links SET wrong_codes = wrong_codes + 1 WHERE code_sha256 = $1 AND expires_at > now() AND wrong_codes < $2 RETURNING 1`,
    [digest(linkCode), WRONG_CODES_PER_LINK],
  );
  if (!tried.rowCount) return null;
  return withTransaction(pool, async (client) => {
    const memberId = await takePairing(client, pairCode);
    const linked = await client.query<{ zoom_user_id: string }>(
      `DELETE FROM zoom_links WHERE code_sha256 = $1 AND expires_at > now() RETURNING zoom_user_id`,
      [digest(linkCode)],
    );
    const zoomUserId = linked.rows[0]?.zoom_user_id;
    if (!memberId || !zoomUserId) throw new NotPaired();
    await client.query(`UPDATE members SET zoom_user_id = $1, updated_at = now() WHERE id = $2`, [zoomUserId, memberId]);
    await audit(client, { actor: memberId, action: 'member.zoom_linked', target: 'member', targetId: memberId, after: { zoom_user_id: true } });
    return (await issueToken(client, memberId)).token;
  }).catch((err: unknown) => {
    if (err instanceof NotPaired) return null;
    throw err;
  });
}

/** What linking a Zoom account by its email did: never the email or the account, which are not logged. */
export type EmailLinkOutcome =
  | 'linked'
  | 'already_linked'
  | 'no_member'
  | 'domain_not_allowed'
  | 'conflict'
  | 'invalid'
  | 'not_configured'
  | 'not_confirmed';

/**
 * Links the Zoom account `zoomUserId` to the activated member whose email is `email`, in an
 * allowed domain, once `confirmedEmail` (zoomApi.userEmail: Zoom's API, the install's own
 * account; null: not configured) answers that same address for the account. Fails closed on
 * any conflict. A link grants what a pairing does: board sign-in as that member. The rules and
 * why: docs/speaker-identity.md (QOR-5111). The usual answers (`already_linked`, `no_member`,
 * `conflict`) take one plain read: no transaction and no call to Zoom.
 */
export async function linkZoomByEmail(
  pool: pg.Pool,
  {
    zoomUserId,
    email,
    allowedDomains,
    confirmedEmail,
  }: {
    zoomUserId: string;
    email: string;
    allowedDomains: readonly string[];
    confirmedEmail: (zoomUserId: string) => Promise<string | null>;
  },
): Promise<EmailLinkOutcome> {
  const address = normalEmail(email);
  // members.zoom_user_id holds at most 64 characters (0004).
  if (!zoomUserId || zoomUserId.length > 64 || !address) return 'invalid';
  if (!inAllowedDomain(address, allowedDomains)) return 'domain_not_allowed';
  const { rows } = await pool.query<{ zoom_user_id: string | null }>(
    `SELECT zoom_user_id FROM members WHERE email = $1 AND activated_at IS NOT NULL`,
    [address],
  );
  const member = rows[0];
  if (!member) return 'no_member';
  if (member.zoom_user_id === zoomUserId) return 'already_linked';
  if (member.zoom_user_id !== null) return 'conflict';
  const confirmed = await confirmedEmail(zoomUserId);
  if (confirmed === null) return 'not_configured';
  if (normalEmail(confirmed) !== address) return 'not_confirmed';
  return withTransaction(pool, async (client): Promise<EmailLinkOutcome> => {
    // Still unlinked (a member never loses activation). One linked meanwhile is left as it is:
    // to this account (a retried or repeated join got there first) it is already linked, to
    // another a conflict. An account another member holds breaks members.zoom_user_id's
    // uniqueness: a conflict too, below.
    const linked = await client.query<{ id: string }>(
      `UPDATE members SET zoom_user_id = $1, updated_at = now() WHERE email = $2 AND zoom_user_id IS NULL RETURNING id`,
      [zoomUserId, address],
    );
    const id = linked.rows[0]?.id;
    if (!id) {
      const now = await client.query<{ zoom_user_id: string | null }>(`SELECT zoom_user_id FROM members WHERE email = $1`, [address]);
      return now.rows[0]?.zoom_user_id === zoomUserId ? 'already_linked' : 'conflict';
    }
    await audit(client, { actor: null, action: 'member.zoom_linked', target: 'member', targetId: id, after: { zoom_user_id: true, by: 'email' } });
    return 'linked';
  }).catch((err: { code?: unknown }) => {
    if (err.code === '23505') return 'conflict';
    throw err;
  });
}

/**
 * Uses up a pairing code (typed by hand: any case, with or without the dash) and answers
 * the member who asked for it, or null when it is unknown, used, expired or minted for
 * another audience (QOR-4806).
 */
export async function takePairing(db: pg.Pool | pg.PoolClient, pairCode: string, audience = 'zoom'): Promise<string | null> {
  const typed = pairCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const { rows } = await db.query<{ member_id: string }>(
    `DELETE FROM zoom_pairings WHERE code_sha256 = $1 AND expires_at > now() AND audience = $2 RETURNING member_id`,
    [digest(typed), audience],
  );
  return rows[0]?.member_id ?? null;
}

// Rolls the transaction back, so a wrong code uses up neither.
class NotPaired extends Error {}

/**
 * Sign-in with a board token first, then `inner` for everything else. A bearer that looks
 * like a board token is never handed to Google: an unknown or expired one is nobody.
 *
 * A board token a plugin issued (`source`, the plugin's name) signs in only while that plugin
 * is switched on (`enabledSources`: the switched-on plugins' names, now); a Zoom one (no source)
 * always; a code sign-in's only while its code is the install's (`codeTag`, null past the local tier). Switched off, the plugin's board tokens are nobody, never handed to `inner` either.
 */
export function withBoardTokens(
  pool: pg.Pool,
  inner: AuthenticatePerson,
  enabledSources: () => Promise<ReadonlySet<string>>,
  codeTag: string | null = null,
): AuthenticatePerson {
  return async (req, onBehalf) => {
    const presented = onBehalf ? onBehalf.authorization : req.headers.authorization;
    const token = presented?.match(/^Bearer (bwz_\S+)$/)?.[1];
    if (!token) return inner(req, onBehalf);
    const { rows } = await pool.query<{ member_id: string; source: string | null }>(
      `SELECT member_id, source FROM zoom_board_sessions WHERE token_sha256 = $1 AND expires_at > now()`,
      [digest(token)],
    );
    const row = rows[0];
    if (!row) return null;
    // A code sign-in's token (QOR-5007) signs in only with the install's current code: none on
    // an install past the local tier, and none from an older code after --new-code.
    if (row.source?.startsWith(CODE_SOURCE_PREFIX)) return codeTag !== null && row.source === codeSource(codeTag) ? { id: row.member_id } : null;
    if (row.source !== null && !(await enabledSources()).has(row.source)) return null;
    return { id: row.member_id };
  };
}
