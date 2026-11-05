/**
 * A per-client-IP minute bucket, as the backend's rate-limit.ts keeps: `limited` answers how
 * many seconds until the IP may try again once it has spent `max` counts in its fixed minute
 * (0 while it may), `count` spends one. Kept in memory for at most `maxIps` addresses (the
 * oldest window forgotten first). The IP is req.ip: the socket address, or the client the proxy
 * names when BWAT_TRUST_PROXY trusts it.
 */
export interface Bucket {
  limited(ip: string): number;
  count(ip: string): void;
}

const MINUTE = 60_000;

export function perMinute(max: number, { now = () => Date.now(), maxIps = 10_000 }: { now?: () => number; maxIps?: number } = {}): Bucket {
  const windows = new Map<string, { start: number; count: number }>();
  const live = (ip: string) => {
    const window = windows.get(ip);
    return window && now() - window.start < MINUTE ? window : undefined;
  };
  return {
    limited(ip) {
      const window = live(ip);
      return window && window.count >= max ? Math.max(1, Math.ceil((window.start + MINUTE - now()) / 1000)) : 0;
    },
    count(ip) {
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
