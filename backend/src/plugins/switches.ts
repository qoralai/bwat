import type pg from 'pg';
import { cached } from '../settings/cached.ts';
import { setValues } from '../settings/store.ts';

/**
 * Which plugins an owner or admin has switched on (the panel's Plugins page). Each is a row in
 * bwat.settings under plugin_<name>, outside the catalogue: the catalogue is core's and never
 * names a plugin. Unset is off, so a fresh install runs none.
 */
const PREFIX = 'plugin_';
export const switchKey = (name: string) => `${PREFIX}${name}`;

/** No switch is served from the cache for longer than this; the web server's own list lags it by up to 30 s more. */
const SWITCHES_TTL_MS = 5_000;

export interface PluginSwitches {
  /** The names switched on. */
  on(): Promise<ReadonlySet<string>>;
  /** Drops the cached answer: the admin route calls it once a switch has committed. */
  invalidate(): void;
}

/** The switches of these plugins through a per-process cache (settings/cached.ts). */
export function pluginSwitches(pool: pg.Pool, names: readonly string[]): PluginSwitches {
  const switches = cached(async () => {
    const rows = await setValues(pool, names.map(switchKey));
    return new Set(rows.filter((r) => r.value === true).map((r) => r.key.slice(PREFIX.length)));
  }, { ttlMs: SWITCHES_TTL_MS });
  return { on: switches.get, invalidate: switches.invalidate };
}
