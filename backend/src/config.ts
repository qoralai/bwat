import { readFileSync } from 'node:fs';
import { SECRET } from './secret-names.ts';

type Env = NodeJS.ProcessEnv;

/** Said once when a startup secret is set in more than one place: its name and the winner, never a value. */
export interface PrecedenceWarning {
  event: 'config.secret_precedence';
  name: string;
  winner: string;
}
export type Warn = (warning: PrecedenceWarning) => void;

/** Where `name` is set in the env, in precedence order: `NAME_FILE`, then `NAME`. */
const envSources = (env: Env, name: string): string[] => [`${name}_FILE`, name].filter((variable) => env[variable]);

/** The value of the env source `variable`: the file `NAME_FILE` names (its trailing newline dropped), or `NAME`. */
function readEnvSource(env: Env, name: string, variable: string): string | undefined {
  if (variable === name) return env[name] || undefined;
  try {
    return readFileSync(env[variable]!, 'utf8').replace(/\r?\n$/, '') || undefined;
  } catch {
    throw new Error(`${variable} cannot be read`);
  }
}

/**
 * A startup (tier-1) secret from the env: `NAME_FILE` > `NAME` (backend/README.md, Secrets). Both set,
 * the file wins and `warn` is told once which one won. Errors name the variable, never
 * the value or the path's contents. Here, and not beside the secret store, so that
 * `npm run migrate` never loads the AWS SDK.
 */
export function envSecret(env: Env, name: string, warn?: Warn): string | undefined {
  const set = envSources(env, name);
  if (set.length > 1) warn?.({ event: 'config.secret_precedence', name, winner: set[0]! });
  return set[0] === undefined ? undefined : readEnvSource(env, name, set[0]);
}

/**
 * A startup secret with the store last: `NAME_FILE` > `NAME` > `fromStore(NAME)` (aws:
 * `<prefix><NAME>`). The store is asked even when the env has the name, so a name set
 * in two or three places gets its one warning. A store that cannot be read is an error
 * only when the env has nothing.
 */
export async function startupSecret(
  env: Env,
  name: string,
  { fromStore, warn }: { fromStore?: ((name: string) => Promise<string | null>) | undefined; warn?: Warn | undefined } = {},
): Promise<string | undefined> {
  const set = envSources(env, name);
  let stored: string | null = null;
  if (fromStore) {
    try {
      stored = await fromStore(name);
    } catch {
      if (set.length === 0) throw new Error(`${name} cannot be read from the secret store`);
    }
  }
  const all = stored === null ? set : [...set, 'store'];
  if (all.length > 1) warn?.({ event: 'config.secret_precedence', name, winner: all[0]! });
  return set[0] === undefined ? (stored ?? undefined) : readEnvSource(env, name, set[0]);
}

/**
 * The startup resolver (tier 1; backend/README.md, Secrets): `env` with each of `names` resolved once,
 * NAME_FILE > NAME > the aws store (`<prefix><NAME>`, BWAT_SECRET_STORE=aws only), as
 * plain `NAME` (its `NAME_FILE` dropped), so everything after it checks the one winner.
 * A name set in more than one place is told to `warn` once, naming the winner, never the
 * value. BWAT_ENC_KEY keys the local store only, so it is never read from aws. The AWS
 * SDK is loaded only in aws mode, so `npm run migrate` on a local install never loads it.
 * Every entry point calls it first: the server, migrate, seed-secrets and the other scripts.
 */
export async function startupEnv(
  env: Env,
  names: readonly string[],
  // SecretsManagerLike, spelled out: config.ts imports nothing of the store (see the migrate guard).
  { awsClient, warn }: { awsClient?: { send(command: object): Promise<unknown> } | undefined; warn?: Warn } = {},
): Promise<Env> {
  let fromStore: ((name: string) => Promise<string | null>) | undefined;
  if (env.BWAT_SECRET_STORE === 'aws') {
    const { awsSecretPrefix, awsStartupSecrets } = await import('./secrets/store.ts');
    const prefix = awsSecretPrefix(env);
    const { SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
    fromStore = awsStartupSecrets(awsClient ?? new SecretsManagerClient({}), prefix);
  }
  const resolved = { ...env };
  for (const name of names) {
    const value = await startupSecret(env, name, { fromStore: name === 'BWAT_ENC_KEY' ? undefined : fromStore, warn });
    delete resolved[`${name}_FILE`];
    if (value === undefined) delete resolved[name];
    else resolved[name] = value;
  }
  return resolved;
}

/** Each entry point's tier-1 names (backend/README.md, Secrets), for startupEnv. */
export const STARTUP_NAMES = {
  server: ['BWAT_DB_URL', 'BWAT_ENC_KEY', 'BWAT_FEED_KEY', 'BWAT_CARDS_BACKEND_TOKEN', 'BWAT_GOOGLE_CLIENT_IDS', 'BWAT_ALLOWED_DOMAINS'],
  migrate: ['BWAT_OWNER_DB_URL'],
  // The admin login is read from the env alone (dbBootstrap): it is never kept in the store.
  dbBootstrap: ['BWAT_OWNER_PASSWORD', 'BWAT_RUNTIME_PASSWORD', 'BWAT_CARDS_PASSWORD'],
  seedSecrets: ['BWAT_DB_URL', 'BWAT_ENC_KEY'],
  runtimeScript: ['BWAT_DB_URL'],
} as const;

/** A 32-byte key (BWAT_ENC_KEY, BWAT_FEED_KEY), as 64 hex characters or base64. Errors name the variable only. */
export function key32(name: string, value: string): Buffer {
  const hex = /^[0-9a-fA-F]{64}$/.test(value);
  const key = Buffer.from(value, hex ? 'hex' : 'base64');
  if (key.length !== 32 || (!hex && key.toString('base64') !== value)) {
    throw new Error(`${name} must be 32 bytes, as 64 hex characters or base64`);
  }
  return key;
}

/** A postgres URL. Errors name the variable and never echo its value. */
export function checkDbUrl(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set`);
  if (!/^postgres(ql)?:\/\//.test(value)) throw new Error(`${name} is not a postgres:// or postgresql:// URL`);
  return value;
}

/**
 * BWAT_DB_URL (or BWAT_DB_URL_FILE): the runtime role the app logs in as. Never the
 * owner: the server checks the role it actually logged in as before it listens
 * (assertRuntimeRole).
 */
export function runtimeDbUrl(env: Env): string {
  return checkDbUrl('BWAT_DB_URL', envSecret(env, 'BWAT_DB_URL'));
}

/**
 * BWAT_DB_SSLROOTCERT: the path of a CA bundle (the image ships the RDS one at
 * /app/rds-global-bundle.pem). Set, every backend database connection uses TLS and
 * verifies the server's certificate and host name against it (verify-full); unset, no TLS.
 */
export function dbTls(env: Env): { ca: string; rejectUnauthorized: true } | undefined {
  const path = env.BWAT_DB_SSLROOTCERT;
  if (!path) return undefined;
  try {
    return { ca: readFileSync(path, 'utf8'), rejectUnauthorized: true };
  } catch {
    throw new Error('BWAT_DB_SSLROOTCERT cannot be read');
  }
}

/** BWAT_OWNER_DB_URL (or BWAT_OWNER_DB_URL_FILE): the owner role, used only to run migrations. */
export function ownerDbUrl(env: Env): string {
  return checkDbUrl('BWAT_OWNER_DB_URL', envSecret(env, 'BWAT_OWNER_DB_URL'));
}

export function serverConfig(env: Env): { host: string; port: number } {
  return { host: env.HOST || '127.0.0.1', port: Number(env.PORT || 3000) };
}

/**
 * BWAT_TRUST_PROXY: whether X-Forwarded-For and -Proto name the client, for a backend
 * behind a TLS-terminating proxy (Caddy on the compose network). Off by default (unset,
 * empty, false or 0): a client could otherwise claim any address. `true` trusts every hop,
 * anything else is a comma-separated list of proxy addresses or CIDRs. A hop count stops
 * the server starting: Fastify (5.12) no longer honours one and would silently trust nothing.
 */
export function trustProxy(env: Env): boolean | string[] {
  const value = (env.BWAT_TRUST_PROXY ?? '').trim();
  if (['', 'false', '0'].includes(value.toLowerCase())) return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) throw new Error('BWAT_TRUST_PROXY must be true or proxy addresses/CIDRs, not a hop count');
  return value.split(',').map((address) => address.trim()).filter(Boolean);
}

/** Who may frame bwat besides Zoom, as a frame-ancestors source: https://host, with a port or :* or not. */
const FRAME_ORIGIN = /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:([0-9]{1,5}|\*))?$/;
/** ...or a bare scheme, such as an app's own (qv:). */
const FRAME_SCHEME = /^[a-z][a-z0-9+.-]*:$/;
/** Bare schemes that would let any site, or any document, frame bwat. */
const OPEN_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'filesystem:', 'javascript:']);

/**
 * BWAT_FRAME_ANCESTORS (QOR-4830): the frame-ancestors sources added to Zoom's, so another
 * product may frame the board (a plugin's that embeds it). Space-separated; each https://host,
 * https://host:port, https://host:* or a bare scheme like qv: (never one any site has, such as https:). Unset or
 * empty: none, so Zoom alone frames bwat. Anything else stops the server starting. The web
 * server reads it the same way (web/server/src/config.ts frameAncestors): change both together.
 */
export function frameAncestors(env: Env): string[] {
  const sources = (env.BWAT_FRAME_ANCESTORS ?? '').split(/\s+/).filter(Boolean);
  for (const source of sources) {
    const scheme = FRAME_SCHEME.test(source) && !OPEN_SCHEMES.has(source);
    if (!scheme && !FRAME_ORIGIN.test(source)) {
      throw new Error(`BWAT_FRAME_ANCESTORS: ${JSON.stringify(source)} is not https://host, https://host:port, https://host:* or a bare scheme like qv:`);
    }
  }
  return sources;
}

/** Per-client-IP request limits on the public edge (QOR-4625), each per minute. */
export interface RateLimits {
  /** BWAT_RATE_LIMIT_SIGNIN_FAILURES_PER_MIN: failed Google sign-ins; a successful one is never counted (default 30). */
  signInFailuresPerMin: number;
  /** BWAT_RATE_LIMIT_ZOOM_PER_MIN: Zoom webhook deliveries, which can burst (default 600). */
  zoomPerMin: number;
}

/** The edge's rate limits, checked at once (empty is unset). */
export function rateLimits(env: Env): RateLimits {
  const perMinute = (name: string, fallback: string) => {
    const value = env[name] || fallback;
    if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new Error(`${name} must be a whole number per minute, at least 1`);
    return Number(value);
  };
  return {
    signInFailuresPerMin: perMinute('BWAT_RATE_LIMIT_SIGNIN_FAILURES_PER_MIN', '30'),
    zoomPerMin: perMinute('BWAT_RATE_LIMIT_ZOOM_PER_MIN', '600'),
  };
}

/**
 * BWAT_FLEET_AUTOSCALE: whether the backend sizes the hosted bot service (QOR-4888).
 * - `off` (unset): nothing runs and no ECS call is made; a self-hosted install's bots are
 *   whatever it starts.
 * - `dryrun`: each pass reads the service's desired count, works out what it would do and
 *   logs it; it writes nothing to ECS and drains no bot.
 * - `on`: task scale-in protection plus the service's desired count.
 */
const FLEET_MODES = ['off', 'dryrun', 'on'] as const;

export interface FleetConfig {
  mode: (typeof FLEET_MODES)[number];
  /**
   * BWAT_FLEET_MIN, BWAT_FLEET_MAX: the bounds of the desired count (default 1 and 2). MAX is
   * at most 10, the most tasks one ECS UpdateTaskProtection call takes; a pass sends each
   * protection list in one call.
   */
  min: number;
  max: number;
  /** BWAT_FLEET_HEADROOM: idle bots kept beyond demand, so a new meeting finds one ready (default 1). */
  headroom: number;
  /** BWAT_FLEET_CLUSTER, BWAT_FLEET_SERVICE: the ECS service sized; required unless off. */
  cluster: string;
  service: string;
}

/** The fleet's settings, checked at once. Errors name the variable only. */
export function fleetConfig(env: Env): FleetConfig {
  const mode = env.BWAT_FLEET_AUTOSCALE || 'off';
  if (!(FLEET_MODES as readonly string[]).includes(mode)) throw new Error('BWAT_FLEET_AUTOSCALE must be off, dryrun or on');
  const whole = (name: string, fallback: number) => {
    const value = env[name] || String(fallback);
    if (!/^[0-9]{1,3}$/.test(value)) throw new Error(`${name} must be a whole number`);
    return Number(value);
  };
  const named = (name: string) => {
    if (mode !== 'off' && !env[name]) throw new Error(`${name} is not set`);
    return env[name] ?? '';
  };
  const max = whole('BWAT_FLEET_MAX', 2);
  if (max > 10) throw new Error('BWAT_FLEET_MAX must be at most 10');
  return {
    mode: mode as FleetConfig['mode'],
    min: whole('BWAT_FLEET_MIN', 1),
    max,
    headroom: whole('BWAT_FLEET_HEADROOM', 1),
    cluster: named('BWAT_FLEET_CLUSTER'),
    service: named('BWAT_FLEET_SERVICE'),
  };
}

/** Spellings that turn a deployment switch off. Anything else, junk and unset included, leaves it on. */
const OFF = new Set(['false', '0', 'no', 'off', 'n', 'disabled']);
const switchedOn = (value: string | undefined) => !OFF.has((value ?? '').trim().toLowerCase());

/**
 * Reads a tier-2 secret by its name (secret-names.ts): the value, or null when none is set.
 * Throws when the store cannot be read. The server's is the secret store's `get` (D142),
 * a stored value first, then its env fallback (ZOOM_SECRET_ENV).
 */
export type GetSecret = (name: string) => Promise<string | null>;

/** The Zoom tier-2 names, and the env variable each falls back to while nothing is stored. */
export const ZOOM_SECRET_ENV: Record<string, string> = { [SECRET.zoomWebhookSecret]: 'BWAT_ZOOM_WEBHOOK_SECRET' };

export interface ZoomConfig {
  /** BWAT_AUTO_JOIN: the deployment's ceiling for auto-join. The stored switch can only lower it. */
  autoJoin: boolean;
  /** BWAT_AUTO_JOIN_REQUIRE_HOST: auto-join waits for the host to arrive, not the first participant. */
  requireHost: boolean;
  /** Tests only: how long a held claim may drain after Zoom's end (default DRAIN_SECONDS, 300). */
  drainSeconds?: number;
}

/**
 * Auto-join's env switches, both on unless set to an explicit "off". BWAT_AUTO_JOIN is only
 * a ceiling: the stored switch is off until an admin saves it on (see switchIsOn).
 * Automatic claims also require the installation's Zoom and bot readiness checks.
 */
export function zoomConfig(env: Env): ZoomConfig {
  return {
    autoJoin: switchedOn(env.BWAT_AUTO_JOIN),
    requireHost: switchedOn(env.BWAT_AUTO_JOIN_REQUIRE_HOST),
  };
}
