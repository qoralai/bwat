// The onboarding page's server: ./bwat setup --web runs it (setup/bwat). It listens on
// this machine's loopback only, at a free port, and answers its API only to a request
// carrying the token printed in the link. Run as a script, it starts, writes
// .bwat/onboard/session for the MCP bridge, opens the browser and prints the link.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HEADERS, json, Refused, send, TYPES, type Handler } from './http.ts';
import { platformTags } from './platform.ts';
import { ROOT } from './root.ts';
import { addRoutes, defaultPaths, type Paths } from './routes.ts';

const STATIC = join(ROOT, 'setup/onboard/static');
const BOARD_UI = join(ROOT, 'web/pages/board/ui');
const SHOTS = join(ROOT, 'docs/onboarding/shots');

export type Onboard = {
  host: string;
  port: number;
  token: string;
  url: string;
  /** Adds a route, `METHOD /path`: one under /api/ answers only with the token; a GET outside /api/ needs none. */
  route(key: string, handler: Handler): void;
  close(): Promise<void>;
};

// A file under dir, or undefined: the decoded path must stay inside it.
function inside(dir: string, path: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return undefined; }
  const file = resolve(dir, '.' + sep + decoded);
  const rel = relative(dir, file);
  if (!rel || rel.startsWith('..') || rel.includes('\0') || !TYPES[extname(file)] || !existsSync(file)) return undefined;
  return file;
}

// The stylesheets board.html links, in its order, so the page looks like the board.
function boardStyles() {
  const board = readFileSync(join(ROOT, 'web/pages/board/board.html'), 'utf8');
  return [...board.matchAll(/<link rel="stylesheet" href="ui\/([^"]+)">/g)].map((m) => `/board-ui/${m[1]}`);
}

function page() {
  const links = [...boardStyles(), '/static/onboard.css'].map((href) => `<link rel="stylesheet" href="${href}">`).join('');
  return readFileSync(join(STATIC, 'index.html'), 'utf8').replace('<!-- styles -->', links);
}

export function start({ token = randomBytes(32).toString('hex'), port = 0, paths = defaultPaths(), commands, cwd, onDestroyed, waitMs, master, sdk, fetch: fetchFn, prep }:
  { token?: string; prep?: boolean; port?: number; paths?: Paths; commands?: Map<string, string>; cwd?: string; onDestroyed?: () => void; waitMs?: number; master?: string;
    sdk?: { exec?: (file: string, args: string[]) => Promise<string>; auto?: boolean; maxBytes?: number }; fetch?: typeof fetch } = {}) {
  const routes = new Map<string, Handler>([['GET /api/ping', ({ res }) => json(res, 200, { ok: true })]]);
  const runner = addRoutes((key, handler) => routes.set(key, handler), paths, {
    ...(commands ? { commands } : {}), ...(cwd ? { cwd } : {}), ...(onDestroyed ? { onDestroyed } : {}), ...(waitMs ? { waitMs } : {}), ...(master ? { master } : {}),
    ...(sdk ? { sdk } : {}), ...(fetchFn ? { fetch: fetchFn } : {}), ...(prep ? { prep } : {}),
  });
  const host = '127.0.0.1';
  const expected = Buffer.from(`Bearer ${token}`);
  let origins: Set<string>;

  // Node drops a request still arriving after 5 minutes; a 100 MB SDK sent over an SSH
  // tunnel to a cloud server can take longer. Slow headers are still cut off at 60 s.
  const server = createServer({ requestTimeout: 60 * 60_000 }, async (req, res) => {
    // DNS rebinding: a name that resolves here still sends its own Host.
    if (!req.headers.host || !origins.has(`http://${req.headers.host}`)) return send(res, 403, '{"error":"wrong host"}');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && !origins.has(String(req.headers.origin))) {
      return send(res, 403, '{"error":"wrong origin"}');
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        const given = Buffer.from(req.headers.authorization ?? '');
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return json(res, 401, { error: 'no token' });
        const handler = routes.get(`${method} ${url.pathname}`);
        if (!handler) return json(res, 404, { error: 'not found' });
        return await handler({ req, res, url });
      }
      if (method !== 'GET') return json(res, 404, { error: 'not found' });
      // A page a browser opens with no token, such as OpenRouter's redirect back here.
      const open = routes.get(`GET ${url.pathname}`);
      if (open) return await open({ req, res, url });
      if (url.pathname === '/') return send(res, 200, page(), TYPES['.html']);
      const [dir, rest] = url.pathname.startsWith('/static/') ? [STATIC, url.pathname.slice(8)]
        : url.pathname.startsWith('/board-ui/') ? [BOARD_UI, url.pathname.slice(10)]
          : url.pathname.startsWith('/shots/') && url.pathname.endsWith('.png') ? [SHOTS, url.pathname.slice(7)] : [undefined, ''];
      const file = dir && inside(dir, rest);
      if (!file) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { ...HEADERS, 'content-type': TYPES[extname(file)]! });
      res.end(readFileSync(file));
    } catch (error) {
      const status = error instanceof Refused ? error.status : error instanceof SyntaxError ? 400 : 500;
      if (!res.headersSent) json(res, status, { error: error instanceof Error ? error.message : 'failed' });
      else res.end();
    }
  });

  return new Promise<Onboard>((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return fail(new Error('no port'));
      origins = new Set([`http://${host}:${address.port}`, `http://localhost:${address.port}`]);
      done({
        host,
        port: address.port,
        token,
        url: `http://${host}:${address.port}/#${token}`,
        route: (key, handler) => { routes.set(key, handler); },
        close: () => new Promise<void>((closed) => { runner.stop(); server.closeAllConnections(); server.close(() => closed()); }),
      });
    });
  });
}

const isWsl = () => platformTags().includes('wsl');

// Best effort: the link is printed whether or not a browser opened.
function openBrowser(url: string) {
  if (process.env.BWAT_NO_BROWSER) return;
  const wsl = isWsl();
  const [command, ...args] = process.platform === 'darwin' ? ['open', url]
    : wsl ? ['cmd.exe', '/c', 'start', '""', url]
      : ['xdg-open', url];
  if (process.platform === 'linux' && !wsl && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const child = spawn(command!, args, { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

type Processes = { kill(pid: number, signal: string | number): void; command(pid: number): string | null };
const processes: Processes = {
  kill: (pid, signal) => { process.kill(pid, signal); },
  command: (pid) => {
    try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null; } catch { return null; }
  },
};

/** Stops the setup page an earlier ./bwat setup --web left running on this clone, and waits
 *  for it to go: one page per clone. A pid that now runs something else is left alone. */
export async function stopEarlier(session: string, procs: Processes = processes) {
  let pid = 0;
  try { pid = Number(JSON.parse(readFileSync(session, 'utf8')).pid) || 0; } catch { return; }
  if (!pid || pid === process.pid || !procs.command(pid)?.includes('setup/onboard/server.ts')) return;
  try { procs.kill(pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 30; i++) {
    try { procs.kill(pid, 0); } catch { return; }
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function main() {
  // Before anything else: the earlier page removes the session file as it stops.
  await stopEarlier(join(ROOT, '.bwat/onboard/session'));
  const onboard: Onboard = await start({ prep: true,
    // The installer deleted the page's records: nothing is left to serve.
    onDestroyed: () => setTimeout(() => {
      console.log('bwat.answers and the setup page\'s records are deleted. bwat keeps running.');
      void onboard.close().then(() => process.exit(0));
    }, 500),
  });
  const dir = join(ROOT, '.bwat/onboard');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const session = join(dir, 'session');
  writeFileSync(session, JSON.stringify({ port: onboard.port, token: onboard.token, pid: process.pid }), { mode: 0o600 });
  const stop = () => {
    rmSync(session, { force: true });
    void onboard.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  openBrowser(onboard.url);
  console.log(`bwat onboarding: ${onboard.url}`);
  console.log('Open the link above if no browser opened. Ctrl-C stops the page; your progress is kept.');
  if (isWsl()) {
    console.log('On WSL, if Windows cannot open it, set localhostForwarding=true in %UserProfile%\\.wslconfig and run wsl --shutdown.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
