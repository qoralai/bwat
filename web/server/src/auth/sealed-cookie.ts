import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The session and login cookies: a JSON payload under AES-256-GCM with
 * BWAT_SESSION_SECRET, a random 12-byte nonce per seal, the cookie name as
 * associated data, a full 16-byte tag, as `v1.<nonce>.<ciphertext+tag>` in base64url
 * (cookie-safe, so @fastify/cookie's URL-encoding leaves it unchanged). Every payload
 * carries `exp` (epoch ms), checked on open.
 */
const VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

// The cookie name is associated data: a login cookie replayed as the session cookie
// (or the reverse) fails to decrypt.
const aad = (cookieName: string) => Buffer.from(cookieName, 'utf8');

/** Encrypts payload for the named cookie. The payload must carry its own `exp`. */
export function sealCookie(payload: object, key: Buffer, cookieName: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(cookieName));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${nonce.toString('base64url')}.${sealed.toString('base64url')}`;
}

/**
 * The payload of a cookie sealed by sealCookie, or null for anything else: absent,
 * malformed, tampered, sealed under another key or for another cookie, not a JSON
 * object, or past its `exp`. Never throws: a bad cookie means signed out, not a 500.
 */
export function openCookie(
  value: string | undefined,
  key: Buffer,
  cookieName: string,
  now = Date.now(),
): Record<string, unknown> | null {
  if (!value) return null;
  const [version, nonceB64, sealedB64, ...rest] = value.split('.');
  if (version !== VERSION || !nonceB64 || !sealedB64 || rest.length > 0) return null;
  let payload: unknown;
  try {
    const nonce = Buffer.from(nonceB64, 'base64url');
    const sealed = Buffer.from(sealedB64, 'base64url');
    // GCM would otherwise accept a short tag.
    if (nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad(cookieName));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
    payload = JSON.parse(plain.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const { exp } = payload as { exp?: unknown };
  if (typeof exp !== 'number' || exp <= now) return null;
  return payload as Record<string, unknown>;
}

/**
 * One sealed cookie's read, write and clear: HttpOnly, SameSite=Lax, on `path`. `read` answers
 * null for anything openCookie refuses or `isValid` does not take. The browser keeps it until
 * the payload's `exp`, or for `maxAge` seconds when one is given.
 */
export function sealedCookie<T extends { exp: number }>(
  name: string,
  path: string,
  isValid: (payload: Record<string, unknown>) => boolean,
  maxAge?: number,
) {
  return {
    read(req: FastifyRequest, key: Buffer): T | null {
      const payload = openCookie(req.cookies[name], key, name);
      return payload && isValid(payload) ? (payload as unknown as T) : null;
    },
    write(reply: FastifyReply, key: Buffer, secure: boolean, value: T) {
      reply.setCookie(name, sealCookie(value, key, name), {
        path,
        httpOnly: true,
        secure,
        sameSite: 'lax',
        ...(maxAge === undefined ? { expires: new Date(value.exp) } : { maxAge }),
      });
    },
    clear(reply: FastifyReply) {
      reply.clearCookie(name, { path });
    },
  };
}
