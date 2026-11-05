import { verify, type KeyObject } from 'node:crypto';

/** Where a verifier finds Google's public key for a token's `kid`, or null if it has none. */
export interface SigningKeys {
  get(kid: string): Promise<KeyObject | null>;
}

/** Google documents both spellings of its issuer. */
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/** A Google ID token is about 1 KB; anything far larger is not one, so it is not parsed. */
const MAX_TOKEN_LENGTH = 4096;

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The verified email of a Google ID token and its `hd` (Workspace domain), both
 * lower-cased, its `sub` (the account) and its `name` (trimmed; undefined when it has none),
 * or null for anything else.
 * Checks, in order: the shape, RS256 with a kid, the signature against Google's key for
 * that kid, the issuer, the audience (one of `clientIds`), the expiry,
 * `email_verified === true` and a non-empty `sub`. A token is never trusted for anything it has not passed.
 * Errors fetching the keys are thrown, not turned into a null: an outage is not a
 * wrong token.
 */
export async function verifyGoogleIdToken(
  token: string,
  { clientIds, keys, now = () => Date.now() }: { clientIds: readonly string[]; keys: SigningKeys; now?: () => number },
): Promise<{ email: string; hd: string | undefined; sub: string; name: string | undefined } | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];

  const header = decodeJson(encodedHeader);
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  const key = await keys.get(header.kid);
  if (!key) return null;
  const signed = verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    key,
    Buffer.from(signature, 'base64url'),
  );
  if (!signed) return null;

  const claims = decodeJson(encodedPayload);
  if (!claims) return null;
  if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) return null;
  if (typeof claims.aud !== 'string' || !clientIds.includes(claims.aud)) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now()) return null;
  if (claims.email_verified !== true || typeof claims.email !== 'string') return null;
  // sub: Google's stable id for the account, which a member is bound to; an email can be reassigned.
  if (typeof claims.sub !== 'string' || claims.sub === '') return null;
  // hd: the Google Workspace domain; a consumer account has none. The caller decides on it.
  return {
    email: claims.email.toLowerCase(),
    hd: typeof claims.hd === 'string' ? claims.hd.toLowerCase() : undefined,
    sub: claims.sub,
    // name: the account's full name, which a member is shown by until an admin names them.
    name: typeof claims.name === 'string' && claims.name.trim() !== '' ? claims.name.trim() : undefined,
  };
}
