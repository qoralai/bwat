import type { WebPlugin } from './plugin.ts';

/** One entry of the backend's GET /v1/plugins. */
interface BackendPlugin {
  name: string;
  display_name?: unknown;
  embeds?: unknown;
}

/**
 * Which web plugins are on: those whose name the backend lists and whose `requires` its
 * entry meets. `ok: false` when the backend's list could not be read: then no plugin is on,
 * and whatever asked for one is refused (fail closed), never answered without it.
 */
export type Activation =
  | { ok: true; on: ReadonlyMap<string, WebPlugin>; listed: readonly BackendPlugin[] }
  | { ok: false };

export interface Activator {
  /** The activation, from a list read at most `ttlMs` ago; a failed read is never kept. */
  current(): Promise<Activation>;
}

/**
 * Whether the plugin named is on, the one check of everything that needs it (its sign-in, routes
 * and scripts): refused 503 while the backend's list cannot be read, 404 while it is off. Each
 * caller answers the refusal its own way.
 */
export async function gate(activation: Activator, name: string): Promise<{ ok: true } | { refuse: 404 | 503 }> {
  const a = await activation.current();
  if (!a.ok) return { refuse: 503 };
  return a.on.has(name) ? { ok: true } : { refuse: 404 };
}

interface Log {
  error(obj: object, msg: string): void;
}

/** How long a list the backend answered is used before it is read again. */
const PLUGINS_TTL_MS = 30_000;

/**
 * The backend's GET /v1/plugins is the one list of which plugins run (an admin's switch there);
 * the web registry only says which plugins have web code. The two must agree: a listed plugin
 * that needs web code this server lacks, or registry code that does not fit what the backend
 * says (`requires`), is logged as an error and left off, never guessed at.
 * `readList` is null when the web server has no backend (sign-in not configured): nothing is on.
 */
export function activation(
  registry: readonly WebPlugin[],
  readList: (() => Promise<Response>) | null,
  log: Log,
  { ttlMs = PLUGINS_TTL_MS, now = Date.now }: { ttlMs?: number; now?: () => number } = {},
): Activator {
  let cached: { at: number; value: Activation & { ok: true } } | null = null;
  let inFlight: Promise<Activation> | null = null;
  let lastMismatch = '';

  const read = async (): Promise<Activation> => {
    if (!readList) return { ok: false };
    const res = await readList().catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as { plugins?: unknown } | null) : null;
    const plugins = body?.plugins;
    if (!Array.isArray(plugins) || !plugins.every((p) => typeof p === 'object' && p !== null && typeof p.name === 'string')) return { ok: false };
    const listed = plugins as BackendPlugin[];
    const on = new Map<string, WebPlugin>();
    const mismatches: string[] = [];
    for (const entry of listed) {
      const code = registry.find((p) => p.name === entry.name);
      if (!code) {
        if (entry.embeds === true) mismatches.push(`${entry.name}: listed as embedding the board, but this web server has no code for it`);
        continue;
      }
      if (code.requires?.embeds && entry.embeds !== true) {
        mismatches.push(`${entry.name}: this web server's code needs it to embed the board, the backend says it does not`);
        continue;
      }
      on.set(code.name, code);
    }
    const key = mismatches.join('\n');
    if (key && key !== lastMismatch) log.error({ mismatches }, 'web plugins disagree with the backend: left off');
    lastMismatch = key;
    return { ok: true, on, listed };
  };

  const current = async (): Promise<Activation> => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    const value = await inFlight;
    if (value.ok) cached = { at: now(), value };
    return value;
  };

  return { current };
}
