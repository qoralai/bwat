import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { start, stopEarlier, type Onboard } from '../server.ts';
import { ROOT } from '../root.ts';

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// node:http rather than fetch: fetch will not send a Host header of our choosing.
function call(onboard: Onboard, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<Reply>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: onboard.port, path, method: init.method ?? 'GET',
      headers: { host: `127.0.0.1:${onboard.port}`, ...init.headers },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

describe('the onboarding server', () => {
  let onboard: Onboard;
  const token = 'a'.repeat(64);
  const auth = () => ({ authorization: `Bearer ${token}` });
  before(async () => { onboard = await start({ token }); });
  after(() => onboard.close());

  it('listens on the loopback only, at the port it reports', () => {
    assert.equal(onboard.host, '127.0.0.1');
    assert.match(onboard.url, /^http:\/\/127\.0\.0\.1:\d+\/#a{64}$/);
  });

  it('serves the page with the board stylesheets board.html links, in board order', async () => {
    const reply = await call(onboard, '/');
    assert.equal(reply.status, 200);
    assert.match(String(reply.headers['content-type']), /^text\/html/);
    const links = [...reply.body.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    assert.ok(links.includes('/board-ui/study.css'));
    assert.ok(links.includes('/board-ui/dark.css'));
    assert.ok(links.indexOf('/board-ui/study.css') < links.indexOf('/board-ui/dark.css'));
    assert.equal(links.at(-1), '/static/onboard.css');
  });

  it('sends no-store, a strict CSP and nosniff on every reply, refusals included', async () => {
    for (const path of ['/', '/api/ping', '/nothing']) {
      const reply = await call(onboard, path);
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.match(String(reply.headers['content-security-policy']), /default-src 'self'/);
      assert.match(String(reply.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.equal(reply.headers['x-content-type-options'], 'nosniff');
      assert.equal(reply.headers['referrer-policy'], 'no-referrer');
    }
  });

  it('refuses any Host but its own loopback address, before anything else', async () => {
    for (const host of ['evil.test', `evil.test:${onboard.port}`, '127.0.0.1:1', `localhost.evil.test:${onboard.port}`]) {
      const reply = await call(onboard, '/', { headers: { host } });
      assert.equal(reply.status, 403, host);
    }
    const local = await call(onboard, '/', { headers: { host: `localhost:${onboard.port}` } });
    assert.equal(local.status, 200);
  });

  it('answers the API only with the token', async () => {
    assert.equal((await call(onboard, '/api/ping')).status, 401);
    assert.equal((await call(onboard, '/api/ping', { headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status, 401);
    assert.equal((await call(onboard, '/api/ping', { headers: { authorization: `Bearer ${token}x` } })).status, 401);
    const ok = await call(onboard, '/api/ping', { headers: auth() });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true });
  });

  it('refuses a write whose Origin is not its own, even with the token', async () => {
    const write = (origin?: string) => call(onboard, '/api/ping', {
      method: 'POST', headers: { ...auth(), ...(origin ? { origin } : {}) },
    });
    assert.equal((await write()).status, 403);
    assert.equal((await write('http://evil.test')).status, 403);
    assert.equal((await write(`http://127.0.0.1:${onboard.port}`)).status, 404);
    assert.equal((await write(`http://localhost:${onboard.port}`)).status, 404);
  });

  it('styles its own layout with the board\'s tokens only, never a colour of its own', () => {
    const css = readFileSync(new URL('../static/onboard.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
    // The soft look's palette (soft.css), light and dark.
    assert.match(css, /var\(--sf-/);
  });

  it('serves board files from web/pages/board/ui and nothing outside it', async () => {
    const css = await call(onboard, '/board-ui/study.css');
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /^text\/css/);
    // web/pages/board/ui is three levels below web/package.json, which exists.
    for (const path of ['/board-ui/../../package.json', '/board-ui/..%2f..%2f..%2fpackage.json', '/board-ui/%2e%2e/board.html',
      '/static/..%2f..%2f..%2fweb%2fpackage.json',
      '/static/../server.ts', '/board-ui/nothing.css', '/board-ui/']) {
      assert.equal((await call(onboard, path)).status, 404, path);
    }
  });
});

describe('an earlier setup page on this clone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-session-'));
  const session = join(dir, 'session');
  const SERVER = `node --experimental-strip-types ${ROOT}/setup/onboard/server.ts`;
  // A stand-in for the processes: which are alive, what each runs, and who was sent what.
  const procs = (alive: Record<number, string>) => {
    const sent: string[] = [];
    return {
      sent,
      kill: (pid: number, signal: string | number) => {
        if (!(pid in alive)) throw new Error('ESRCH');
        sent.push(`${pid} ${signal}`);
        if (signal === 'SIGTERM') delete alive[pid];
      },
      command: (pid: number) => alive[pid] ?? null,
    };
  };

  it('is stopped before a new one starts', async () => {
    writeFileSync(session, JSON.stringify({ port: 1, token: 't', pid: 4242 }));
    const p = procs({ 4242: SERVER });
    await stopEarlier(session, p);
    assert.deepEqual(p.sent.filter((s) => s.endsWith('SIGTERM')), ['4242 SIGTERM']);
  });

  it('is left alone when its pid now runs something else, or nothing', async () => {
    writeFileSync(session, JSON.stringify({ port: 1, token: 't', pid: 4242 }));
    const other = procs({ 4242: 'vim notes.txt' });
    await stopEarlier(session, other);
    assert.deepEqual(other.sent.filter((s) => s.endsWith('SIGTERM')), []);
    const none = procs({});
    await stopEarlier(session, none);
    assert.deepEqual(none.sent, []);
  });

  it('with no session file, does nothing', async () => {
    rmSync(session, { force: true });
    const p = procs({ 4242: SERVER });
    await stopEarlier(session, p);
    assert.deepEqual(p.sent, []);
  });
});
