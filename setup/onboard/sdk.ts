// The Zoom Meeting SDK on the setup page (QOR-5044): the file the person drops on the page,
// the one setup would build from, and the meeting bot, built in the background as soon as
// a finished file is there, while the person carries on with the other steps. bwat never
// fetches the SDK: every file here is one the company downloaded from Zoom (D92).
//
// The dropped file goes to <sdk dir> (.bwat/sdk/, which setup/zoom-sdk searches first), so
// on a cloud server reached through an SSH tunnel the laptop's download lands on the
// server. The build is setup/zoom-sdk itself, in a runner of its own, so the page's other
// commands never wait behind it; its lock makes setup's own step wait for it, not build again.
import { execFile } from 'node:child_process';
import { chmodSync, createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { basename, join } from 'node:path';
import { Refused } from './http.ts';
import { ROOT } from './root.ts';
import { createRunner, type Runner } from './runner.ts';

/** The one file name taken: the Linux x86_64 SDK as Zoom names it, never a path. A browser's
 * " (1)" on a second download is that version too, as setup/zoom-sdk's version_of reads it. */
export const SDK_FILE = /^zoom-meeting-sdk-linux_x86_64-(\d+(?:\.\d+){1,3})(?: \(\d+\))?\.tar\.(?:xz|gz|bz2)$/;
/** Zoom's archive is about 100 MB; anything far larger is not it. */
export const SDK_MAX_BYTES = 512 * 1024 * 1024;
export const BUILD_ID = 'sdk-build';
// Rosetta first (a build under it hangs); no wait for a download: the page has the file.
const BUILD = 'setup/docker-rosetta "setup/zoom-sdk" && BWAT_SDK_WAIT=off setup/zoom-sdk';

export type SdkKind = 'tested' | 'built-here' | 'untested';
export type SdkStatus = {
  file: string | null;
  version: string | null;
  kind: SdkKind | null;
  tested: string;
  docker: boolean;
  /** current: built from this clone's bot/; stale: from another; none: not built. */
  image: 'current' | 'stale' | 'none';
  building: boolean;
  uploading: boolean;
  /** The last background build, for the log. */
  build: { exit: number | null; started: string; ended: string | null; lines: string[] } | null;
};

type Exec = (file: string, args: string[]) => Promise<string>;
const defaultExec = (cwd: string): Exec => (file, args) => new Promise((done, fail) => {
  execFile(file, args, { cwd, timeout: 10_000 }, (error, stdout) => (error ? fail(error) : done(stdout)));
});

/** The version bwat is tested with, from bot/sdk/zoom-sdk.lock. */
export function testedVersion(root = ROOT) {
  return readFileSync(join(root, 'bot/sdk/zoom-sdk.lock'), 'utf8').match(/^ZOOM_SDK_VERSION="([^"]+)"/m)?.[1] ?? '';
}

export function createSdk({ dir, cwd = ROOT, logs, exec = defaultExec(cwd), auto = true, busy = () => false, tested = testedVersion(), command = BUILD, maxBytes = SDK_MAX_BYTES, settleMs = 3_000, freshMs = 2_000 }: {
  /** Where a dropped file goes; setup/zoom-sdk searches it first. */
  dir: string;
  cwd?: string;
  logs: string;
  exec?: Exec;
  /** Whether a finished file starts the build on its own (tests turn it off). */
  auto?: boolean;
  /** Whether a command of the page runs: setup's own step builds then, so nothing starts. */
  busy?: () => boolean;
  tested?: string;
  /** The build's command line (tests give a stand-in). */
  command?: string;
  maxBytes?: number;
  /** How long a file must hold still before it counts as finished. */
  settleMs?: number;
  /** How long one look at Docker and git answers for: the page and its checks both ask. */
  freshMs?: number;
}) {
  const runner: Runner = createRunner({ commands: new Map([[BUILD_ID, command]]), cwd, logs, secrets: () => [] });
  let uploading = false;
  // The file as last seen and since when: one that has held still for settleMs is finished.
  // A build is tried once per file and bot/ tree, worked or not: an image whose label can't
  // be read as this tree (no usable git) would otherwise be rebuilt on every look.
  let seen = '';
  let seenAt = 0;
  let triedOn = '';
  let lastKey = '';
  let building = '';
  runner.on((event) => {
    if (event.type === 'exit') { triedOn = building; looked = null; }
  });

  const run = (file: string, args: string[]) => exec(file, args).then((out) => out.trim(), () => '');
  const mark = (path: string) => {
    try { const s = statSync(path); return `${path}\n${s.size}\n${s.mtimeMs}`; } catch { return ''; }
  };

  type Facts = { archive: string | null; docker: boolean; image: SdkStatus['image']; tree: string };
  let looked: { at: number; done: boolean; facts: Promise<Facts> } | null = null;
  /** One look shared by every caller in flight or within freshMs: a hung Docker is waited on once. */
  function facts() {
    if (!looked || (looked.done && Date.now() - looked.at >= freshMs)) {
      const next = { at: Date.now(), done: false, facts: look() };
      void next.facts.finally(() => { next.done = true; next.at = Date.now(); });
      looked = next;
    }
    return looked.facts;
  }

  async function look(): Promise<Facts> {
    const [archive, server, label, tree] = await Promise.all([
      run('bash', ['setup/zoom-sdk', '--find']),
      run('docker', ['version', '--format', '{{.Server.Version}}']),
      run('docker', ['image', 'inspect', '-f', '{{index .Config.Labels "bwat.bot-tree"}}', 'bwat-bot:zoom']),
      run('git', ['rev-parse', 'HEAD:bot']),
    ]);
    const image: SdkStatus['image'] = !label ? 'none' : label === tree ? 'current' : 'stale';
    return { archive: archive || null, docker: Boolean(server), image, tree };
  }

  function kindOf(version: string): SdkKind {
    if (version === tested) return 'tested';
    try {
      if (readFileSync(join(dir, 'built'), 'utf8').split('\n').some((line) => line.startsWith(`${version} `))) return 'built-here';
    } catch { /* nothing built here yet */ }
    return 'untested';
  }

  const start = () => runner.start(BUILD_ID);

  /** Starts the build once a finished file is there and nothing is built from this clone yet. */
  async function tick() {
    const f = await facts();
    const now = f.archive ? mark(f.archive) : '';
    const changed = now !== seen;
    if (changed) { seen = now; seenAt = Date.now(); }
    const stable = now !== '' && !changed && Date.now() - seenAt >= settleMs;
    const key = lastKey = `${now}
${f.tree}`;
    if (!auto || uploading || runner.running() || busy() || !f.docker || f.image === 'current' || !stable || key === triedOn) return f;
    building = key;
    start();
    return f;
  }

  async function status(): Promise<SdkStatus> {
    const f = await tick();
    const name = f.archive ? basename(f.archive) : null;
    const version = name?.match(SDK_FILE)?.[1] ?? null;
    const last = runner.last(BUILD_ID);
    return {
      file: name, version, kind: version ? kindOf(version) : null, tested,
      docker: f.docker, image: f.image, building: runner.running(), uploading,
      build: last ? { exit: last.exit ?? null, started: last.started, ended: last.ended ?? null, lines: last.lines.slice(-40) } : null,
    };
  }

  /** The dropped file, streamed to <dir>/<name>.part and renamed once whole; older copies go. */
  async function upload(req: IncomingMessage) {
    const name = String(req.headers['x-sdk-name'] ?? '');
    if (!SDK_FILE.test(name)) throw new Refused('That is not the Zoom Meeting SDK for Linux x86_64: its file is named like zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz.');
    if (Number(req.headers['content-length'] ?? 0) > maxBytes) throw new Refused('That file is far larger than the Zoom Meeting SDK.', 413);
    if (uploading) throw new Refused('A file is already being sent: wait for it to finish.', 409);
    uploading = true;
    const part = join(dir, `${name}.part`);
    let bytes = 0;
    let out: ReturnType<typeof createWriteStream> | undefined;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      await new Promise<void>((done, fail) => {
        const file = out = createWriteStream(part, { mode: 0o600 });
        req.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) { req.destroy(); fail(new Refused('That file is far larger than the Zoom Meeting SDK.', 413)); }
        });
        req.on('aborted', () => fail(new Refused('The file did not arrive whole: send it again.')));
        req.pipe(file);
        file.on('finish', done);
        file.on('error', fail);
      });
      if (bytes === 0) throw new Refused('The file was empty.');
      chmodSync(part, 0o600);
      for (const other of readdirSync(dir)) {
        if (other !== name && other !== basename(part) && SDK_FILE.test(other.replace(/\.part$/, ''))) rmSync(join(dir, other), { force: true });
      }
      renameSync(part, join(dir, name));
    } catch (error) {
      out?.destroy();
      rmSync(part, { force: true });
      throw error;
    } finally {
      uploading = false;
    }
    // Whole on arrival: the next look may start the build at once.
    seen = mark(join(dir, name));
    seenAt = 0;
    return { file: name, bytes };
  }

  return {
    runner, status, tick, upload, kindOf,
    /** A build the person asked for: tried even on a file that failed before. */
    build() {
      if (runner.running()) throw new Refused('The meeting bot is already being built.', 409);
      if (busy()) throw new Refused('Another command is running: wait for it to finish.', 409);
      building = lastKey;
      return start();
    },
    /** For the zoom-sdk step's check: ticks once the bot is built from this clone. */
    async check() {
      const f = await facts();
      return f.image === 'current' ? { ok: true, detail: 'The meeting bot is built.' }
        : runner.running() ? { ok: false, detail: 'The meeting bot is being built.' }
          : { ok: false, detail: f.archive ? 'The SDK is here; the meeting bot is not built yet.' : 'No Zoom Meeting SDK file yet.' };
    },
  };
}

export type Sdk = ReturnType<typeof createSdk>;
