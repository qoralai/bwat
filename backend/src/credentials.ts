import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

/**
 * Bot credentials. Two kinds of bearer token, told apart by prefix:
 *   bwf_  a fleet credential, issued by an operator (npm run fleet-credential). It can
 *         only register a bot (D140: one per install, not per workspace).
 *   bwb_  a bot token, handed to a bot by POST /bots/register. The bot's identity: every
 *         other bot route takes the bot id from it, never from the body.
 *   bwc_  the card service's credential, issued by an operator (npm run cards-credential).
 *         It reads GET /fleet with the feed fields and meeting transcripts, nothing else.
 *   bwi_  the onboarding page's credential, minted by setup (npm run install-credential).
 *         It reaches only the /install routes, until it expires or is revoked.
 * Only the sha256 digest is stored; the token is shown once.
 */
const TOKEN = /^(bwf|bwb|bwc|bwi)_[A-Za-z0-9_-]{43}$/;

const KINDS = { bwf: 'fleet', bwb: 'bot', bwc: 'cards', bwi: 'install' } as const;
const TABLES = { fleet: 'fleet_credentials', bot: 'bots', cards: 'cards_credentials', install: 'install_credentials' } as const;
// Only the onboarding page's credential lapses.
const LIVE = { fleet: '', bot: '', cards: '', install: ' AND revoked_at IS NULL AND expires_at > now()' } as const;

type Db = pg.Pool | pg.ClientBase;

/** A known credential: a fleet credential's id, or a bot's id. */
export type BotCaller = { kind: 'fleet' | 'bot' | 'cards' | 'install'; id: string };

/** A new bearer: a service credential's prefix, or a plugin's person bearer (bwr). */
export function newToken(prefix: keyof typeof KINDS | 'bwr'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Issues a fleet credential and returns the token; only its digest is stored. */
export async function issueFleetCredential(db: Db, label: string | null = null): Promise<string> {
  const token = newToken('bwf');
  await db.query(`INSERT INTO fleet_credentials (token_sha256, label) VALUES ($1, $2)`, [digest(token), label]);
  return token;
}

/** Issues the card service's credential and returns the token; only its digest is stored. */
export async function issueCardsCredential(db: Db, label: string | null = null): Promise<string> {
  const token = newToken('bwc');
  await db.query(`INSERT INTO cards_credentials (token_sha256, label) VALUES ($1, $2)`, [digest(token), label]);
  return token;
}

/** Issues the onboarding page's credential and returns the token; only its digest is stored. */
export async function issueInstallCredential(db: Db, label: string | null = null): Promise<string> {
  const token = newToken('bwi');
  await db.query(`INSERT INTO install_credentials (token_sha256, label) VALUES ($1, $2)`, [digest(token), label]);
  return token;
}

/** The bearer token in an Authorization header, if it has the shape of one of ours: its kind and digest. */
export function presentedToken(header: string | undefined): { kind: BotCaller['kind']; digest: Buffer } | null {
  const token = header?.match(/^Bearer (\S+)$/)?.[1];
  if (!token || !TOKEN.test(token)) return null;
  return { kind: KINDS[token.slice(0, 3) as keyof typeof KINDS], digest: digest(token) };
}

/**
 * Who is calling a bot route, or null. The row is found by the token's sha256 digest
 * (an index lookup): a stored digest only matches the token it was made from, so no
 * further comparison is needed, and the token itself is never stored or compared.
 */
export async function resolveBotCaller(db: Db, authorization: string | undefined): Promise<BotCaller | null> {
  const token = presentedToken(authorization);
  if (!token) return null;
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ${TABLES[token.kind]} WHERE token_sha256 = $1${LIVE[token.kind]}`,
    [token.digest],
  );
  return rows[0] ? { kind: token.kind, id: rows[0].id } : null;
}
