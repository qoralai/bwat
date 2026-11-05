import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { BACKEND_TIMEOUT_MS, postJson, type Backend } from '../backend.ts';
import type { AuthConfig } from '../config.ts';
import { escapeHtml, inFrame, PLUGIN_UNAVAILABLE, sendMessagePage, SESSION_ENDED } from '../pages.ts';
import { type Activator, gate } from '../plugins/activation.ts';
import type { WebAuthProvider, WebPlugin, WebPluginDeps } from '../plugins/plugin.ts';
import { pageSelection, requestSelection, withoutSurface } from '../plugins/selector.ts';
import {
  authorizationUrl,
  createPkce,
  idTokenExpiry,
  randomToken,
  tokenRequest,
  verifyIdToken,
  type GoogleEndpoints,
} from './oidc.ts';
import {
  clearLogin,
  clearSession,
  clearZoom,
  LOGIN_TTL_S,
  type PairFor,
  readLogin,
  readSession,
  readZoom,
  SESSION_TTL_MS,
  writeLogin,
  writeSession,
  writeZoom,
  type Session,
  type ZoomSignIn,
} from './session.ts';

export interface AuthOptions {
  auth: Extract<AuthConfig, { enabled: true }>;
  google: GoogleEndpoints;
  /** Google's signing keys; tests pass a local set. */
  jwks?: JWTVerifyGetKey | undefined;
  /** The backend, at BWAT_BACKEND_URL. */
  backend: Backend;
  /** Which plugins the backend runs (GET /v1/plugins). */
  activation: Activator;
  /** The web plugins this server has code for (plugins/index.ts): their sign-ins and selector tokens. */
  plugins: readonly WebPlugin[];
  /** What the plugins' sign-ins are handed (app.ts, the same object their routes get). */
  deps: WebPluginDeps;
}

// An id_token closer than this to expiry is refreshed before /whoami hands it out, so the
// page never sends the backend one that lapses mid-request.
export const REFRESH_BEFORE_MS = 5 * 60 * 1000;

/**
 * Google sign-in (D141, D180): /auth/login, /auth/callback, /auth/logout and /whoami.
 * The sealed session cookie holds the id_token and the refresh token; /whoami refreshes
 * the id_token server-side and hands the page only that. Returns the signed-in gate for
 * the admin pages: signed out goes straight to Google.
 *
 * Inside Zoom, Zoom sends its signed app context with the board's home page;
 * the backend swaps it for a board token, or for a link code when no member holds that
 * Zoom user yet, which stays in the board's sealed cookie. Then the person opens
 * /auth/zoom-link in a browser, signs in with Google, and types the pairing code it
 * shows into the board (POST /auth/zoom-pair); from then on the board signs them in.
 *
 * A web plugin may bring its own sign-in (plugins/plugin.ts), as the board inside its product
 * does. Which sign-in a request uses is chosen explicitly, before any credential is read, never
 * by which cookies happen to ride along (plugins/selector.ts): a page by its `?surface=`, a
 * request by its X-Bwat-Surface. A request that selects a plugin is answered by that plugin's
 * sign-in only, or refused (signed out: 401; the plugin off: 404; the backend's plugin list
 * unreadable: 503), never by Google or Zoom; a malformed selector is 400. A request that selects
 * none is answered by Google or Zoom and never reads a plugin's credential. Nothing inside a
 * frame that is not Zoom's is ever sent to Google (Google refuses to be framed).
 */
export interface Gates {
  /** The admin pages: a Google session. */
  admin: onRequestHookHandler;
  /** The board's pages: a Google session or a Zoom board sign-in; scripts and styles pass. */
  board: onRequestHookHandler;
}

export function registerAuth(app: FastifyInstance, { auth, google, jwks, backend, activation, plugins, deps }: AuthOptions): Gates {
  const key = auth.sessionKey;
  // Each plugin's sign-in, made once.
  const providers = new Map<string, WebAuthProvider>();
  for (const p of plugins) if (p.auth) providers.set(p.name, p.auth(deps));
  // The sign-in of the plugin a request selected, while that plugin is on; else the status to
  // refuse with (off: 404; the backend's list unreadable: 503). The one place both the board
  // gate and selectedProvider decide it, so admission and the page's sign-in always agree.
  const selectedSignIn = async (plugin: WebPlugin): Promise<{ provider: WebAuthProvider } | { refuse: 404 | 503 }> => {
    const g = await gate(activation, plugin.name);
    if ('refuse' in g) return g;
    const provider = providers.get(plugin.name);
    // validateRegistry gives every token a sign-in, and only a token selects a plugin.
    if (!provider) throw new Error(`web plugin ${plugin.name}: selected, but it has no sign-in`);
    return { provider };
  };
  const localPath = (back: unknown) => localPathFor(back, plugins);
  const secure = auth.publicUrl.startsWith('https:');
  const redirectUri = `${auth.publicUrl}/auth/callback`;
  // Caches Google's signing keys and refetches on an unknown key id (rotation).
  const googleKeys = jwks ?? createRemoteJWKSet(new URL(google.jwksUri));

  // A local install (D202) signs in with its code: /auth/login is the code form, and
  // nothing is ever sent to Google.
  const codeMode = auth.signIn === 'code';

  const startLogin = (reply: FastifyReply, back: string, pairFor?: PairFor) => {
    if (codeMode) return reply.redirect(back === '/' ? '/auth/login' : `/auth/login?back=${encodeURIComponent(back)}`);
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = createPkce();
    writeLogin(reply, key, secure, { state, nonce, verifier, back, ...(pairFor && { pairFor }), exp: Date.now() + LOGIN_TTL_S * 1000 });
    return reply.redirect(
      authorizationUrl(google.authorizationEndpoint, { clientId: auth.googleClientId, redirectUri, state, nonce, challenge }),
    );
  };

  // What this request's Zoom app context was exchanged for, read by the board gate.
  const exchanged = new WeakMap<FastifyRequest, 'token' | 'link' | 'refused' | 'unavailable'>();

  // Zoom sends the context only with the request for the board's home page.
  app.addHook('onRequest', async (req, reply) => {
    const context = req.headers[ZOOM_CONTEXT_HEADER];
    if (req.method !== 'GET' || !BOARD_PAGES.has(req.url.replace(/\?.*$/s, '')) || typeof context !== 'string' || !context) return;
    // A Zoom cookie that outlasts a failed exchange (the board gate) is an earlier open's: the meeting
    // it named may be the last one, so it is forgotten and the board waits for Zoom's own answer.
    const failed = (why: 'refused' | 'unavailable') => {
      exchanged.set(req, why);
      const kept = readZoom(req, key);
      if (kept && kept.occurrenceId) writeZoom(reply, key, secure, { ...kept, occurrenceId: null });
    };
    try {
      const { res, body } = await postJson(backend, '/v1/zoom/board-session', { context });
      // The Zoom meeting the board was opened from, for /whoami.
      const occurrenceId = typeof body.occurrence_id === 'string' ? body.occurrence_id : null;
      if (res.ok && typeof body.token === 'string') {
        writeZoom(reply, key, secure, { token: body.token, occurrenceId, exp: Date.now() + SESSION_TTL_MS });
        exchanged.set(req, 'token');
      } else if (res.ok && typeof body.link_code === 'string') {
        writeZoom(reply, key, secure, { linkCode: body.link_code, occurrenceId, exp: Date.now() + LOGIN_TTL_S * 1000 });
        exchanged.set(req, 'link');
      } else if (res.status >= 500) {
        failed('unavailable');
        req.log.warn({ status: res.status }, 'zoom app context not exchanged (backend unavailable)');
      } else {
        // Any other answer is the backend saying no: a 400 it cannot read, a 413, a 2xx with neither.
        failed('refused');
        req.log.warn({ status: res.status }, 'zoom app context refused');
      }
    } catch (err) {
      failed('unavailable');
      req.log.warn({ reason: (err as Error).message }, 'zoom app context not exchanged (backend unavailable)');
    }
  });

  // The board sends `back`, the page it was on, so a deep link survives sign-in.
  app.get('/auth/login', async (req, reply) => {
    const back = localPath((req.query as { back?: unknown }).back);
    if (!codeMode) return startLogin(reply, back);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(codePage(back));
  });

  // The code form's answer: the backend checks the code (counting a wrong one against the
  // sign-in limit) and answers a board token for the session, and the code session's refresh
  // token, kept only for signing out. Answers where to go next.
  app.post('/auth/code', { bodyLimit: 2048 }, async (req, reply) => {
    if (!codeMode) return reply.code(404).send({ error: 'not_found' });
    // Only the code page itself: JSON, which another site cannot send without a CORS preflight
    // this server never answers, and never a browser's cross-site request. Otherwise any page the
    // person has open could post wrong codes and fill the one sign-in bucket every board shares.
    const json = /^application\/json\b/i.test(req.headers['content-type'] ?? '');
    const site = req.headers['sec-fetch-site'];
    if (!json || (site !== undefined && site !== 'same-origin')) return reply.code(403).send({ error: 'forbidden' });
    const { code, email, back } = (req.body ?? {}) as { code?: unknown; email?: unknown; back?: unknown };
    let res: Response;
    try {
      res = await backend('/v1/code-signin', {
        method: 'POST',
        // From this server, so the backend counts wrong codes in one bucket for the whole board:
        // on a local install, one computer, that is the person and anyone guessing alike.
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ code, email }),
      });
    } catch (err) {
      req.log.warn({ reason: (err as Error).message }, 'code sign-in: backend unavailable');
      return reply.code(502).send({ error: 'backend_unavailable' });
    }
    const body = (await res.json().catch(() => ({}))) as { token?: unknown; refresh_token?: unknown; expires_at?: unknown; error?: unknown };
    if (!res.ok || typeof body.token !== 'string' || typeof body.refresh_token !== 'string') {
      // 401 wrong_code, 400 bad_email, 403 removed, 429 rate_limited: passed on as they are.
      const status = [400, 401, 403, 429].includes(res.status) ? res.status : 502;
      return reply.code(status).send({ error: typeof body.error === 'string' ? body.error : 'backend_unavailable' });
    }
    const lapses = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
    writeSession(reply, key, secure, {
      idToken: body.token,
      refreshToken: body.refresh_token,
      exp: Math.min(Date.now() + SESSION_TTL_MS, Number.isFinite(lapses) ? lapses : Infinity),
      kind: 'code',
    });
    return { next: localPath(back) };
  });

  app.get('/auth/zoom-link', async (_req, reply) => (codeMode ? reply.code(404).send({ error: 'not_found' }) : startLogin(reply, '/', ZOOM_PAIR)));
  // A pairing code for a switched-on plugin's product (GET /v1/plugins names them), redeemable only there.
  app.get('/auth/pair', async (req, reply) => {
    if (codeMode) return reply.code(404).send({ error: 'not_found' });
    const name = (req.query as { for?: unknown }).for;
    const a = await activation.current();
    const plugin = a.ok ? a.listed.find((p) => typeof name === 'string' && p.name === name && typeof p.display_name === 'string') : undefined;
    if (!plugin) return reply.code(404).send({ error: 'not_found' });
    return startLogin(reply, '/', { for: name as string, into: plugin.display_name as string });
  });

  // The board inside Zoom sends the code the browser showed; with the link code in its
  // cookie, the backend links the Zoom user and answers the board token.
  app.post('/auth/zoom-pair', { bodyLimit: 1024 }, async (req, reply) => {
    const zoom = readZoom(req, key);
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (!zoom || !('linkCode' in zoom)) return reply.code(401).send({ error: 'signed_out' });
    if (typeof code !== 'string' || !code) return reply.code(400).send({ error: 'wrong_code' });
    const { res, body } = await postJson(backend, '/v1/zoom/link', { link_code: zoom.linkCode, pair_code: code });
    if (res.status === 404) return reply.code(400).send({ error: 'wrong_code' });
    if (!res.ok || typeof body.token !== 'string') {
      req.log.warn({ status: res.status }, 'zoom pairing failed');
      return reply.code(502).send({ error: 'backend_unavailable' });
    }
    writeZoom(reply, key, secure, { token: body.token, occurrenceId: zoom.occurrenceId ?? null, exp: Date.now() + SESSION_TTL_MS });
    return reply.code(204).send();
  });

  app.get('/auth/callback', async (req, reply) => {
    // One login cookie serves one callback, whatever the outcome.
    const login = readLogin(req, key);
    clearLogin(reply);
    const failed = (reason: string) => {
      // The reason only: never the code, state or a token.
      req.log.warn({ reason }, 'sign-in failed');
      return reply.code(401).type('text/plain').send('Sign-in failed. Close this tab and try again.');
    };

    const { code, state } = req.query as { code?: unknown; state?: unknown };
    if (!login) return failed('no login cookie');
    if (typeof state !== 'string' || state !== login.state) return failed('state mismatch');
    if (typeof code !== 'string' || !code) return failed('no code');

    try {
      const tokens = await tokenRequest(google.tokenEndpoint, {
        grant_type: 'authorization_code',
        code,
        code_verifier: login.verifier,
        client_id: auth.googleClientId,
        client_secret: auth.googleClientSecret,
        redirect_uri: redirectUri,
      });
      await verifyIdToken(tokens.idToken, googleKeys, {
        issuers: google.issuers,
        audience: auth.googleClientId,
        nonce: login.nonce,
      });
      if (!tokens.refreshToken) return failed('no refresh token');
      writeSession(reply, key, secure, {
        idToken: tokens.idToken,
        refreshToken: tokens.refreshToken,
        exp: Date.now() + SESSION_TTL_MS,
      });
      if (login.pairFor) {
        const { res, body } = await postJson(backend, '/v1/zoom/pair', { for: login.pairFor.for }, tokens.idToken);
        if (!res.ok || typeof body.pair_code !== 'string') return failed(`POST /v1/zoom/pair answered ${res.status}`);
        return reply.type('text/html').header('cache-control', 'no-store').send(pairPage(body.pair_code, login.pairFor));
      }
    } catch (err) {
      return failed((err as Error).message);
    }
    // Never back onto a page marked for a plugin's sign-in as a page of its own (localPath drops the mark).
    return reply.redirect(localPath(login.back));
  });

  app.get('/auth/logout', async (req, reply) => {
    const session = readSession(req, key);
    // A code session ends at the backend too, so its refresh token mints nothing more.
    if (session?.kind === 'code') {
      await backend('/v1/code-signin/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      }).catch((err: Error) => req.log.warn({ reason: err.message }, 'code sign-out: backend unavailable'));
    }
    clearSession(reply);
    return reply.redirect('/auth/signed-out');
  });
  // Where signing out lands: it says so, rather than Google's account chooser (the board's gate for `/`).
  app.get('/auth/signed-out', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(SIGNED_OUT_PAGE));

  /** The session with an id_token good for at least REFRESH_BEFORE_MS, refreshed and re-sealed if needed. */
  async function freshSession(req: FastifyRequest, reply: FastifyReply): Promise<Session | null> {
    const session = readSession(req, key);
    if (!session) return null;
    // A code session's board token lasts as long as the session: nothing to refresh.
    if (session.kind === 'code') return session;
    if (idTokenExpiry(session.idToken) - Date.now() > REFRESH_BEFORE_MS) return session;
    try {
      const tokens = await tokenRequest(google.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: auth.googleClientId,
        client_secret: auth.googleClientSecret,
      });
      const renewed = { ...session, idToken: tokens.idToken, refreshToken: tokens.refreshToken ?? session.refreshToken };
      writeSession(reply, key, secure, renewed);
      return renewed;
    } catch (err) {
      // A revoked or expired grant: signed out, sign in again.
      req.log.warn({ reason: (err as Error).message }, 'token refresh failed');
      clearSession(reply);
      return null;
    }
  }

  /**
   * The plugin sign-in a request selected (X-Bwat-Surface), chosen before any credential is
   * read: null for none, or the refusal already sent (malformed 400, the plugin off 404, the
   * backend's plugin list unreadable 503). Never a fall back to Google or Zoom.
   */
  const selectedProvider = async (req: FastifyRequest, reply: FastifyReply): Promise<WebAuthProvider | null | 'refused'> => {
    const sel = requestSelection(req, plugins);
    if (sel.kind === 'none') return null;
    if (sel.kind !== 'requested') {
      await reply.code(400).send({ error: 'bad_surface' });
      return 'refused';
    }
    const s = await selectedSignIn(sel.plugin);
    if ('refuse' in s) {
      await reply.code(s.refuse).send({ error: s.refuse === 404 ? 'surface_unavailable' : 'plugins_unavailable' });
      return 'refused';
    }
    return s.provider;
  };

  // The page's identity and bearer (D180): the member from the backend's /v1/me and the
  // current id_token, which the page sends to the backend and the card service.
  // Inside Zoom the bearer is the board token instead; the backend and the card service
  // take either. `occurrence_id` is the Zoom meeting the board was opened from (null
  // outside Zoom), whichever sign-in wins, so the board opens on that meeting. A request that
  // selected a plugin's sign-in gets that sign-in's bearer and nothing else, and
  // `embedded: true` tells the page never to send it to Google; with no such credential it is
  // signed out, never the browser's Google session or Zoom sign-in, which ride along too.
  app.get('/whoami', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const provider = await selectedProvider(req, reply);
    if (provider === 'refused') return reply;
    if (provider) {
      const bearer = provider.bearer(req);
      if (!bearer) return reply.code(401).send({ error: 'signed_out' });
      return me(req, reply, bearer, null, () => provider.signOut(reply), { embedded: true });
    }
    const session = await freshSession(req, reply);
    const zoom = readZoom(req, key);
    if (!session && zoom && 'linkCode' in zoom) {
      return reply.code(401).send({ error: 'link_needed', link_url: `${auth.publicUrl}/auth/zoom-link` });
    }
    const bearer = session?.idToken ?? zoomToken(zoom);
    if (!bearer) return reply.code(401).send({ error: 'signed_out' });
    return me(req, reply, bearer, zoom?.occurrenceId ?? null, () => {
      clearSession(reply);
      clearZoom(reply);
    }, {});
  });

  /** /whoami's answer for a bearer: the member from the backend's /v1/me; a refused bearer is signed out (`signOut`). */
  async function me(
    req: FastifyRequest, reply: FastifyReply, bearer: string, occurrenceId: string | null, signOut: () => void, extra: { embedded?: true },
  ) {
    const unavailable = (reason: string) => {
      req.log.warn({ reason }, 'backend unavailable for /whoami');
      return reply.code(502).send({ error: 'backend_unavailable' });
    };
    let res: Response;
    try {
      res = await backend('/v1/me', { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' } });
    } catch (err) {
      return unavailable((err as Error).message);
    }
    // The backend refuses this person (no longer a member, say): signed out here too.
    // A refused plugin bearer ends that plugin's credential only, never the browser's Google session.
    if (res.status === 401) {
      signOut();
      return reply.code(401).send({ error: 'signed_out' });
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) return reply.code(res.status).send(body ?? { error: 'backend_unavailable' });
    if (typeof body !== 'object' || body === null) {
      return unavailable(`GET /v1/me answered ${res.status} without a member`);
    }
    return { member: body, id_token: bearer, occurrence_id: occurrenceId, ...extra };
  }

  // One meeting's transcript as a .txt download: the board's "Download transcript" link is
  // a navigation, which carries no bearer, so this reads it from the backend as the person
  // (their session, or their board token inside Zoom or a plugin's product), every page, and answers
  // text. A meeting they may not read is the backend's 404, passed on. Inside a plugin's product the
  // board fetches it with the marker and saves what it answers; the sign-in is chosen as at /whoami.
  app.get('/transcript', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { source } = req.query as { source?: unknown };
    if (typeof source !== 'string' || !UUID.test(source)) return reply.code(404).send({ error: 'not_found' });
    const provider = await selectedProvider(req, reply);
    if (provider === 'refused') return reply;
    let bearer: string | undefined;
    if (provider) {
      bearer = provider.bearer(req) ?? undefined;
    } else {
      const zoom = readZoom(req, key);
      bearer = (await freshSession(req, reply))?.idToken ?? zoomToken(zoom);
    }
    if (!bearer) return reply.code(401).send({ error: 'signed_out' });
    // The backend writes the text (GET /v1/meetings/:id/transcript.txt); this is the cookie-to-bearer step.
    const unavailable = (reason: string) => {
      req.log.warn({ reason }, 'transcript download failed');
      return reply.code(502).send({ error: 'backend_unavailable' });
    };
    // The backend's answer must start within the usual timeout; the text then streams for as
    // long as the browser takes it, and stops if the browser goes away.
    const answer = new AbortController();
    const late = setTimeout(() => answer.abort(), BACKEND_TIMEOUT_MS);
    let res: Response;
    try {
      res = await backend(`/v1/meetings/${source}/transcript.txt`, { headers: { authorization: `Bearer ${bearer}` }, signal: answer.signal });
    } catch (err) {
      return unavailable((err as Error).message);
    } finally {
      clearTimeout(late);
    }
    if (!res.ok || !res.body) {
      // Nothing of a refusal's body is passed on: let the backend's connection go.
      await res.body?.cancel();
      if (res.status === 404) return reply.code(404).send({ error: 'not_found' });
      if (res.status === 401) return reply.code(401).send({ error: 'signed_out' });
      return unavailable(`status ${res.status}`);
    }
    // Passed on as the backend writes it, never held whole here; a backend that stops mid-way
    // ends the download short.
    const expired = res.headers.get('x-transcript-expired-at');
    if (expired) reply.header('x-transcript-expired-at', expired);
    return reply
      .type('text/plain; charset=utf-8')
      .header('content-disposition', `attachment; filename="transcript-${source}.txt"`)
      .send(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream));
  });

  // Sign-in gates only: membership and roles are the backend's to enforce on every /v1
  // call, so the pages must hold nothing a signed-in non-member may not read.
  const admin: onRequestHookHandler = async (req, reply) => {
    if (!readSession(req, key)) return startLogin(reply, '/admin/');
  };
  // No board page for anyone signed out. A Zoom user no member holds yet gets the
  // linking page instead; a Zoom app context the backend refused or could not answer for, a page
  // saying so (a redirect to Google is blank inside Zoom); a frame that is not Zoom's (the board inside a plugin's product)
  // a page saying to open the board again, since Google refuses to be framed; anyone else
  // goes to Google and back to the page asked for. A page load is a navigation, which carries no
  // header: a page asks for a plugin's sign-in by its URL instead (`?surface=<its token>`, which
  // the board keeps), and that plugin's sign-in alone admits it, or it is refused (the plugin off:
  // 404; its list unreadable: 503), never Google or Zoom; an unmarked page never reads a plugin's
  // credential. The page reads the mark by the same rule (bwat-api.js), so admission and the
  // page's sign-in always agree: more than one `surface` is a 400. The gate decides only whether
  // the page loads: who it acts as is /whoami's.
  const board: onRequestHookHandler = async (req, reply) => {
    if (isBoardAsset(req.url)) return;
    const page = (status: number, text: string) => sendMessagePage(reply, status, text);
    const sel = pageSelection(req.url, plugins);
    if (sel.kind === 'ambiguous') return page(400, SURFACE_AMBIGUOUS);
    if (sel.kind === 'unknown') return page(404, SURFACE_UNAVAILABLE);
    if (sel.kind === 'requested') {
      const s = await selectedSignIn(sel.plugin);
      if ('refuse' in s) return s.refuse === 503 ? page(503, PLUGIN_UNAVAILABLE) : page(404, SURFACE_UNAVAILABLE);
      const d = s.provider.admitPage(req);
      if ('pass' in d) return;
      if ('redirect' in d) return reply.header('cache-control', 'no-store').redirect(localPath(d.redirect), 303);
      return page(d.status, d.text);
    }
    if (readSession(req, key)) return;
    const cookie = readZoom(req, key);
    const issued = cookie && ('token' in cookie ? 'token' : 'link');
    // A fresh exchange wins; a Zoom cookie bwat already issued outlasts one that failed now.
    const fresh = exchanged.get(req);
    const zoom = fresh === 'token' || fresh === 'link' ? fresh : issued || fresh;
    if (zoom === 'token') return;
    if (zoom === 'link') {
      return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(linkPage(`${auth.publicUrl}/auth/zoom-link`));
    }
    if (zoom === 'refused') return page(403, ZOOM_NOT_CONNECTED);
    if (zoom === 'unavailable') return page(503, ZOOM_UNAVAILABLE);
    if (framedOutsideZoom(req)) return page(401, SESSION_ENDED);
    return startLogin(reply, localPath(req.url));
  };
  return { admin, board };
}

// The board's scripts, styles and icon: code, never a page or data. Anything else
// under the board's root, any spelling, is a page and needs a sign-in.
const ASSET = /^\/[A-Za-z0-9._\/-]*[A-Za-z0-9_-]\.(js|css|svg)$/;
// /v1 is the edge's to route, never this server's: it stays a 404 here, signed in or not.
export const isBoardAsset = (url: string): boolean =>
  url.startsWith('/v1/') || (ASSET.test(url.replace(/\?.*$/s, '')) && !url.includes('..'));

// The board inside Zoom for a Zoom user no member holds yet: sign in with Google in the
// browser (Google refuses an embedded window), then type the code it shows here.
export const linkPage = (url: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>bwat: link your account</title></head>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:340px;margin:15vh auto;padding:0 16px;text-align:center">
<h1 style="font-size:18px;margin:0 0 8px">Link your bwat account</h1>
<p style="margin:0 0 16px">Once only: sign in with Google in your browser, then type the code it shows here.</p>
<button id="open" type="button" data-url="${escapeHtml(url)}" style="font:inherit;padding:8px 12px;cursor:pointer">Sign in with Google</button>
<form style="display:flex;gap:8px;justify-content:center;margin:16px 0 0">
<label for="code" style="position:absolute;left:-9999px">Code from your browser</label>
<input id="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" style="font:inherit;padding:8px 12px;width:9em;text-transform:uppercase;letter-spacing:1px">
<button type="submit" style="font:inherit;padding:8px 12px;cursor:pointer">Link</button></form>
<p role="status" aria-live="polite" style="margin:12px 0 0;min-height:1.5em"></p>
<script src="https://appssdk.zoom.us/sdk.min.js"></script>
<script src="/ui/link.js"></script><script src="/ui/zoom-link.js"></script></body></html>`;

/**
 * A path on this site to land on after sign-in; anything else (another site, `//host`, `/\host`)
 * is `/`. No control characters: a browser drops a tab or newline, so `/\t/host` reads as `//host`.
 */
const localPathFor = (back: unknown, plugins: readonly WebPlugin[]): string => {
  if (typeof back !== 'string' || !/^\/(?![/\\])[^\x00-\x1f\x7f]*$/.test(back)) return '/';
  return pageSelection(back, plugins).kind === 'none' ? back : withoutSurface(back);
};

// A page asking for a plugin's sign-in while that plugin is off.
const SURFACE_UNAVAILABLE = 'This board link is not valid here. Open the board again.';

/**
 * A request for a page inside a frame that is not the Zoom client's: no Zoom app context with
 * it and no Zoom user agent. Only Zoom and BWAT_FRAME_ANCESTORS may frame the board, so this is
 * the board inside a plugin's product.
 */
const framedOutsideZoom = (req: FastifyRequest) =>
  inFrame(req) && !req.headers[ZOOM_CONTEXT_HEADER] && !/zoom/i.test(req.headers['user-agent'] ?? '');

const SURFACE_AMBIGUOUS = 'This board link is not valid. Open the board again.';

// The board inside Zoom when the backend refused Zoom's app context: most often the board
// app's client secret is not the one this install holds.
const ZOOM_NOT_CONNECTED =
  "This Zoom app is not connected to this bwat. Close it and open it again. If this page comes back, ask your bwat admin to check that the board app's client secret is the one saved in bwat.";

// The board inside Zoom while the backend cannot answer for Zoom's app context (down or unreachable).
const ZOOM_UNAVAILABLE = 'bwat is unavailable right now. Close and reopen bwat in a minute.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZOOM_CONTEXT_HEADER = 'x-zoom-app-context';
// The board app's home URL is one of these.
const BOARD_PAGES = new Set(['/', '/board.html']);

// After Sign out: one card in the board's soft look (pages/board/ui/soft.css, the --sf-* tokens),
// light or dark as the browser is, with the board header's lens. Self-contained: no requests.
const LENS =
  '<svg viewBox="0 0 68.84 68.84" width="36" height="36" aria-hidden="true" focusable="false"><circle cx="34.42" cy="34.42" r="34.42" fill="#231f20"/>' +
  '<path fill="#f15a36" d="M44.56,51.63c-2.98,1.76-6.44,2.78-10.14,2.78-11.05,0-20-8.95-20-20s8.950-20,20-20,20,8.95,20,20c0,3.71-1.03,7.17-2.78,10.14l2.19,2.19c2.27-3.57,3.59-7.8,3.59-12.34,0-12.7-10.3-23-23-23s-23,10.3-23,23,10.3,23,23,23c4.54,0,8.77-1.32,12.34-3.59l-2.19-2.19Z"/>' +
  '<path fill="#fff" d="M55.54,51.3l-6.46-6.46c2.09-2.94,3.34-6.53,3.34-10.42,0-9.94-8.06-18-18-18s-18,8.06-18,18,8.06,18,18,18c3.89,0,7.48-1.24,10.42-3.34l6.46,6.46c1.17,1.17,3.07,1.17,4.24,0s1.17-3.07,0-4.24ZM34.42,48.42c-7.73,0-14-6.27-14-14s6.27-14,14-14,14,6.27,14,14-6.27,14-14,14Z"/>' +
  '<circle cx="34.42" cy="34.42" r="14" fill="#231f20"/></svg>';
// The soft card both sign-in pages share: the board's --sf-* tokens, light or dark as the browser is.
const SOFT_STYLE = `
:root{color-scheme:light dark;--sf-page:#f1f4f7;--sf-card:#fff;--sf-title:#22262e;--sf-ink:#1d2129;--sf-ink-3:#5b6270;
  --sf-accent:#2f6fed;--sf-on-accent:#fff;--sf-shadow-panel:0 1px 3px #1d212912,0 14px 44px #1d212924}
@media (prefers-color-scheme:dark){:root{--sf-page:#14161b;--sf-card:#1f232a;--sf-title:#e3e6ea;--sf-ink:#e8eaed;--sf-ink-3:#a3aab5;
  --sf-accent:#6b9bff;--sf-on-accent:#14161b;--sf-shadow-panel:0 0 0 1px #ffffff0d,0 16px 48px #0000008c}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--sf-page);color:var(--sf-ink);
  font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif}
main{width:100%;max-width:380px;padding:32px 28px 30px;border-radius:16px;background:var(--sf-card);box-shadow:var(--sf-shadow-panel);
  text-align:center;animation:in .24s ease-out}
.brand{display:inline-flex;align-items:center;gap:9px;font-size:20px;font-weight:700;letter-spacing:-.4px}
h1{margin:22px 0 6px;color:var(--sf-title);font-size:22px;font-weight:600;letter-spacing:-.3px;line-height:1.3}
p{margin:0 0 22px;color:var(--sf-ink-3);text-wrap:balance}
a{display:inline-block;padding:9px 20px;border-radius:999px;background:var(--sf-accent);color:var(--sf-on-accent);font-weight:600;text-decoration:none}
a:hover{filter:brightness(1.08)}a:focus-visible{outline:2px solid var(--sf-accent);outline-offset:3px}
@keyframes in{from{opacity:0}}
@media (prefers-reduced-motion:reduce){main{animation:none}}
`;

export const SIGNED_OUT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>bwat: signed out</title><link rel="icon" href="data:,"><style>${SOFT_STYLE}</style></head>
<body><main><div class="brand">${LENS}<span>bwat</span></div><h1>You’re signed out</h1>
<p>Sign in again to see your meetings and cards.</p><a href="/auth/login">Sign in again</a></main></body></html>`;

// The browser page after Google sign-in. The code is the backend's, letters, digits and a dash only.
const ZOOM_PAIR: PairFor = { for: 'zoom', into: 'bwat in Zoom' };

/** The board token Zoom's app context got this browser, if it got one (not a link code). */
const zoomToken = (zoom: ZoomSignIn | null) => (zoom && 'token' in zoom ? zoom.token : undefined);
const pairPage = (code: string, pairFor: PairFor) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>bwat: your code</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;text-align:center">
<h1 style="font-size:20px;margin:0 0 8px">Type this code into ${escapeHtml(pairFor.into)}</h1>
<p style="font:600 32px/1.2 ui-monospace,monospace;letter-spacing:2px;margin:16px 0">${code.replace(/[^A-Z0-9-]/g, '')}</p>
<p style="margin:0">It works once, for 10 minutes. Then you can close this tab.</p>
<p style="margin:12px 0 0"><strong>Never share this code with anyone</strong>, bwat's admins included: whoever types it in signs in as you.</p>
</body></html>`;

/**
 * A local install's sign-in (D202): the install's code and an email. Anyone with the
 * code signs in as the email they type, which the page says plainly. `back` is a local path
 * (localPathFor), escaped in the form's data-back, which the page's script (pages/board/ui/code-signin.js) reads.
 */
export const codePage = (back: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>bwat: sign in</title><link rel="icon" href="data:,"><style>${SOFT_STYLE}
form{display:grid;gap:12px;text-align:left;margin:0 0 6px}
label{display:grid;gap:4px;font-size:13px;font-weight:600;color:var(--sf-ink)}
input{font:inherit;font-weight:400;padding:9px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--sf-ink-3) 45%,transparent);
  background:var(--sf-page);color:var(--sf-ink)}
input:focus-visible{outline:2px solid var(--sf-accent);outline-offset:1px}
#code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;letter-spacing:.5px;text-transform:uppercase}
button{font:inherit;font-weight:600;padding:9px 20px;border:0;border-radius:999px;background:var(--sf-accent);color:var(--sf-on-accent);cursor:pointer}
button:hover{filter:brightness(1.08)}button:focus-visible{outline:2px solid var(--sf-accent);outline-offset:3px}
button[disabled]{opacity:.6;cursor:default}
.note{margin:0 0 18px;font-size:13px}
[role=status]{margin:10px 0 0;min-height:1.5em;font-size:13px;color:var(--sf-ink)}
</style></head>
<body><main><div class="brand">${LENS}<span>bwat</span></div><h1>Sign in</h1>
<p class="note">Type the code <code>./bwat setup</code> showed, and your email. Anyone with this code can sign in, as any email.</p>
<form novalidate data-back="${escapeHtml(back)}">
<label for="code">Install code<input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required placeholder="ABCD-EFGH-…"></label>
<label for="email">Your email<input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com"></label>
<button type="submit">Sign in</button>
</form>
<p role="status" aria-live="polite"></p></main>
<script src="/ui/code-signin.js"></script></body></html>`;
