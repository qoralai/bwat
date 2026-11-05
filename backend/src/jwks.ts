import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { SigningKeys } from './google-id-token.ts';

/** Google's public keys for the ID tokens it signs. */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Never cache longer than this, whatever max-age says; an hour when it says nothing. */
const MAX_AGE_CEILING = 6 * HOUR;
const DEFAULT_MAX_AGE = HOUR;
/** An unknown kid refetches (Google rotated its keys), but at most this often. */
const UNKNOWN_KID_COOLDOWN = MINUTE;
const FETCH_TIMEOUT = 5_000;

type Fetch = (url: string) => Promise<Response>;

function maxAgeMs(cacheControl: string | null): number {
  const seconds = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
  return seconds === undefined ? DEFAULT_MAX_AGE : Math.min(Number(seconds) * 1000, MAX_AGE_CEILING);
}

function rsaKeys(body: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const list = (body as { keys?: unknown })?.keys;
  for (const jwk of Array.isArray(list) ? (list as (JsonWebKey & { kid?: unknown; use?: unknown })[]) : []) {
    if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // A malformed key is skipped; a token naming it is then refused.
    }
  }
  return keys;
}

const unavailable = () => Object.assign(new Error('jwks_unavailable'), { code: 'jwks_unavailable' });

/**
 * Google's signing keys by kid: fetched from `url`, cached for the max-age Google sends
 * (capped), and refetched early when a token names a kid not in the cache, at most once
 * a minute however many such kids arrive. Concurrent lookups share one fetch. A failed
 * fetch throws `jwks_unavailable`.
 */
export function jwksKeys({
  url = GOOGLE_JWKS_URL,
  fetch = (u) => globalThis.fetch(u, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }),
  now = () => Date.now(),
}: { url?: string; fetch?: Fetch; now?: () => number } = {}): SigningKeys {
  let keys = new Map<string, KeyObject>();
  let expiresAt = -Infinity;
  let unknownKidRefreshAt = -Infinity;
  let inFlight: Promise<void> | null = null;

  async function load(): Promise<void> {
    let body: unknown;
    let res: Response;
    try {
      res = await fetch(url);
      if (!res.ok) throw unavailable();
      body = await res.json();
    } catch {
      // A timeout or DNS failure is the same outage; its message never reaches a log.
      throw unavailable();
    }
    keys = rsaKeys(body);
    expiresAt = now() + maxAgeMs(res.headers.get('cache-control'));
  }

  function refresh(): Promise<void> {
    inFlight ??= load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    async get(kid) {
      if (now() >= expiresAt) await refresh();
      else if (!keys.has(kid) && now() - unknownKidRefreshAt >= UNKNOWN_KID_COOLDOWN) {
        unknownKidRefreshAt = now();
        await refresh();
      }
      return keys.get(kid) ?? null;
    },
  };
}
