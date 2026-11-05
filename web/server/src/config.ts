import { fileURLToPath } from 'node:url';

/** Every env var the web server reads, parsed once. Documented in web/README.md. */
export interface Config {
  /** The board pages, served at /. Defaults to web/pages. */
  pagesDir: string;
  /** The admin panel's Vite build, served at /admin/ to signed-in people only. Defaults to web/dist/admin. */
  adminDir: string;
  /** The web plugins' folders (web/plugins/<name>/), whose board/ scripts are served at /plugins/<name>/. Defaults to web/plugins. */
  pluginsDir: string;
  /** Google sign-in: every auth variable valid, or disabled with the reason. */
  auth: AuthConfig;
  /** The build this server is (BWAT_VERSION), shown in the board's footer; unset, /version is 404. */
  version: string | undefined;
  /** BWAT_FRAME_ANCESTORS: who may frame the board besides Zoom (frameAncestors). */
  frameAncestors: string[];
  /** BWAT_TRUST_PROXY: whether X-Forwarded-For/-Proto set req.ip and req.protocol (trustProxy). */
  trustProxy: boolean | string[];
}

/**
 * The sign-in group: enabled only when all five variables are set (on a local install, all but the
 * two Google ones) and the session key decodes to 32 bytes. Otherwise sign-in is disabled rather than the server failing to
 * start: /health and the pages keep serving and /auth/*, /admin and /whoami answer 503.
 */
export type AuthConfig =
  | {
      enabled: true;
      /** AES-256-GCM key for the session and login cookies (BWAT_SESSION_SECRET). */
      sessionKey: Buffer;
      /**
       * How people sign in (D202): 'google', or 'code' on a local install (BWAT_TIER=local), which
       * has no Google and signs people in with the install's code.
       */
      signIn: 'google' | 'code';
      /** Empty on a code install. */
      googleClientId: string;
      googleClientSecret: string;
      /** No trailing slash; the OAuth redirect URI is `${publicUrl}/auth/callback`. */
      publicUrl: string;
      /** No trailing slash; /whoami reads the member from `${backendUrl}/v1/me`. */
      backendUrl: string;
    }
  | {
      enabled: false;
      /** Names each missing or invalid variable, never a value. */
      reason: string;
    };

export const PORT = 8080;

const KEY_BYTES = 32;

// The web/ directory: server/src -> ../../ from source, dist/server/src -> ../../../ once built.
const fromWeb = (path: string) =>
  fileURLToPath(new URL((import.meta.url.includes('/dist/') ? '../../../' : '../../') + path, import.meta.url));

// Empty counts as unset, so compose's `${VAR:-}` falls back to the default.
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === '' ? undefined : value;
}

function loadAuth(env: NodeJS.ProcessEnv): AuthConfig {
  const problems: string[] = [];
  const get = (name: string) => {
    const value = read(env, name);
    if (value === undefined) problems.push(`${name} is unset`);
    return value;
  };
  const rawKey = get('BWAT_SESSION_SECRET');
  // A local install signs in with its code, never Google: no Google variables to ask for. Keyed on
  // the tier, never on Google being absent, so a team install missing them stays disabled.
  // t0 is the local tier's old name, still in an install saved before the rename.
  const code = ['local', 't0'].includes(read(env, 'BWAT_TIER') ?? '');
  const googleClientId = code ? '' : get('BWAT_GOOGLE_CLIENT_ID');
  const googleClientSecret = code ? '' : get('BWAT_GOOGLE_CLIENT_SECRET');
  const publicUrl = get('BWAT_PUBLIC_URL');
  const backendUrl = get('BWAT_BACKEND_URL');
  const sessionKey = rawKey === undefined ? undefined : Buffer.from(rawKey, 'base64');
  if (sessionKey && sessionKey.length !== KEY_BYTES) {
    problems.unshift(`BWAT_SESSION_SECRET must decode to ${KEY_BYTES} bytes (base64), got ${sessionKey.length}`);
  }
  if (problems.length > 0 || !sessionKey || (!code && (!googleClientId || !googleClientSecret)) || !publicUrl || !backendUrl) {
    return { enabled: false, reason: problems.join('; ') };
  }
  const trim = (url: string) => url.replace(/\/+$/, '');
  return {
    enabled: true,
    sessionKey,
    signIn: code ? 'code' : 'google',
    googleClientId: googleClientId ?? '',
    googleClientSecret: googleClientSecret ?? '',
    publicUrl: trim(publicUrl),
    backendUrl: trim(backendUrl),
  };
}

/** Who may frame the board besides Zoom, as a frame-ancestors source: https://host, with a port or :* or not. */
const FRAME_ORIGIN = /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:([0-9]{1,5}|\*))?$/;
/** ...or a bare scheme, such as an app's own (qv:). */
const FRAME_SCHEME = /^[a-z][a-z0-9+.-]*:$/;
/** Bare schemes that would let any site, or any document, frame the board. */
const OPEN_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'file:', 'filesystem:', 'javascript:']);

/**
 * BWAT_FRAME_ANCESTORS, as the backend reads it: the frame-ancestors sources added
 * to Zoom's, so another product may frame the board (a plugin's that embeds it). Space-separated; each
 * https://host, https://host:port, https://host:* or a bare scheme like qv: (never one any site
 * has, such as https:). Unset or empty: none. Anything else throws, so the server never starts
 * with a framing policy nobody meant.
 */
export function frameAncestors(env: NodeJS.ProcessEnv): string[] {
  const sources = (env.BWAT_FRAME_ANCESTORS ?? '').split(/\s+/).filter(Boolean);
  for (const source of sources) {
    const scheme = FRAME_SCHEME.test(source) && !OPEN_SCHEMES.has(source);
    if (!scheme && !FRAME_ORIGIN.test(source)) {
      throw new Error(`BWAT_FRAME_ANCESTORS: ${JSON.stringify(source)} is not https://host, https://host:port, https://host:* or a bare scheme like qv:`);
    }
  }
  return sources;
}

/**
 * BWAT_TRUST_PROXY, as the backend reads it: whether X-Forwarded-For and -Proto name the
 * client, for the web server behind the edge (Caddy on the compose network, or the load
 * balancer). Off by default (unset, empty, false or 0): a client could otherwise claim any
 * address. `true` trusts every hop, anything else is a comma-separated list of proxy addresses
 * or CIDRs. A hop count stops the server starting: Fastify (5.12) no longer honours one and
 * would silently trust nothing. The /embed limit is per client address, so behind the edge it
 * needs this set, or every client shares the edge's address.
 */
export function trustProxy(env: NodeJS.ProcessEnv): boolean | string[] {
  const value = (env.BWAT_TRUST_PROXY ?? '').trim();
  if (['', 'false', '0'].includes(value.toLowerCase())) return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) throw new Error('BWAT_TRUST_PROXY must be true or proxy addresses/CIDRs, not a hop count');
  return value.split(',').map((address) => address.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    pagesDir: fromWeb('pages'),
    adminDir: read(env, 'BWAT_WEB_ADMIN_DIR') ?? fromWeb('dist/admin'),
    pluginsDir: read(env, 'BWAT_WEB_PLUGINS_DIR') ?? fromWeb('plugins'),
    auth: loadAuth(env),
    version: read(env, 'BWAT_VERSION'),
    frameAncestors: frameAncestors(env),
    trustProxy: trustProxy(env),
  };
}
