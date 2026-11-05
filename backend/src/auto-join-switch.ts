import { cached } from './settings/cached.ts';

export { SETTINGS_CACHE_MAX_MS } from './settings/cached.ts';

/**
 * The stored auto-join settings. They live in the company's settings (QOR-4578,
 * bwat.settings) under two catalogue keys; this module only reads them, through a
 * reader (the server's reads bwat.settings), and caches the answers per process. The env is the ceiling
 * of each (BWAT_AUTO_JOIN, BWAT_AUTO_JOIN_REQUIRE_HOST; A109).
 */

/** The settings catalogue key that holds the switch. */
export const AUTO_JOIN_KEY = 'auto_join_enabled';
/** The settings catalogue key that says whether auto-join waits for the host. */
export const AUTO_JOIN_REQUIRE_HOST_KEY = 'auto_join_require_host';

/**
 * Reads one key's RAW stored value (AUTO_JOIN_KEY or AUTO_JOIN_REQUIRE_HOST_KEY): undefined
 * when absent, JSON null when unset. It must NEVER answer with the settings catalogue's
 * default: explicit false must survive default changes. Throws when the
 * store does not answer. The server's is readStoredSetting (src/settings/store.ts).
 */
export type ReadAutoJoinSwitch = (key: string) => Promise<unknown>;

/** A reader with nothing stored: joining is requested, subject to readiness and env. */
export const nothingStored: ReadAutoJoinSwitch = async () => undefined;

/**
 * Joining defaults on when unset. Explicit false and malformed values stay off.
 * Readiness is checked separately before any automatic claim is created.
 */
export function switchIsOn(value: unknown): boolean {
  return value === true || value === undefined || value === null;
}

/**
 * The stored require-host value lets auto-join stop waiting for the host only when it is
 * `false`. Anything else, unset included, leaves it to the env, which stays the ceiling.
 */
function hostOptional(value: unknown): boolean {
  return value === false;
}

export interface AutoJoinSwitch {
  /** Whether the stored switch is on. Throws when it cannot be read (fail closed). */
  isOn(fresh?: boolean): Promise<boolean>;
  /** Whether the stored settings leave auto-join waiting for the host (the env decides first). Throws like isOn. */
  requiresHost(): Promise<boolean>;
  /** Drops the cached values. Settings calls it once a write to either key has committed. */
  invalidate(): void;
}

/** The switch through a per-process cache (settings/cached.ts). */
export function createAutoJoinSwitch(read: ReadAutoJoinSwitch, options: { ttlMs?: number; now?: () => number } = {}): AutoJoinSwitch {
  const stored = cached(async () => {
    const [enabled, requireHost] = await Promise.all([read(AUTO_JOIN_KEY), read(AUTO_JOIN_REQUIRE_HOST_KEY)]);
    return { on: switchIsOn(enabled), requiresHost: !hostOptional(requireHost) };
  }, options);

  return {
    async isOn(fresh = false) {
      if (fresh) return switchIsOn(await read(AUTO_JOIN_KEY));
      return (await stored.get()).on;
    },
    async requiresHost() {
      return (await stored.get()).requiresHost;
    },
    invalidate: stored.invalidate,
  };
}
