import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createRunner, type RunEvent } from '../runner.ts';

const SECRET = 'GOCSPX-' + 'q'.repeat(24) + 'a1b2';

function runner(commands: Record<string, string>, secrets: string[] = [SECRET]) {
  const logs = mkdtempSync(join(tmpdir(), 'onboard-logs-'));
  const events: RunEvent[] = [];
  const r = createRunner({ commands: new Map(Object.entries(commands)), cwd: tmpdir(), logs, secrets: () => secrets });
  r.on((event) => events.push(event));
  return { r, events, logs };
}

const finished = (r: ReturnType<typeof createRunner>, id: string) => new Promise<void>((done) => {
  r.on((event) => { if (event.type === 'exit' && event.id === id) done(); });
});

describe('the command runner', () => {
  it('runs a known command, streams its lines, and records its exit code', async () => {
    const { r, events } = runner({ hello: 'echo one; echo two >&2; exit 3' });
    const done = finished(r, 'hello');
    r.start('hello');
    await done;
    assert.deepEqual(events.filter((e) => e.type === 'line').map((e) => e.type === 'line' && e.line).sort(), ['one', 'two']);
    assert.deepEqual(r.last('hello')?.exit, 3);
    assert.deepEqual(events.at(-1), { type: 'exit', id: 'hello', exit: 3 });
  });

  it('runs nothing when the text it was told to run is not the guide\'s text now', () => {
    const { r, events } = runner({ hello: 'echo one' });
    assert.throws(() => r.start('hello', 'echo other'), /changed/);
    assert.deepEqual(events, []);
  });

  it('runs nothing but the guide\'s commands, by id', () => {
    const { r } = runner({ hello: 'echo hi' });
    assert.throws(() => r.start('echo hi'), /unknown command/);
    assert.throws(() => r.start('rm'), /unknown command/);
  });

  it('runs one command at a time', async () => {
    const { r } = runner({ slow: 'sleep 0.3', quick: 'echo hi' });
    const done = finished(r, 'slow');
    r.start('slow');
    assert.throws(() => r.start('quick'), /still running/);
    await done;
    const quick = finished(r, 'quick');
    r.start('quick');
    await quick;
  });

  it('masks every secret in the output and the log, by the page\'s rule', async () => {
    const { r, events, logs } = runner({ leak: `echo "key=${SECRET} done"` });
    const done = finished(r, 'leak');
    r.start('leak');
    await done;
    const lines = events.filter((e) => e.type === 'line').map((e) => (e.type === 'line' ? e.line : ''));
    assert.deepEqual(lines, [`key=${'*'.repeat(31)}a1b2 done`]);
    const [log] = readdirSync(logs);
    const text = readFileSync(join(logs, log!), 'utf8');
    assert.ok(!text.includes(SECRET));
    assert.ok(text.includes('*'.repeat(31) + 'a1b2'));
    assert.equal(statSync(join(logs, log!)).mode & 0o777, 0o600);
  });

  it('reads the installer\'s "Step N of 7" lines as progress', async () => {
    const { r, events } = runner({ setup: 'echo "Step 3 of 7: Your Zoom app"; echo other' });
    const done = finished(r, 'setup');
    r.start('setup');
    await done;
    assert.deepEqual(events.filter((e) => e.type === 'progress'), [{ type: 'progress', id: 'setup', step: 3, of: 7, title: 'Your Zoom app' }]);
    assert.deepEqual(r.last('setup')?.progress, { step: 3, of: 7, title: 'Your Zoom app' });
  });

  it('keeps each command\'s last 200 lines for a page that reloads', async () => {
    const { r } = runner({ many: 'for i in $(seq 250); do echo "line $i"; done' });
    const done = finished(r, 'many');
    r.start('many');
    await done;
    const last = r.last('many')!;
    assert.equal(last.lines.length, 200);
    assert.equal(last.lines[0], 'line 51');
    assert.equal(last.lines.at(-1), 'line 250');
  });

  it('gives a command no stdin, so it can never wait for an answer', async () => {
    const { r, events } = runner({ ask: 'read -r answer || echo "no input"' });
    const done = finished(r, 'ask');
    r.start('ask');
    await done;
    assert.ok(events.some((e) => e.type === 'line' && e.line === 'no input'));
  });
});

describe('the Allow path', () => {
  it('starts the command with the text the person allowed', async () => {
    const { addLlmRoutes, createBus } = await import('../llm.ts');
    const handlers = new Map<string, (ctx: any) => Promise<void> | void>();
    const bus = createBus();
    const started: unknown[][] = [];
    const runner = { start: (...args: unknown[]) => { started.push(args); throw new Error('stop'); }, on: () => () => {}, last: () => undefined } as any;
    addLlmRoutes((key, handler) => { handlers.set(key, handler as any); }, {
      bus, runner, commands: () => new Map([['go', './bwat prep --check']]), runWaitMs: 1,
    });
    const call = async (key: string, value: unknown) => handlers.get(key)!({ req: (async function* () { yield Buffer.from(JSON.stringify(value)); })(), res: { writeHead() {}, end() {} } });
    bus.on((event) => { if (event.type === 'allow') void call('POST /api/allow', { request: event.request, allow: true }); });
    await assert.rejects(call('POST /api/llm/run', { id: 'go' }), /stop/);
    assert.deepEqual(started, [['go', './bwat prep --check']]);
  });
});
