/**
 * Whether OpenRouter serves a model only from endpoints that retain no data (QOR-4769).
 * Zero Data Retention endpoints cannot train on what they are sent, so the card service
 * gets a model key only for a model that passes. The bot checks its transcription route
 * the same way (bot/bwat_bot/transcription.py).
 *
 * `any`: at least one of the model's endpoints is on OpenRouter's ZDR list. Enough for a
 * chat call that asks for `provider: {zdr: true}`, which routes to those endpoints only.
 * `all`: every one is. Needed where the routing preference is not documented to apply
 * (the Decisions API), since any endpoint could then be the one that serves the call.
 * `decided`: OpenRouter answered. A failed lookup fails both and is undecided,
 * so it is never read as "this model has no ZDR endpoint".
 */
export interface ZdrVerdict {
  any: boolean;
  all: boolean;
  decided: boolean;
}

/** The verdict for one model id; never throws, a failed lookup fails both. */
export type ZdrLookup = (model: string) => Promise<ZdrVerdict>;

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
/** How long a verdict is kept, and a failed lookup's (so a broken route is not asked on every poll). */
const VERDICT_HOLD_MS = 3_600_000;
const FAIL_HOLD_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const FAILED: ZdrVerdict = { any: false, all: false, decided: false };
/** One `owner/name` model id; anything else would change the lookup's URL path (QOR-4769). */
const MODEL_ID = /^[\w.:~-]+\/[\w.:~-]+$/;

/** The `name` of every entry, or null when any is missing or blank (blank names would match each other). */
function names(entries: unknown): string[] | null {
  if (!Array.isArray(entries)) return null;
  const out = entries.map((e: { name?: unknown } | null) => e?.name);
  return out.every((n): n is string => typeof n === 'string' && n !== '') ? out : null;
}

async function getJson(fetch: typeof globalThis.fetch, url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/** One lookup: the verdict; an undecided one (a failure) is held for less. */
async function lookUp(fetch: typeof globalThis.fetch, model: string): Promise<ZdrVerdict> {
  try {
    const [endpoints, listed] = await Promise.all([
      getJson(fetch, `${OPENROUTER_API}/models/${model}/endpoints`) as Promise<{ data?: { endpoints?: unknown } }>,
      getJson(fetch, `${OPENROUTER_API}/endpoints/zdr`) as Promise<{ data?: unknown }>,
    ]);
    const served = names(endpoints?.data?.endpoints);
    const zdr = names(listed?.data);
    if (!served || !zdr) return FAILED;
    const onList = served.filter((n) => zdr.includes(n)).length;
    return { any: onList > 0, all: served.length > 0 && onList === served.length, decided: true };
  } catch {
    return FAILED;
  }
}

/**
 * The ZDR lookup, its verdicts kept per model id for an hour and a failed lookup for 30 s.
 * Lookups in flight are shared. A model id that is not one `owner/name` pair fails
 * without a lookup. `fetch` and `clock`: tests only.
 */
export function zdrLookup({ fetch = globalThis.fetch, clock = Date.now }: { fetch?: typeof globalThis.fetch; clock?: () => number } = {}): ZdrLookup {
  const kept = new Map<string, { verdict: Promise<ZdrVerdict>; until: number }>();
  return (model) => {
    // Refused before the cache, so an arbitrary string is neither fetched nor kept (QOR-4769).
    if (!MODEL_ID.test(model)) return Promise.resolve(FAILED);
    const hit = kept.get(model);
    if (hit && clock() < hit.until) return hit.verdict;
    // Held until stamped below, so callers while it runs share it.
    const entry = { verdict: Promise.resolve(FAILED), until: Infinity };
    entry.verdict = lookUp(fetch, model).then((verdict) => {
      // Stamped after the lookup, so a slow failure still gets the full hold.
      entry.until = clock() + (verdict.decided ? VERDICT_HOLD_MS : FAIL_HOLD_MS);
      return verdict;
    });
    kept.set(model, entry);
    return entry.verdict;
  };
}
