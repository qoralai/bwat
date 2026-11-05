import { createDecipheriv, createHash } from 'node:crypto';

/** Who opened the board inside Zoom, and from which meeting: what bwat reads from the context. */
export interface ZoomAppContext {
  uid: string;
  mid: string | null;
  bmid?: string;
  attendrole?: string;
  issuedAtMs?: number;
}

const TAG_LEN = 16;

/**
 * Zoom's `x-zoom-app-context` header, opened: the Zoom user id and meeting id, or null.
 *
 * Zoom sends it with the request for the board app's home URL, encrypted with
 * AES-256-GCM under SHA-256 of the board app's client secret, base64url, laid out as
 * [ivLen:1][iv][aadLen:2][aad][cipherLen:4][cipher][tag:16]. The two lengths are
 * little-endian: read big-endian, every real context is refused while a test minted
 * big-endian passes (the prototype shipped that once). Null for anything unexpected (a
 * bad shape, another secret, a tampered body, an expired one, no uid): to the board each
 * means the same thing, nobody identified. Zoom always sets `exp`, in milliseconds or
 * seconds; a context without one is refused.
 */
export function zoomAppContext(raw: string, secret: string, nowMs: number): ZoomAppContext | null {
  if (!raw || !secret) return null;
  try {
    const blob = Buffer.from(raw.trim(), 'base64url');
    let at = 0;
    const ivLen = blob.readUInt8(at);
    at += 1;
    const iv = blob.subarray(at, at + ivLen);
    at += ivLen;
    const aadLen = blob.readUInt16LE(at);
    at += 2;
    const aad = blob.subarray(at, at + aadLen);
    at += aadLen;
    const cipherLen = blob.readUInt32LE(at);
    at += 4;
    const cipher = blob.subarray(at, at + cipherLen);
    at += cipherLen;
    const tag = blob.subarray(at, at + TAG_LEN);
    if (iv.length !== ivLen || aad.length !== aadLen || cipher.length !== cipherLen || tag.length !== TAG_LEN) return null;

    const key = createHash('sha256').update(secret, 'utf8').digest();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
    const ctx: unknown = JSON.parse(plain);
    if (typeof ctx !== 'object' || ctx === null) return null;
    const { uid, mid, exp } = ctx as { uid?: unknown; mid?: unknown; exp?: unknown };
    if (typeof uid !== 'string' || !uid) return null;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    // Seconds are far below 1e12; milliseconds far above.
    const expMs = exp < 1e12 ? exp * 1000 : exp;
    if (expMs <= nowMs) return null;
    const bmid = (ctx as { bmid?: unknown }).bmid;
    const attendrole = (ctx as { attendrole?: unknown }).attendrole;
    const ts = (ctx as { ts?: unknown }).ts;
    return {
      uid,
      mid: typeof mid === 'string' && mid ? mid : null,
      ...(typeof bmid === 'string' && bmid ? { bmid } : {}),
      ...(typeof attendrole === 'string' ? { attendrole } : {}),
      ...(typeof ts === 'number' && Number.isFinite(ts) ? { issuedAtMs: ts < 1e12 ? ts * 1000 : ts } : {}),
    };
  } catch {
    return null;
  }
}
