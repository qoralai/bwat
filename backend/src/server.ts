import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { createAutoJoinSwitch, type AutoJoinSwitch, type ReadAutoJoinSwitch } from './auto-join-switch.ts';
import { noBusyProtection, type BusyProtection } from './busy.ts';
import {
  fleetConfig,
  frameAncestors as frameAncestorsFromEnv,
  rateLimits as rateLimitsFromEnv,
  type RateLimits,
  serverConfig,
  STARTUP_NAMES,
  startupEnv,
  trustProxy as trustProxyFromEnv,
  zoomConfig,
  type GetSecret,
  type PrecedenceWarning,
  ZOOM_SECRET_ENV,
  type ZoomConfig,
} from './config.ts';
import { cardsClientFromEnv, type CardsClient } from './cards-client.ts';
import { feedKey } from './feed.ts';
import type { EcsSender } from './fleet-ecs.ts';
import { ecsBusyProtection, reconcileFleet } from './fleet.ts';
import { runtimePool } from './db/pool.ts';
import { keyChecker, MODEL_KEY_ENV, type KeyChecker } from './model-keys.ts';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  secretStoreFromEnv,
  withEnvFallback,
  type SecretsManagerLike,
  type SecretStore,
} from './secrets/store.ts';
import { perMinute, RateLimited, type Bucket } from './rate-limit.ts';
import { readStoredSetting } from './settings/store.ts';
import { assertRuntimeRole } from './db/runtime-role.ts';
import { nobodySignedIn, peopleAuth, peopleAuthConfig, type AuthenticatePerson } from './people-auth.ts';
import { repeat } from './repeat.ts';
import { retentionFromSettings, startRetention } from './retention.ts';
import { allocateAndLog, allocationRoutes } from './routes/allocations.ts';
import { assignmentRoutes } from './routes/assignment.ts';
import { botSettingsRoutes } from './routes/bot-settings.ts';
import { cardsModelRoutes } from './routes/cards-model.ts';
import { cardsModelFromEnv, cardsSettingsRoutes, type CardsModel } from './routes/cards-settings.ts';
import { botRoutes } from './routes/bots.ts';
import { consoleSecretRoutes } from './routes/console-secrets.ts';
import { pluginRoutes } from './routes/plugins.ts';
import { correctionsRoutes } from './routes/corrections.ts';
import { fleetRoutes } from './routes/fleet.ts';
import { inboxRoutes } from './routes/inbox.ts';
import { installRoutes } from './routes/install.ts';
import { meetingRoutes, OCCURRENCE_MAX_LENGTH } from './routes/meetings.ts';
import { memberRoutes } from './routes/members.ts';
import { modelKeyRoutes } from './routes/model-keys.ts';
import { presenceImageRoutes } from './routes/presence-image.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { settingsRoutes } from './routes/settings.ts';
import { createAutoJoinReadiness } from './auto-join-readiness.ts';
import { zoomRoutes } from './routes/zoom.ts';
import { codeTag, endCodeSignIn } from './code-signin.ts';
import { codeSignInRoutes, type CodeSignInConfig } from './routes/code-signin.ts';
import { desktopClientFromEnv, desktopClientRoutes, type DesktopClient } from './routes/desktop-client.ts';
import { googleSignInRoutes } from './routes/google-signin.ts';
import { allowedDomainsFrom, type AllowedDomains } from './google-signin.ts';
import { zoomBoardRoutes } from './routes/zoom-board.ts';
import { zoomInviteRoutes } from './routes/zoom-invite.ts';
import { withBoardTokens } from './zoom-board-signin.ts';
import { PLUGINS } from './plugins/index.ts';
import { pluginSecretNames, type BwatPlugin } from './plugins/plugin.ts';
import { pluginSwitches } from './plugins/switches.ts';
import { zoomApi } from './zoom-api.ts';
import { zdrLookup } from './zdr.ts';
import { meetingLookups } from './zoom-events.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** The stored auto-join switch's cache: settings calls invalidate() after it writes the switch. */
    autoJoinSwitch: AutoJoinSwitch;
    /** Failed Google sign-ins per client IP (QOR-4625): people-auth checks it before verifying, and counts each failure. */
    signInFailures: Bucket;
  }
}

/**
 * What the request logger may record: a request's method and path (no query string,
 * which can carry a passcode, and no headers, which carry tokens) and a response's
 * status. Bodies are never logged; errors are logged by the error handler below.
 */
const LOG_SERIALIZERS = {
  req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.replace(/\?.*$/s, '') }),
  res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
};

/**
 * bwat backend. One company per install (D140): no workspace context. Logs record
 * events, never meeting content.
 */
export interface ServerOptions {
  pool: pg.Pool;
  logger?: FastifyServerOptions['logger'];
  authenticatePerson?: AuthenticatePerson;
  /** Where model keys are kept (D142). Unset: a store with no key, which holds nothing and refuses writes. */
  secrets?: SecretStore;
  /** The provider check behind POST /console/model-keys/{provider}/validate. */
  checkKey?: KeyChecker;
  busy?: BusyProtection;
  /** BWAT_ALLOWED_DOMAINS (D146): only an email in one of them is invited or made owner. */
  allowedDomains?: readonly string[];
  /**
   * The allowed domains in force: an admin's saved list over BWAT_ALLOWED_DOMAINS (QOR-5070). The
   * same one the sign-in reads, so a save reaches it at once. Default: one over `allowedDomains`.
   */
  domains?: AllowedDomains;
  /** BWAT_GOOGLE_CLIENT_IDS: shown on the Google sign-in card (QOR-5070). Default none. */
  googleClientIds?: readonly string[];
  /** Auto-join's env switches (BWAT_AUTO_JOIN*). */
  zoom?: ZoomConfig;
  /** Tier-2 secrets by name (zoom.webhook_secret). Default: the secret store's get, read on every delivery. */
  getSecret?: GetSecret;
  /** How long the stored auto-join switch is cached (at most 60 s, the default). */
  autoJoinCacheMs?: number;
  /** Reads a stored auto-join key's RAW value (auto_join_enabled, auto_join_require_host), never the catalogue default. Default: bwat.settings. */
  readAutoJoinSwitch?: ReadAutoJoinSwitch;
  /** How long GET /bot/settings serves model keys without reading them again (default 60 s). */
  keyRefreshMs?: number;
  /** Tests only: the server's clock (the model-key refresh bound; the dates of a Meeting SDK JWT; the rate-limit windows). */
  clock?: () => number;
  /** BWAT_TRUST_PROXY: whether X-Forwarded-For/-Proto set req.ip and req.protocol (default off). */
  trustProxy?: FastifyServerOptions['trustProxy'];
  /** Tests only: the fetch every call to Zoom's OAuth and REST hosts goes through (default: the global fetch). */
  zoomFetch?: typeof fetch;
  /** Tests only: the fetch plugins' calls out of bwat go through (default: the global fetch). */
  pluginFetch?: typeof fetch;
  /** Tests only: how auto-join's meeting lookup pauses before its one retry (default: a timer). */
  sleep?: (ms: number) => Promise<void>;
  /** BWAT_RATE_LIMIT_*_PER_MIN: the per-client-IP limits on failed sign-ins and the Zoom webhook. */
  rateLimits?: RateLimits;
  /** The card service's backend-only operations (BWAT_CARDS_URL, D162). Unset: none to call. */
  cards?: CardsClient | undefined;
  /** BWAT_PUBLIC_URL: the board's address, linked from a card hand-off's message. */
  boardUrl?: string | undefined;
  /** BWAT_FEED_KEY: every claim generation's feed token is derived from it (unset: none). */
  feedKey?: Buffer | undefined;
  /** BWAT_CARDS_MODEL_URL and BWAT_CARDS_MODEL: the card writer's model, served on GET /cards/settings. */
  cardsModel?: CardsModel;
  /** Tests only: the fetch the ZDR lookups behind GET /cards/settings go through (default: the global fetch). */
  zdrFetch?: typeof fetch;
  /** Tests only: the fetch the card writer model's checks go through, its list and test call (default: the global fetch). */
  modelFetch?: typeof fetch;
  /** BWAT_GOOGLE_DESKTOP_CLIENT_ID and _SECRET: served to the plugin for its sign-in (unset: none). */
  desktopClient?: DesktopClient | undefined;
  /** A local install's code sign-in (QOR-5007, D202); unset on every other tier. */
  codeSignIn?: CodeSignInConfig | undefined;
  /** Every plugin bwat ships (QOR-4806): each runs only while an admin has it switched on. Default none. */
  plugins?: readonly BwatPlugin[];
  /** The operator's env, read for what a plugin needs (BwatPlugin.needs). Default empty. */
  env?: NodeJS.ProcessEnv;
  /** BWAT_FRAME_ANCESTORS (QOR-4830): who may frame bwat besides Zoom. Default none. */
  frameAncestors?: readonly string[];
}

/**
 * Sent on every answer, errors and 304s included (QOR-4588). The board opens inside the
 * Zoom client, so framing is limited to Zoom by frame-ancestors, plus BWAT_FRAME_ANCESTORS
 * (QOR-4830), and X-Frame-Options is never sent (it cannot name Zoom and would forbid it).
 * No Referer: nothing here needs one, and a URL can carry a meeting link.
 */
const securityHeaders = (frameAncestors: readonly string[]) => ({
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': ['frame-ancestors https://*.zoom.us https://*.zoom.com', ...frameAncestors].join(' '),
});

/**
 * Errors that are the caller's, by code, with the answer each gets; any other 4xx is
 * invalid_body, anything else a 500. PostgreSQL refuses text holding a NUL (\u0000), which
 * JSON carries: 22021 for text, 22P05 for jsonb. That is the body's fault, on any route.
 */
const REJECTED: Record<string, { status: number; error: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, error: 'too_large' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, error: 'unsupported_media_type' },
  '22021': { status: 400, error: 'invalid_body' },
  '22P05': { status: 400, error: 'invalid_body' },
};

/** Every API route's base path; /health stays at the root for load-balancer checks. */
export const API_PREFIX = '/v1';

export function buildServer({
  pool,
  logger = false,
  authenticatePerson: signInSeam = nobodySignedIn,
  busy = noBusyProtection,
  allowedDomains = [],
  domains = allowedDomainsFrom(pool, allowedDomains),
  googleClientIds = [],
  zoom = zoomConfig({}),
  // Before secrets, whose default keeps their names.
  plugins = [],
  secrets = secretStoreFromEnv({}, pool, { pluginNames: pluginSecretNames(plugins, { retired: true }) }),
  getSecret = (name) => secrets.get(name),
  autoJoinCacheMs,
  // The raw stored value, never the catalogue default: a fresh install auto-joins nothing.
  readAutoJoinSwitch = (key) => readStoredSetting(pool, key),
  checkKey,
  keyRefreshMs = 60_000,
  clock,
  trustProxy = false,
  zoomFetch,
  pluginFetch = fetch,
  sleep,
  rateLimits = rateLimitsFromEnv({}),
  cards,
  boardUrl,
  feedKey,
  cardsModel = cardsModelFromEnv({}),
  zdrFetch,
  modelFetch = fetch,
  desktopClient,
  codeSignIn,
  env = {},
  frameAncestors = [],
}: ServerOptions): FastifyInstance {
  const SECURITY_HEADERS = securityHeaders(frameAncestors);
  // A board token (the board inside Zoom, QOR-4708) is checked before the given sign-in,
  // and each plugin's own bearer (QOR-4806) before both while the plugin is switched on; off,
  // its bearer passes it by. A board token a plugin issued signs in only while it is on (QOR-4890).
  const switches = pluginSwitches(pool, plugins.map((p) => p.name));
  const isOn = async (name: string) => (await switches.on()).has(name);
  const authenticatePerson = plugins.reduce<AuthenticatePerson>(
    (inner, plugin) => (plugin.authenticate ? plugin.authenticate(pool, () => isOn(plugin.name))(inner) : inner),
    withBoardTokens(pool, signInSeam, switches.on, codeSignIn ? codeTag(codeSignIn.codeDigest) : null),
  );
  const app = Fastify({
    logger: logger && { ...(logger === true ? {} : logger), serializers: LOG_SERIALIZERS },
    trustProxy,
    // The router's limit on a path parameter, measured decoded (default 100): a Zoom
    // occurrence can be 128 characters. A longer one is refused 414 before any handler.
    routerOptions: { maxParamLength: OCCURRENCE_MAX_LENGTH },
    // The router's own errors (a malformed URL, an overlong parameter) never reach the
    // onSend hook and Fastify's default body echoes the path, so answer them here: the
    // security headers set explicitly, a generic body, the event and code logged only.
    frameworkErrors: (err, req, reply) => {
      const tooLong = err.code === 'FST_ERR_MAX_PARAM_LENGTH';
      const status = tooLong ? 414 : 400;
      req.log.info({ event: 'request.rejected', code: err.code ?? status }, 'request rejected');
      void (reply as FastifyReply).headers(SECURITY_HEADERS).code(status).send({ error: tooLong ? 'too_long' : 'bad_url' });
    },
  });

  // An error is logged as its event and code (a PostgreSQL error code, or the HTTP
  // status), never its message, detail or context: those can quote request data back,
  // such as a passcode. The caller gets a generic answer.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Logged as its bucket only, never the client's IP or what it presented.
    if (err instanceof RateLimited) {
      req.log.info({ event: 'rate_limited', group: err.group }, 'rate limited');
      return reply.header('retry-after', err.retryAfterSeconds).code(429).send({ error: 'rate_limited' });
    }
    const code = typeof err.code === 'string' ? err.code : undefined;
    const known = code === undefined ? undefined : REJECTED[code];
    const status = known?.status ?? (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500);
    if (status < 500) {
      req.log.info({ event: 'request.rejected', code: code ?? status }, 'request rejected');
      return reply.code(status).send({ error: known?.error ?? 'invalid_body' });
    }
    req.log.error({ event: 'request.failed', code: code ?? status }, 'request failed');
    return reply.code(500).send({ error: 'internal' });
  });

  // Fastify's own 404 logs and echoes the raw URL, query string included (a passcode can
  // ride there). Answer a generic 404 and log only the event.
  app.setNotFoundHandler((req, reply) => {
    req.log.info({ event: 'request.not_found' }, 'route not found');
    return reply.code(404).send({ error: 'not_found' });
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
  });

  // Says whether the database answers, and nothing about where it is or why it failed.
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      app.log.warn({ event: 'health.db_unavailable', code: (err as { code?: string }).code }, 'database unavailable');
      return reply.code(503).send({ status: 'error', db: 'unavailable' });
    }
  });

  // One cache per app, so the settings routes (QOR-4578) can invalidate what auto-join reads.
  const autoJoinSwitch = createAutoJoinSwitch(readAutoJoinSwitch, autoJoinCacheMs === undefined ? {} : { ttlMs: autoJoinCacheMs });
  app.decorate('autoJoinSwitch', autoJoinSwitch);

  // One Zoom client per app, so the join-token route and auto-join share its access token.
  const zoomClient = zoomApi({ getSecret, fetch: zoomFetch });
  const autoJoinReadiness = createAutoJoinReadiness({ pool, getSecret, zoomApi: zoomClient, enabled: zoom.autoJoin });
  // One per app: auto-join's lookups in flight, and the final noes it keeps.
  const lookups = meetingLookups({ ...(clock && { now: clock }), ...(sleep && { sleep }) });

  // Every API route, under /v1. The root's hooks and handlers above apply inside it too.
  app.register(
    async (api) => {
      // Work a route runs after it answers (auto-join's passcode lookup). Awaited on close,
      // in this child scope, whose onClose runs before the root's (start() ends the pool there).
      const running = new Set<Promise<void>>();
      const later = (task: () => Promise<void>) => {
        const run: Promise<void> = task()
          .catch(() => undefined)
          .finally(() => running.delete(run));
        running.add(run);
      };
      api.addHook('onClose', async () => {
        await Promise.all(running);
      });
      // Per-client-IP buckets (QOR-4625), only where a request costs something before it is
      // trusted: failed Google sign-ins, and the Zoom webhook's signature check.
      const now = clock ?? (() => Date.now());
      api.decorate('signInFailures', perMinute('signin', rateLimits.signInFailuresPerMin, { now }));
      const limitZoom = perMinute('zoom', rateLimits.zoomPerMin, { now });
      botRoutes(api, { pool, busy, feedKey });
      assignmentRoutes(api, { pool, busy, getSecret, zoomApi: zoomClient, feedKey, later, cards, ...(clock && { clock }) });
      allocationRoutes(api, { pool, authenticatePerson, busy, zoomApi: zoomClient, limitZoom });
      fleetRoutes(api, { pool, authenticatePerson, feedKey });
      memberRoutes(api, { pool, authenticatePerson, allowedDomains: domains.get });
      desktopClientRoutes(api, { desktopClient, codeSignIn: codeSignIn !== undefined });
      googleSignInRoutes(api, {
        pool, authenticatePerson, domains, googleClientIds, desktopClient, codeSignIn: codeSignIn !== undefined,
      });
      codeSignInRoutes(api, { pool, codeSignIn });
      zoomBoardRoutes(api, { pool, signIn: signInSeam, getSecret, audiences: async () => ['zoom', ...(await switches.on())] });
      zoomInviteRoutes(api, { pool, authenticatePerson, getSecret, busy, zoomApi: zoomClient });
      zoomRoutes(api, { pool, zoom, getSecret, autoJoinSwitch, autoJoinReadiness, busy, zoomApi: zoomClient, lookups, later, limit: limitZoom, allowedDomains: domains.get });
      meetingRoutes(api, { pool, authenticatePerson });
      settingsRoutes(api, { pool, authenticatePerson, autoJoinSwitch, autoJoinReadiness });
      presenceImageRoutes(api, { pool, authenticatePerson });
      correctionsRoutes(api, { pool, authenticatePerson });
      modelKeyRoutes(api, { pool, authenticatePerson, secrets, checkKey: checkKey ?? keyChecker(cardsModel.baseUrl) });
      consoleSecretRoutes(api, { pool, authenticatePerson, secrets, pluginSecrets: pluginSecretNames(plugins) });
      const zdr = zdrLookup({ ...(zdrFetch && { fetch: zdrFetch }), ...(clock && { clock }) });
      cardsSettingsRoutes(api, { pool, secrets, cardsModel, zdr });
      cardsModelRoutes(api, { pool, authenticatePerson, secrets, cardsModel, zdr, fetch: modelFetch, cards });
      botSettingsRoutes(api, { pool, secrets, keyRefreshMs, ...(clock && { clock }) });
      sessionRoutes(api, { pool, authenticatePerson });
      inboxRoutes(api, { pool, authenticatePerson, cards, boardUrl });
      installRoutes(api, { pool, autoJoinReadiness, cards, authenticatePerson });
      pluginRoutes(api, { pool, authenticatePerson, plugins, switches, env });
      // Every plugin's routes, each 404 while it is off, as if it were not there.
      for (const plugin of plugins) {
        const routes = plugin.routes;
        if (!routes) continue;
        const own = new Set(pluginSecretNames([plugin]));
        const pluginSecret: GetSecret = async (name) => (own.has(name) ? getSecret(name) : null);
        api.register(
          async (scope) => {
            scope.addHook('onRequest', async (req, reply) => {
              if (!(await isOn(plugin.name))) return reply.callNotFound();
            });
            routes(scope, { pool, authenticatePerson, now, cards, getSecret: pluginSecret, fetch: pluginFetch });
          },
          { prefix: `/plugins/${plugin.name}` },
        );
      }
    },
    { prefix: API_PREFIX },
  );

  return app;
}

/** How often the server retires lapsed claims and re-runs allocation; `start`'s `sweepMs` is for tests. */
const SWEEP_MS = 15_000;

/** How often a fleet pass runs while BWAT_FLEET_AUTOSCALE is on or dryrun (fleet.ts); `fleetMs` is for tests. */
const FLEET_MS = 60_000;

/**
 * Reads the startup secrets (NAME_FILE > NAME > the aws store; backend/README.md, Secrets), connects as
 * the runtime role, refuses to start as anything more, and listens. A startup secret set
 * in more than one place is logged once, as a warning naming the winner. `logger`
 * overrides the default (on, except under test) so a test can read what it logs.
 */
export async function start(
  processEnv = process.env,
  options: {
    logger?: FastifyServerOptions['logger'];
    awsClient?: SecretsManagerLike;
    sweepMs?: number;
    zdrFetch?: typeof fetch;
    /** Tests: the ECS client the fleet uses, and how often it runs. */
    ecsClient?: EcsSender;
    fleetMs?: number;
  } = {},
): Promise<FastifyInstance> {
  const warnings: PrecedenceWarning[] = [];
  const warn = (warning: PrecedenceWarning) => void warnings.push(warning);
  const awsClient = processEnv.BWAT_SECRET_STORE === 'aws' ? (options.awsClient ?? new SecretsManagerClient({})) : undefined;
  // Every startup secret resolved first, so nothing below checks a value the env alone holds.
  const env = await startupEnv(processEnv, STARTUP_NAMES.server, { awsClient, warn });
  const signIn = peopleAuthConfig(env);
  const zoom = zoomConfig(env);
  const limits = rateLimitsFromEnv(env);
  const proxy = trustProxyFromEnv(env);
  const framers = frameAncestorsFromEnv(env);
  const cards = cardsClientFromEnv(env);
  const feed = feedKey(env);
  const fleet = fleetConfig(env);
  const pool = runtimePool(env);
  let secrets: SecretStore;
  try {
    // A stored model key or Zoom secret wins; the env (or its *_FILE form) is the fallback.
    secrets = withEnvFallback(
      secretStoreFromEnv(env, pool, { awsClient, warn, pluginNames: pluginSecretNames(PLUGINS, { retired: true }) }),
      { ...MODEL_KEY_ENV, ...ZOOM_SECRET_ENV },
      env,
    );
    await assertRuntimeRole(pool);
  } catch (err) {
    await pool.end();
    throw err;
  }
  const logger = options.logger ?? (env.NODE_ENV !== 'test' && !env.VITEST);
  const domains = allowedDomainsFrom(pool, signIn.allowedDomains);
  const authenticatePerson = peopleAuth(pool, signIn, { domains: domains.get });
  let busy: BusyProtection = noBusyProtection;
  let fleetPass: (() => Promise<void>) | undefined;
  if (fleet.mode !== 'off') {
    // Loaded only here, so an install without the fleet never loads the ECS SDK.
    const { ecsClient, ecsFleet } = await import('./fleet-ecs.ts');
    const ecs = ecsFleet(options.ecsClient ?? ecsClient(), fleet);
    // A dryrun writes nothing to ECS, so only `on` protects a bot as it takes a meeting.
    if (fleet.mode === 'on') busy = ecsBusyProtection(pool, ecs);
    const state = { lowerSince: null };
    fleetPass = async () => {
      await reconcileFleet({ pool, ecs, config: fleet, state, now: () => new Date(), log: (level, line) => app.log[level](line, 'fleet pass') }).catch(
        (err: { name?: string }) => app.log.error({ event: 'fleet.failed', code: err.name }, 'fleet pass failed'),
      );
    };
  }
  const app = buildServer({
    pool,
    logger,
    authenticatePerson,
    busy,
    allowedDomains: signIn.allowedDomains,
    domains,
    googleClientIds: signIn.googleClientIds,
    zoom,
    secrets,
    trustProxy: proxy,
    rateLimits: limits,
    cards,
    boardUrl: env.BWAT_PUBLIC_URL || undefined,
    feedKey: feed,
    cardsModel: cardsModelFromEnv(env),
    ...(options.zdrFetch && { zdrFetch: options.zdrFetch }),
    desktopClient: desktopClientFromEnv(env),
    ...(signIn.codeDigest && { codeSignIn: { codeDigest: signIn.codeDigest, firstOwnerEmail: signIn.firstOwnerEmail } }),
    plugins: PLUGINS,
    env,
    frameAncestors: framers,
  });
  for (const warning of warnings) app.log.warn(warning, 'startup secret set in more than one place');
  // Each shipped plugin's start step, on or off; each logs its own failure.
  for (const plugin of PLUGINS) await plugin.start?.({ pool, secrets, log: app.log });
  if (signIn.testPeople?.length) {
    app.log.warn({ event: 'auth.test_people_on', count: signIn.testPeople.length }, 'BWAT_TEST_PEOPLE is set: local and test stacks only');
  }
  if (signIn.codeDigest) {
    app.log.warn({ event: 'auth.code_signin_on' }, 'Local tier: anyone with the install code signs in, as any email');
  } else {
    if (signIn.allowedDomains.length === 0) {
      app.log.warn({ event: 'auth.allowed_domains_unset' }, 'BWAT_ALLOWED_DOMAINS is unset: every Google sign-in is refused');
    }
    // Moved past the local tier (D202): whoever joined by code is removed once, their work kept. Only on a
    // tier named past local, never because the tier is missing (a stack started by hand), since
    // the removal is not undone by putting the code back.
    if (signIn.tier !== undefined) {
      const removed = await endCodeSignIn(pool, { firstOwnerEmail: signIn.firstOwnerEmail });
      if (removed > 0) app.log.info({ event: 'auth.code_members_removed', count: removed }, 'code sign-in is off: removed the members who joined by code');
    }
  }
  // The sweep: one retire step (lapsed leases, pending claims past their bound or out of
  // attempts), then allocation, on a timer, so nothing waits for the next request.
  const sweep = repeat(async () => {
    await allocateAndLog(pool, app.log, busy).catch((err: { code?: string }) => {
      app.log.error({ event: 'sweep.failed', code: err.code }, 'sweep failed');
    });
  }, options.sweepMs ?? SWEEP_MS);
  const stopRetention = startRetention(pool, retentionFromSettings(pool), app.log);
  const fleetLoop = fleetPass && repeat(fleetPass, options.fleetMs ?? FLEET_MS);
  app.addHook('onClose', async () => {
    await stopRetention();
    await sweep.stop();
    await fleetLoop?.stop();
    await pool.end();
  });
  await app.listen(serverConfig(env));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err: Error) => {
    console.error(`bwat-backend failed to start: ${err.message}`);
    process.exit(1);
  });
}
