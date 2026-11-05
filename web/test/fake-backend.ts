import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../server/src/app.ts';
import { loadConfig } from '../server/src/config.ts';
import type { WebPlugin } from '../server/src/plugins/plugin.ts';
import { check } from './inline-script.ts';

/**
 * Google's token endpoint and the backend the web server talks to, as one fake HTTP server,
 * for the server's tests (core's and each plugin's). Names no plugin: a plugin's tests say
 * which plugins the backend lists (`state.plugins`).
 */

// Stands in for the admin panel's Vite build (web/dist/admin).
export const ADMIN_FIXTURE = join(import.meta.dirname, 'fixtures', 'admin');
export const CLIENT_ID = 'web-client.apps.googleusercontent.com';
export const AUTHORIZE = 'https://accounts.example.test/auth';
export const ISSUER = 'https://accounts.google.com';
export const MEMBER = { id: 'm-1', email: 'ada@example.com', display_name: 'Ada', role: 'owner' };
export const SESSION_KEY = Buffer.alloc(32, 7);
// The one embed ticket the fake backend knows, once.
export const TICKET = 'T'.repeat(43);
// The one meeting the fake backend holds a transcript for.
export const MEETING = '0b0c3a51-8a4e-4a57-9a5d-2f4d1c6c7e11';
// The Zoom meeting the board inside Zoom was opened from, as the backend reads it from the app context.
export const OCCURRENCE = 'occ/zoom+1==';

export interface ListedPlugin {
  name: unknown;
  display_name?: unknown;
  embeds?: unknown;
}

/** What the fake saw, and how it answers; reset before each test. */
export interface State {
  // What the fake Google token endpoint issued and was asked.
  tokenCalls: URLSearchParams[];
  issued: string[];
  nextIdToken: () => Promise<string>;
  // GET /v1/me: who asked, and how it answers (the member, a 401, or a 200 that is not JSON).
  meBearers: string[];
  meAnswer: 'member' | 'unauthorized' | 'garbage';
  // POST /v1/zoom/board-session, /v1/zoom/pair and /v1/zoom/link.
  boardSession: 'token' | 'link' | 'invalid' | 'tooLarge' | 'down' | 'unreachable';
  contexts: string[];
  pairBearers: string[];
  pairFors: unknown[];
  links: { link_code: string; pair_code: string }[];
  // GET /v1/plugins: what it lists, whether it fails (500), and how often it was asked.
  plugins: ListedPlugin[];
  pluginsDown: boolean;
  pluginsCalls: number;
  // POST /v1/plugins/<name>/embed/redeem: the tickets asked (with the plugin), failing (500), and the expiry it answers.
  redeemed: unknown[];
  redeemedBy: string[];
  redeemDown: boolean;
  redeemExpiresAt: string | null;
  // GET /v1/meetings/:id/transcript.
  transcriptCalls: { bearer: string; meeting: string; query: string }[];
}

export const PROBE_LISTED: ListedPlugin = { name: 'probe', display_name: 'Probe', embeds: false };

export function freshState(plugins: ListedPlugin[] = [PROBE_LISTED]): State {
  return {
    tokenCalls: [], issued: [], nextIdToken: async () => { throw new Error('no id_token expected'); },
    meBearers: [], meAnswer: 'member',
    boardSession: 'token', contexts: [], pairBearers: [], pairFors: [], links: [],
    plugins, pluginsDown: false, pluginsCalls: 0,
    redeemed: [], redeemedBy: [], redeemDown: false, redeemExpiresAt: null,
    transcriptCalls: [],
  };
}

export interface FakeBackend {
  url: string;
  jwks: ReturnType<typeof createLocalJWKSet>;
  state: State;
  /** A Google id_token for MEMBER, signed with the fake's key. */
  idToken(nonce: string | undefined, expiresInS: number): Promise<string>;
  close(): Promise<void>;
}

export async function fakeBackend(): Promise<FakeBackend> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] });
  const idToken = async (nonce: string | undefined, expiresInS: number) => {
    const claims: Record<string, unknown> = { email: MEMBER.email, email_verified: true };
    if (nonce) claims.nonce = nonce;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject('google-sub-1')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInS)
      .sign(pair.privateKey);
  };
  const fake = { state: freshState() } as FakeBackend;
  const server: Server = createServer((req, res) => {
    const s = fake.state;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const send = (status: number, value: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(value));
      };
      if (req.url === '/token') {
        const form = new URLSearchParams(body);
        s.tokenCalls.push(form);
        const reply: Record<string, string> = { id_token: await s.nextIdToken(), access_token: 'unused' };
        s.issued.push(reply.id_token!);
        if (form.get('grant_type') === 'authorization_code') reply.refresh_token = 'refresh-1';
        return send(200, reply);
      }
      if (req.url === '/v1/zoom/board-session') {
        s.contexts.push(JSON.parse(body).context);
        // 'unreachable': the connection drops with no answer, so the fetch itself fails.
        if (s.boardSession === 'unreachable') return res.destroy();
        const answer = {
          token: { status: 200, body: { token: 'bwz_board-token', occurrence_id: OCCURRENCE } },
          link: { status: 200, body: { link_code: 'the-link-code', occurrence_id: OCCURRENCE } },
          invalid: { status: 400, body: { error: 'invalid_context' } },
          tooLarge: { status: 413, body: { error: 'payload_too_large' } },
          down: { status: 503, body: { error: 'internal' } },
        }[s.boardSession];
        return send(answer.status, answer.body);
      }
      if (req.url === '/v1/plugins') {
        s.pluginsCalls += 1;
        if (s.pluginsDown) return send(500, { error: 'internal' });
        return send(200, { plugins: s.plugins });
      }
      if (req.url === '/v1/zoom/pair') {
        s.pairBearers.push(req.headers.authorization ?? '');
        s.pairFors.push(body ? JSON.parse(body).for : undefined);
        return send(200, { pair_code: 'ABCD-EFGH' });
      }
      const redeem = /^\/v1\/plugins\/([^/]+)\/embed\/redeem$/.exec(req.url ?? '');
      if (redeem) {
        if (s.redeemDown) return send(500, { error: 'internal' });
        const { ticket } = JSON.parse(body);
        const known = ticket === TICKET && !s.redeemed.includes(ticket);
        s.redeemed.push(ticket);
        s.redeemedBy.push(redeem[1]!);
        return send(known ? 200 : 404, known ? { token: 'bwz_embedded', ...(s.redeemExpiresAt && { expires_at: s.redeemExpiresAt }) } : { error: 'unknown_ticket' });
      }
      if (req.url === '/v1/zoom/link') {
        const { link_code, pair_code } = JSON.parse(body);
        s.links.push({ link_code, pair_code });
        const ok = link_code === 'the-link-code' && pair_code === 'ABCD-EFGH';
        return send(ok ? 200 : 404, ok ? { token: 'bwz_linked' } : { error: 'unknown_code' });
      }
      // The download: the backend's whole transcript as text (GET /v1/meetings/:id/transcript.txt).
      const download = /^\/v1\/meetings\/([^/?]+)\/transcript\.txt$/.exec(req.url ?? '');
      if (download) {
        s.transcriptCalls.push({ bearer: req.headers.authorization ?? '', meeting: download[1]!, query: '' });
        if (download[1] !== MEETING) return send(404, { error: 'not_found' });
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        return res.end('Ada: Ship it Friday.\nLin: I will file it.\nUnknown speaker: Agreed.\n');
      }
      const transcript = /^\/v1\/meetings\/([^/?]+)\/transcript\?(.*)$/.exec(req.url ?? '');
      if (transcript) {
        s.transcriptCalls.push({ bearer: req.headers.authorization ?? '', meeting: transcript[1]!, query: transcript[2]! });
        if (transcript[1] !== MEETING) return send(404, { error: 'not_found' });
        const line = (label: string | null, text: string) => ({ speaker: { label, member_id: null }, text });
        const page = new URLSearchParams(transcript[2]).get('cursor')
          ? { segments: [line(null, 'Agreed.')], next_cursor: null }
          : { segments: [line('Ada', 'Ship it Friday.'), line('Lin', 'I will file it.')], next_cursor: 'page-2' };
        return send(200, page);
      }
      if (req.url === '/v1/me') {
        s.meBearers.push(req.headers.authorization ?? '');
        if (s.meAnswer === 'garbage') return res.end('<html>proxy error</html>');
        return s.meAnswer === 'unauthorized' ? send(401, { error: 'unauthorized' }) : send(200, MEMBER);
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.jwks = jwks;
  fake.idToken = idToken;
  fake.close = () => new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
  return fake;
}

/** The sign-in env for a web server talking to `backendUrl`, plus `extra`. */
export const authEnv = (backendUrl: string, extra: Record<string, string> = {}) => ({
  BWAT_PUBLIC_URL: 'https://bwat.example.test',
  BWAT_GOOGLE_CLIENT_ID: CLIENT_ID,
  BWAT_GOOGLE_CLIENT_SECRET: 'web-secret',
  BWAT_SESSION_SECRET: SESSION_KEY.toString('base64'),
  BWAT_BACKEND_URL: backendUrl,
  BWAT_WEB_ADMIN_DIR: ADMIN_FIXTURE,
  ...extra,
});

/**
 * A web server signed in against the fake, with Google's endpoints pointed at it. Every page it
 * renders in any test is checked for an inline script, which the Content-Security-Policy would
 * refuse: one found fails the test (test/html-checks.ts), whatever the response then does
 * (csp.test.ts walks every route; this catches the pages only a flow reaches). A static file
 * streams, unread here; the walk reads those.
 */
export function appFor(fake: FakeBackend, options: { env?: Record<string, string> } & Omit<AppOptions, 'config'> = {}): FastifyInstance {
  const { env, ...rest } = options;
  const app = buildApp({
    config: loadConfig(env ?? authEnv(fake.url)),
    google: { authorizationEndpoint: AUTHORIZE, tokenEndpoint: `${fake.url}/token`, issuers: [ISSUER] },
    jwks: fake.jwks,
    ...rest,
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const html = String(reply.getHeader('content-type') ?? '').startsWith('text/html');
    if (html && (typeof payload === 'string' || Buffer.isBuffer(payload))) check(`${req.method} ${req.url}`, String(payload));
    return payload;
  });
  return app;
}

export const cookieHeader = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

/** Signs in through /admin and the callback; returns the session cookie header. */
export async function signIn(app: FastifyInstance, fake: FakeBackend, firstTokenLifetimeS = 3600): Promise<string> {
  const start = await app.inject({ method: 'GET', url: '/admin' });
  const location = new URL(start.headers.location as string);
  const nonce = location.searchParams.get('nonce')!;
  fake.state.nextIdToken = () => fake.idToken(nonce, firstTokenLifetimeS);
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/callback?code=the-code&state=${location.searchParams.get('state')}`,
    headers: { cookie: cookieHeader(start) },
  });
  expect(callback.statusCode).toBe(302);
  expect(callback.headers.location).toBe('/admin/');
  const session = callback.cookies.find((c) => c.name === 'bwat_session');
  expect(session?.value).toMatch(/^v1\./);
  return `bwat_session=${session!.value}`;
}

/** Where the probe web plugin's board scripts are (test/fixtures/plugins/probe/board/). */
export const FIXTURE_PLUGINS = join(import.meta.dirname, 'fixtures', 'plugins');

/**
 * A web plugin for core's tests, named as the fake backend's default plugin: it signs in with
 * the `x-probe-token` header's value (selected by `probe-sel`), has one route and one board script.
 */
export const PROBE_WEB: WebPlugin = {
  name: 'probe',
  token: 'probe-sel',
  auth: () => ({
    admitPage: (req) => (typeof req.headers['x-probe-token'] === 'string' ? { pass: true } : { status: 401, text: 'The probe is signed out.' }),
    bearer: (req) => {
      const token = req.headers['x-probe-token'];
      return typeof token === 'string' ? token : null;
    },
    signOut: (reply) => {
      reply.header('x-probe-signed-out', '1');
    },
  }),
  paths: ['/probe-route'],
  routes: (app) => {
    app.get('/probe-route', async () => ({ ok: true }));
  },
  boardScripts: ['probe.js'],
};
