import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { start, type Onboard } from '../server.ts';
import { readState, writeState } from '../state.ts';

const KEY = 'sk-or-v1-' + '0123456789abcdef'.repeat(4);
const MASTER = `# t

<!-- bwat:step id=model flows=local title="Connect OpenRouter" -->
Connect OpenRouter on this page.
<!-- bwat:secret OPENROUTER_API_KEY -->
<!-- bwat:check openrouter-key -->
<!-- bwat:end -->

<!-- bwat:step id=fields flows=local title="Name and secret" -->
Fill in both of these.
<!-- bwat:answer BWAT_BOT_NAME -->
<!-- bwat:secret ZOOM_CLIENT_SECRET -->
<!-- bwat:end -->

<!-- bwat:step id=checked flows=local title="Checked" -->
Ticks itself from its check.
<!-- bwat:answer BWAT_JEV -->
<!-- bwat:check prep-complete -->
<!-- bwat:end -->

<!-- bwat:step id=empty flows=local title="Nothing to fill" -->
Nothing to fill in here.
<!-- bwat:end -->
`;

// node:http rather than fetch: the callback arrives as the browser sends it, Host localhost:PORT.
function visit(onboard: Onboard, path: string) {
  return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: onboard.port, path, headers: { host: `localhost:${onboard.port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Connect OpenRouter, and steps that finish when their fields are set', () => {
  let onboard: Onboard;
  let paths: { state: string; answers: string; env: string; logs: string };
  const token = 'f'.repeat(64);
  const exchanges: Record<string, string>[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    if (url === 'https://openrouter.ai/api/v1/auth/keys' && init?.method === 'POST') {
      const sent = JSON.parse(String(init.body));
      exchanges.push(sent);
      if (sent.code === 'refused') return Response.json({ error: { code: 400, message: 'Invalid code' } }, { status: 400 });
      if (sent.code === 'keyless') return Response.json({});
      return Response.json({ key: KEY });
    }
    return new Response('{}', { status: 401 });
  }) as typeof fetch;
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${onboard.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${onboard.port}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-openrouter-'));
    const master = join(dir, 'master.md');
    writeFileSync(master, MASTER);
    paths = { state: join(dir, 'onboard/state.json'), answers: join(dir, 'bwat.answers'), env: join(dir, '.env'), logs: join(dir, 'logs') };
    writeFileSync(paths.answers, 'BWAT_BOT_NAME=\nBWAT_JEV=on\nZOOM_CLIENT_SECRET=\nOPENROUTER_API_KEY=\n');
    onboard = await start({ token, paths, cwd: dir, master, fetch: fake });
    writeState(paths.state, { version: 1, flow: 'local', steps: {} });
  });
  after(() => onboard.close());

  it('starts with the token only, and sends the person to OpenRouter with a PKCE challenge and a state', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${onboard.port}/api/openrouter/start`, { method: 'POST', headers: { origin: `http://127.0.0.1:${onboard.port}` } })).status, 401);
    const url = new URL((await api('/api/openrouter/start', {})).body.url);
    assert.equal(`${url.origin}${url.pathname}`, 'https://openrouter.ai/auth');
    assert.equal(url.searchParams.get('callback_url'), `http://localhost:${onboard.port}/openrouter/callback`);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{32,}$/);
  });

  it('saves the key OpenRouter hands back, never shows it, and takes each state once', async () => {
    const url = new URL((await api('/api/openrouter/start', {})).body.url);
    const back = `/openrouter/callback?code=the-code&state=${url.searchParams.get('state')}`;
    const reply = await visit(onboard, back);
    assert.equal(reply.status, 200);
    assert.match(reply.type, /^text\/html/);
    assert.match(reply.body, /OpenRouter is connected\. You can close this tab\./);
    assert.ok(!reply.body.includes(KEY) && !reply.body.includes(KEY.slice(-4)) && !reply.body.includes('<script'), reply.body);
    const sent = exchanges.at(-1)!;
    assert.equal(sent.code, 'the-code');
    assert.equal(sent.code_challenge_method, 'S256');
    assert.equal(createHash('sha256').update(sent.code_verifier!).digest('base64url'), url.searchParams.get('code_challenge'));
    assert.ok(readFileSync(paths.answers, 'utf8').includes(`OPENROUTER_API_KEY=${KEY}\n`));

    const count = exchanges.length;
    assert.equal((await visit(onboard, back)).status, 400);
    assert.equal((await visit(onboard, '/openrouter/callback?code=x&state=made-up')).status, 400);
    assert.equal(exchanges.length, count);
  });

  it('keeps the saved key and says so when OpenRouter refuses the code or sends no key', async () => {
    for (const code of ['refused', 'keyless']) {
      const url = new URL((await api('/api/openrouter/start', {})).body.url);
      const reply = await visit(onboard, `/openrouter/callback?code=${code}&state=${url.searchParams.get('state')}`);
      assert.equal(reply.status, 400, code);
      assert.doesNotMatch(reply.body, /OpenRouter is connected/);
      assert.match(reply.body, /Connect OpenRouter again/);
      assert.ok(readFileSync(paths.answers, 'utf8').includes(`OPENROUTER_API_KEY=${KEY}\n`), code);
    }
  });

  it('ticks a step once all its answers and secrets are set, but never one with a check or with no fields', async () => {
    assert.equal((await api('/api/answer', { key: 'BWAT_BOT_NAME', value: 'bwat' })).status, 200);
    await api('/api/checks');
    assert.equal(readState(paths.state).steps.fields, undefined, 'its secret is still blank');
    assert.equal((await api('/api/secret', { key: 'ZOOM_CLIENT_SECRET', value: 'zoom-secret-0123456789' })).status, 200);
    await api('/api/checks');
    const steps = readState(paths.state).steps;
    assert.equal(steps.fields?.state, 'done');
    assert.equal(steps.fields?.by, 'check');
    assert.equal(steps.checked, undefined);
    assert.equal(steps.empty, undefined);
  });
});
