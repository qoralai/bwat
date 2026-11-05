import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { codePage, linkPage as linkPageFor } from '../server/src/auth/routes.ts';
import { WEB_PLUGINS } from '../server/src/plugins/index.ts';
import { ORIGIN, Pages, until } from './board-harness.ts';
import { check, inline } from './inline-script.ts';
import { appFor, authEnv, fakeBackend, freshState, signIn, type FakeBackend } from './fake-backend.ts';

// No page the web server serves runs a script written into it: script-src allows this origin
// and the Zoom Apps SDK only, so an injected <script> or on*= handler never runs.
const ZOOM = { 'x-zoom-app-context': 'sealed-by-zoom' };
// The Zoom app context's answers that a page shows for (fake-backend.ts boardSession).
const ZOOM_STATES = ['link', 'invalid', 'down', 'unreachable'] as const;
// Every web plugin on, as the backend lists them.
const ALL_ON = () => freshState(WEB_PLUGINS.map((p) => ({ name: p.name, display_name: p.name, embeds: !!p.requires?.embeds })));

let fake: FakeBackend;
// A Google install and a code install, each with every web plugin.
let app: FastifyInstance;
let code: FastifyInstance;

beforeAll(async () => {
  fake = await fakeBackend();
  app = appFor(fake);
  code = appFor(fake, { env: { ...authEnv(fake.url), BWAT_TIER: 'local', BWAT_GOOGLE_CLIENT_ID: '', BWAT_GOOGLE_CLIENT_SECRET: '' } });
});
afterAll(async () => {
  await Promise.all([app.close(), code.close()]);
  await fake.close();
});
beforeEach(() => {
  fake.state = ALL_ON();
});

const linkPage = async () => {
  fake.state.boardSession = 'link';
  const res = await app.inject({ method: 'GET', url: '/', headers: ZOOM });
  expect(res.body).toContain('Link your bwat account');
  return res.body;
};

describe("the web server's Content-Security-Policy", () => {
  it("allows scripts from this origin and the Zoom Apps SDK only, never 'unsafe-inline'", async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const scriptSrc = String(res.headers['content-security-policy']).split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toBe("script-src 'self' https://appssdk.zoom.us");
  });

  // Every GET route the server has (read from the server itself, so a new page is walked too),
  // with every plugin on, on a Google install and a code install, asked signed out, signed in and
  // from inside Zoom in each state the backend can answer: every answer that is HTML is checked.
  it('serves no page, on any route, that needs an inline script to work', async () => {
    const cookie = await signIn(app, fake);
    const seen = new Map<string, string>();
    for (const server of [app, code]) {
      for (const url of await getUrls(server)) {
        for (const asked of [url, url + (url.includes('?') ? '&' : '?') + 'surface=nope']) {
          const asks: [string, Record<string, string>][] = [['signed out', {}], ['signed in', { cookie }], ...ZOOM_STATES.map((z) => [`Zoom ${z}`, ZOOM] as [string, Record<string, string>])];
          for (const [who, headers] of asks) {
            if (who.startsWith('Zoom ')) fake.state.boardSession = who.slice(5) as (typeof ZOOM_STATES)[number];
            const res = await server.inject({ method: 'GET', url: asked, headers });
            fake.state.boardSession = 'token';
            // Every answer is one the server meant, never its error handler's 500: a page, or what
            // it answers for something that is not one (a redirect, a JSON answer, a refusal).
            const where = `${asked}, ${who}`;
            expect(res.statusCode, where).not.toBe(500);
            if (String(res.headers['content-type']).startsWith('text/html')) seen.set(where, res.body);
            else expect([200, 302, 303, 401, 404], where).toContain(res.statusCode);
          }
        }
      }
    }
    // The pages a person meets, each reached by the walk: the board, the admin, the code sign-in,
    // the Zoom link page, signed out, and a page that says why it cannot open.
    const bodies = [...seen.values()];
    for (const page of ['bwat-api.js', 'bwat admin', 'Install code', 'Link your bwat account', 'signed out', 'role="status"']) {
      expect(bodies.some((b) => b.includes(page)), page).toBe(true);
    }
    for (const [asked, html] of seen) check(asked, html);
  });

  it("serves the pages' scripts from the board's own static files, as its other scripts, signed out", async () => {
    const board = await app.inject({ method: 'GET', url: '/bwat-api.js' });
    for (const url of ['/ui/link.js', '/ui/code-signin.js', '/ui/zoom-link.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toBe(board.headers['content-type']);
      expect(res.headers['cache-control'], url).toBe(board.headers['cache-control']);
    }
  });
});

/**
 * Every GET path the server routes, from its own route tree. A wildcard stands for the files
 * under it: at the root, each board page (and one that is not there); elsewhere, its index.
 */
async function getUrls(server: FastifyInstance): Promise<string[]> {
  await server.ready();
  const paths: string[] = [], stack: string[] = [];
  for (const line of server.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^((?:│ {3}| {4})*)[├└]── (\S+) \(([A-Z, ]+)\)$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4, path = (stack[depth - 1] ?? '') + m[2];
    stack[depth] = path;
    if (m[3]!.split(', ').includes('GET')) paths.push(path);
  }
  const pages = readdirSync(join(import.meta.dirname, '..', 'pages', 'board')).filter((f) => f.endsWith('.html'));
  return paths.flatMap((p) => {
    const path = p.replace(/:[^/]+/g, 'x');
    if (!path.endsWith('*')) return [path];
    const base = path.slice(0, -1).replace(/\/?$/, '/');
    return base === '/' ? ['/', ...pages.map((f) => '/' + f), '/no-such-page'] : [base];
  });
}

/**
 * A page as a browser runs it, its scripts loaded from this site's files; `fetch` answers its
 * requests. Quiet: jsdom only logs the navigation a signed-in page then makes.
 */
async function run(html: string, path: string, fetch: (input: string, init?: RequestInit) => Promise<Response>) {
  const dom = new JSDOM(html, {
    url: ORIGIN + path, runScripts: 'dangerously', resources: new Pages(), virtualConsole: new VirtualConsole(),
    beforeParse(window) { (window as unknown as { fetch: typeof fetch }).fetch = fetch; },
  });
  await new Promise<void>((resolve) => dom.window.addEventListener('load', () => resolve()));
  return dom;
}
const status = (dom: JSDOM) => dom.window.document.querySelector('[role=status]')!.textContent!;

describe('the code sign-in page', () => {
  const signIn = (dom: JSDOM) => {
    const { document } = dom.window;
    (document.getElementById('code') as HTMLInputElement).value = ' abcd-efgh ';
    (document.getElementById('email') as HTMLInputElement).value = 'ada@example.com';
    document.querySelector('form')!.requestSubmit();
  };

  it('posts the code, the email and the page to go back to', async () => {
    const posted: unknown[] = [];
    const dom = await run(codePage('/board.html?source=m-1'), '/auth/login', async (_input, init) => {
      posted.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ next: '/board.html?source=m-1' }), { status: 200 });
    });
    signIn(dom);
    await until(() => posted.length > 0);
    expect(posted).toEqual([{ code: 'abcd-efgh', email: 'ada@example.com', back: '/board.html?source=m-1' }]);
  });

  it('keeps a page to go back to as text, never as markup', async () => {
    const back = '/"><script>alert(1)</script>';
    const html = codePage(back);
    expect(html).toContain('data-back="/&#34;&#62;&#60;script&#62;alert(1)&#60;/script&#62;"');
    const dom = await run(html, '/auth/login', async () => new Response('{}'));
    expect(dom.window.document.querySelector('form')!.dataset.back).toBe(back);
    expect(inline(html)).toEqual([]);
  });

  it('says a wrong code in words', async () => {
    const dom = await run(codePage('/'), '/auth/login', async () => new Response('{}', { status: 401 }));
    signIn(dom);
    await until(() => status(dom) !== 'Signing in…' && status(dom) !== '');
    expect(status(dom)).toBe("That code didn't work. Check it against what ./bwat setup showed.");
  });
});

describe("the Zoom page asking to link the person's account", () => {
  it("keeps the sign-in address as text, never as markup, escaped by the pages' one helper", async () => {
    const url = 'https://bwat.example.test/"><script>alert(1)</script>';
    const html = linkPageFor(url);
    expect(html).toContain('data-url="https://bwat.example.test/&#34;&#62;&#60;script&#62;alert(1)&#60;/script&#62;"');
    const dom = await run(html, '/', async () => new Response('{}'));
    expect((dom.window.document.getElementById('open') as HTMLElement).dataset.url).toBe(url);
    expect(inline(html)).toEqual([]);
  });

  it('opens the sign-in in the browser through Zoom, and sends the code typed in', async () => {
    const paired: unknown[] = [];
    const dom = await run(await linkPage(), '/', async (input, init) => {
      paired.push([input, JSON.parse(String(init!.body))]);
      return new Response(null, { status: 400 });
    });
    const { document } = dom.window;
    const asked: unknown[] = [];
    (dom.window as unknown as { zoomSdk: unknown }).zoomSdk = {
      config: async (c: unknown) => { asked.push(c); },
      openUrl: async (o: unknown) => { asked.push(o); },
    };
    (document.getElementById('open') as HTMLButtonElement).click();
    await until(() => asked.length === 2);
    expect(asked).toEqual([{ capabilities: ['openUrl'] }, { url: 'https://bwat.example.test/auth/zoom-link' }]);
    (document.getElementById('code') as HTMLInputElement).value = ' ABCD-EFGH ';
    document.querySelector('form')!.requestSubmit();
    await until(() => /^That code didn't work/.test(status(dom)));
    expect(paired).toEqual([['/auth/zoom-pair', { code: 'ABCD-EFGH' }]]);
  });
});
