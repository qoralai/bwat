import type pg from 'pg';
import { cached, type Cached } from './settings/cached.ts';
import { readStoredSetting } from './settings/store.ts';

/**
 * The settings row holding the allowed email domains an admin saved (QOR-5070). Not in the
 * catalogue: no bot reads it, and its save has its own check (routes/google-signin.ts).
 * Unset or JSON null: BWAT_ALLOWED_DOMAINS applies.
 */
export const ALLOWED_DOMAINS_KEY = 'allowed_domains';

/** How long a saved list may take to reach another backend process. */
const DOMAINS_CACHE_MS = 15_000;

/** The domains that may sign in now: get() per sign-in; invalidate() once a save has committed. */
export type AllowedDomains = Cached<string[]> & { env: readonly string[] };

/**
 * The saved list when there is one, else BWAT_ALLOWED_DOMAINS (`env`), read through a short
 * cache, so a save applies without a restart.
 */
export function allowedDomainsFrom(
  pool: pg.Pool,
  env: readonly string[],
  { ttlMs = DOMAINS_CACHE_MS, now }: { ttlMs?: number; now?: () => number } = {},
): AllowedDomains {
  const read = async () => domainsInForce(await readStoredSetting(pool, ALLOWED_DOMAINS_KEY), env);
  return { ...cached(read, { ttlMs, ...(now && { now }) }), env };
}

/** A stored value as a list, or null when none is saved (never saved, or cleared). */
export const savedDomains = (stored: unknown): string[] | null =>
  Array.isArray(stored) && stored.length > 0 ? (stored as string[]) : null;

/** The domains in force: the saved list, else the env's. */
export const domainsInForce = (stored: unknown, env: readonly string[]): string[] => savedDomains(stored) ?? [...env];
