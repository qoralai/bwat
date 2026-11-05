import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { inline } from './inline-script.ts';
import { appFor, authEnv, fakeBackend, signIn, type FakeBackend } from './fake-backend.ts';

// The admin panel as the image ships it: built now from admin/ (never a dist/ left from an
// earlier build), served by the web server, under its Content-Security-Policy.
const WEB = join(import.meta.dirname, '..');
let out: string;
let fake: FakeBackend;
let app: FastifyInstance;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'bwat-admin-'));
  await build({ configFile: join(WEB, 'vite.config.ts'), root: join(WEB, 'admin'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
  fake = await fakeBackend();
  app = appFor(fake, { env: authEnv(fake.url, { BWAT_WEB_ADMIN_DIR: out }) });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await fake?.close();
  rmSync(out, { recursive: true, force: true });
});

it('builds an admin page with no inline script, whose scripts and styles all load from this site', async () => {
  const cookie = await signIn(app, fake);
  const page = await app.inject({ method: 'GET', url: '/admin/', headers: { cookie } });
  expect(page.statusCode).toBe(200);
  expect(inline(page.body)).toEqual([]);
  const { document } = new JSDOM(page.body).window;
  const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')!);
  const styles = [...document.querySelectorAll('link[rel="stylesheet"], link[rel="modulepreload"]')].map((l) => l.getAttribute('href')!);
  expect(scripts.length).toBeGreaterThan(0);
  for (const url of [...scripts, ...styles]) {
    // script-src 'self': only this site's own files.
    expect(url, url).toMatch(/^\/admin\//);
    const res = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(res.statusCode, url).toBe(200);
    expect(res.headers['content-type'], url).toMatch(scripts.includes(url) ? /javascript/ : /css|javascript/);
    expect(res.body.length, url).toBeGreaterThan(0);
  }
});
