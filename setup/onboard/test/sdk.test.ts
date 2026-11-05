import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import { start, type Onboard } from '../server.ts';
import { createSdk } from '../sdk.ts';

const NAME = 'zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz';
const TREE = 'b'.repeat(40);

/** A stand-in for setup/zoom-sdk --find, docker and git: what each would answer. */
function world(over: { archive?: string; docker?: boolean; label?: string } = {}) {
  const facts = { archive: '', docker: true, label: '', ...over };
  const calls: string[] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args].join(' '));
    if (file === 'bash' && args.includes('--find')) { if (!facts.archive) throw new Error('none'); return facts.archive + '\n'; }
    if (file === 'docker' && args[0] === 'version') { if (!facts.docker) throw new Error('down'); return '27.0.0\n'; }
    if (file === 'docker' && args[0] === 'image') { if (!facts.label) throw new Error('no image'); return facts.label + '\n'; }
    if (file === 'git') return TREE + '\n';
    throw new Error(`unexpected ${file}`);
  };
  return { facts, calls, exec };
}

const starts = (sdk: ReturnType<typeof createSdk>) => {
  const seen = { n: 0 };
  sdk.runner.on((event) => { if (event.type === 'start') seen.n += 1; });
  return seen;
};

const exited = (sdk: ReturnType<typeof createSdk>) => new Promise<number>((done) => {
  sdk.runner.on((event) => { if (event.type === 'exit') done(event.exit); });
});

describe('the SDK build in the background', () => {
  let dir: string;
  let archive: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onboard-sdk-'));
    archive = join(dir, NAME);
    writeFileSync(archive, 'sdk');
  });
  const sdk = (w: ReturnType<typeof world>, more: Partial<Parameters<typeof createSdk>[0]> = {}) =>
    createSdk({ dir, cwd: dir, logs: join(dir, 'logs'), exec: w.exec, tested: '7.0.2.5001', command: 'echo building', settleMs: 0, freshMs: 0, ...more });

  it('two looks moments apart do not count a file as finished', async () => {
    const s = sdk(world({ archive }), { settleMs: 60_000 });
    await s.tick();
    await s.tick();
    assert.equal(s.runner.last('sdk-build'), undefined);
  });

  it('looks at the same time ask Docker and git once', async () => {
    const w = world({ archive });
    const s = sdk(w, { auto: false });
    await Promise.all([s.tick(), s.status(), s.check()]);
    assert.equal(w.calls.filter((c) => c.startsWith('docker version')).length, 1);
  });

  it('a build that worked is not run again on the same file and bot/ tree, even if the image says nothing of its tree', async () => {
    // No usable git in the clone: the image carries an empty label, so it never reads as current.
    const s = sdk(world({ archive }));
    const started = starts(s);
    await s.tick();
    const done = exited(s);
    await s.tick();
    assert.equal(await done, 0);
    await s.tick();
    await s.tick();
    assert.equal(started.n, 1);
  });

  it('a folder that cannot be made fails that upload only, not every later one', async () => {
    const blocked = join(dir, 'not-a-folder');
    writeFileSync(blocked, 'a file where the folder goes');
    const s = sdk(world(), { dir: blocked });
    const body = () => Object.assign(new PassThrough(), { headers: { 'x-sdk-name': NAME } }) as unknown as IncomingMessage;
    await assert.rejects(s.upload(body()), (error: Error) => !/already being sent/.test(error.message));
    await assert.rejects(s.upload(body()), (error: Error) => !/already being sent/.test(error.message));
  });

  it('nothing starts while a file is arriving', async () => {
    const s = sdk(world({ archive }));
    const body = Object.assign(new PassThrough(), { headers: { 'x-sdk-name': NAME } });
    const sent = s.upload(body as unknown as IncomingMessage);
    body.write('half');
    await s.tick();
    await s.tick();
    assert.equal(s.runner.last('sdk-build'), undefined);
    body.end();
    await sent;
  });

  it('starts once a file has held still between two looks, and not before', async () => {
    const s = sdk(world({ archive }));
    await s.tick();
    assert.equal(s.runner.last('sdk-build'), undefined, 'first look: the file may still be growing');
    const done = exited(s);
    await s.tick();
    assert.equal(await done, 0);
    assert.deepEqual(s.runner.last('sdk-build')?.lines, ['building']);
  });

  it('a file that grows between looks is still downloading', async () => {
    const s = sdk(world({ archive }));
    await s.tick();
    writeFileSync(archive, 'sdk, more of it');
    await s.tick();
    assert.equal(s.runner.last('sdk-build'), undefined);
  });

  it('starts nothing with no file, Docker down, the bot already built from this clone, a command running, or auto off', async () => {
    const cases = [
      sdk(world()),
      sdk(world({ archive, docker: false })),
      sdk(world({ archive, label: TREE })),
      sdk(world({ archive }), { busy: () => true }),
      sdk(world({ archive }), { auto: false }),
    ];
    for (const s of cases) { await s.tick(); await s.tick(); assert.equal(s.runner.last('sdk-build'), undefined); }
  });

  it('a bot built from another bot/ tree is rebuilt', async () => {
    const s = sdk(world({ archive, label: 'a'.repeat(40) }));
    assert.equal((await s.status()).image, 'stale');
    const done = exited(s);
    await s.tick();
    assert.equal(await done, 0);
  });

  it('a build that failed is not tried again on the same file, but is once the file changes or the person asks', async () => {
    const s = sdk(world({ archive }), { command: 'echo nope; exit 3' });
    const started = starts(s);
    await s.tick();
    let done = exited(s);
    await s.tick();
    assert.equal(await done, 3);
    await s.tick();
    await s.tick();
    assert.equal(started.n, 1, 'not started again on its own');
    done = exited(s);
    s.build();
    assert.equal(await done, 3, 'the person asked: tried again');
    writeFileSync(archive, 'a new download');
    await s.tick();
    done = exited(s);
    await s.tick();
    assert.equal(await done, 3, 'a changed file is tried again');
  });

  it('names the version as tested, built on this computer before, or untested', async () => {
    const s = sdk(world());
    assert.equal(s.kindOf('7.0.2.5001'), 'tested');
    assert.equal(s.kindOf('7.1.5.4432'), 'untested');
    writeFileSync(join(dir, 'built'), `7.1.5.4432 ${'c'.repeat(64)}\n`);
    assert.equal(s.kindOf('7.1.5.4432'), 'built-here');
    assert.equal(s.kindOf('7.1.5'), 'untested', 'a version is matched whole');
  });

  it('the status names the file, its version and kind, never its path', async () => {
    const status = await sdk(world({ archive }), { auto: false }).status();
    assert.equal(status.file, NAME);
    assert.equal(status.version, '7.1.5.4432');
    assert.equal(status.kind, 'untested');
    assert.equal(status.tested, '7.0.2.5001');
    assert.equal(status.image, 'none');
    assert.ok(!JSON.stringify(status).includes(dir));
  });

  it('a second download, which the browser names with (1), counts as that version', async () => {
    const copy = join(dir, 'zoom-meeting-sdk-linux_x86_64-7.1.5.4432 (1).tar.xz');
    writeFileSync(copy, 'sdk');
    const status = await sdk(world({ archive: copy }), { auto: false }).status();
    assert.equal(status.version, '7.1.5.4432');
    assert.equal(status.kind, 'untested');
  });

  it('ticks the zoom-sdk step once the bot is built from this clone', async () => {
    assert.deepEqual(await sdk(world({ archive, label: TREE })).check(), { ok: true, detail: 'The meeting bot is built.' });
    assert.equal((await sdk(world({ archive })).check()).ok, false);
  });
});

describe('POST /api/sdk', () => {
  let onboard: Onboard;
  let dir: string;
  let sdkDir: string;
  const token = 'd'.repeat(64);
  const send = (name: string, body: string) => fetch(`http://127.0.0.1:${onboard.port}/api/sdk`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${onboard.port}`, 'content-type': 'application/octet-stream', 'x-sdk-name': name },
    body,
  });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'onboard-sdk-api-'));
    sdkDir = join(dir, 'sdk');
    const paths = { state: join(dir, 'onboard/state.json'), answers: join(dir, 'bwat.answers'), env: join(dir, '.env'), logs: join(dir, 'logs'), sdk: sdkDir };
    onboard = await start({ token, paths, cwd: dir, commands: new Map(), sdk: { exec: world().exec, auto: false, maxBytes: 1024 } });
  });
  after(() => onboard.close());

  it('keeps the file under its own name, private to this user, and drops an older copy', async () => {
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(sdkDir, 'zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz'), 'old');
    const res = await send(NAME, 'the sdk');
    assert.deepEqual([res.status, await res.json()], [200, { file: NAME, bytes: 7 }]);
    assert.equal(readFileSync(join(sdkDir, NAME), 'utf8'), 'the sdk');
    assert.deepEqual(readdirSync(sdkDir), [NAME]);
    if (process.platform !== 'win32') assert.equal(statSync(join(sdkDir, NAME)).mode & 0o777, 0o600);
  });

  it('refuses any other name, a path among them, and writes nothing', async () => {
    for (const name of ['zoom-plugin-sdk-windows-7.2.0.3001.zip', '../zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz', 'zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz/x', '']) {
      const res = await send(name, 'x');
      assert.equal(res.status, 400, name);
      assert.match(String(((await res.json()) as { error: string }).error), /not the Zoom Meeting SDK for Linux x86_64/);
    }
    assert.ok(!existsSync(join(dir, NAME)));
  });

  it('refuses a file far larger than the SDK, and leaves no part behind', async () => {
    const res = await send('zoom-meeting-sdk-linux_x86_64-7.2.0.1.tar.xz', 'x'.repeat(4096));
    assert.equal(res.status, 413);
    assert.ok(!readdirSync(sdkDir).some((f) => f.includes('7.2.0.1')));
  });

  it('refuses an empty file', async () => {
    const res = await send('zoom-meeting-sdk-linux_x86_64-7.2.0.2.tar.xz', '');
    assert.equal(res.status, 400);
  });

  it('answers only with the token', async () => {
    const res = await fetch(`http://127.0.0.1:${onboard.port}/api/sdk`, { method: 'POST', headers: { origin: `http://127.0.0.1:${onboard.port}`, 'x-sdk-name': NAME }, body: 'x' });
    assert.equal(res.status, 401);
  });
});
