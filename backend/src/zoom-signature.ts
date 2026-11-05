import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Zoom webhook verification. Zoom signs each delivery with the app's secret token:
 * `x-zm-signature: v0=<hex HMAC-SHA256 of "v0:{x-zm-request-timestamp}:{raw body}">`,
 * the timestamp in epoch seconds. A delivery further than this from our clock is
 * refused, so a captured one cannot be replayed later.
 */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

type Verdict = 'ok' | 'stale' | 'bad_signature';

const hmac = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');

export function zoomSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  return `v0=${hmac(secret, Buffer.concat([Buffer.from(`v0:${timestamp}:`), rawBody]))}`;
}

/**
 * What can be checked without the secret: a timestamp in the window and a signature
 * shaped like Zoom's (`v0=` and 64 hex digits). Run before the secret is read, so a
 * delivery that cannot be Zoom's never reaches the secret store.
 */
export function prescreenZoomRequest(req: { signature: string | undefined; timestamp: string | undefined; nowMs: number }): Verdict {
  if (!req.timestamp || !/^\d{1,12}$/.test(req.timestamp)) return 'stale';
  if (Math.abs(req.nowMs - Number(req.timestamp) * 1000) > SIGNATURE_WINDOW_MS) return 'stale';
  return req.signature && /^v0=[0-9a-f]{64}$/.test(req.signature) ? 'ok' : 'bad_signature';
}

/** Whether a delivery is fresh and signed with `secret`. Compared in constant time. */
export function verifyZoomRequest(req: {
  secret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer;
  nowMs: number;
}): Verdict {
  const shape = prescreenZoomRequest(req);
  if (shape !== 'ok') return shape;
  // The prescreen passed, so the timestamp is there.
  const expected = Buffer.from(zoomSignature(req.secret, req.timestamp!, req.rawBody));
  const presented = Buffer.from(req.signature ?? '');
  // timingSafeEqual throws on unequal lengths; a length differs only for a forgery.
  return presented.length === expected.length && timingSafeEqual(presented, expected) ? 'ok' : 'bad_signature';
}

/** Zoom's endpoint.url_validation challenge: the plain token and its HMAC under the secret. */
export function urlValidation(secret: string, plainToken: string): { plainToken: string; encryptedToken: string } {
  return { plainToken, encryptedToken: hmac(secret, plainToken) };
}
