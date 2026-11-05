import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../server/src/app.ts';
import { loadConfig } from '../server/src/config.ts';
import { ADMIN_FIXTURE } from './fake-backend.ts';

/**
 * A local install's board sign-in (QOR-5007, D202): the install's code and an email, checked by
 * the backend's POST /v1/code-signin, never Google.
 */
const MEMBER = { id: 'm-1', email: 'owner@home.example', display_name: null, role: 'owner' };
const TOKEN = 'bwz_board-token';
const REFRESH = 'bwr_refresh-token';

let backend: Server;
let backendUrl: string;
// What the fake backend saw, and how it answers.
let seen: { path: string; body: unknown; authorization?: string | undefined }[];
let codeAnswer: { status: number; body: unknown };

beforeAll(async () => {
  backend = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ path: req.url ?? '', body, authorization: req.headers.authorization });
      const send = (status: number, value?: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (req.url === '/v1/code-signin') return send(codeAnswer.status, codeAnswer.body);
      if (req.url === '/v1/code-signin/sign-out') return send(204);
      if (req.url === '/v1/me') return req.headers.authorization === `Bearer ${TOKEN}` ? send(200, MEMBER) : send(401, { error: 'unauthorized' });
      if (req.url === '/v1/plugins') return send(200, { plugins: [] });
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((done) => backend.listen(0, '127.0.0.1', done));
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => backend.close(() => done())));

const local = (extra: Record<string, string> = {}) =>
  loadConfig({
    BWAT_WEB_ADMIN_DIR: ADMIN_FIXTURE,
    BWAT_TIER: 'local',
    BWAT_PUBLIC_URL: 'http://127.0.0.1:8080',
    BWAT_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64'),
    BWAT_BACKEND_URL: backendUrl,
    ...extra,
  });

let app: FastifyInstance;
beforeEach(() => {
  seen = [];
  codeAnswer = { status: 200, body: { token: TOKEN, refresh_token: REFRESH, expires_at: new Date(Date.now() + 3_600_000).toISOString(), member: MEMBER } };
  app = buildApp({ config: local() });
});

const signIn = (payload: object) => app.inject({ method: 'POST', url: '/auth/code', payload });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

describe('the board on a local install signs in with the install code (QOR-5007)', () => {
  it('turns sign-in on without any Google variable, keyed on the tier', () => {
    const config = local();
    expect(config.auth).toMatchObject({ enabled: true, signIn: 'code', googleClientId: '' });
    // A team install missing Google stays off, never quietly a code install.
    const team = loadConfig({ BWAT_TIER: 'team', BWAT_PUBLIC_URL: 'http://x', BWAT_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64'), BWAT_BACKEND_URL: backendUrl });
    expect(team.auth.enabled).toBe(false);
  });

  it('reads t0, the tier\'s name before QOR-5117, as local', () => {
    expect(local({ BWAT_TIER: 't0' }).auth).toMatchObject({ enabled: true, signIn: 'code' });
  });

  it('sends a signed-out board to the code form, never Google, and keeps the page asked for', async () => {
    const res = await app.inject({ method: 'GET', url: '/board.html' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/login?back=%2Fboard.html');
    const form = await app.inject({ method: 'GET', url: res.headers.location as string });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('Install code');
    expect(form.body).toContain('Anyone with this code can sign in, as any email.');
    expect(form.body).toContain('data-back="/board.html"');
    expect(form.body).not.toContain('google');
  });

  it('signs in with the code and an email, then /whoami answers the member and the board token', async () => {
    const res = await signIn({ code: 'abcd-efgh', email: 'Owner@Home.Example', back: '/board.html' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: '/board.html' });
    expect(seen.find((r) => r.path === '/v1/code-signin')?.body).toEqual({ code: 'abcd-efgh', email: 'Owner@Home.Example' });
    const who = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: cookieOf(res) } });
    expect(who.statusCode).toBe(200);
    expect(who.json()).toMatchObject({ member: MEMBER, id_token: TOKEN });
    // The refresh token stays in the sealed cookie: never handed to the page.
    expect(who.body).not.toContain(REFRESH);
    expect((await app.inject({ method: 'GET', url: '/', headers: { cookie: cookieOf(res) } })).statusCode).toBe(200);
  });

  it('never goes back to another site after sign-in', async () => {
    expect((await signIn({ code: 'x', email: 'a@b.example', back: '//evil.example/' })).json()).toEqual({ next: '/' });
  });

  it("passes on the backend's refusals: wrong code, bad email, removed, too many tries", async () => {
    for (const [status, error] of [[401, 'wrong_code'], [400, 'bad_email'], [403, 'removed'], [429, 'rate_limited']] as const) {
      codeAnswer = { status, body: { error } };
      const res = await signIn({ code: 'x', email: 'a@b.example' });
      expect(res.statusCode, error).toBe(status);
      expect(res.json()).toEqual({ error });
      expect(res.cookies).toEqual([]);
    }
    codeAnswer = { status: 500, body: { error: 'internal' } };
    expect((await signIn({ code: 'x', email: 'a@b.example' })).statusCode).toBe(502);
  });

  it("refuses another site's post, and anything but JSON, before the backend counts a try", async () => {
    const forms = await app.inject({ method: 'POST', url: '/auth/code', headers: { 'content-type': 'text/plain' }, payload: 'code=x&email=a@b.example' });
    expect(forms.statusCode).toBe(403);
    const crossSite = await app.inject({ method: 'POST', url: '/auth/code', headers: { 'sec-fetch-site': 'cross-site' }, payload: { code: 'x', email: 'a@b.example' } });
    expect(crossSite.statusCode).toBe(403);
    expect(seen.filter((r) => r.path === '/v1/code-signin')).toEqual([]);
    const own = await app.inject({ method: 'POST', url: '/auth/code', headers: { 'sec-fetch-site': 'same-origin' }, payload: { code: 'x', email: 'a@b.example' } });
    expect(own.statusCode).toBe(200);
  });

  it('ends the code session at the backend on sign-out', async () => {
    const cookie = cookieOf(await signIn({ code: 'x', email: 'a@b.example' }));
    const out = await app.inject({ method: 'GET', url: '/auth/logout', headers: { cookie } });
    expect(out.headers.location).toBe('/auth/signed-out');
    expect(seen.find((r) => r.path === '/v1/code-signin/sign-out')?.body).toEqual({ refresh_token: REFRESH });
  });

  it('has no Google pairing links on a code install', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/zoom-link' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/pair?for=zoom' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/callback' })).statusCode).toBe(401);
  });
});

describe('the code exchange on a Google install', () => {
  it('is not there', async () => {
    const google = buildApp({
      config: loadConfig({
        BWAT_WEB_ADMIN_DIR: ADMIN_FIXTURE,
        BWAT_PUBLIC_URL: 'https://bwat.example.test',
        BWAT_GOOGLE_CLIENT_ID: 'web.example',
        BWAT_GOOGLE_CLIENT_SECRET: 'secret',
        BWAT_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64'),
        BWAT_BACKEND_URL: backendUrl,
      }),
    });
    expect((await google.inject({ method: 'POST', url: '/auth/code', payload: { code: 'x', email: 'a@b.example' } })).statusCode).toBe(404);
  });
});
