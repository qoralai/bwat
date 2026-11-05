import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { createChecks, edgeBases } from '../checks.ts';
import { masterReader } from '../flow.ts';
import { readState, writeState } from '../state.ts';
import { start } from '../server.ts';

const CREDENTIAL = 'bwi_' + 'k'.repeat(43);
const steps = [
  { id: 'check-answers', checks: ['prep-complete'] },
  { id: 'install', checks: ['edge-healthy'] },
  { id: 'sign-in', checks: ['owner-signed-in'] },
  { id: 'auto-join', checks: ['zoom-ready'] },
  { id: 'first-meeting', checks: ['first-card'] },
  { id: 'company', checks: [] },
];

const KEY = 'sk-or-v1-' + 'a'.repeat(64);

function setup(facts: Record<string, unknown> | undefined, { healthy = true, mint = CREDENTIAL } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-checks-'));
  const paths = { state: join(dir, 'state.json'), answers: join(dir, 'bwat.answers'), env: join(dir, '.env'), logs: join(dir, 'logs') };
  writeFileSync(paths.env, 'BWAT_PUBLIC_URL=http://localhost:9090\nBWAT_EDGE_PORT=9090\n');
  const calls: string[] = [];
  const execs: string[][] = [];
  const sent: unknown[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(`${url} ${new Headers(init?.headers).get('authorization') ?? ''}`.trim());
    if (url.endsWith('/health')) return new Response('{}', { status: healthy ? 200 : 503 });
    if (url.endsWith('/v1/install/status') && facts) return Response.json(facts);
    if (url === 'https://openrouter.ai/api/v1/key' && new Headers(init?.headers).get('authorization') === `Bearer ${KEY}`) return Response.json({ data: {} });
    if (url.endsWith('/v1/install/checklist') && init?.method === 'PUT') { sent.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
    return new Response('{}', { status: 401 });
  }) as typeof fetch;
  const exec = async (file: string, args: string[]) => { execs.push([file, ...args]); return `onboarding page credential (shown once; kept in .bwat/onboard/state.json):\n${mint}\n`; };
  return { paths, calls, execs, sent, checks: createChecks({ paths, cwd: dir, fetch: fetchFn, exec }) };
}

const ready = { owner_signed_in: true, zoom: { ready: true, problems: [] }, meeting_transcribed: true, cards: 2 };

describe('the checks', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(ready); });

  it('wait for bwat to answer before minting a credential or asking the backend', async () => {
    t = setup(ready, { healthy: false });
    const results = await t.checks.run(steps);
    assert.equal(t.execs.length, 0);
    assert.deepEqual(results['owner-signed-in'], { ok: false, detail: 'Waits for bwat to be installed and running.' });
    assert.equal(results['edge-healthy'].ok, false);
  });

  it('mint the credential once bwat answers, even when setup ran in a terminal and not from the page', async () => {
    const results = await t.checks.run(steps);
    assert.equal(readState(t.paths.state).runs, undefined);
    assert.equal(t.execs.length, 1);
    assert.equal(readState(t.paths.state).install?.credential, CREDENTIAL);
    assert.equal(results['owner-signed-in'].ok, true);
    assert.equal(results['prep-complete'].ok, false, 'only the page\'s own prep --check run counts');
    assert.deepEqual(readState(t.paths.state).steps.install?.by, 'check');
  });

  it('pass openrouter-key once OpenRouter takes the saved key, and ask nothing while it is blank', async () => {
    writeFileSync(t.paths.answers, 'BWAT_BOT_NAME=\n');
    assert.equal((await t.checks.run(steps))['openrouter-key'].ok, false, 'no key saved yet');
    writeFileSync(t.paths.answers, 'OPENROUTER_API_KEY=\n');
    assert.equal((await t.checks.run(steps))['openrouter-key'].ok, false);
    assert.ok(!t.calls.some((c) => c.startsWith('https://openrouter.ai')));
    writeFileSync(t.paths.answers, 'OPENROUTER_API_KEY=sk-or-v1-revoked\n');
    assert.equal((await t.checks.run(steps))['openrouter-key'].ok, false, 'OpenRouter refuses it');
    writeFileSync(t.paths.answers, `OPENROUTER_API_KEY=${KEY}\n`);
    const results = await t.checks.run([...steps, { id: 'model-key', checks: ['openrouter-key'] }]);
    assert.equal(results['openrouter-key'].ok, true);
    assert.ok(t.calls.includes(`https://openrouter.ai/api/v1/key Bearer ${KEY}`));
    assert.equal(readState(t.paths.state).steps['model-key']?.by, 'check');
    const asked = t.calls.filter((c) => c.startsWith('https://openrouter.ai')).length;
    assert.equal((await t.checks.run(steps))['openrouter-key'].ok, true);
    assert.equal(t.calls.filter((c) => c.startsWith('https://openrouter.ai')).length, asked, 'a key OpenRouter took is not sent again');
  });

  it('tick a step of the chosen flow with fields and no check once every field is set, wherever it was written', async () => {
    writeState(t.paths.state, { version: 1, flow: 'local', steps: {} });
    const fields = [
      { id: 'name', checks: [], flows: ['local'], answers: ['BWAT_BOT_NAME'], secrets: [] },
      { id: 'other', checks: [], flows: ['server'], answers: ['BWAT_BOT_NAME'], secrets: [] },
    ];
    writeFileSync(t.paths.answers, 'BWAT_BOT_NAME=\n');
    await t.checks.run(fields);
    assert.equal(readState(t.paths.state).steps.name, undefined);
    writeFileSync(t.paths.answers, 'BWAT_BOT_NAME=bwat\n');
    await t.checks.run(fields);
    assert.equal(readState(t.paths.state).steps.name?.by, 'check');
    assert.equal(readState(t.paths.state).steps.other, undefined, 'not of the chosen flow');
  });

  it('never tick the Zoom app from its saved credentials: the person says the manifest is uploaded', async () => {
    writeState(t.paths.state, { version: 1, flow: 'local', steps: {} });
    const zoomMain = masterReader()().steps.find((s) => s.id === 'zoom-main')!;
    assert.deepEqual(zoomMain.checks, [], 'the real step has fields and no check');
    writeFileSync(t.paths.answers, [...zoomMain.answers, ...zoomMain.secrets].map((k) => `${k}=set\n`).join(''));
    await t.checks.run([zoomMain]);
    assert.equal(readState(t.paths.state).steps['zoom-main'], undefined);
  });

  it('mint the page\'s credential once setup succeeded, keep it, and read the facts with it', async () => {
    writeState(t.paths.state, { version: 1, flow: 'local', steps: {}, runs: { setup: { exit: 0, started: '', ended: '' }, 'prep-check': { exit: 0, started: '', ended: '' } } });
    const results = await t.checks.run(steps);
    assert.deepEqual(t.execs, [['docker', 'compose', 'exec', '-T', 'backend', 'node', 'dist/scripts/install-credential.js', '--label', 'onboard']]);
    assert.equal(readState(t.paths.state).install?.credential, CREDENTIAL);
    assert.ok(t.calls.includes(`http://localhost:9090/v1/install/status Bearer ${CREDENTIAL}`));
    for (const id of ['prep-complete', 'edge-healthy', 'owner-signed-in', 'zoom-ready', 'first-card'] as const) assert.equal(results[id].ok, true, id);
    assert.deepEqual(Object.keys(readState(t.paths.state).steps).sort(), ['auto-join', 'check-answers', 'first-meeting', 'install', 'sign-in']);
    await t.checks.run(steps);
    assert.equal(t.execs.length, 1);
  });

  it('say what is missing, and tick nothing a check has not passed', async () => {
    t = setup({ owner_signed_in: false, zoom: { ready: false, problems: ['Set the webhook secret.'] }, meeting_transcribed: true, cards: 0 });
    writeState(t.paths.state, { version: 1, flow: 'server', steps: {}, runs: { setup: { exit: 0, started: '', ended: '' }, 'prep-check': { exit: 1, started: '', ended: '' } } });
    const results = await t.checks.run(steps);
    assert.equal(results['zoom-ready'].detail, 'Set the webhook secret.');
    assert.equal(results['first-card'].detail, 'bwat has transcribed a meeting; no card yet.');
    assert.equal(results['prep-complete'].ok, false);
    assert.deepEqual(Object.keys(readState(t.paths.state).steps), ['install']);
  });

  it('keep no credential that does not look like one', async () => {
    t = setup(ready, { mint: 'error: no such service' });
    writeState(t.paths.state, { version: 1, flow: 'local', steps: {}, runs: { setup: { exit: 0, started: '', ended: '' } } });
    await t.checks.run(steps);
    assert.equal(readState(t.paths.state).install, undefined);
  });
});

describe('sendChecklist', () => {
  it('sends the open steps with the page\'s credential once bwat answers, and says when it cannot yet', async () => {
    let t = setup(ready, { healthy: false });
    const items = [{ id: 'share', title: 'Share bwat with the team', detail: '', link: null }];
    assert.equal((await t.checks.sendChecklist(items)).ok, false);
    assert.deepEqual(t.sent, []);
    t = setup(ready);
    assert.equal((await t.checks.sendChecklist(items)).ok, true);
    assert.deepEqual(t.sent, [{ items }]);
    assert.ok(t.calls.includes(`http://localhost:9090/v1/install/checklist Bearer ${CREDENTIAL}`));
  });
});

describe('edgeBases', () => {
  it('tries the public address, then this machine\'s edge port', () => {
    assert.deepEqual(edgeBases(new Map([['BWAT_PUBLIC_URL', 'https://bwat.example.com/'], ['BWAT_EDGE_PORT', '8081']])),
      ['https://bwat.example.com', 'http://127.0.0.1:8081']);
    assert.deepEqual(edgeBases(new Map()), ['http://127.0.0.1:8080']);
  });
});

describe('GET /api/state', () => {
  it('never sends the page\'s credential to the browser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-state-'));
    const paths = { state: join(dir, 'state.json'), answers: join(dir, 'bwat.answers'), env: join(dir, '.env'), logs: join(dir, 'logs') };
    writeState(paths.state, { version: 1, flow: 'local', steps: {}, install: { credential: CREDENTIAL } });
    const token = 'e'.repeat(64);
    const onboard = await start({ token, paths });
    try {
      const res = await fetch(`http://127.0.0.1:${onboard.port}/api/state`, { headers: { authorization: `Bearer ${token}` } });
      const text = await res.text();
      assert.ok(!text.includes('bwi_'), text);
      assert.equal(JSON.parse(text).flow, 'local');
      assert.ok(readFileSync(paths.state, 'utf8').includes(CREDENTIAL));
    } finally { await onboard.close(); }
  });
});
