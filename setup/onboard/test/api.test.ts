import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { start, type Onboard } from '../server.ts';
import { platformTags } from '../platform.ts';
import { writeState } from '../state.ts';
import { SERVER_GUIDE } from '../flow.ts';

const HELLO = 'echo "Step 1 of 7: Your address"; echo "port 8080, password pg-password-0123456789"; exit 4';

describe('the onboarding API', () => {
  let onboard: Onboard;
  let dir: string;
  let paths: { state: string; answers: string; env: string; logs: string };
  const token = 'c'.repeat(64);
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${onboard.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${onboard.port}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'onboard-'));
    paths = { state: join(dir, 'onboard/state.json'), answers: join(dir, 'bwat.answers'), env: join(dir, '.env'), logs: join(dir, 'logs') };
    writeFileSync(paths.env, 'BWAT_EDGE_PORT=8080\nPOSTGRES_PASSWORD=pg-password-0123456789\n');
    onboard = await start({ token, paths, cwd: dir, commands: new Map([
      ['hello', HELLO],
    ]) });
  });
  after(() => onboard.close());
  beforeEach(() => {
    writeFileSync(paths.answers, '# comment\nBWAT_PUBLIC_URL=\nBWAT_GOOGLE_CLIENT_SECRET=fakegc-abcdefghijklmnopqrstuvwxyz12\nBWAT_BOT_NAME=bwat\nZOOM_CLIENT_SECRET=\nOPENROUTER_API_KEY=\n', { mode: 0o600 });
  });

  it('serves the guide: the flows and each step with its rendered text', async () => {
    const { status, body } = await api('/api/guide');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.flows as object), ['local']);
    const steps = body.steps as { id: string; html: string }[];
    assert.ok(steps.some((s) => s.id === 'install' && s.html.includes('data-run="setup"')));
    assert.ok(Array.isArray(body.shots));
    assert.deepEqual(body.platform, platformTags(), 'which computer this is, for the bwat:os blocks');
  });

  it('the guide reports each condition from the answers', async () => {
    const at = async () => (await api('/api/guide')).body.conditions as Record<string, { label: string; applies: boolean | null }>;
    let c = await at();
    assert.deepEqual(c['board-app'], { label: 'the address is https', applies: null });
    assert.equal(c.production!.applies, null);
    writeFileSync(paths.answers, 'BWAT_PUBLIC_URL=https://bwat.example.com\nBWAT_MODE=developer\n');
    c = await at();
    assert.equal(c['board-app']!.applies, true);
    assert.equal(c.production!.applies, false);
    writeFileSync(paths.answers, 'BWAT_PUBLIC_URL=http://localhost:8080\nBWAT_MODE=production\n');
    c = await at();
    assert.equal(c['board-app']!.applies, false);
    assert.equal(c.production!.applies, true);
  });

  it('the guide serves the master\'s parts and its first step is before-you-start', async () => {
    const body = (await api('/api/guide')).body;
    const parts = body.parts as { id: string; title: string; html: string }[];
    assert.deepEqual(parts.map((p) => p.id), ['start', 'modes', 'download', 'address-intro', 'google-intro', 'zoom-intro', 'who-can-sign-in', 'delete-answers', 'teammates', 'troubleshooting']);
    assert.ok(parts.every((p) => p.title && p.html && Object.keys(p).length === 3));
    assert.equal((body.steps as { id: string }[])[0]!.id, 'before-you-start');
  });

  it('keeps the chosen flow and ticked steps on disk, mode 600, across a restart', async () => {
    assert.equal((await api('/api/flow', { flow: 'local' })).status, 200);
    assert.equal((await api('/api/step', { id: 'install', state: 'done' })).status, 200);
    assert.equal(statSync(paths.state).mode & 0o777, 0o600);
    const again = await start({ token: 'd'.repeat(64), paths });
    try {
      const res = await fetch(`http://127.0.0.1:${again.port}/api/state`, { headers: { authorization: `Bearer ${'d'.repeat(64)}` } });
      const state = await res.json() as { flow: string; steps: Record<string, { state: string; by: string }> };
      assert.equal(state.flow, 'local');
      assert.equal(state.steps.install?.state, 'done');
      assert.equal(state.steps.install?.by, 'person');
    } finally { await again.close(); }
    assert.equal((await api('/api/step', { id: 'install', state: 'todo' })).status, 200);
    assert.deepEqual((await api('/api/state')).body.steps, {});
  });

  it('refuses an unknown flow, step or state', async () => {
    assert.equal((await api('/api/flow', { flow: 'moon' })).status, 400);
    assert.equal((await api('/api/flow', { flow: 'constructor' })).status, 400);
    assert.equal((await api('/api/step', { id: 'nope', state: 'done' })).status, 400);
    assert.equal((await api('/api/step', { id: 'install', state: 'running' })).status, 400);
  });

  it('shows plain answers and never a secret, not even that one is there', async () => {
    const { body } = await api('/api/answers');
    assert.equal(body.file, true);
    const values = body.values as Record<string, string>;
    assert.equal(values.BWAT_BOT_NAME, 'bwat');
    assert.equal(values.BWAT_PUBLIC_URL, '');
    assert.ok(!('BWAT_GOOGLE_CLIENT_SECRET' in values));
    assert.doesNotMatch(JSON.stringify(body), /fakegc|abcdefghij/);
  });

  it('shows the address setup saved, once it has moved bwat past a busy port', async () => {
    writeFileSync(paths.answers, 'BWAT_PUBLIC_URL=http://localhost:8080\nBWAT_EDGE_PORT=8080\n');
    writeFileSync(paths.env, 'BWAT_PUBLIC_URL=http://localhost:8081\nBWAT_EDGE_PORT=8081\nPOSTGRES_PASSWORD=pg-password-0123456789\n');
    try {
      const values = (await api('/api/answers')).body.values as Record<string, string>;
      assert.equal(values.BWAT_PUBLIC_URL, 'http://localhost:8081');
      assert.equal(values.BWAT_EDGE_PORT, '8081');
    } finally {
      writeFileSync(paths.env, 'BWAT_EDGE_PORT=8080\nPOSTGRES_PASSWORD=pg-password-0123456789\n');
    }
  });

  it('writes a plain answer into its line, keeping the rest of the file and its mode', async () => {
    assert.equal((await api('/api/answer', { key: 'BWAT_PUBLIC_URL', value: 'https://bwat.example.com' })).status, 200);
    assert.equal(readFileSync(paths.answers, 'utf8'),
      '# comment\nBWAT_PUBLIC_URL=https://bwat.example.com\nBWAT_GOOGLE_CLIENT_SECRET=fakegc-abcdefghijklmnopqrstuvwxyz12\nBWAT_BOT_NAME=bwat\nZOOM_CLIENT_SECRET=\nOPENROUTER_API_KEY=\n');
    assert.equal(statSync(paths.answers).mode & 0o777, 0o600);
  });

  it('refuses to write a secret, an unknown key, or a value with a line break', async () => {
    assert.equal((await api('/api/answer', { key: 'BWAT_GOOGLE_CLIENT_SECRET', value: 'x' })).status, 400);
    assert.equal((await api('/api/answer', { key: 'NOT_A_KEY', value: 'x' })).status, 400);
    assert.equal((await api('/api/answer', { key: 'BWAT_PUBLIC_URL', value: 'a\nBWAT_TLS=caddy' })).status, 400);
    assert.match(readFileSync(paths.answers, 'utf8'), /^BWAT_PUBLIC_URL=$/m);
  });

  it('shows whether each secret is set by its mask alone', async () => {
    const { body } = await api('/api/secrets');
    assert.deepEqual(body.BWAT_GOOGLE_CLIENT_SECRET, { set: true, hidden: 31, last4: 'yz12' });
    assert.deepEqual(body.OPENROUTER_API_KEY, { set: false, hidden: 0, last4: null });
    assert.doesNotMatch(JSON.stringify(body), /fakegc|abcdefghij/);
  });

  it('saves a secret through setup/secret, answering with its mask only', async () => {
    const value = 'sk-or-v1-' + '0123456789'.repeat(6) + '9f3c';
    const { status, body } = await api('/api/secret', { key: 'OPENROUTER_API_KEY', value });
    assert.equal(status, 200);
    assert.deepEqual(body, { key: 'OPENROUTER_API_KEY', set: true, hidden: 69, last4: '9f3c' });
    assert.ok(readFileSync(paths.answers, 'utf8').includes(`OPENROUTER_API_KEY=${value}\n`));
    assert.equal(statSync(paths.answers).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(await api('/api/secrets')), /0123456789/);
  });

  it('refuses a plain key, or a value with characters no credential has, and never echoes the value', async () => {
    const plain = await api('/api/secret', { key: 'BWAT_PUBLIC_URL', value: 'abcdefghijklmnop' });
    assert.equal(plain.status, 400);
    const bad = await api('/api/secret', { key: 'ZOOM_CLIENT_SECRET', value: 'abc def"ghijklmnop' });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(JSON.stringify(bad.body), /ghijklmnop/);
    assert.match(readFileSync(paths.answers, 'utf8'), /^BWAT_PUBLIC_URL=$/m);
  });

  it('runs a guide command by id and streams it, masking .env\'s secrets but not its port', async () => {
    const stream = await fetch(`http://127.0.0.1:${onboard.port}/api/events`, { headers: { authorization: `Bearer ${token}` } });
    assert.match(String(stream.headers.get('content-type')), /^text\/event-stream/);
    assert.equal(stream.headers.get('cache-control'), 'no-store');
    const reader = stream.body!.getReader();
    assert.equal((await api('/api/run', { id: 'hello' })).status, 400); // the command text is required
    assert.equal((await api('/api/run', { id: 'hello', command: HELLO })).status, 202);
    let text = '';
    while (!text.includes('"type":"exit"')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(text, /"type":"progress","id":"hello","step":1,"of":7,"title":"Your address"/);
    assert.match(text, /port 8080, password \*{18}6789/);
    assert.doesNotMatch(text, /pg-password/);
    assert.match(text, /"type":"exit","id":"hello","exit":4/);
    const runs = (await api('/api/runs')).body as { runs: { id: string; exit: number; lines: string[] }[] };
    assert.equal(runs.runs[0]!.exit, 4);
    const state = (await api('/api/state')).body as { runs: Record<string, { exit: number }> };
    assert.equal(state.runs.hello!.exit, 4);
  });

  it('refuses a command that is not the guide\'s', async () => {
    assert.equal((await api('/api/run', { id: 'rm -rf /' })).status, 400);
    assert.equal((await api('/api/run', {})).status, 400);
  });

  it('asks for ./bwat prep first when there is no answers file', async () => {
    rmSync(paths.answers);
    assert.equal((await api('/api/answers')).body.file, false);
    const write = await api('/api/answer', { key: 'BWAT_PUBLIC_URL', value: 'x' });
    assert.equal(write.status, 409);
    assert.match(String(write.body.error), /\.\/bwat prep/);
  });
});

describe('a master edited while the page runs', () => {
  const token = 'd'.repeat(64);
  const text = (title: string, extra = '') => `# t\n\n<!-- bwat:step id=one flows=local title="${title}" -->\nFirst.\n<!-- bwat:end -->\n\n<!-- bwat:step id=two flows=local title="Second" -->\nSecond.\n<!-- bwat:end -->\n${extra}`;
  let n = 0;
  async function boot() {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-master-'));
    const master = join(dir, 'master.md');
    const paths = { state: join(dir, 'onboard/state.json'), answers: join(dir, 'bwat.answers'), env: join(dir, '.env'), logs: join(dir, 'logs') };
    writeFileSync(paths.answers, 'BWAT_MODE=developer\n');
    writeFileSync(master, text('First'));
    const onboard = await start({ token, paths, cwd: dir, master });
    const api = async (path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${onboard.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${onboard.port}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
    // A distinct modified time, whatever the file system's resolution.
    const write = (content: string) => { writeFileSync(master, content); utimesSync(master, new Date(), new Date(Date.now() + ++n * 5000)); };
    return { onboard, api, write, paths };
  }

  it('an edited master shows on the next request, ticks kept', async () => {
    const t = await boot();
    try {
      await t.api('/api/flow', { flow: 'local' });
      await t.api('/api/step', { id: 'one', state: 'done' });
      assert.equal((await t.api('/api/guide')).body.steps[0].title, 'First');
      t.write(text('First, reworded').replace(/<!-- bwat:step id=two[^]*?bwat:end -->\n/, ''));
      const guide = (await t.api('/api/guide')).body;
      assert.deepEqual(guide.steps.map((s: any) => [s.id, s.title]), [['one', 'First, reworded']]);
      assert.equal((await t.api('/api/state')).body.steps.one.state, 'done');
      assert.equal((await t.api('/api/step', { id: 'two', state: 'done' })).status, 400);
    } finally { await t.onboard.close(); }
  });

  it('a master with an error keeps the last good guide, and says so once', async () => {
    const t = await boot();
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      t.write('# t\n\n<!-- bwat:step id=one flows=local title="Broken" -->\n<!-- bwat:answer NOT_A_KEY -->\n<!-- bwat:end -->\n');
      for (let i = 0; i < 3; i++) assert.equal((await t.api('/api/guide')).body.steps[0].title, 'First');
      assert.equal(errors.length, 1);
      assert.match(errors[0]!, /NOT_A_KEY/);
    } finally { console.error = original; await t.onboard.close(); }
  });

  it('a master deleted while the page runs keeps the last good guide', async () => {
    const t = await boot();
    const original = console.error;
    console.error = () => {};
    try {
      rmSync(join(t.paths.state, '..', '..', 'master.md'));
      const guide = await t.api('/api/guide');
      assert.equal(guide.status, 200);
      assert.equal(guide.body.steps[0].title, 'First');
    } finally { console.error = original; await t.onboard.close(); }
  });

  it('a command edited while the person decides is not run; nothing runs', async () => {
    const t = await boot();
    const run = (command: string) => `# t\n\n<!-- bwat:step id=one flows=local title="One" -->\n\`\`\`sh {bwat-run=go}\n${command}\n\`\`\`\n<!-- bwat:end -->\n`;
    t.write(run('./bwat prep --check'));
    const events = await fetch(`http://127.0.0.1:${t.onboard.port}/api/events`, { headers: { authorization: `Bearer ${token}` } });
    const reader = events.body!.getReader();
    try {
      const pending = t.api('/api/llm/run', { id: 'go' });
      let buffer = '';
      let request = '';
      while (!request) {
        buffer += new TextDecoder().decode((await reader.read()).value);
        request = buffer.match(/"type":"allow","request":"([^"]+)"/)?.[1] ?? '';
      }
      t.write(run('./bwat prep --other'));
      await t.api('/api/allow', { request, allow: true });
      const answer = await pending;
      assert.deepEqual(answer.body, { id: 'go', ran: false, detail: 'The command changed while waiting; ask again.' });
      assert.deepEqual((await t.api('/api/runs')).body.runs, []);
    } finally { await reader.cancel(); await t.onboard.close(); }
  });

  for (const route of ['/api/flow']) {
    it(`choosing a flow through ${route} sets BWAT_MODE and tells the page (key only)`, async () => {
      const t = await boot();
      const events = await fetch(`http://127.0.0.1:${t.onboard.port}/api/events`, { headers: { authorization: `Bearer ${token}` } });
      const reader = events.body!.getReader();
      const mode = () => readFileSync(t.paths.answers, 'utf8').trim();
      try {
        let buffer = '';
        const heard = async () => {
          const until = Date.now() + 2000;
          while (!buffer.includes('"type":"answer","key":"BWAT_MODE"') && Date.now() < until) {
            const chunk = await Promise.race([reader.read(), new Promise<{ value?: undefined }>((r) => setTimeout(() => r({}), 300))]);
            if (chunk.value) buffer += new TextDecoder().decode(chunk.value);
          }
          return buffer;
        };
        for (const flow of ['local']) {
          writeFileSync(t.paths.answers, 'BWAT_MODE=production\n');
          buffer = '';
          await t.api(route, { flow });
          assert.equal(mode(), 'BWAT_MODE=developer', flow);
          assert.match(await heard(), /data: \{"type":"answer","key":"BWAT_MODE"\}/);
          assert.doesNotMatch(buffer, /developer/);
        }
      } finally { await reader.cancel(); await t.onboard.close(); }
    });
  }

  it('a new port moves a localhost address with it; any other address stays', async () => {
    const t = await boot();
    try {
      writeFileSync(t.paths.answers, 'BWAT_PUBLIC_URL=http://localhost:8080\nBWAT_EDGE_PORT=8080\n');
      assert.equal((await t.api('/api/answer', { key: 'BWAT_EDGE_PORT', value: '8090' })).status, 200);
      assert.equal(readFileSync(t.paths.answers, 'utf8'), 'BWAT_PUBLIC_URL=http://localhost:8090\nBWAT_EDGE_PORT=8090\n');
      writeFileSync(t.paths.answers, 'BWAT_PUBLIC_URL=https://bwat.example.com\nBWAT_EDGE_PORT=8080\n');
      await t.api('/api/answer', { key: 'BWAT_EDGE_PORT', value: '8091' });
      assert.match(readFileSync(t.paths.answers, 'utf8'), /^BWAT_PUBLIC_URL=https:\/\/bwat\.example\.com$/m);
    } finally { await t.onboard.close(); }
  });

  it('refuses a port that is not a number from 1 to 65535, writing nothing', async () => {
    const t = await boot();
    try {
      const saved = 'BWAT_PUBLIC_URL=http://localhost:8080\nBWAT_EDGE_PORT=8080\n';
      writeFileSync(t.paths.answers, saved);
      for (const value of ['0', '65536', '00080', '80a']) {
        assert.equal((await t.api('/api/answer', { key: 'BWAT_EDGE_PORT', value })).status, 400, value);
      }
      assert.equal(readFileSync(t.paths.answers, 'utf8'), saved);
    } finally { await t.onboard.close(); }
  });

  it('offers Myself only, chosen from the start: a server install is not on the page, and choosing it is refused', async () => {
    const t = await boot();
    try {
      assert.deepEqual(Object.keys((await t.api('/api/guide')).body.flows), ['local']);
      for (const route of ['/api/flow']) {
        const refused = await t.api(route, { flow: 'server' });
        assert.equal(refused.status, 400, route);
        assert.ok(refused.body.error.includes(`run it on the server, following ${SERVER_GUIDE}`), route);
      }
      assert.equal((await t.api('/api/state')).body.flow, 'local');
    } finally { await t.onboard.close(); }
  });

  it('has one view, so there is no view to choose', async () => {
    const t = await boot();
    try {
      assert.equal((await t.api('/api/view', { view: 'technical' })).status, 404);
    } finally { await t.onboard.close(); }
  });

  it('trying it on this computer fills the address and TLS answers itself, at the port prep picked', async () => {
    const t = await boot();
    try {
      writeFileSync(t.paths.answers, 'BWAT_MODE=production\nBWAT_PUBLIC_URL=\nBWAT_TLS=\nBWAT_EDGE_PORT=8081\n');
      await t.api('/api/flow', { flow: 'local' });
      assert.equal(readFileSync(t.paths.answers, 'utf8'),
        'BWAT_MODE=developer\nBWAT_PUBLIC_URL=http://localhost:8081\nBWAT_TLS=external\nBWAT_EDGE_PORT=8081\n');
    } finally { await t.onboard.close(); }
  });

  it('a look at trying it on this computer keeps an address the person saved', async () => {
    const t = await boot();
    try {
      const saved = 'BWAT_MODE=developer\nBWAT_PUBLIC_URL=https://x.example.com\nBWAT_TLS=caddy\nBWAT_EDGE_PORT=8081\n';
      writeFileSync(t.paths.answers, saved);
      await t.api('/api/flow', { flow: 'local' });
      await t.api('/api/flow', { flow: 'local' });
      assert.equal(readFileSync(t.paths.answers, 'utf8'), saved);
    } finally { await t.onboard.close(); }
  });

  it('Myself is the local tier, with no Google (D202)', async () => {
    const t = await boot();
    try {
      writeFileSync(t.paths.answers, 'BWAT_MODE=developer\nBWAT_TIER=\nBWAT_PUBLIC_URL=\nBWAT_TLS=\nBWAT_EDGE_PORT=8080\n');
      await t.api('/api/flow', { flow: 'local' });
      assert.match(readFileSync(t.paths.answers, 'utf8'), /^BWAT_TIER=local$/m);
    } finally { await t.onboard.close(); }
  });

  it('shows the sign-in code setup left once, then deletes it', async () => {
    const t = await boot();
    try {
      const file = join(t.paths.logs, '..', 'signin-code');
      assert.equal((await t.api('/api/signin-code', {})).status, 404);
      writeFileSync(file, 'ABCD-EFGH-JKLM-NPQR\n', { mode: 0o600 });
      const shown = await t.api('/api/signin-code', {});
      assert.equal(shown.status, 200);
      assert.deepEqual(shown.body, { code: 'ABCD-EFGH-JKLM-NPQR' });
      assert.equal(existsSync(file), false);
      assert.equal((await t.api('/api/signin-code', {})).status, 404);
    } finally { await t.onboard.close(); }
  });

  for (const route of ['/api/flow']) {
    it(`a flow chosen through ${route} before bwat.answers exists sets BWAT_MODE once prep has written it`, async () => {
      const t = await boot();
      const events = await fetch(`http://127.0.0.1:${t.onboard.port}/api/events`, { headers: { authorization: `Bearer ${token}` } });
      const reader = events.body!.getReader();
      try {
        rmSync(t.paths.answers);
        await t.api(route, { flow: 'local' });
        assert.equal(existsSync(t.paths.answers), false);
        writeFileSync(t.paths.answers, 'BWAT_MODE=production\n'); // left from an earlier install, from outside the page
        const guide = await t.api('/api/guide');
        assert.equal(readFileSync(t.paths.answers, 'utf8').trim(), 'BWAT_MODE=developer');
        assert.equal(guide.body.conditions.production.applies, false);
        assert.equal((await t.api('/api/state')).body.modePending, undefined);
        let buffer = '';
        const until = Date.now() + 2000;
        while (!buffer.includes('"type":"answer","key":"BWAT_MODE"') && Date.now() < until) {
          const chunk = await Promise.race([reader.read(), new Promise<{ value?: undefined }>((r) => setTimeout(() => r({}), 300))]);
          if (chunk.value) buffer += new TextDecoder().decode(chunk.value);
        }
        assert.match(buffer, /data: \{"type":"answer","key":"BWAT_MODE"\}/);
        assert.doesNotMatch(buffer, /developer/);
      } finally { await reader.cancel(); await t.onboard.close(); }
    });
  }

  it('a mode the person saves themselves wins over the one a flow is waiting to set', async () => {
    const t = await boot();
    try {
      rmSync(t.paths.answers);
      await t.api('/api/flow', { flow: 'local' });
      writeFileSync(t.paths.answers, 'BWAT_MODE=production\n');
      await t.api('/api/answer', { key: 'BWAT_MODE', value: 'production' });
      await t.api('/api/guide');
      assert.equal(readFileSync(t.paths.answers, 'utf8').trim(), 'BWAT_MODE=production');
    } finally { await t.onboard.close(); }
  });

  it('a flow chosen before bwat.answers exists is kept and writes nothing', async () => {
    const t = await boot();
    try {
      rmSync(t.paths.answers);
      assert.equal((await t.api('/api/flow', { flow: 'local' })).status, 200);
      assert.equal((await t.api('/api/state')).body.flow, 'local');
    } finally { await t.onboard.close(); }
  });

  it('the Run button refuses a command other than the one it showed', async () => {
    const t = await boot();
    try {
      t.write('# t\n\n<!-- bwat:step id=one flows=local title="One" -->\n```sh {bwat-run=go}\n./bwat prep --check\n```\n<!-- bwat:end -->\n');
      const r = await t.api('/api/run', { id: 'go', command: 'echo bye' }); assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.deepEqual((await t.api('/api/runs')).body.runs, []);
      assert.equal((await t.api('/api/run', { id: 'go', command: './bwat prep --check' })).status, 202);
    } finally { await t.onboard.close(); }
  });

  it('has no route that lets Claude move the page, fill it in or tick a step', async () => {
    const t = await boot();
    try {
      for (const route of ['/api/llm/show', '/api/llm/point', '/api/llm/tick', '/api/llm/flow', '/api/llm/request-secret']) {
        assert.equal((await t.api(route, { step: 'one', link: 0, flow: 'local', key: 'ZOOM_CLIENT_SECRET' })).status, 404, route);
      }
    } finally { await t.onboard.close(); }
  });
});

describe('the panels page (QOR-5052)', () => {
  const token = 'e'.repeat(64);
  const master = '# t\n\n<!-- bwat:step id=one flows=local title="One" -->\nFirst.\n<!-- bwat:end -->\n';
  const credential = 'bwi_' + 'k'.repeat(43);
  async function boot(answers: string, extra: { claude?: () => boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-panels-'));
    const paths = { state: join(dir, 'onboard/state.json'), answers: join(dir, 'bwat.answers'), env: join(dir, '.env'), logs: join(dir, 'logs') };
    writeFileSync(join(dir, 'master.md'), master);
    writeFileSync(paths.answers, answers);
    writeState(paths.state, { version: 1, flow: 'local', steps: {}, install: { credential } });
    // bwat answers, the owner has signed in, and Claude Code has connected once extra.claude says so.
    const stub = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === '/health') return new Response('{}', { status: 200 });
      if (path === '/v1/install/status') {
        return Response.json({ owner_signed_in: true, claude_connected: extra.claude?.() ?? false, zoom: { ready: true, problems: [] }, cards: 0, meeting_transcribed: false });
      }
      if (path === '/v1/install/revoke') return new Response(null, { status: 204 });
      return new Response('{}', { status: 401 });
    }) as typeof fetch;
    const onboard = await start({
      token, paths, cwd: dir, master: join(dir, 'master.md'), fetch: stub,
      commands: new Map([['prep-manifests', 'echo prepped']]), sdk: { auto: false, exec: () => Promise.reject(new Error('no docker')) },
    });
    const api = async (path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${onboard.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${onboard.port}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
    return { onboard, api, paths };
  }

  it("saves the owner's email as Zoom's contact email too, and then writes the manifest", async () => {
    const t = await boot('BWAT_FIRST_OWNER_EMAIL=\nBWAT_ZOOM_COMPANY=Example\nBWAT_ZOOM_CONTACT_NAME=Ada\nBWAT_ZOOM_CONTACT_EMAIL=\n');
    try {
      assert.equal((await t.api('/api/answer', { key: 'BWAT_FIRST_OWNER_EMAIL', value: 'ada@example.com' })).status, 200);
      assert.match(readFileSync(t.paths.answers, 'utf8'), /^BWAT_ZOOM_CONTACT_EMAIL=ada@example\.com$/m);
      const runs = (await t.api('/api/runs')).body.runs.map((r: { id: string }) => r.id);
      assert.ok(runs.includes('prep-manifests'), `prep-manifests ran: ${runs.join(', ')}`);
      // A changed email changes the contact too, not only a blank one.
      assert.equal((await t.api('/api/answer', { key: 'BWAT_FIRST_OWNER_EMAIL', value: 'ada@example.org' })).status, 200);
      assert.match(readFileSync(t.paths.answers, 'utf8'), /^BWAT_ZOOM_CONTACT_EMAIL=ada@example\.org$/m);
    } finally { await t.onboard.close(); }
  });

  it('deletes what setup kept only once Claude Code has connected, not just once the owner signed in', async () => {
    let claude = false;
    const t = await boot('BWAT_MODE=developer\n', { claude: () => claude });
    try {
      assert.equal((await t.api('/api/destroy', {})).status, 409);
      assert.ok(existsSync(t.paths.answers));
      claude = true;
      assert.equal((await t.api('/api/destroy', {})).status, 200);
      assert.equal(existsSync(t.paths.answers), false);
    } finally { await t.onboard.close(); }
  });
});
