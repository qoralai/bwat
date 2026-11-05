import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { JWTVerifyGetKey } from 'jose';
import { backendAt } from './backend.ts';
import type { Config } from './config.ts';
import { GOOGLE_ENDPOINTS, type GoogleEndpoints } from './auth/oidc.ts';
import { type Gates, isBoardAsset, registerAuth } from './auth/routes.ts';
import { PLUGIN_UNAVAILABLE, sendMessagePage } from './pages.ts';
import { activation, gate } from './plugins/activation.ts';
import { WEB_PLUGINS } from './plugins/index.ts';
import { validateRegistry, type WebPlugin, type WebPluginDeps } from './plugins/plugin.ts';

export interface AppOptions {
  /** Parsed env (loadConfig). */
  config: Config;
  /** Google's OIDC endpoints and issuers; tests point them at a stub. */
  google?: Partial<GoogleEndpoints>;
  /** Google's signing keys; tests pass a local set. */
  jwks?: JWTVerifyGetKey;
  /** Request log destination (JSON lines); index.ts passes stdout. Omitted = no request log (tests). */
  logStream?: { write(line: string): unknown };
  /** The web plugins this server has code for; the registry (plugins/index.ts) unless a test passes its own. */
  plugins?: readonly WebPlugin[];
  /** Read the backend's plugin list once at start, to log a disagreement early (index.ts); tests leave it off. */
  checkPluginsAtStart?: boolean;
}

/**
 * The web image (D169): the board and admin pages as static files, Google sign-in and
 * /whoami (D141, D180), the board's transcript download, /version and /health. It proxies nothing: the edge routes /v1/* to the
 * backend and the card service, so a /v1 path that reaches this server is a 404.
 *
 * Web plugins (plugins/plugin.ts) add their board scripts, under /plugins/<name>/, their own
 * routes and their own sign-in, each only while the backend runs the plugin.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const { config } = options;
  const registry = options.plugins ?? WEB_PLUGINS;
  validateRegistry(registry);
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: options.logStream ? { level: 'info', stream: options.logStream, redact: LOG_REDACT, serializers: LOG_SERIALIZERS } : false,
  });

  // The board opens inside the Zoom client, which requires these on every page (and
  // they cost nothing elsewhere). Scripts and styles come from this origin, the Zoom
  // Apps SDK and Google Fonts only, and no script is inline.
  const headers = securityHeaders(config.frameAncestors);
  app.addHook('onSend', async (_req, reply) => {
    reply.headers(headers);
  });

  // No session, no database: the load balancer's check that this process serves.
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  // Which build is serving, for the board's footer.
  app.get('/version', { logLevel: 'warn' }, async (_req, reply) =>
    config.version ? { version: config.version } : reply.code(404).send({ error: 'not_found' }));

  // Which plugins run: the backend's list, read only by what needs it (a request for a
  // plugin's sign-in, route or script). With no backend (sign-in not configured), none do.
  const signIn = config.auth.enabled
    ? { on: true as const, auth: config.auth, backend: backendAt(config.auth.backendUrl) }
    : { on: false as const, reason: config.auth.reason };
  const backend = signIn.on ? signIn.backend : null;
  const act = activation(registry, backend && (() => backend('/v1/plugins', { headers: { accept: 'application/json' } })), app.log);
  if (options.checkPluginsAtStart) app.addHook('onReady', async () => void act.current());

  // The board page's plugins, before it asks who anyone is: those on, with their selector and
  // scripts, and every token any plugin claims (`reserved`), on or not, so the page can tell a
  // request for a plugin that is off from no request at all. Names only, no sign-in.
  const reserved = registry.flatMap((p) => (p.token === undefined ? [] : [p.token]));
  app.get('/board-plugins', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const a = await act.current();
    if (!a.ok) return reply.code(503).send({ error: 'plugins_unavailable' });
    const plugins = [...a.on.values()]
      .filter((p) => p.token !== undefined || (p.boardScripts?.length ?? 0) > 0)
      .map((p) => ({ name: p.name, token: p.token ?? null, scripts: (p.boardScripts ?? []).map((s) => `/plugins/${p.name}/${s}`) }));
    return { plugins, reserved };
  });

  // The board's slots: every link the plugins on declare (plugins/plugin.ts PluginLink). Names
  // and paths only, no sign-in, like /board-plugins.
  app.get('/board-links', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const a = await act.current();
    if (!a.ok) return reply.code(503).send({ error: 'plugins_unavailable' });
    return { links: [...a.on.values()].flatMap((p) => p.links ?? []) };
  });

  // Each plugin's board scripts and assets, outside the board's root: only the files it lists, and
  // only while it is on. Code, never data, so no sign-in, as the board's own scripts.
  const pages = { dotfiles: 'ignore', cacheControl: false, setHeaders: noCache } as const;
  const served = (p: WebPlugin) => [...(p.boardScripts ?? []), ...(p.assets ?? [])];
  const scripted = registry.filter((p) => served(p).length > 0);
  if (scripted.length > 0) {
    app.register(async (assets) => {
      assets.addHook('onRequest', async (req, reply) => {
        const [, name, file] = /^\/plugins\/([^/?]+)\/([^?]*)/.exec(req.url) ?? [];
        const plugin = scripted.find((p) => p.name === name);
        if (!plugin || !file || !served(plugin).includes(file)) return reply.code(404).send({ error: 'not_found' });
        const g = await gate(act, plugin.name);
        if ('refuse' in g) return g.refuse === 503 ? reply.code(503).send({ error: 'plugins_unavailable' }) : reply.code(404).send({ error: 'not_found' });
      });
      for (const p of scripted) {
        assets.register(fastifyStatic, {
          ...pages, root: join(config.pluginsDir, p.name, 'board'), prefix: `/plugins/${p.name}/`, decorateReply: false, index: false,
        });
      }
    });
  }

  app.register(fastifyCookie);
  let gates: Gates;
  if (signIn.on) {
    const { auth, backend } = signIn;
    // What every plugin is handed: its sign-in and its routes alike.
    const deps: WebPluginDeps = { key: auth.sessionKey, backend, frameAncestors: config.frameAncestors };
    gates = registerAuth(app, {
      auth, google: { ...GOOGLE_ENDPOINTS, ...options.google }, jwks: options.jwks, backend, activation: act, plugins: registry, deps,
    });
    // Each plugin's own routes, at the paths it declared and no others, answering only while
    // it is on (off: 404, as if it had none; the backend's list unreadable: a page saying so).
    for (const plugin of registry) {
      const routes = plugin.routes;
      if (!routes) continue;
      app.register(async (scope) => {
        scope.addHook('onRoute', (route) => {
          if (!plugin.paths?.includes(route.url)) throw new Error(`web plugin ${plugin.name}: route ${route.url} was not declared`);
        });
        scope.addHook('onRequest', async (_req, reply) => {
          const g = await gate(act, plugin.name);
          if ('refuse' in g) return g.refuse === 503 ? sendMessagePage(reply, 502, PLUGIN_UNAVAILABLE) : reply.code(404).send({ error: 'not_found' });
        });
        // A plugin with no sign-in of its own serves the ordinary signed-in person: its routes
        // pass the board's gate, as the board's pages do.
        if (!plugin.auth) scope.addHook('onRequest', gates.board);
        routes(scope, deps);
      });
    }
  } else {
    app.log.warn({ reason: signIn.reason }, 'Google sign-in is not configured');
    const notConfigured = async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.code(503).send({ error: 'sign_in_not_configured' });
    app.all('/auth/*', notConfigured);
    app.get('/whoami', notConfigured);
    app.get('/transcript', notConfigured);
    // A plugin's routes need sign-in's key and the backend: none are mounted.
    for (const path of registry.flatMap((p) => p.paths ?? [])) app.all(path, notConfigured);
    // No sign-in, no board and no admin: neither is ever served to someone not signed in.
    gates = { admin: notConfigured, board: async (req, reply) => (isBoardAsset(req.url) ? undefined : notConfigured(req, reply)) };
  }

  // The meeting desk is the board's front page (D181).
  // Every page passes the board's sign-in gate first; its scripts and styles need none.
  app.register(async (board) => {
    board.addHook('onRequest', gates.board);
    board.register(fastifyStatic, { ...pages, root: join(config.pagesDir, 'board'), index: 'board.html' });
  });
  // The admin pages sit outside the board's root, so no spelling of a path reaches them
  // except through this scope, where every request passes the signed-in gate first.
  app.register(async (admin) => {
    admin.addHook('onRequest', gates.admin);
    admin.get('/admin', async (_req, reply) => reply.redirect('/admin/'));
    admin.register(fastifyStatic, { ...pages, root: config.adminDir, prefix: '/admin/', decorateReply: false });
  });

  // Fastify's default puts error.message in the body; a server fault's text stays in the log.
  app.setErrorHandler((err: { statusCode?: number; message: string }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: err.message }, 'request failed');
      return reply.code(500).send({ error: 'internal' });
    }
    return reply.code(status).send({ error: 'bad_request' });
  });

  return app;
}

const securityHeaders = (frameAncestors: readonly string[]) => ({
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' https://appssdk.zoom.us",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    // Only Zoom may frame the board, as the backend allows: its buttons act as the person. An
    // install may add one more product (BWAT_FRAME_ANCESTORS: the board inside a plugin's product).
    ['frame-ancestors https://*.zoom.us https://*.zoom.com', ...frameAncestors].join(' '),
  ].join('; '),
  'x-content-type-options': 'nosniff',
  // A board URL can carry a meeting link.
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
});

const noCache = (res: { setHeader(name: string, value: string): unknown }) => res.setHeader('cache-control', 'no-cache');

// Fastify's default req serializer logs req.url, which on /auth/callback carries the
// authorization code and state: log the path only. Headers are never serialized; the
// redact list is a backstop should a log call ever include them.
const LOG_SERIALIZERS = {
  req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.replace(/\?.*$/s, '') }),
};
const LOG_REDACT = ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'];
