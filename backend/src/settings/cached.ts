/** No value is served from a settings cache for longer than this. */
export const SETTINGS_CACHE_MAX_MS = 60_000;

export interface Cached<T> {
  get(): Promise<T>;
  /** Drops the value: the next get() reads again. Call it once a write has committed. */
  invalidate(): void;
}

/**
 * `read`'s answer through a per-process cache. A value is served for at most `ttlMs` (never
 * more than SETTINGS_CACHE_MAX_MS); gets that miss together share one read; a failed read is
 * never kept; invalidate drops the value, and a read already in flight when it landed is not
 * kept. Another process sees a write when its own cached value runs out.
 */
export function cached<T>(read: () => Promise<T>, { ttlMs = SETTINGS_CACHE_MAX_MS, now = Date.now }: { ttlMs?: number; now?: () => number } = {}): Cached<T> {
  const ttl = Math.min(ttlMs, SETTINGS_CACHE_MAX_MS);
  let entry: { at: number; value: Promise<T> } | null = null;
  return {
    get() {
      if (entry && now() - entry.at < ttl) return entry.value;
      const mine = { at: now(), value: read() };
      entry = mine;
      mine.value.catch(() => {
        if (entry === mine) entry = null;
      });
      return mine.value;
    },
    invalidate() {
      entry = null;
    },
  };
}
