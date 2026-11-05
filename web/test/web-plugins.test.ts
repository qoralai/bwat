import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/src/app.ts';
import { loadConfig } from '../server/src/config.ts';
import { activation } from '../server/src/plugins/activation.ts';
import { validateRegistry, type WebPlugin } from '../server/src/plugins/plugin.ts';
import { pageSelection, requestSelection, withoutSurface } from '../server/src/plugins/selector.ts';
import {
  ADMIN_FIXTURE, appFor, authEnv, cookieHeader, fakeBackend, FIXTURE_PLUGINS, freshState, MEETING, MEMBER, PROBE_LISTED, PROBE_WEB,
  signIn as signInTo, type FakeBackend, type State,
} from './fake-backend.ts';

// The web plugin slot: which plugins run is the backend's GET /v1/plugins, never a list of
// the web server's own; a plugin's routes and board scripts answer only while it is on.
let fake: FakeBackend;
let s: State;
let app: FastifyInstance;

beforeAll(async () => {
  fake = await fakeBackend();
});
afterAll(() => fake.close());

const env = () => authEnv(fake.url, { BWAT_WEB_PLUGINS_DIR: FIXTURE_PLUGINS });
beforeEach(() => {
  s = fake.state = freshState();
  app = appFor(fake, { env: env(), plugins: [PROBE_WEB] });
});

describe('the registry, at start', () => {
  const plugin = (p: Partial<WebPlugin>): WebPlugin => ({ name: 'probe', ...p });

  it('refuses a token that is a view, repeated, or without a sign-in; a bad name; a bad script name', () => {
    const auth = PROBE_WEB.auth!;
    for (const [label, registry] of [
      ['a view token', [plugin({ token: 'zoom', auth })]],
      ['the other view token', [plugin({ token: 'web', auth })]],
      ['a token with capitals', [plugin({ token: 'Probe', auth })]],
      ['a repeated token', [plugin({ token: 'x', auth }), plugin({ name: 'other', token: 'x', auth })]],
      ['a token without a sign-in', [plugin({ token: 'x' })]],
      ['a sign-in without a token', [plugin({ auth })]],
      ['a repeated name', [plugin({}), plugin({})]],
      ['a bad name', [plugin({ name: 'Probe' })]],
      ['a script path', [plugin({ boardScripts: ['../x.js'] })]],
      ['a script that is not .js', [plugin({ boardScripts: ['x.html'] })]],
      ['an asset path', [plugin({ assets: ['../x.js'] })]],
      ['an asset that is not .js', [plugin({ assets: ['x.html'] })]],
    ] as const) {
      expect(() => validateRegistry(registry), label).toThrow();
      expect(() => buildApp({ config: loadConfig(env()), plugins: registry }), label).toThrow();
    }
    expect(() => validateRegistry([PROBE_WEB])).not.toThrow();
  });

  it("refuses a declared path that is core's, or not a plain path", () => {
    const routes = () => {};
    for (const path of ['/whoami', '/transcript', '/health', '/version', '/board-plugins', '/admin', '/admin/x', '/auth/x', '/plugins/x', '/v1/x', '/', '/a/:id', '/board.html', 'embed']) {
      expect(() => validateRegistry([plugin({ paths: [path], routes })]), path).toThrow();
    }
  });

  it('refuses a link to a slot core does not have, or to a path the plugin does not declare', () => {
    const routes = () => {};
    const link = (slot: string, href: string) => plugin({ paths: ['/probe-page'], routes, links: [{ slot: slot as 'nav', label: 'Probe', href }] });
    expect(() => validateRegistry([link('nav', '/probe-page')])).not.toThrow();
    expect(() => validateRegistry([link('meeting', '/probe-page?meeting={meeting_id}')])).not.toThrow();
    for (const [slot, href] of [['sidebar', '/probe-page'], ['nav', '/other'], ['nav', 'https://evil.example/probe-page'], ['nav', '//evil.example/x'], ['nav', '']]) {
      expect(() => validateRegistry([link(slot!, href!)]), `${slot} ${href}`).toThrow();
    }
  });

  it('refuses at ready a route the plugin did not declare', async () => {
    const sneaky = plugin({ paths: ['/declared'], routes: (a) => { a.get('/undeclared', async () => ({})); } });
    await expect(appFor(fake, { env: env(), plugins: [sneaky] }).ready()).rejects.toThrow(/undeclared/);
  });
});

describe('which plugins are on', () => {
  it('lists only the plugins the backend runs, and every token any plugin claims', async () => {
    const on = await app.inject({ method: 'GET', url: '/board-plugins' });
    expect(on.statusCode).toBe(200);
    expect(on.headers['cache-control']).toBe('no-store');
    expect(on.json()).toEqual({ plugins: [{ name: 'probe', token: 'probe-sel', scripts: ['/plugins/probe/probe.js'] }], reserved: ['probe-sel'] });
    s.plugins = [];
    const off = await appFor(fake, { env: env(), plugins: [PROBE_WEB] }).inject({ method: 'GET', url: '/board-plugins' });
    expect(off.json()).toEqual({ plugins: [], reserved: ['probe-sel'] });
  });

  it("lists the links of the plugins on, for the board's slots (GET /board-links)", async () => {
    const linked: WebPlugin = { ...PROBE_WEB, links: [{ slot: 'meeting', label: 'Probe', href: '/probe-route?meeting={meeting_id}' }] };
    const on = await appFor(fake, { env: env(), plugins: [linked] }).inject({ method: 'GET', url: '/board-links' });
    expect([on.statusCode, on.headers['cache-control']]).toEqual([200, 'no-store']);
    expect(on.json()).toEqual({ links: [{ slot: 'meeting', label: 'Probe', href: '/probe-route?meeting={meeting_id}' }] });
    s.plugins = [];
    const off = await appFor(fake, { env: env(), plugins: [linked] }).inject({ method: 'GET', url: '/board-links' });
    expect(off.json()).toEqual({ links: [] });
  });

  it("answers 503 when the backend's list cannot be read, or there is no backend", async () => {
    s.pluginsDown = true;
    const down = await app.inject({ method: 'GET', url: '/board-plugins' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ error: 'plugins_unavailable' });
    const bare = buildApp({ config: loadConfig({ BWAT_WEB_ADMIN_DIR: ADMIN_FIXTURE, BWAT_WEB_PLUGINS_DIR: FIXTURE_PLUGINS }), plugins: [PROBE_WEB] });
    expect((await bare.inject({ method: 'GET', url: '/board-plugins' })).statusCode).toBe(503);
  });

  it('reads the list at most once in its 30 s, and never keeps a failed read', async () => {
    await app.inject({ method: 'GET', url: '/board-plugins' });
    await app.inject({ method: 'GET', url: '/plugins/probe/probe.js' });
    expect(s.pluginsCalls).toBe(1);
    const again = appFor(fake, { env: env(), plugins: [PROBE_WEB] });
    s.pluginsDown = true;
    expect((await again.inject({ method: 'GET', url: '/board-plugins' })).statusCode).toBe(503);
    s.pluginsDown = false;
    expect((await again.inject({ method: 'GET', url: '/board-plugins' })).statusCode).toBe(200);
    expect(s.pluginsCalls).toBe(3);
  });

  it('reads nothing for a request that needs no plugin', async () => {
    for (const url of ['/health', '/whoami', '/', '/bwat-api.js', '/admin']) await app.inject({ method: 'GET', url });
    expect(s.pluginsCalls).toBe(0);
  });

  it('expires a read after its time, and asks again', async () => {
    let at = 0;
    let reads = 0;
    const act = activation([PROBE_WEB], async () => {
      reads += 1;
      return new Response(JSON.stringify({ plugins: [PROBE_LISTED] }));
    }, { error() {} }, { ttlMs: 1000, now: () => at });
    expect((await act.current()).ok).toBe(true);
    at = 999;
    await act.current();
    expect(reads).toBe(1);
    at = 1000;
    await act.current();
    expect(reads).toBe(2);
  });

  it('leaves off, with one error logged, code that does not fit what the backend says', async () => {
    const errors: unknown[] = [];
    const embedding: WebPlugin = { ...PROBE_WEB, requires: { embeds: true } };
    let answer = { plugins: [PROBE_LISTED] } as unknown;
    const act = activation([embedding], async () => new Response(JSON.stringify(answer)), { error: (o) => errors.push(o) }, { ttlMs: 0 });
    for (let i = 0; i < 3; i++) {
      const a = await act.current();
      expect(a.ok && a.on.size).toBe(0);
    }
    expect(errors).toHaveLength(1);
    // A listed plugin that embeds the board, with no code here: an error too, and nothing on.
    answer = { plugins: [{ name: 'elsewhere', embeds: true }] };
    expect(await act.current()).toMatchObject({ ok: true });
    expect(errors).toHaveLength(2);
    // What the backend lists must be names: anything else is an unreadable list.
    for (const bad of [{ plugins: [{ display_name: 'x' }] }, { plugins: 'probe' }, {}, null]) {
      answer = bad;
      expect((await act.current()).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("a plugin's routes and board scripts", () => {
  it('answer while it is on', async () => {
    expect((await app.inject({ method: 'GET', url: '/probe-route' })).json()).toEqual({ ok: true });
    const script = await app.inject({ method: 'GET', url: '/plugins/probe/probe.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect(script.body).toContain('probe plugin');
  });

  it('are 404 while it is off', async () => {
    s.plugins = [];
    expect((await app.inject({ method: 'GET', url: '/probe-route' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/plugins/probe/probe.js' })).statusCode).toBe(404);
  });

  it("are refused while the backend's list cannot be read: a page for the route (502), 503 for a script", async () => {
    s.pluginsDown = true;
    const route = await app.inject({ method: 'GET', url: '/probe-route' });
    expect(route.statusCode).toBe(502);
    expect(route.headers['content-type']).toMatch(/^text\/html/);
    expect(route.body).toContain('Open the board again.');
    expect((await app.inject({ method: 'GET', url: '/plugins/probe/probe.js' })).statusCode).toBe(503);
  });

  it('serve only the scripts it lists, by no other spelling', async () => {
    for (const url of ['/plugins/probe/other.js', '/plugins/probe/', '/plugins/probe/..%2fprobe%2fother.js', '/plugins/probe/sub/../other.js',
      '/plugins/probe/probe.js/', '/plugins/probe//probe.js', '/plugins/nobody/probe.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('probe plugin');
    }
  });

  // A page of the plugin's own loads its script from here too, but the board never does.
  it('serve the files it lists as its own assets, never loaded into the board, only while it is on', async () => {
    const assetsOnly: WebPlugin = { ...PROBE_WEB, assets: ['other.js'] };
    delete assetsOnly.boardScripts;
    for (const plugin of [{ ...PROBE_WEB, assets: ['other.js'] }, assetsOnly]) {
      s.plugins = [PROBE_LISTED];
      const withAsset = appFor(fake, { env: env(), plugins: [plugin] });
      const asset = await withAsset.inject({ method: 'GET', url: '/plugins/probe/other.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toMatch(/javascript/);
      const listed = (await withAsset.inject({ method: 'GET', url: '/board-plugins' })).json().plugins;
      expect(listed).toEqual([{ name: 'probe', token: 'probe-sel', scripts: (plugin.boardScripts ?? []).map((f) => `/plugins/probe/${f}`) }]);
      s.plugins = [];
      const off = appFor(fake, { env: env(), plugins: [plugin] });
      expect((await off.inject({ method: 'GET', url: '/plugins/probe/other.js' })).statusCode).toBe(404);
    }
  });

  it('are 503 sign_in_not_configured without sign-in, as /whoami is', async () => {
    const bare = buildApp({ config: loadConfig({ BWAT_WEB_ADMIN_DIR: ADMIN_FIXTURE, BWAT_WEB_PLUGINS_DIR: FIXTURE_PLUGINS }), plugins: [PROBE_WEB] });
    expect((await bare.inject({ method: 'GET', url: '/probe-route' })).statusCode).toBe(503);
    expect((await bare.inject({ method: 'GET', url: '/plugins/probe/probe.js' })).statusCode).toBe(503);
  });
});

describe('the selector', () => {
  const registry = [PROBE_WEB];
  const req = (headers: Record<string, string | string[]>) => ({ headers }) as never;

  it('reads a page URL: one claimed token requests it; views and none are none; any other value is unknown; two are ambiguous', () => {
    expect(pageSelection('/?surface=probe-sel', registry)).toEqual({ kind: 'requested', plugin: PROBE_WEB });
    expect(pageSelection('/board.html?a=1&surface=probe-sel#x', registry).kind).toBe('requested');
    for (const url of ['/', '/?surface=zoom', '/?surface=web', '/?x=surface']) {
      expect(pageSelection(url, registry), url).toEqual({ kind: 'none' });
    }
    // A plugin whose web code is not here (or no such plugin) is never the ordinary sign-in.
    for (const url of ['/?surface=other', '/?surface=', '/?surface=probe-sel']) {
      expect(pageSelection(url, url.endsWith('probe-sel') ? [] : registry), url).toEqual({ kind: 'unknown' });
    }
    for (const url of ['/?surface=probe-sel&surface=probe-sel', '/?surface=zoom&surface=web']) {
      expect(pageSelection(url, registry).kind, url).toBe('ambiguous');
    }
  });

  it('reads the header strictly: absent is none, exactly a claimed token requests it, anything else is malformed', () => {
    expect(requestSelection(req({}), registry)).toEqual({ kind: 'none' });
    expect(requestSelection(req({ 'x-bwat-surface': 'probe-sel' }), registry).kind).toBe('requested');
    for (const value of ['zoom', 'web', 'other', '', 'probe-sel, probe-sel', 'PROBE-SEL', ' probe-sel']) {
      expect(requestSelection(req({ 'x-bwat-surface': value }), registry).kind, value).toBe('malformed');
    }
    expect(requestSelection(req({ 'x-bwat-surface': ['probe-sel', 'probe-sel'] }), registry).kind).toBe('malformed');
  });

  it('drops every surface from a path, keeping the rest', () => {
    expect(withoutSurface('/board.html?a=1&surface=x&b=2#f')).toBe('/board.html?a=1&b=2#f');
    expect(withoutSurface('/?surface=x')).toBe('/');
    expect(withoutSurface('/plain')).toBe('/plain');
  });
});

// Core keeps identity selection: it picks one sign-in, or none, before reading any credential;
// a selected plugin's sign-in answers alone or the request is refused, never Google or Zoom.
describe("a plugin's sign-in, chosen by its selector", () => {
  const signIn = () => signInTo(app, fake);
  const PROBE = { 'x-bwat-surface': 'probe-sel', 'x-probe-token': 'bwz_probe' };

  it('is never read, nor the plugin list asked, for a request with no selector', async () => {
    const cookie = await signIn();
    s.pluginsCalls = 0;
    const who = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie, 'x-probe-token': 'bwz_probe' } });
    expect(who.json().id_token).toMatch(/^ey/);
    expect(who.json().embedded).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: `/transcript?source=${MEETING}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/', headers: { cookie } })).statusCode).toBe(200);
    expect(s.meBearers.some((b) => b === 'Bearer bwz_probe')).toBe(false);
    expect(s.pluginsCalls).toBe(0);
  });

  it("answers a selected request with the plugin's bearer only, and the page with its admission", async () => {
    const cookie = await signIn();
    s.meBearers = [];
    const who = await app.inject({ method: 'GET', url: '/whoami', headers: { ...PROBE, cookie } });
    expect(who.json()).toEqual({ member: MEMBER, id_token: 'bwz_probe', occurrence_id: null, embedded: true });
    expect(s.meBearers).toEqual(['Bearer bwz_probe']);
    expect((await app.inject({ method: 'GET', url: `/transcript?source=${MEETING}`, headers: { ...PROBE, cookie } })).statusCode).toBe(200);
    expect(new Set(s.transcriptCalls.map((c) => c.bearer))).toEqual(new Set(['Bearer bwz_probe']));
    // Signed out of the plugin: 401, never the Google session beside it.
    const out = await app.inject({ method: 'GET', url: '/whoami', headers: { 'x-bwat-surface': 'probe-sel', cookie } });
    expect(out.statusCode).toBe(401);
    expect(out.json()).toEqual({ error: 'signed_out' });
    const transcript = await app.inject({ method: 'GET', url: `/transcript?source=${MEETING}`, headers: { 'x-bwat-surface': 'probe-sel', cookie } });
    expect(transcript.statusCode).toBe(401);
    // A page: the plugin admits it or answers it; Google never does.
    expect((await app.inject({ method: 'GET', url: '/?surface=probe-sel', headers: { 'x-probe-token': 'x' } })).statusCode).toBe(200);
    const page = await app.inject({ method: 'GET', url: '/?surface=probe-sel', headers: { cookie } });
    expect(page.statusCode).toBe(401);
    expect(page.body).toContain('The probe is signed out.');
    expect(page.headers.location).toBeUndefined();
  });

  it("ends only the plugin's credential when the backend refuses its bearer", async () => {
    const cookie = await signIn();
    s.meAnswer = 'unauthorized';
    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { ...PROBE, cookie } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-probe-signed-out']).toBe('1');
    expect(([res.headers['set-cookie'] ?? []].flat() as string[]).some((c) => c.startsWith('bwat_session='))).toBe(false);
  });

  it('refuses a malformed selector (400) before any credential is read', async () => {
    const cookie = await signIn();
    s.meBearers = [];
    s.tokenCalls = [];
    for (const value of ['other', 'zoom', 'web', '', 'probe-sel, probe-sel']) {
      for (const url of ['/whoami', `/transcript?source=${MEETING}`]) {
        const res = await app.inject({ method: 'GET', url, headers: { 'x-bwat-surface': value, 'x-probe-token': 'bwz_probe', cookie } });
        expect(res.statusCode, `${url} ${value}`).toBe(400);
        expect(res.json(), `${url} ${value}`).toEqual({ error: 'bad_surface' });
      }
    }
    expect(s.meBearers).toEqual([]);
    expect(s.tokenCalls).toEqual([]);
    expect(s.transcriptCalls).toEqual([]);
  });

  it('refuses a selected plugin that is off (404), never answering as Google', async () => {
    const cookie = await signIn();
    s.plugins = [];
    const off = appFor(fake, { env: env(), plugins: [PROBE_WEB] });
    s.meBearers = [];
    for (const url of ['/whoami', `/transcript?source=${MEETING}`]) {
      const res = await off.inject({ method: 'GET', url, headers: { ...PROBE, cookie } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'surface_unavailable' });
    }
    for (const headers of [{ cookie, 'x-probe-token': 'x' }, { cookie, 'sec-fetch-dest': 'iframe' }, {}]) {
      const page = await off.inject({ method: 'GET', url: '/board.html?surface=probe-sel', headers });
      expect(page.statusCode).toBe(404);
      expect(page.body).toContain('This board link is not valid here.');
      expect(page.body).not.toContain('bwat-api.js');
      expect(page.headers.location).toBeUndefined();
    }
    expect(s.meBearers).toEqual([]);
    expect(s.transcriptCalls).toEqual([]);
    // Without the selector, the same browser is still its Google person.
    expect((await off.inject({ method: 'GET', url: '/whoami', headers: { cookie } })).statusCode).toBe(200);
  });

  it('refuses a selector whose plugin has no web code here (404), never answering as Google', async () => {
    const cookie = await signIn();
    const bare = appFor(fake, { env: env(), plugins: [] });
    s.meBearers = [];
    for (const url of ['/?surface=probe-sel', '/board.html?surface=probe-sel', '/?surface=retired', '/?surface=']) {
      const page = await bare.inject({ method: 'GET', url, headers: { cookie } });
      expect(page.statusCode, url).toBe(404);
      expect(page.body, url).toContain('This board link is not valid here.');
      expect(page.body, url).not.toContain('bwat-api.js');
      expect(page.headers.location, url).toBeUndefined();
    }
    const who = await bare.inject({ method: 'GET', url: '/whoami', headers: { cookie, 'x-bwat-surface': 'probe-sel' } });
    expect(who.statusCode).toBe(400);
    expect(s.meBearers).toEqual([]);
    // Without the selector, the same browser is still its Google person.
    expect((await bare.inject({ method: 'GET', url: '/', headers: { cookie } })).statusCode).toBe(200);
  });

  it("refuses a selected plugin while the backend's list cannot be read (503); no selector still signs in", async () => {
    const cookie = await signIn();
    s.pluginsDown = true;
    s.meBearers = [];
    for (const url of ['/whoami', `/transcript?source=${MEETING}`]) {
      const res = await app.inject({ method: 'GET', url, headers: { ...PROBE, cookie } });
      expect(res.statusCode, url).toBe(503);
      expect(res.json(), url).toEqual({ error: 'plugins_unavailable' });
    }
    const page = await app.inject({ method: 'GET', url: '/?surface=probe-sel', headers: { cookie, 'x-probe-token': 'x' } });
    expect(page.statusCode).toBe(503);
    expect(page.body).toContain('Open the board again.');
    expect(s.meBearers).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/whoami', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/', headers: { cookie } })).statusCode).toBe(200);
  });

  it('reads the plugin list at most once in its 30 s for selected requests', async () => {
    for (let i = 0; i < 3; i++) await app.inject({ method: 'GET', url: '/whoami', headers: PROBE });
    expect(s.pluginsCalls).toBe(1);
  });

  it("never signs in back onto a page selecting a plugin, on or off; the board's own views are kept", async () => {
    for (const [back, plain] of [
      ['/?surface=probe-sel', '/'],
      ['/board.html?surface=probe-sel&card=T-1', '/board.html?card=T-1'],
      ['/?surface=web&surface=probe-sel', '/'],
      ['/board.html?surface=zoom&cols=todo', '/board.html?surface=zoom&cols=todo'],
      ['/board.html?surface=other', '/board.html'],
    ] as const) {
      const start = await app.inject({ method: 'GET', url: `/auth/login?back=${encodeURIComponent(back)}` });
      const at = new URL(start.headers.location as string);
      s.nextIdToken = () => fake.idToken(at.searchParams.get('nonce')!, 3600);
      const landed = await app.inject({
        method: 'GET', url: `/auth/callback?code=the-code&state=${at.searchParams.get('state')}`, headers: { cookie: cookieHeader(start) },
      });
      expect(landed.headers.location, back).toBe(plain);
    }
  });
});
