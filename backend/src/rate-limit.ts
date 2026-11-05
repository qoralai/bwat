import type { FastifyRequest } from 'fastify';

/** A request over its bucket's limit. The error handler answers it 429 with Retry-After. */
export class RateLimited extends Error {
  readonly statusCode = 429;
  /** Which bucket: logged, as the only thing said about the request. */
  readonly group: 'signin' | 'zoom' | 'pairing' | 'embed' | 'embed_redeem' | 'plugin_write';
  readonly retryAfterSeconds: number;
  constructor(group: RateLimited['group'], retryAfterSeconds: number) {
    super('rate_limited');
    this.group = group;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A per-client-IP bucket: check throws RateLimited once the IP has spent it; count spends
 * one. The IP is req.ip unless `ip` names the client (the card service's, QOR-4749).
 */
export interface Bucket {
  check(req: FastifyRequest, ip?: string): void;
  count(req: FastifyRequest, ip?: string): void;
}

const MINUTE = 60_000;

/**
 * A bucket of `max` counts per client IP in a fixed minute, kept in memory for at most
 * `maxIps` addresses (the oldest window forgotten first). The IP is req.ip: the socket
 * address, or the client the proxy names when BWAT_TRUST_PROXY trusts it.
 */
export function perMinute(
  group: RateLimited['group'],
  max: number,
  { now = () => Date.now(), maxIps = 10_000 }: { now?: () => number; maxIps?: number } = {},
): Bucket {
  const windows = new Map<string, { start: number; count: number }>();
  const live = (ip: string) => {
    const window = windows.get(ip);
    return window && now() - window.start < MINUTE ? window : undefined;
  };
  return {
    check(req, ip = req.ip) {
      const window = live(ip);
      if (window && window.count >= max) throw new RateLimited(group, Math.max(1, Math.ceil((window.start + MINUTE - now()) / 1000)));
    },
    count(req, ip = req.ip) {
      const window = live(ip);
      if (window) {
        window.count++;
        return;
      }
      // A new window goes to the back of the map's insertion order, so the front is the oldest.
      windows.delete(ip);
      if (windows.size >= maxIps) windows.delete(windows.keys().next().value!);
      windows.set(ip, { start: now(), count: 1 });
    },
  };
}
