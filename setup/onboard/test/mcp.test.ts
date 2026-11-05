import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';
import { handle, TOOLS } from '../mcp.ts';
import { start, type Onboard } from '../server.ts';

const SECRET = 'zsecret-from-the-page-0123456789';

describe('the MCP bridge', () => {
  let onboard: Onboard;
  let dir: string;
  let sessionPath: string;
  let paths: { state: string; answers: string; env: string; logs: string };
  const token = 'f'.repeat(64);
  let id = 0;
  /** Every page still listening; cancelled after each test so a failed assert cannot leave one answering the next. */
  const listening = new Set<() => Promise<void>>();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const answer = await handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, sessionPath) as
      { result: { isError?: boolean; content: { text: string }[] } };
    const text = answer.result.content[0]!.text;
    return { isError: answer.result.isError === true, text, value: answer.result.isError ? undefined : JSON.parse(text) };
  };
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${onboard.port}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${onboard.port}`, 'content-type': 'application/json' },
  });
  /** The page: reads its events and answers each Allow with allow. */
  async function page(allow: boolean, seen: unknown[]) {
    const res = await fetch(`http://127.0.0.1:${onboard.port}/api/events`, { headers: { authorization: `Bearer ${token}` } });
    const reader = res.body!.getReader();
    void (async () => {
      let buffer = '';
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (chunk.done) return;
        buffer += new TextDecoder().decode(chunk.value);
        const parts = buffer.split('\n\n');
        buffer = parts.pop()!;
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const event = JSON.parse(part.slice(6)) as { type: string; request?: string };
          seen.push(event);
          if (event.type === 'allow') await post('/api/allow', { request: event.request, allow });
        }
      }
    })();
    const stop = () => reader.cancel();
    listening.add(stop);
    return stop;
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'onboard-mcp-'));
    paths = { state: join(dir, 'state.json'), answers: join(dir, 'bwat.answers'), env: join(dir, '.env'), logs: join(dir, 'logs') };
    writeFileSync(paths.answers, 'BWAT_PUBLIC_URL=\nZOOM_CLIENT_SECRET=\n', { mode: 0o600 });
    onboard = await start({ token, paths, cwd: dir, waitMs: 10_000, commands: new Map([['hello', `echo "the key is ${SECRET}"; exit 0`]]) });
    sessionPath = join(dir, 'session');
    writeFileSync(sessionPath, JSON.stringify({ port: onboard.port, token }));
  });
  afterEach(async () => {
    await Promise.all([...listening].map((stop) => stop()));
    listening.clear();
  });
  after(() => onboard.close());

  it('answers initialize and lists its tools', async () => {
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, sessionPath) as { result: { protocolVersion: string; capabilities: object } };
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionPath) as { result: { tools: { name: string }[] } };
    assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionPath), undefined);
  });

  it('only reads the page and runs a guide command the person allows: the page leads, Claude never steers it', () => {
    assert.deepEqual(TOOLS.map((t) => t.name), ['get_state', 'get_guide', 'run_command', 'command_output']);
  });

  it('runs a command only once the person allows it, and answers its output masked', async () => {
    await post('/api/secret', { key: 'ZOOM_CLIENT_SECRET', value: SECRET });
    const seen: { type: string }[] = [];
    let stop = await page(false, seen);
    const denied = await call('run_command', { id: 'hello' });
    assert.deepEqual(denied.value, { id: 'hello', ran: false, detail: 'The person did not allow it.' });
    await stop();
    stop = await page(true, seen);
    const ran = await call('run_command', { id: 'hello' });
    assert.equal(ran.value.exit, 0);
    assert.deepEqual(ran.value.lines, [`the key is ${'*'.repeat(28)}6789`]);
    assert.ok(!ran.text.includes('zsecret'));
    assert.ok(seen.some((e) => e.type === 'allow'));
    const output = await call('command_output', { id: 'hello' });
    assert.equal(output.value.running, false);
    await stop();
  });

  it('an unanswered Allow says no answer yet; a refusal says did not allow', async () => {
    const unanswered = await call('run_command', { id: 'hello' });
    assert.deepEqual(unanswered.value, { id: 'hello', ran: false, detail: 'No answer yet: ask the person to look at the page.' });
    const stop = await page(false, []);
    const refused = await call('run_command', { id: 'hello' });
    assert.deepEqual(refused.value, { id: 'hello', ran: false, detail: 'The person did not allow it.' });
    await stop();
  });

  it('tells the page an answer was written, never its value', async () => {
    const seen: unknown[] = [];
    const stop = await page(true, seen);
    await post('/api/answer', { key: 'BWAT_PUBLIC_URL', value: 'https://again.example.com' });
    await post('/api/secret', { key: 'ZOOM_CLIENT_SECRET', value: SECRET });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(seen.filter((e) => (e as { type: string }).type === 'answer'), [
      { type: 'answer', key: 'BWAT_PUBLIC_URL' }, { type: 'answer', key: 'ZOOM_CLIENT_SECRET' },
    ]);
    await stop();
  });

  it('runs nothing when nobody answers', async () => {
    const answer = await call('run_command', { id: 'hello' });
    assert.equal(answer.value.ran, false);
    assert.equal((await call('run_command', { id: 'rm -rf /' })).isError, true);
  });

  it('says so when the setup page is not running', async () => {
    const answer = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, join(dir, 'none')) as
      { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(answer.result.isError, true);
    assert.match(answer.result.content[0]!.text, /\.\/bwat setup --web/);
  });

  it('speaks newline-delimited JSON-RPC over stdio', async () => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../mcp.ts', import.meta.url))],
      { env: { ...process.env, BWAT_ONBOARD_SESSION: sessionPath }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines: string[] = [];
    const got = new Promise<void>((done) => {
      child.stdout.on('data', (chunk: Buffer) => {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        if (lines.length >= 2) done();
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_state', arguments: {} } }) + '\n');
    await got;
    child.kill();
    const state = JSON.parse(lines.find((l) => l.includes('"id":2'))!) as { result: { content: { text: string }[] } };
    assert.ok('state' in JSON.parse(state.result.content[0]!.text));
  });
});
