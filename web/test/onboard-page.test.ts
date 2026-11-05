// The onboarding page's script (setup/onboard/static/page.js), loaded into jsdom as the
// board's scripts are. The server it talks to is setup/onboard/server.ts; here a stand-in
// api records the calls.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const STATIC = join(import.meta.dirname, '..', '..', 'setup', 'onboard', 'static');

type Call = { path: string; init?: { method?: string; body?: unknown } };
type Page = {
  render: (root: Element, data: unknown, ctx: unknown) => void;
  applyRunEvent: (panels: unknown, event: unknown) => void;
  applyChecks: (root: Element, results: unknown) => void;
  applyPageEvent: (root: Element, event: unknown, ctx: unknown) => void;
  connection: (document: Document, ok: boolean) => void;
};
type Check = { ok: boolean; detail: string };

const step = (id: string, title: string, html: string, more: Record<string, unknown> = {}) => ({
  id, title, flows: ['local'], when: null, answers: [], secrets: [], checks: [], shots: [], runs: [], html, ...more,
});

// The guide's steps in the master's order, as /api/guide answers them.
const guide = {
  flows: { local: 'Try it on this computer' },
  shots: [{ name: 'zoom-app', url: 'https://marketplace.zoom.us/', caption: 'The app credentials.', labels: [] }],
  parts: [{ id: 'troubleshooting', title: 'Troubleshooting', html: '<p>When something goes wrong.</p>' }],
  steps: [
    step('before-you-start', 'Before you start', '<p>About 20 minutes.</p>'),
    step('prerequisites', 'Prerequisites', '<p>Docker Desktop, running.</p>'),
    step('owner-local', 'Name the owner', '<div class="bwat-answer" data-key="BWAT_FIRST_OWNER_EMAIL"></div><p>The email you sign in with.</p>'),
    step('company', 'Name the bot', '<p>People see these names in Zoom.</p><div class="bwat-answer" data-key="BWAT_ZOOM_CONTACT_NAME"></div>'
      + '<div class="bwat-answer" data-key="BWAT_BOT_NAME"></div><div class="bwat-answer" data-key="BWAT_ZOOM_COMPANY"></div>'
      + '<div class="bwat-flows" data-flows="server"><div class="bwat-answer" data-key="BWAT_ZOOM_CONTACT_EMAIL"></div></div>'
      + '<div class="bwat-run" data-run="prep-manifests"><pre><code>./bwat prep</code></pre></div>',
    { runs: [{ id: 'prep-manifests', command: './bwat prep' }] }),
    step('zoom-main', 'Create the Zoom app <b>now</b>', '<ol><li>Open <a href="https://marketplace.zoom.us/" target="_blank" rel="noopener noreferrer">Zoom</a>.</li><li>Add the app to your account.</li></ol>'
      + '<figure class="bwat-shot" data-shot="zoom-app"></figure>'
      + '<div class="bwat-answer" data-key="ZOOM_CLIENT_ID"></div><div class="bwat-secret" data-key="ZOOM_CLIENT_SECRET"></div>'
      + '<p>Redirect URL: <code>&lt;address&gt;/auth/zoom</code></p>'
      + '<details class="bwat-more"><summary>More detail</summary><p>Why Zoom asks.</p></details>',
    { secrets: ['ZOOM_CLIENT_SECRET'] }),
    step('zoom-sdk', 'Download the Meeting SDK', '<p>Download it.</p>'),
    step('zoom-account', 'Check the Zoom account settings', '<table><tr><th>Setting</th><th>What bwat needs</th></tr><tr><td>Recording</td><td>Local recording on.</td></tr></table>'),
    step('model-key', 'Connect OpenRouter', '<div class="bwat-secret" data-key="OPENROUTER_API_KEY"></div>'
      + '<p>bwat needs credit on your OpenRouter account.</p><div class="bwat-check" data-check="openrouter-key"></div>'),
    step('install', 'Install and start bwat', '<div class="bwat-run" data-run="setup"><pre><code>./bwat setup -y</code></pre></div><div class="bwat-check" data-check="edge-healthy"></div>'
      + '<p>bwat runs at <code>&lt;address&gt;</code>.</p>',
    { runs: [{ id: 'setup', command: './bwat setup -y' }] }),
    step('sign-in', 'Sign in first', '<p>Open <code>&lt;address&gt;</code>.</p>'),
    step('claude-here', 'Connect Claude Code on this computer', '<div class="bwat-run" data-run="plugin"><pre><code>./bwat plugin</code></pre></div>'
      + '<p>Restart Claude Code, then type <code>/bwat:login</code> and <code>/bwat:status</code>.</p><div class="bwat-check" data-check="claude-connected"></div>'
      + '<div class="bwat-run" data-run="plugin-repoint"><pre><code>./bwat plugin --repoint</code></pre></div>',
    { runs: [{ id: 'plugin', command: './bwat plugin' }, { id: 'plugin-repoint', command: './bwat plugin --repoint' }] }),
    { ...step('zoom-add-main', 'Add the main app to your account', '<p>Add it.</p>'), flows: ['server'] },
    step('first-meeting', 'Your <b>first</b> meeting', '<p>Invite bwat.</p><div class="bwat-check" data-check="first-card"></div>'),
  ],
};

const ok = (detail = 'yes'): Check => ({ ok: true, detail });
const SDK_NONE = { file: null, version: null, kind: null, tested: '7.0.2.5001', docker: true, image: 'none', building: false, uploading: false, build: null };
const settle = () => new Promise((r) => setTimeout(r, 0));

type Options = {
  values?: Record<string, string>; file?: boolean; steps?: Record<string, unknown>; secrets?: Record<string, unknown>;
  sdkFile?: string | null; checks?: Record<string, Check>; problems?: string[]; last?: Record<string, unknown>;
  replies?: Record<string, unknown>; secretFields?: boolean;
};

// The seven panels in order, and what makes each one done.
const ORDER = ['model-key', 'company', 'zoom-main', 'zoom-sdk', 'install', 'sign-in', 'claude-here'] as const;
const TITLES = ['Connect OpenRouter', 'Name your bwat', 'Create the Zoom app', 'Download the Meeting SDK', 'Install bwat', 'Sign in', 'Connect Claude Code'];
const DONE: Record<(typeof ORDER)[number], Options> = {
  'model-key': { checks: { 'openrouter-key': ok() } },
  company: { values: { BWAT_FIRST_OWNER_EMAIL: 'a@example.com', BWAT_ZOOM_CONTACT_NAME: 'Ada', BWAT_BOT_NAME: 'bwat', BWAT_ZOOM_COMPANY: 'Example', BWAT_ZOOM_CONTACT_EMAIL: 'a@example.com' } },
  'zoom-main': { values: { ZOOM_CLIENT_ID: 'id' }, secrets: { ZOOM_CLIENT_SECRET: { set: true, hidden: 20, last4: 'abcd' } }, steps: { 'zoom-main': { state: 'done', by: 'person', at: '2026-11-03T00:00:00Z' } } },
  'zoom-sdk': { sdkFile: 'zoom-sdk.tar.xz' },
  install: { checks: { 'edge-healthy': ok() }, last: { setup: { lines: ['done'], exit: 0 } } },
  'sign-in': { checks: { 'owner-signed-in': ok() } },
  'claude-here': { checks: { 'claude-connected': ok() } },
};
function merge(...all: Options[]): Options {
  const out: Options = {};
  for (const o of all) {
    for (const [k, v] of Object.entries(o)) {
      const key = k as keyof Options;
      (out as Record<string, unknown>)[key] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(out[key] as object), ...v } : v;
    }
  }
  return out;
}
/** Every step done up to and including id (none for null). */
const upTo = (id: (typeof ORDER)[number] | null, ...extra: Options[]) =>
  merge(...ORDER.slice(0, id ? ORDER.indexOf(id) + 1 : 0).map((s) => DONE[s]), ...extra);

function load(options: Options = {}) {
  const dom = new JSDOM('<!doctype html><main id="root"></main><p id="status"></p>', { runScripts: 'outside-only', url: 'http://127.0.0.1:4000/' });
  const { window } = dom;
  window.eval(readFileSync(join(STATIC, 'page.js'), 'utf8'));
  const calls: Call[] = [];
  const counts = { recheck: 0, reload: 0, hints: 0 };
  const replies: Record<string, unknown> = { '/api/sdk': SDK_NONE, ...options.replies };
  const document = window.document;
  const ctx = {
    // A reply that is an Error is a refusal.
    api: (path: string, init?: Call['init']) => {
      calls.push({ path, ...(init ? { init } : {}) });
      return replies[path] instanceof Error ? Promise.reject(replies[path]) : Promise.resolve(replies[path] ?? { ok: true });
    },
    reload: () => { counts.reload++; return Promise.resolve(); },
    recheck: () => { counts.recheck++; },
    splitHint: () => { counts.hints++; },
    runs: { panels: {} as Record<string, unknown>, last: options.last ?? {} },
    secretField: options.secretFields === false ? undefined : (key: string) => {
      const wrap = document.createElement('div');
      wrap.className = 'onboard-field onboard-secret';
      wrap.innerHTML = `<label class="field-label" for="secret-${key}"><span aria-hidden="true">🔒 </span>${key}</label><input id="secret-${key}" type="password"><p class="draft-status"></p>`;
      return wrap;
    },
  };
  const root = document.getElementById('root')!;
  const page = (window as unknown as { bwatOnboard: Page }).bwatOnboard;
  const data = () => ({
    guide,
    state: { version: 1, steps: options.steps ?? {} },
    answers: { file: options.file ?? true, values: options.values ?? {} },
    secrets: options.secrets ?? {},
    sdkFile: options.sdkFile ?? null,
    checks: options.checks ?? {},
    problems: options.problems ?? [],
  });
  const draw = () => page.render(root, data(), ctx);
  draw();
  const panel = () => root.querySelector('[data-panel]');
  const shown = () => panel()?.getAttribute('data-panel') ?? null;
  const posts = (path: string) => calls.filter((c) => c.path === path && c.init?.method === 'POST');
  const dots = () => [...root.querySelectorAll('[data-dot]')] as HTMLButtonElement[];
  const counter = () => root.querySelector('.onboard-counter')!.textContent;
  return { window, document, root, page, ctx, calls, counts, draw, panel, shown, posts, dots, counter, options };
}

const visibleButtons = (root: Element) => [...root.querySelectorAll('button')].filter((b) => !b.hidden && !b.closest('[hidden]')).map((b) => b.textContent);

describe('the onboarding page', () => {
  it('shows one panel, the first step not done, under the progress: three labelled groups of dots and "Step N of 7"', () => {
    const { root, shown, dots, counter } = load();
    expect(root.querySelectorAll('[data-panel]')).toHaveLength(1);
    expect(shown()).toBe('model-key');
    expect([...root.querySelectorAll('.onboard-group-label')].map((l) => l.textContent)).toEqual(['OpenRouter', 'Zoom', 'bwat']);
    expect(dots().map((d) => d.getAttribute('data-dot'))).toEqual([...ORDER]);
    expect([...root.querySelectorAll('.onboard-group')].map((g) => g.querySelectorAll('[data-dot]').length)).toEqual([1, 3, 3]);
    expect(counter()).toBe('Step 1 of 7');
    const current = dots()[0]!;
    expect(current.classList.contains('onboard-dot-current')).toBe(true);
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(current.getAttribute('aria-label')).toBe('Step 1: Connect OpenRouter');
  });

  it('moves on by itself as each step is done, in order, with nothing to press', () => {
    ORDER.forEach((id, i) => {
      const page = load(upTo(i === 0 ? null : ORDER[i - 1]!));
      expect(page.shown()).toBe(id);
      expect(page.panel()!.querySelector('h2')!.textContent).toBe(TITLES[i]);
      expect(page.counter()).toBe(`Step ${i + 1} of 7`);
      const buttons = visibleButtons(page.root);
      for (const word of ['Done', 'Mark as done', 'Skip', 'Next', 'Save', 'Back', 'Run']) expect(buttons).not.toContain(word);
    });
  });

  it('the Zoom app moves on only once the person says the manifest is uploaded and the app added', async () => {
    const page = load(upTo('company', { values: { ZOOM_CLIENT_ID: 'id' }, secrets: { ZOOM_CLIENT_SECRET: { set: true } } }));
    const done = page.root.querySelector('[data-confirm]') as HTMLButtonElement;
    expect(done.textContent).toBe('I uploaded the manifest and added the app');
    done.click();
    expect(page.posts('/api/step')[0]!.init!.body).toEqual({ id: 'zoom-main', state: 'done' });
    await settle();
    expect(page.counts.reload).toBe(1);
    expect(page.panel()!.querySelector('.onboard-foot')!.textContent).toContain('you select I uploaded the manifest and added the app');
  });

  it('does not pull back a setup the checks ticked past the Zoom app before the manifest question existed', () => {
    const creds = { values: { ZOOM_CLIENT_ID: 'id' }, secrets: { ZOOM_CLIENT_SECRET: { set: true } } };
    expect(load(upTo('company', { ...creds, steps: { 'zoom-main': { state: 'done', by: 'check', at: '2026-10-30T00:00:00Z' } } })).shown()).toBe('zoom-sdk');
  });

  it('an SDK file already in Downloads does not stand for the manifest upload', () => {
    const creds = { values: { ZOOM_CLIENT_ID: 'id' }, secrets: { ZOOM_CLIENT_SECRET: { set: true } } };
    expect(load(merge(upTo('company', creds), DONE['zoom-sdk'])).shown()).toBe('zoom-main');
  });

  it('asks whether the manifest is uploaded only once the Zoom credentials are saved', () => {
    for (const partial of [{}, { values: { ZOOM_CLIENT_ID: 'id' } }, { secrets: { ZOOM_CLIENT_SECRET: { set: true } } }]) {
      const page = load(upTo('company', partial));
      expect(page.shown()).toBe('zoom-main');
      expect(page.root.querySelector('[data-confirm]'), JSON.stringify(partial)).toBeNull();
    }
  });

  it('a step is done only when all of it is', () => {
    for (const missing of Object.keys(DONE.company.values!)) {
      const values = Object.fromEntries(Object.entries(DONE.company.values!).filter(([key]) => key !== missing));
      expect(load(merge(DONE['model-key'], { values })).shown(), missing).toBe('company');
    }
    expect(load(upTo('company', { values: { ZOOM_CLIENT_ID: 'id' } })).shown()).toBe('zoom-main');
    expect(load(upTo('company', { secrets: { ZOOM_CLIENT_SECRET: { set: true } } })).shown()).toBe('zoom-main');
    // Zoom shows the credentials before the manifest is uploaded: they alone are not the step.
    expect(load(upTo('company', { values: { ZOOM_CLIENT_ID: 'id' }, secrets: { ZOOM_CLIENT_SECRET: { set: true } } })).shown()).toBe('zoom-main');
    // The SDK file is enough: the meeting bot builds in the background.
    expect(load(upTo('zoom-sdk', { checks: { 'bot-built': { ok: false, detail: 'not yet' } } })).shown()).toBe('install');
    // Install: bwat answers and the run, when there is one, exited 0.
    expect(load(upTo('zoom-sdk', { last: { setup: { lines: [], exit: 0 } } })).shown()).toBe('install');
    expect(load(upTo('install', { last: { setup: { lines: [], exit: 2 } } })).shown()).toBe('install');
    expect(load(upTo('install', { last: { setup: { lines: [] } } })).shown()).toBe('install');
  });

  it('ticks a finished group, fills the dots of done steps, and leaves later dots shut', () => {
    const { root, dots } = load(upTo('company'));
    expect([...root.querySelectorAll('.onboard-group-label')].map((l) => l.textContent)).toEqual(['✓ OpenRouter', 'Zoom', 'bwat']);
    expect(root.querySelector('.onboard-group-done .onboard-group-label')!.textContent).toBe('✓ OpenRouter');
    const [model, company, zoom, sdk] = dots();
    expect(model!.classList.contains('onboard-dot-done')).toBe(true);
    expect(company!.classList.contains('onboard-dot-done')).toBe(true);
    expect(zoom!.classList.contains('onboard-dot-current')).toBe(true);
    expect(sdk!.disabled).toBe(true);
  });

  it('a done dot shows its step again, and the current dot comes back', () => {
    const { dots, shown, counter, panel } = load(upTo('company'));
    dots()[0]!.click();
    expect(shown()).toBe('model-key');
    expect(counter()).toBe('Step 1 of 7');
    expect(dots()[0]!.classList.contains('onboard-dot-current')).toBe(true);
    expect(dots()[0]!.getAttribute('aria-current')).toBe('step');
    expect(dots()[2]!.classList.contains('onboard-dot-current')).toBe(false);
    expect(dots()[2]!.hasAttribute('aria-current')).toBe(false);
    expect(panel()!.querySelector('.onboard-connected')!.textContent).toBe('Connected. OpenRouter accepts the key.');
    expect(panel()!.textContent).toContain('bwat needs credit on your OpenRouter account.');
    dots()[2]!.click();
    expect(shown()).toBe('zoom-main');
    dots()[3]!.click();
    expect(shown()).toBe('zoom-main');
  });

  it('a step viewed again that is no longer done gives way to the first step not done', () => {
    const page = load(upTo('company'));
    page.dots()[1]!.click();
    expect(page.shown()).toBe('company');
    // Both OpenRouter and the bot name are gone: the page goes to OpenRouter, not the step viewed.
    page.options.checks = {};
    page.options.values = { ...page.options.values, BWAT_BOT_NAME: '' };
    page.draw();
    expect(page.shown()).toBe('model-key');
  });

  it('names the panel with its own title, and puts a guide step title in as text, never markup', () => {
    const { panel } = load(upTo('company'));
    expect(panel()!.querySelector('h2')!.textContent).toBe('Create the Zoom app');
    const end = load(upTo('claude-here')).root.querySelector('.onboard-end')!;
    expect(end.querySelector('details.bwat-more h3')!.textContent).toBe('Your <b>first</b> meeting');
    expect(end.querySelector('details.bwat-more h3 b')).toBeNull();
  });

  it('Name your bwat asks the owner\'s email, name, bot name and company, and not the contact email', () => {
    const { panel } = load(upTo('model-key'));
    const fields = [...panel()!.querySelectorAll('.onboard-field')].filter((f) => !f.closest('[hidden]'));
    expect(fields.map((f) => f.querySelector('label')!.textContent)).toEqual(['Your email', 'Your name', 'Bot name', 'Company name']);
    expect(panel()!.querySelector('[data-step="company"] p')!.textContent).toBe('People see these names in Zoom.');
  });

  it('Create the Zoom app keeps its numbered steps, its fields and its More detail, folded', () => {
    const { panel } = load(upTo('company'));
    expect([...panel()!.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual(['Open Zoom.', 'Add the app to your account.']);
    expect(panel()!.querySelector('#answer-ZOOM_CLIENT_ID')).not.toBeNull();
    // The friendly name replaces the key, and the 🔒 the guide explains stays (secret-field.js).
    expect(panel()!.querySelector('label[for="secret-ZOOM_CLIENT_SECRET"]')!.textContent).toBe('🔒 Client secret');
    const more = panel()!.querySelector('details.bwat-more') as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain('Why Zoom asks.');
  });

  it('a field saves itself when the person leaves it or presses Enter, only when it changed, and checks again', async () => {
    const { document, window, posts, counts } = load(upTo('model-key'));
    const input = document.getElementById('answer-BWAT_ZOOM_COMPANY') as HTMLInputElement;
    expect(document.querySelector('label[for="answer-BWAT_ZOOM_COMPANY"]')!.textContent).toBe('Company name');
    input.dispatchEvent(new window.Event('change'));
    expect(posts('/api/answer')).toHaveLength(0);
    input.value = 'Example';
    input.dispatchEvent(new window.Event('change'));
    expect(posts('/api/answer')[0]!.init!.body).toEqual({ key: 'BWAT_ZOOM_COMPANY', value: 'Example' });
    expect(input.closest('.onboard-field')!.querySelector('.draft-status')!.textContent).toBe('Saving…');
    await settle();
    expect(input.closest('.onboard-field')!.querySelector('.draft-status')!.textContent).toBe('Saved.');
    expect(counts.recheck).toBe(1);
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    expect(posts('/api/answer')).toHaveLength(1);
    input.value = 'Example Inc';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    expect(posts('/api/answer')).toHaveLength(2);
  });

  it('keeps a field\'s explanation inside the field, describing it', () => {
    const { document } = load(upTo('model-key'));
    const input = document.getElementById('answer-BWAT_FIRST_OWNER_EMAIL')!;
    const help = input.closest('.onboard-field')!.querySelector('.onboard-field-help')!;
    expect(help.textContent).toBe('The email you sign in with.');
    expect(input.getAttribute('aria-describedby')).toContain(help.id);
  });

  it('a failed save shows the server\'s reason', async () => {
    const { document, window, ctx, draw } = load(upTo('model-key'));
    ctx.api = () => Promise.reject(new Error('That is not an email address.'));
    draw();
    const input = document.getElementById('answer-BWAT_FIRST_OWNER_EMAIL') as HTMLInputElement;
    input.value = 'nope';
    input.dispatchEvent(new window.Event('change'));
    await settle();
    expect(input.closest('.onboard-field')!.querySelector('.draft-status')!.textContent).toBe('That is not an email address.');
  });

  it('holds the fields, saying it is getting ready, until the server has made bwat.answers', () => {
    const { document } = load(upTo('model-key', { file: false }));
    const input = document.getElementById('answer-BWAT_ZOOM_COMPANY') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.closest('.onboard-field')!.textContent).toContain('Getting ready…');
  });

  it('hides the commands the server runs itself', () => {
    const { root } = load(upTo('model-key'));
    expect((root.querySelector('[data-run="prep-manifests"]') as HTMLElement).hidden).toBe(true);
  });

  it('Connect OpenRouter opens a tab within the click, then sends it to the server\'s link', async () => {
    const { window, panel, posts } = load({ replies: { '/api/openrouter/start': { url: 'https://openrouter.ai/auth?x=1' } } });
    const tab = { location: '' as unknown };
    window.open = (() => tab) as unknown as typeof window.open;
    const connect = panel()!.querySelector('.onboard-connect') as HTMLButtonElement;
    expect(connect.textContent).toBe('Connect OpenRouter');
    // Above the key's field: the button is the way in, the field shows the key it brings back.
    const key = panel()!.querySelector('#secret-OPENROUTER_API_KEY')!;
    expect(connect.compareDocumentPosition(key) & 4).toBe(4);
    expect(panel()!.querySelector('.onboard-connected')).toBeNull();
    connect.click();
    expect(posts('/api/openrouter/start')).toHaveLength(1);
    await settle();
    expect(tab.location).toBe('https://openrouter.ai/auth?x=1');
  });

  it('once OpenRouter and Zoom are done, setup starts on its own, once, and shows the address', () => {
    const page = load(upTo('zoom-sdk', { values: { BWAT_PUBLIC_URL: 'http://localhost:8081' } }));
    expect(page.shown()).toBe('install');
    expect(page.posts('/api/run').map((c) => c.init!.body)).toEqual([{ id: 'setup', command: './bwat setup -y' }]);
    page.draw();
    expect(page.posts('/api/run')).toHaveLength(1);
    expect(page.panel()!.textContent).toContain('bwat runs at http://localhost:8081.');
    const setup = page.root.querySelector('[data-run="setup"]')!;
    expect(visibleButtons(setup)).toEqual(['Copy']);
    expect(setup.querySelector('details.onboard-tech code')!.textContent).toBe('./bwat setup -y');
  });

  it('starts nothing when setup already ran, bwat already answers, or a step before it is not done', () => {
    expect(load(upTo('zoom-sdk', { last: { setup: { lines: [], exit: 2 } } })).posts('/api/run')).toHaveLength(0);
    expect(load(upTo('zoom-sdk', { checks: { 'edge-healthy': ok() } })).posts('/api/run')).toHaveLength(0);
    expect(load(upTo('zoom-main')).posts('/api/run')).toHaveLength(0);
  });

  it('shows setup\'s output, progress and exit as it runs, as text', () => {
    const { root, page, ctx } = load(upTo('zoom-sdk'));
    expect((root.querySelector('[data-run-fold="setup"]') as HTMLDetailsElement).open).toBe(false);
    page.applyRunEvent(ctx.runs.panels, { type: 'start', id: 'setup' });
    // Running by itself, it shows its output.
    expect((root.querySelector('[data-run-fold="setup"]') as HTMLDetailsElement).open).toBe(true);
    page.applyRunEvent(ctx.runs.panels, { type: 'progress', id: 'setup', step: 2, of: 5, title: 'Building' });
    page.applyRunEvent(ctx.runs.panels, { type: 'line', id: 'setup', line: '<b>pulling</b>' });
    const status = root.querySelector('[data-run="setup"] .onboard-run-status')!;
    expect(status.textContent).toBe('Step 2 of 5: Building');
    const output = root.querySelector('[data-run="setup"] .onboard-output')!;
    expect(output.textContent).toBe('<b>pulling</b>\n');
    expect(output.querySelector('b')).toBeNull();
    page.applyRunEvent(ctx.runs.panels, { type: 'exit', id: 'setup', exit: 2 });
    expect(status.textContent).toBe('Stopped with exit code 2: see the output.');
    expect((root.querySelector('[data-run-fold="setup"]') as HTMLDetailsElement).open).toBe(true);
  });

  it('shows the last run of setup again after a reload', () => {
    const { root } = load(upTo('zoom-sdk', { last: { setup: { lines: ['building'] } } }));
    expect(root.querySelector('[data-run="setup"] .onboard-output')!.textContent).toBe('building\n');
    expect(root.querySelector('[data-run="setup"] .onboard-run-status')!.textContent).toBe('Running…');
  });

  it('shows each check\'s result under its step', () => {
    const { root, page } = load(upTo('zoom-sdk'));
    page.applyChecks(root, { 'edge-healthy': { ok: false, detail: 'bwat is not answering yet.' } });
    expect(root.querySelector('[data-check="edge-healthy"]')!.textContent).toBe('Not yet: bwat is not answering yet.');
  });

  it('once bwat is installed, shows the sign-in code by itself, once, in monospace with a Copy button', async () => {
    const code = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567';
    const page = load(upTo('install', { replies: { '/api/signin-code': { code } } }));
    expect(page.shown()).toBe('sign-in');
    expect(page.root.querySelector('[data-show-code]')).toBeNull();
    page.draw();
    expect(page.posts('/api/signin-code')).toHaveLength(1);
    await settle();
    expect(page.counts.reload).toBeGreaterThan(0);
    page.draw();
    const value = page.root.querySelector('pre.onboard-code-value')!;
    expect(value.textContent).toBe(code);
    expect(value.parentElement!.querySelector('button')!.textContent).toBe('Copy');
    expect(page.posts('/api/signin-code')).toHaveLength(1);
  });

  it('when no sign-in code is waiting, says how to make one, and asks no more on a redraw', async () => {
    const lost = /No new code is waiting.*\.\/bwat setup --new-code/;
    // Refused, or answered with no code.
    for (const reply of [new Error('no code'), {}]) {
      const page = load(upTo('install', { replies: { '/api/signin-code': reply } }));
      await settle();
      expect(page.root.querySelector('[data-signin-code]')!.textContent).toMatch(lost);
      page.draw();
      await settle();
      expect(page.posts('/api/signin-code')).toHaveLength(1);
      expect(page.root.querySelector('[data-signin-code]')!.textContent).toMatch(lost);
    }
  });

  it('puts the saved address in place of <address>, as text, and makes it a link on its own', () => {
    const { root } = load(upTo('install', { values: { BWAT_PUBLIC_URL: 'http://localhost:8080' } }));
    const link = root.querySelector('#step-sign-in a')!;
    expect(link.getAttribute('href')).toBe('http://localhost:8080');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('after sign-in, connects Claude Code by itself, once, and says what to type', () => {
    const page = load(upTo('sign-in'));
    expect(page.shown()).toBe('claude-here');
    expect(page.posts('/api/run').map((c) => c.init!.body)).toEqual([{ id: 'plugin', command: './bwat plugin' }]);
    page.draw();
    expect(page.posts('/api/run')).toHaveLength(1);
    expect(page.panel()!.textContent).toContain('Restart Claude Code, then type /bwat:login and /bwat:status.');
    page.page.applyRunEvent(page.ctx.runs.panels, { type: 'line', id: 'plugin', line: 'The plugin is installed.' });
    expect(page.root.querySelector('[data-run="plugin"] .onboard-output')!.textContent).toBe('The plugin is installed.\n');
  });

  it('a plugin pointed at another bwat is a choice, not a failure: Point it here runs the repoint', async () => {
    const page = load(upTo('sign-in'));
    page.page.applyRunEvent(page.ctx.runs.panels, { type: 'exit', id: 'plugin', exit: 3 });
    const status = page.root.querySelector('[data-run="plugin"] .onboard-run-status')!;
    expect(status.textContent).toContain('points at another bwat');
    expect(status.textContent).not.toContain('Stopped with exit code');
    expect(visibleButtons(page.root)).toContain('Point it here');
    const button = [...page.root.querySelectorAll('button')].find((b) => b.textContent === 'Point it here')!;
    button.click();
    await settle();
    expect(page.posts('/api/run').map((c) => c.init!.body)).toContainEqual({ id: 'plugin-repoint', command: './bwat plugin --repoint' });
    // The repoint shows in the same panel: its output, its failure, then its success.
    page.page.applyRunEvent(page.ctx.runs.panels, { type: 'start', id: 'plugin-repoint' });
    page.page.applyRunEvent(page.ctx.runs.panels, { type: 'line', id: 'plugin-repoint', line: 'configure refused' });
    expect(page.root.querySelector('[data-run="plugin"] .onboard-output')!.textContent).toContain('configure refused');
    page.page.applyRunEvent(page.ctx.runs.panels, { type: 'exit', id: 'plugin-repoint', exit: 1 });
    expect(status.textContent).toBe('Stopped with exit code 1: see the output.');
    expect(visibleButtons(page.root)).toContain('Point it here');
    expect(button.disabled).toBe(false);
    page.page.applyRunEvent(page.ctx.runs.panels, { type: 'exit', id: 'plugin-repoint', exit: 0 });
    expect(status.textContent).toBe('Pointed here. Restart Claude Code, then type /bwat:login.');
    expect(visibleButtons(page.root)).not.toContain('Point it here');
  });

  it('after a reload, a later repoint wins over the stop it answered', () => {
    const page = load(upTo('sign-in', { last: {
      plugin: { lines: [], exit: 3, started: '2026-11-02T10:00:00Z' },
      'plugin-repoint': { lines: [], exit: 0, started: '2026-11-02T10:01:00Z' },
    } }));
    expect(page.root.querySelector('[data-run="plugin"] .onboard-run-status')!.textContent).toBe('Pointed here. Restart Claude Code, then type /bwat:login.');
    expect(visibleButtons(page.root)).not.toContain('Point it here');
  });

  it('a step the server already ticked stays done before the first check, and when a live check fails once', () => {
    const ticked = { state: 'done', by: 'check', at: '2026-11-02T00:00:00Z' };
    expect(load({ steps: { 'model-key': ticked } }).shown()).toBe('company');
    expect(load({ steps: { 'model-key': ticked }, checks: { 'openrouter-key': { ok: false, detail: 'timed out' } } }).shown()).toBe('company');
    const signedIn = upTo('install', { steps: { 'sign-in': ticked }, checks: { 'owner-signed-in': { ok: false, detail: 'timed out' } } });
    expect(load(signedIn).shown()).toBe('claude-here');
    // Skipped means not needed, not done: the live check still decides.
    expect(load({ steps: { 'model-key': { ...ticked, state: 'skipped' } } }).shown()).toBe('model-key');
  });

  it('connects Claude Code only after sign-in, and not when it already ran', () => {
    expect(load(upTo('install')).posts('/api/run')).toHaveLength(0);
    expect(load(upTo('sign-in', { last: { plugin: { lines: [], exit: 0 } } })).posts('/api/run')).toHaveLength(0);
  });

  it('connects Claude Code only when it is the step at hand, not while an earlier one is undone', () => {
    const page = load(merge(upTo('sign-in'), { checks: { 'openrouter-key': { ok: false, detail: 'no' }, 'claude-connected': ok() } }));
    expect(page.shown()).toBe('model-key');
    expect(page.posts('/api/run').filter((c) => (c.init!.body as { id: string }).id === 'plugin')).toHaveLength(0);
  });

  it('shows a shot with a link to open it beside the page, and suggests split view on a vendor link', () => {
    const { root, counts } = load(upTo('company'));
    expect(root.querySelector('[data-shot="zoom-app"] .onboard-open')!.getAttribute('href')).toBe('https://marketplace.zoom.us/');
    (root.querySelector('#step-zoom-main li a') as HTMLAnchorElement).click();
    expect(counts.hints).toBe(1);
  });

  it('a problem with this computer shows at the top, with the prerequisites under More detail', () => {
    const { root } = load({ problems: ['Docker Desktop is not running.'] });
    const banner = root.firstElementChild!;
    expect(banner.classList.contains('onboard-problem')).toBe(true);
    expect(banner.textContent).toContain('Docker Desktop is not running.');
    expect(banner.querySelector('details.bwat-more')!.textContent).toContain('Docker Desktop, running.');
    expect(load().root.querySelector('.onboard-problem')).toBeNull();
  });

  it('ends with troubleshooting and a link for installing on a cloud server', () => {
    const { root } = load();
    expect(root.querySelector('details[data-part="troubleshooting"] summary')!.textContent).toBe('Troubleshooting');
    expect(root.lastElementChild!.textContent).toBe('Installing on a cloud server instead?');
  });

  it('waits for Claude Code: until it connects, there is no end and nothing is deleted', () => {
    const page = load(upTo('sign-in'));
    expect(page.root.querySelector('.onboard-end')).toBeNull();
    expect(page.posts('/api/destroy')).toHaveLength(0);
  });

  it('once all seven are done, says bwat is ready, shows the Zoom settings to check, and deletes what setup kept, once', () => {
    const page = load(upTo('claude-here', { values: { BWAT_PUBLIC_URL: 'http://localhost:8080' } }));
    expect(page.panel()).toBeNull();
    expect(page.counter()).toBe('All 7 steps done');
    const end = page.root.querySelector('.onboard-end')!;
    expect(end.querySelector('h2')!.textContent).toBe('bwat is ready');
    expect(end.textContent).toContain('/bwat:join');
    expect(end.querySelector('table')!.textContent).toContain('Local recording on.');
    expect(end.querySelector('a.onboard-board')!.getAttribute('href')).toBe('http://localhost:8080');
    expect(end.querySelector('details.bwat-more')!.textContent).toContain('Invite bwat.');
    expect(end.querySelector('.bwat-check')).toBeNull();
    expect(end.textContent).toContain('Setup has deleted the files it kept.');
    expect(page.posts('/api/destroy')).toHaveLength(1);
    page.draw();
    expect(page.posts('/api/destroy')).toHaveLength(1);
    expect(page.document.body.classList.contains('onboard-finished')).toBe(true);
    page.page.connection(page.document, false);
    expect(page.document.body.classList.contains('onboard-offline')).toBe(false);
  });

  it('links the board only at a web address', () => {
    const end = load(upTo('claude-here', { values: { BWAT_PUBLIC_URL: 'javascript:alert(1)' } })).root.querySelector('.onboard-end')!;
    expect(end.querySelector('a.onboard-board')).toBeNull();
  });

  it('says when the setup server stops, and when it is back', () => {
    const { document, page } = load();
    page.connection(document, false);
    expect(document.getElementById('status')!.textContent).toMatch(/setup server stopped/);
    page.connection(document, true);
    expect(document.getElementById('status')!.textContent).toBe('Connected again. Nothing was lost.');
  });

  it('asks the person before running what the assistant asks for, and keeps the ask across a redraw', async () => {
    const { root, page, ctx, posts, draw } = load();
    page.applyPageEvent(root, { type: 'allow', request: 'r1', command: './bwat logs' }, ctx);
    expect(posts('/api/allow')).toHaveLength(0);
    draw();
    const ask = root.querySelector('[data-request="r1"]')!;
    expect(ask.querySelector('pre')!.textContent).toBe('./bwat logs');
    (ask.querySelector('[data-allow="yes"]') as HTMLButtonElement).click();
    expect(posts('/api/allow')[0]!.init!.body).toEqual({ request: 'r1', allow: true });
    await settle();
    expect(root.querySelector('[data-request="r1"]')).toBeNull();
  });

  it('the page leads: an old show or request-secret event from the assistant moves nothing', () => {
    const page = load(upTo('company'));
    const before = page.shown();
    page.page.applyPageEvent(page.root, { type: 'show', step: 'model-key' }, page.ctx);
    page.page.applyPageEvent(page.root, { type: 'request-secret', key: 'ZOOM_CLIENT_SECRET' }, page.ctx);
    expect(page.shown()).toBe(before);
  });

  it('a redraw keeps half-typed text and focus', () => {
    const { document, draw } = load(upTo('model-key'));
    const input = document.getElementById('answer-BWAT_ZOOM_COMPANY') as HTMLInputElement;
    input.value = 'Exam';
    input.focus();
    draw();
    const again = document.getElementById('answer-BWAT_ZOOM_COMPANY') as HTMLInputElement;
    expect(again).not.toBe(input);
    expect(again.value).toBe('Exam');
    expect(document.activeElement).toBe(again);
  });

  it('an answer saved elsewhere fills its field in place, unless the person is typing in it', async () => {
    const { document, root, page, ctx } = load(upTo('model-key', { replies: { '/api/answers': { file: true, values: { BWAT_ZOOM_COMPANY: 'From Claude' } }, '/api/guide': guide } }));
    const input = document.getElementById('answer-BWAT_ZOOM_COMPANY') as HTMLInputElement;
    page.applyPageEvent(root, { type: 'answer', key: 'BWAT_ZOOM_COMPANY' }, ctx);
    await settle();
    expect(document.getElementById('answer-BWAT_ZOOM_COMPANY')).toBe(input);
    expect(input.value).toBe('From Claude');
    input.focus();
    (ctx as unknown as { api: (p: string) => Promise<unknown> }).api = (p: string) =>
      Promise.resolve(p === '/api/answers' ? { file: true, values: { BWAT_ZOOM_COMPANY: 'Again' } } : guide);
    page.applyPageEvent(root, { type: 'answer', key: 'BWAT_ZOOM_COMPANY' }, ctx);
    await settle();
    expect(input.value).toBe('From Claude');
  });
});

describe('the SDK step', () => {
  function sdkPage(status: Record<string, unknown>) {
    let reply: Record<string, unknown> = { ...SDK_NONE, ...status };
    const page = load(upTo('zoom-main', { replies: {} }));
    const uploads: { name: string }[] = [];
    Object.assign(page.ctx, {
      api: (path: string, init?: Call['init']) => { page.calls.push({ path, ...(init ? { init } : {}) }); return Promise.resolve(path === '/api/sdk' ? reply : { ok: true }); },
      upload: (_path: string, name: string) => { uploads.push({ name }); return Promise.resolve({ file: name }); },
    });
    page.draw();
    return { ...page, uploads, set: (s: Record<string, unknown>) => { reply = { ...SDK_NONE, ...s }; } };
  }
  const text = (root: Element) => root.querySelector('[data-sdk] [role=status]')!.textContent;

  it('with no file, says where the page looks and offers the drop zone', async () => {
    const { root } = sdkPage({});
    await settle();
    expect(text(root)).toMatch(/Downloads folder.*Drop the file here/);
    expect((root.querySelector('[data-sdk-drop]') as HTMLElement).hidden).toBe(false);
  });

  it('while building, says so and that the person can carry on, and hides the drop zone', async () => {
    const { root } = sdkPage({ file: 'zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz', version: '7.1.5.4432', kind: 'untested', building: true, build: { exit: null, started: new Date().toISOString(), ended: null, lines: ['building the bot'] } });
    await settle();
    expect(text(root)).toMatch(/^Building the meeting bot from zoom-meeting-sdk-linux_x86_64-7\.1\.5\.4432\.tar\.xz\. Carry on/);
    expect(text(root)).toMatch(/newer than the tested 7\.0\.2\.5001/);
    expect((root.querySelector('[data-sdk-drop]') as HTMLElement).hidden).toBe(true);
    expect(root.querySelector('[data-run-fold="sdk-build"] pre')!.textContent).toBe('building the bot');
  });

  it('once a file appears the page reloads, so the step can move on', async () => {
    const { counts } = sdkPage({ file: 'f' });
    await settle();
    expect(counts.reload).toBeGreaterThan(0);
  });

  it("the build's live lines go to its own output", async () => {
    const { root, page, ctx } = sdkPage({ building: true, file: 'f', build: { exit: null, started: new Date().toISOString(), ended: null, lines: [] } });
    await settle();
    page.applyRunEvent(ctx.runs.panels, { type: 'line', id: 'sdk-build', line: 'Step 3/9' });
    expect(root.querySelector('[data-run-fold="sdk-build"] pre')!.textContent).toBe('Step 3/9\n');
  });

  it('a version that built here before says so; a built bot says it is built', async () => {
    let { root } = sdkPage({ file: 'f', version: '7.1.5.4432', kind: 'built-here', docker: false });
    await settle();
    expect(text(root)).toMatch(/Start Docker.*has built on this computer before/);
    ({ root } = sdkPage({ file: 'f', version: '7.1.5.4432', kind: 'built-here', image: 'current' }));
    await settle();
    expect(text(root)).toBe('The meeting bot is built (Zoom Meeting SDK 7.1.5.4432).');
  });

  it('a failed build opens its output and offers Build again, which asks the server', async () => {
    const { root, posts } = sdkPage({ file: 'f', version: '7.0.2.5001', kind: 'tested', build: { exit: 1, started: 's', ended: 'e', lines: ['no space left'] } });
    await settle();
    expect(text(root)).toMatch(/stopped: see its output/);
    expect((root.querySelector('[data-run-fold="sdk-build"]') as HTMLDetailsElement).open).toBe(true);
    const again = root.querySelector('[data-sdk-build]') as HTMLButtonElement;
    expect(again.hidden).toBe(false);
    again.click();
    expect(posts('/api/sdk/build')).toHaveLength(1);
  });

  it('sends a chosen file under Zoom\'s own name, without a browser\'s (1)', async () => {
    const { root, uploads, window } = sdkPage({});
    await settle();
    const input = root.querySelector('[data-sdk-file]') as HTMLInputElement;
    const file = new window.File(['x'], 'zoom-meeting-sdk-linux_x86_64-7.1.5.4432 (1).tar.xz');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new window.Event('change'));
    await settle();
    expect(uploads).toEqual([{ name: 'zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz' }]);
  });
});
