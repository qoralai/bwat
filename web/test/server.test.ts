import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/src/app.ts';
import { frameAncestors, loadConfig, trustProxy } from '../server/src/config.ts';
import {
  ADMIN_FIXTURE, appFor, AUTHORIZE, CLIENT_ID, cookieHeader, fakeBackend, freshState, ISSUER, MEETING, MEMBER, OCCURRENCE,
  PROBE_WEB, signIn as signInTo, type FakeBackend, type State,
} from './fake-backend.ts';

let fake: FakeBackend;
// What the fake backend saw, and how it answers this test (fake-backend.ts).
let s: State;
let app: FastifyInstance;

beforeAll(async () => {
  fake = await fakeBackend();
});
afterAll(() => fake.close());

beforeEach(() => {
  s = fake.state = freshState();
  app = appFor(fake, { plugins: [PROBE_WEB] });
});

const idToken = (nonce: string | undefined, expiresInS: number) => fake.idToken(nonce, expiresInS);
/** Signs in through /admin and the callback; returns the session cookie header. */
const signIn = (firstTokenLifetimeS = 3600) => signInTo(app, fake, firstTokenLifetimeS);

describe('web server', () => {
  it('answers /health 200 with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('serves the meeting desk at /, signed in, and no classic board beside it', async () => {
    const cookie = await signIn();
    const res = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('bwat-api.js');
    expect((await app.inject({ method: 'GET', url: '/board-classic.html', headers: { cookie } })).statusCode).toBe(404);
  });

  it('never serves a board page signed out: straight to Google, back to the page after', async () => {
    for (const url of ['/', '/board.html', '/board.html?source=0b0c3a51&card=T-12',
      '//board.html', '/./board.html', '/%62oard.html', '/board.html/', '/no-such-page', '/ui/']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(302);
      expect(res.body, url).not.toContain('bwat-api.js');
      const location = new URL(res.headers.location as string);
      expect(`${location.origin}${location.pathname}`, url).toBe(AUTHORIZE);
    }
    // HEAD is refused the same way.
    expect((await app.inject({ method: 'HEAD', url: '/' })).statusCode).toBe(302);
  });

  it('lands back on the board page it was asked for after sign-in', async () => {
    const back = '/board.html?source=0b0c3a51&card=T-12';
    const start = await app.inject({ method: 'GET', url: back });
    const location = new URL(start.headers.location as string);
    s.nextIdToken = () => idToken(location.searchParams.get('nonce')!, 3600);
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${location.searchParams.get('state')}`,
      headers: { cookie: cookieHeader(start) },
    });
    expect(callback.headers.location).toBe(back);
  });

  it('serves the board scripts and styles signed out: code only, no page', async () => {
    const res = await app.inject({ method: 'GET', url: '/bwat-api.js' });
    expect(res.statusCode).toBe(200);
  });

  it('sends the Zoom-safe headers, the CSP allowing only the Zoom Apps SDK and Google Fonts', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { cookie: await signIn() } });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
    expect(csp).toContain("connect-src 'self'");
    // Only Zoom may frame the board, as the backend allows: its buttons act as the person.
    expect(csp).toContain('frame-ancestors https://*.zoom.us https://*.zoom.com');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });

  it('sends a signed-out /admin straight to Google with offline access', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(AUTHORIZE);
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe('https://bwat.example.test/auth/callback');
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toContain('consent');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('never serves the admin page signed out, whatever the path spelling', async () => {
    for (const url of ['/admin/', '/admin/index.html', '/%61dmin/', '/admin%2findex.html', '//admin/', '/./admin/']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('bwat admin');
    }
  });

  it('signs in at the callback, then /whoami answers the member and the id_token', async () => {
    const cookie = await signIn();
    expect(s.tokenCalls[0]!.get('grant_type')).toBe('authorization_code');
    expect(s.tokenCalls[0]!.get('code_verifier')).toBeTruthy();

    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.member).toEqual(MEMBER);
    expect(body.id_token).toMatch(/^ey/);
    expect(body.occurrence_id).toBeNull();
    expect(s.meBearers).toEqual([`Bearer ${body.id_token}`]);
  });

  it('signs in from the board back to the page it was on, query and all, and never to another site', async () => {
    const back = '/board.html?source=0b0c3a51&card=T-12&cols=todo';
    const start = await app.inject({ method: 'GET', url: `/auth/login?back=${encodeURIComponent(back)}` });
    expect(start.statusCode).toBe(302);
    const location = new URL(start.headers.location as string);
    s.nextIdToken = () => idToken(location.searchParams.get('nonce')!, 3600);
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${location.searchParams.get('state')}`,
      headers: { cookie: cookieHeader(start) },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(back);

    // A browser drops a tab or newline in a URL: "/\t/evil.example" is //evil.example.
    for (const elsewhere of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n\\evil.example', 'https://evil.example/', 'board.html']) {
      const other = await app.inject({ method: 'GET', url: `/auth/login?back=${encodeURIComponent(elsewhere)}` });
      const at = new URL(other.headers.location as string);
      s.nextIdToken = () => idToken(at.searchParams.get('nonce')!, 3600);
      const landed = await app.inject({
        method: 'GET',
        url: `/auth/callback?code=the-code&state=${at.searchParams.get('state')}`,
        headers: { cookie: cookieHeader(other) },
      });
      expect(landed.headers.location, elsewhere).toBe('/');
    }
  });

  it('keeps each sign-in cookie HttpOnly and Lax on its own path: the login on /auth for ten minutes, the session until it expires', async () => {
    const start = await app.inject({ method: 'GET', url: '/auth/login?back=%2F' });
    const login = start.cookies.find((c) => c.name === 'bwat_login')!;
    expect([login.path, login.maxAge, login.httpOnly, login.sameSite]).toEqual(['/auth', 600, true, 'Lax']);
    const location = new URL(start.headers.location as string);
    s.nextIdToken = () => idToken(location.searchParams.get('nonce')!, 3600);
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${location.searchParams.get('state')}`,
      headers: { cookie: cookieHeader(start) },
    });
    const session = callback.cookies.find((c) => c.name === 'bwat_session')!;
    expect([session.path, session.maxAge, session.httpOnly, session.sameSite]).toEqual(['/', undefined, true, 'Lax']);
    expect(session.expires).toBeInstanceOf(Date);
  });

  // QOR-4959: signing out says so, rather than landing on Google's account chooser.
  it('signs out to a page saying so, with a button to sign in again', async () => {
    const cookie = await signIn();
    const res = await app.inject({ method: 'GET', url: '/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/signed-out');
    expect(res.cookies.find((c) => c.name === 'bwat_session')!.value).toBe('');
    const page = await app.inject({ method: 'GET', url: '/auth/signed-out' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.body).toContain('You’re signed out');
    expect(page.body).toMatch(/<a [^>]*href="\/auth\/login"[^>]*>Sign in again<\/a>/);
    // The board's look: its lens and wordmark, the --sf-* tokens in both themes, a fade-in off under Reduce Motion.
    expect(page.body).toContain('<div class="brand"><svg');
    expect(page.body).toMatch(/@media \(prefers-color-scheme:dark\)\{:root\{--sf-page:/);
    expect(page.body).toMatch(/@media \(prefers-reduced-motion:reduce\)\{main\{animation:none\}\}/);
    // Self-contained: nothing fetched from anywhere.
    expect(page.body).not.toMatch(/(src|href)="https?:/);
  });

  it('serves /admin/ once signed in', async () => {
    const cookie = await signIn();
    const res = await app.inject({ method: 'GET', url: '/admin/', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
  });

  it('refuses a callback whose state does not match', async () => {
    const start = await app.inject({ method: 'GET', url: '/admin' });
    s.nextIdToken = () => idToken(new URL(start.headers.location as string).searchParams.get('nonce')!, 3600);
    const res = await app.inject({
      method: 'GET',
      url: '/auth/callback?code=the-code&state=wrong',
      headers: { cookie: cookieHeader(start) },
    });
    expect(res.cookies.find((c) => c.name === 'bwat_session' && c.value)).toBeUndefined();
    expect(s.tokenCalls).toHaveLength(0);
  });

  it('refuses an id_token minted for another login (nonce mismatch)', async () => {
    const start = await app.inject({ method: 'GET', url: '/admin' });
    s.nextIdToken = () => idToken('another-nonce', 3600);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const res = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${state}`,
      headers: { cookie: cookieHeader(start) },
    });
    expect(res.cookies.find((c) => c.name === 'bwat_session' && c.value)).toBeUndefined();
  });

  it('refreshes an id_token a minute from expiry exactly once, server-side', async () => {
    const cookie = await signIn(60);
    const signedInToken = s.issued[0];

    s.nextIdToken = () => idToken(undefined, 3600);
    s.tokenCalls = [];
    const refreshed = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie } });
    expect(s.tokenCalls.map((f) => f.get('grant_type'))).toEqual(['refresh_token']);
    expect(s.tokenCalls[0]!.get('refresh_token')).toBe('refresh-1');
    expect(refreshed.json().id_token).not.toBe(signedInToken);
    expect(s.meBearers).toEqual([`Bearer ${refreshed.json().id_token}`]);

    const renewed = `bwat_session=${refreshed.cookies.find((c) => c.name === 'bwat_session')!.value}`;
    const again = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: renewed } });
    expect(again.json().id_token).toBe(refreshed.json().id_token);
    expect(s.tokenCalls).toHaveLength(1);
  });

  it('answers /whoami 502 backend_unavailable when the backend cannot be reached', async () => {
    const cookie = await signIn();
    const down = buildApp({
      config: loadConfig({
        BWAT_PUBLIC_URL: 'https://bwat.example.test',
        BWAT_GOOGLE_CLIENT_ID: CLIENT_ID,
        BWAT_GOOGLE_CLIENT_SECRET: 'web-secret',
        BWAT_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64'),
        BWAT_BACKEND_URL: 'http://127.0.0.1:9',
      }),
      google: { authorizationEndpoint: AUTHORIZE, tokenEndpoint: `${fake.url}/token`, issuers: [ISSUER] },
      jwks: fake.jwks,
    });
    const res = await down.inject({ method: 'GET', url: '/whoami', headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'backend_unavailable' });
    // The transcript download too, never a 500 (QOR-5023).
    const download = await down.inject({ method: 'GET', url: `/transcript?source=${MEETING}`, headers: { cookie } });
    expect([download.statusCode, download.json()]).toEqual([502, { error: 'backend_unavailable' }]);
  });

  it('answers /whoami 502 when the backend answers something that is not a member', async () => {
    const cookie = await signIn();
    s.meAnswer = 'garbage';
    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'backend_unavailable' });
  });

  it('signs the person out when the backend refuses their token', async () => {
    const cookie = await signIn();
    s.meAnswer = 'unauthorized';
    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    const cleared = res.cookies.find((c) => c.name === 'bwat_session');
    expect(cleared?.value).toBe('');
  });

  it('answers /whoami 401 when signed out', async () => {
    const res = await app.inject({ method: 'GET', url: '/whoami' });
    expect(res.statusCode).toBe(401);
  });

  it('downloads a meeting transcript as the backend writes it, with the token of the person', async () => {
    const cookie = await signIn();
    const res = await app.inject({ method: 'GET', url: `/transcript?source=${MEETING}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="transcript-${MEETING}.txt"`);
    expect(res.body).toBe('Ada: Ship it Friday.\nLin: I will file it.\nUnknown speaker: Agreed.\n');
    // One read of the backend's text download (QOR-5023), not the paged JSON.
    expect(s.transcriptCalls.map((c) => [c.meeting, c.query])).toEqual([[MEETING, '']]);
    expect(new Set(s.transcriptCalls.map((c) => c.bearer))).toEqual(new Set([`Bearer ${s.issued[0]}`]));
  });

  it('answers a transcript download 401 signed out and 404 for a meeting the person may not read', async () => {
    expect((await app.inject({ method: 'GET', url: `/transcript?source=${MEETING}` })).statusCode).toBe(401);
    const cookie = await signIn();
    const other = '1b0c3a51-8a4e-4a57-9a5d-2f4d1c6c7e11';
    expect((await app.inject({ method: 'GET', url: `/transcript?source=${other}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/transcript?source=../me', headers: { cookie } })).statusCode).toBe(404);
    expect(s.transcriptCalls.map((c) => c.meeting)).toEqual([other]);
  });

  it('answers /version with the build it serves, and 404 when none was set', async () => {
    expect((await app.inject({ method: 'GET', url: '/version' })).statusCode).toBe(404);
    const built = buildApp({ config: loadConfig({ BWAT_WEB_ADMIN_DIR: ADMIN_FIXTURE, BWAT_VERSION: '1.4.0' }) });
    expect((await built.inject({ method: 'GET', url: '/version' })).json()).toEqual({ version: '1.4.0' });
  });

  it('proxies nothing: /v1/* is 404 on the web server, even for a browser', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/meetings', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(404);
  });

  it('keeps /health serving and never serves the board when Google sign-in is not configured', async () => {
    const bare = buildApp({ config: loadConfig({ BWAT_WEB_ADMIN_DIR: ADMIN_FIXTURE }) });
    expect((await bare.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    for (const url of ['/', '/board.html']) {
      const res = await bare.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(503);
      expect(res.body, url).not.toContain('bwat-api.js');
    }
    expect((await bare.inject({ method: 'GET', url: '/whoami' })).statusCode).toBe(503);
    expect((await bare.inject({ method: 'GET', url: '/admin' })).statusCode).toBe(503);
  });

  it('serves the board pages from web/pages: no setting moves them (QOR-5016)', () => {
    expect(loadConfig({ BWAT_WEB_PAGES_DIR: '/elsewhere' }).pagesDir).toBe(loadConfig({}).pagesDir);
  });

  describe('BWAT_FRAME_ANCESTORS (QOR-4830)', () => {
    const env = (value?: string) => ({ BWAT_WEB_ADMIN_DIR: ADMIN_FIXTURE, ...(value === undefined ? {} : { BWAT_FRAME_ANCESTORS: value }) });
    const csp = async (value?: string) =>
      String((await buildApp({ config: loadConfig(env(value)) }).inject({ method: 'GET', url: '/health' })).headers['content-security-policy']);

    it('leaves the CSP exactly as it was when unset or empty: Zoom alone frames the board', async () => {
      const before = [
        "default-src 'self'",
        "script-src 'self' https://appssdk.zoom.us",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        'frame-ancestors https://*.zoom.us https://*.zoom.com',
      ].join('; ');
      expect(await csp()).toBe(before);
      expect(await csp('')).toBe(before);
      expect(frameAncestors({})).toEqual([]);
    });

    it("adds its sources after Zoom's, on every answer", async () => {
      expect(await csp(' https://hub.example.test:4519  qv: ')).toMatch(
        /; frame-ancestors https:\/\/\*\.zoom\.us https:\/\/\*\.zoom\.com https:\/\/hub\.example\.test:4519 qv:$/,
      );
      expect(frameAncestors({ BWAT_FRAME_ANCESTORS: 'https://a.example.test https://b.example.test:* https://10.0.0.5:4519 qv:' })).toEqual([
        'https://a.example.test', 'https://b.example.test:*', 'https://10.0.0.5:4519', 'qv:',
      ]);
    });

    it('refuses anything else at start, naming the source', () => {
      for (const bad of ['http://a.example.test', 'https://a.example.test/', 'https://*.example.test', "'self'", '*', 'https:', 'data:', 'file:', 'filesystem:', 'a.example.test']) {
        expect(() => loadConfig(env(`qv: ${bad}`)), bad).toThrow(`BWAT_FRAME_ANCESTORS: ${JSON.stringify(bad)} is not`);
      }
    });
  });

    it('reads BWAT_TRUST_PROXY as the backend does, refusing a hop count at start', () => {
      for (const value of [undefined, '', 'false', ' FALSE ', '0']) expect(trustProxy({ BWAT_TRUST_PROXY: value }), String(value)).toBe(false);
      expect(trustProxy({ BWAT_TRUST_PROXY: 'true' })).toBe(true);
      expect(trustProxy({ BWAT_TRUST_PROXY: '172.16.0.0/12, 127.0.0.1' })).toEqual(['172.16.0.0/12', '127.0.0.1']);
      expect(() => loadConfig({ BWAT_TRUST_PROXY: '1' })).toThrow(/^BWAT_TRUST_PROXY must be true or proxy addresses\/CIDRs, not a hop count$/);
    });

  describe('inside Zoom', () => {
    const ZOOM = { 'x-zoom-app-context': 'sealed-by-zoom' };
    const zoomCookie = (res: { cookies: { name: string; value: string }[] }) => {
      const c = res.cookies.find((x) => x.name === 'bwat_zoom');
      expect(c?.value).toMatch(/^v1\./);
      return `bwat_zoom=${c!.value}`;
    };

    it('signs a linked Zoom user in from the app context: /whoami answers the member and the board token', async () => {
      const home = await app.inject({ method: 'GET', url: '/board.html', headers: ZOOM });
      expect(home.statusCode).toBe(200);
      expect(s.contexts).toEqual(['sealed-by-zoom']);

      const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: zoomCookie(home) } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ member: MEMBER, id_token: 'bwz_board-token', occurrence_id: OCCURRENCE });
      expect(s.meBearers).toEqual(['Bearer bwz_board-token']);
    });

    it('asks a Zoom user no member holds to link, without the link code leaving the server', async () => {
      s.boardSession = 'link';
      const home = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
      // Not signed in yet: the linking page only, never the board.
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain('Link your bwat account');
      expect(home.body).not.toContain('bwat-api.js');
      expect(home.headers['cache-control']).toBe('no-store');
      const again = await app.inject({ method: 'GET', url: '/board.html', headers: { cookie: zoomCookie(home) } });
      expect(again.body).not.toContain('bwat-api.js');
      const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: zoomCookie(home) } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'link_needed', link_url: 'https://bwat.example.test/auth/zoom-link' });
    });

    it('shows a pairing code in the browser once the person has signed in with Google', async () => {
      const start = await app.inject({ method: 'GET', url: '/auth/zoom-link' });
      expect(start.statusCode).toBe(302);
      const location = new URL(start.headers.location as string);
      expect(`${location.origin}${location.pathname}`).toBe(AUTHORIZE);
      s.nextIdToken = () => idToken(location.searchParams.get('nonce')!, 3600);

      const callback = await app.inject({
        method: 'GET',
        url: `/auth/callback?code=the-code&state=${location.searchParams.get('state')}`,
        headers: { cookie: cookieHeader(start) },
      });
      expect(callback.statusCode).toBe(200);
      expect(callback.headers['content-type']).toMatch(/^text\/html/);
      expect(callback.body).toContain('ABCD-EFGH');
      expect(callback.body).toContain('Type this code into bwat in Zoom');
      expect(callback.body).toContain('Never share this code');
      expect(callback.headers['cache-control']).toBe('no-store');
      expect(s.pairBearers).toEqual([`Bearer ${s.issued[0]}`]);
      expect(s.pairFors).toEqual(['zoom']);
      // Signing in links nothing: only the code typed into the board does.
      expect(s.links).toEqual([]);
    });

    it("shows a pairing code for a switched-on plugin's product, worded for it, minted for it (QOR-4806)", async () => {
      const start = await app.inject({ method: 'GET', url: '/auth/pair?for=probe' });
      const location = new URL(start.headers.location as string);
      s.nextIdToken = () => idToken(location.searchParams.get('nonce')!, 3600);
      const callback = await app.inject({
        method: 'GET',
        url: `/auth/callback?code=the-code&state=${location.searchParams.get('state')}`,
        headers: { cookie: cookieHeader(start) },
      });
      expect(callback.statusCode).toBe(200);
      expect(callback.body).toContain('ABCD-EFGH');
      expect(callback.body).toContain('Type this code into Probe');
      expect(callback.body).not.toContain('Zoom');
      expect(s.pairBearers).toHaveLength(1);
      expect(s.pairFors).toEqual(['probe']);
    });

    it('refuses a pairing page for a product this install does not run, before any sign-in (QOR-4806)', async () => {
      // Zoom's pairing page is /auth/zoom-link only (QOR-5023): for=zoom names no plugin.
      for (const url of ['/auth/pair?for=nope', '/auth/pair', '/auth/pair?for=probe&for=x', '/auth/pair?for=zoom']) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
      }
      expect(s.pairBearers).toEqual([]);
    });

    it('pairs the board with the typed code, and signs it in there and then', async () => {
      s.boardSession = 'link';
      const home = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
      const paired = await app.inject({
        method: 'POST',
        url: '/auth/zoom-pair',
        headers: { cookie: zoomCookie(home) },
        payload: { code: 'ABCD-EFGH' },
      });
      expect(paired.statusCode).toBe(204);
      expect(s.links).toEqual([{ link_code: 'the-link-code', pair_code: 'ABCD-EFGH' }]);

      const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: zoomCookie(paired) } });
      expect(res.json()).toEqual({ member: MEMBER, id_token: 'bwz_linked', occurrence_id: OCCURRENCE });
      expect((await app.inject({ method: 'GET', url: '/', headers: { cookie: zoomCookie(paired) } })).body).toContain('bwat-api.js');
    });

    it('names the Zoom meeting the board was opened from even when a Google session signs the person in', async () => {
      const cookie = await signIn();
      const home = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
      const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: `${cookie}; ${zoomCookie(home)}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().id_token).toMatch(/^ey/);
      expect(res.json().occurrence_id).toBe(OCCURRENCE);
    });

    it('says so when the typed code is wrong', async () => {
      s.boardSession = 'link';
      const home = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
      const res = await app.inject({
        method: 'POST',
        url: '/auth/zoom-pair',
        headers: { cookie: zoomCookie(home) },
        payload: { code: 'WRONG-ONE' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'wrong_code' });
    });

    it('never serves the board when Zoom sends a context the backend refuses', async () => {
      s.boardSession = 'invalid';
      const home = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
      // Not Google, which refuses Zoom's embedded window and leaves it blank: a page saying why.
      expect(home.statusCode).toBe(403);
      expect(home.body).toContain('not connected to this bwat');
      expect(home.body).not.toContain('bwat-api.js');
      expect(home.headers['cache-control']).toBe('no-store');
      expect(home.cookies.find((c) => c.name === 'bwat_zoom')).toBeUndefined();
    });

    it('says bwat is unavailable, never Google or the not-connected page, while the backend is down or unreachable', async () => {
      for (const answer of ['down', 'unreachable'] as const) {
        s.boardSession = answer;
        const home = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
        expect(home.statusCode, answer).toBe(503);
        expect(home.body, answer).toContain('bwat is unavailable right now');
        expect(home.body, answer).not.toContain('bwat-api.js');
        expect(home.headers['cache-control'], answer).toBe('no-store');
        expect(home.cookies.find((c) => c.name === 'bwat_zoom'), answer).toBeUndefined();
      }
    });

    it('treats a context the backend will never take (413) as refused', async () => {
      s.boardSession = 'tooLarge';
      const home = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
      expect(home.statusCode).toBe(403);
      expect(home.body).toContain('not connected to this bwat');
    });

    it('serves the board again from the Zoom cookie, without a new context', async () => {
      const home = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
      const again = await app.inject({ method: 'GET', url: '/board.html', headers: { cookie: zoomCookie(home) } });
      expect(again.statusCode).toBe(200);
    });

    it('keeps serving the board from the Zoom cookie when a later context is refused, or the backend is down or unreachable', async () => {
      for (const answer of ['invalid', 'down', 'unreachable'] as const) {
        s.boardSession = 'token';
        const home = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
        s.boardSession = answer;
        const again = await app.inject({ method: 'GET', url: '/', headers: { ...ZOOM, cookie: zoomCookie(home) } });
        expect(again.statusCode, answer).toBe(200);
        expect(again.body, answer).toContain('bwat-api.js');
      }
    });

    // A cookie kept through a failed exchange is an earlier open's; the meeting it named
    // may be the last one, so /whoami no longer names it and the board waits for Zoom's own answer.
    it('forgets the meeting an earlier open named when a later context is refused, or the backend is down or unreachable, and keeps the sign-in', async () => {
      for (const answer of ['invalid', 'down', 'unreachable'] as const) {
        s.boardSession = 'token';
        const home = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
        s.boardSession = answer;
        const again = await app.inject({ method: 'GET', url: '/', headers: { ...ZOOM, cookie: zoomCookie(home) } });
        expect(again.statusCode, answer).toBe(200);
        const who = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: zoomCookie(again) } });
        expect(who.json(), answer).toEqual({ member: MEMBER, id_token: 'bwz_board-token', occurrence_id: null });
      }
    });

    it('asks the backend nothing for a page without the context, or for any path but the board', async () => {
      await app.inject({ method: 'GET', url: '/' });
      await app.inject({ method: 'GET', url: '/health', headers: ZOOM });
      await app.inject({ method: 'GET', url: '/whoami', headers: ZOOM });
      expect(s.contexts).toEqual([]);
    });
  });
});
