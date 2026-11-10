import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { answerKeys, checkedLine, loadMaster, parseMaster, type Master } from '../flow.ts';

const keys = { plain: new Set(['BWAT_MODE', 'BWAT_PUBLIC_URL']), secret: new Set(['ZOOM_CLIENT_SECRET']) };
const shots = new Set(['zoom-credentials']);

const guide = `# Title


<!-- bwat:step id=address flows=local,server title="Choose your address" -->
Pick one. See [Docker](https://docs.docker.com/get-docker/).

<!-- bwat:answer BWAT_PUBLIC_URL -->

\`\`\`sh {bwat-run=prep}
./bwat prep
\`\`\`
<!-- bwat:end -->

## Between

<!-- bwat:step id=zoom flows=server title="Create the Zoom app" -->
<!-- bwat:shot zoom-credentials -->
<!-- bwat:secret ZOOM_CLIENT_SECRET -->
<!-- bwat:check prep-complete -->
\`\`\`sh
echo not run by the page
\`\`\`
<!-- bwat:end -->
`;

const parse = (text: string) => parseMaster('docs/test.md', text, { keys, shots });
const errorsOf = (text: string) => { try { parse(text); return []; } catch (e) { return (e as Error).message.split('\n'); } };

describe('parseMaster', () => {
  it('finds each step with its flows, title, answers, secrets, commands, checks and shots', () => {
    const steps: Master['steps'] = parse(guide).steps;
    assert.deepEqual(steps.map((s) => [s.id, s.flows, s.title]), [
      ['address', ['local', 'server'], 'Choose your address'],
      ['zoom', ['server'], 'Create the Zoom app'],
    ]);
    assert.deepEqual(steps[0]!.answers, ['BWAT_PUBLIC_URL']);
    assert.deepEqual(steps[0]!.runs, [{ id: 'prep', command: './bwat prep' }]);
    assert.deepEqual(steps[1]!.secrets, ['ZOOM_CLIENT_SECRET']);
    assert.deepEqual(steps[1]!.checks, ['prep-complete']);
    assert.deepEqual(steps[1]!.shots, ['zoom-credentials']);
  });

  it('renders each step\'s body, directives as placeholders, links opening a new tab', () => {
    const [address, zoom] = parse(guide).steps;
    assert.match(address!.html, /<a href="https:\/\/docs.docker.com\/get-docker\/" target="_blank" rel="noopener noreferrer">Docker<\/a>/);
    assert.match(address!.html, /<div class="bwat-answer" data-key="BWAT_PUBLIC_URL"><\/div>/);
    assert.match(address!.html, /<div class="bwat-run" data-run="prep"><pre><code>\.\/bwat prep<\/code><\/pre><\/div>/);
    assert.match(zoom!.html, /<figure class="bwat-shot" data-shot="zoom-credentials"><\/figure>/);
    assert.match(zoom!.html, /<div class="bwat-secret" data-key="ZOOM_CLIENT_SECRET"><\/div>/);
    assert.match(zoom!.html, /<pre><code class="language-sh">echo not run by the page/);
    assert.doesNotMatch(address!.html + zoom!.html, /bwat:/);
    assert.doesNotMatch(address!.html, /GitHub readers/);
  });

  it('escapes text, so a guide cannot inject markup through a code block or a title', () => {
    const steps = parse('<!-- bwat:step id=x flows=local title="a <b>" -->\n`<script>`\n<!-- bwat:end -->\n').steps;
    assert.equal(steps[0]!.title, 'a <b>');
    assert.match(steps[0]!.html, /<code>&lt;script&gt;<\/code>/);
  });

  it('names every problem at once, with its line', () => {
    const errors = errorsOf([
      '<!-- bwat:step id=a flows=local title="A" -->', // 1
      '<!-- bwat:answer NOT_A_KEY -->', // 2
      '<!-- bwat:answer ZOOM_CLIENT_SECRET -->', // 3: a secret as a plain answer
      '<!-- bwat:secret BWAT_MODE -->', // 4: a plain answer as a secret
      '<!-- bwat:shot nowhere -->', // 5
      '<!-- bwat:check guess -->', // 6
      '<!-- bwat:wat -->', // 7
      '```sh {bwat-run=rm}', // 8: only ./bwat and setup/ commands
      'rm -rf /',
      '```',
      '<!-- bwat:step id=b flows=local title="B" -->', // 11: nested
      '<!-- bwat:end -->',
      '<!-- bwat:step id=a flows=moon title="" -->', // 13: repeated id, unknown flow, no title
      '<!-- bwat:end -->',
      '<!-- bwat:answer BWAT_MODE -->', // 15: outside a step
      '<!-- bwat:step id=c flows=local title="C" -->', // 16: never closed
    ].join('\n'));
    assert.deepEqual(errors, [
      'docs/test.md:2: NOT_A_KEY is not a line of the bwat.answers template',
      'docs/test.md:3: ZOOM_CLIENT_SECRET is a secret: use bwat:secret',
      'docs/test.md:4: BWAT_MODE is not a secret: use bwat:answer',
      'docs/test.md:5: no shot named nowhere in docs/onboarding/shots/shots.json',
      'docs/test.md:6: unknown check guess',
      'docs/test.md:7: unknown directive bwat:wat',
      'docs/test.md:8: a bwat-run command must start with ./bwat or setup/',
      'docs/test.md:11: step b starts inside step a',
      'docs/test.md:13: step id a is used twice',
      'docs/test.md:13: unknown flow moon',
      'docs/test.md:13: step a has no title',
      'docs/test.md:15: bwat:answer outside a step',
      'docs/test.md:16: step c is never closed with bwat:end',
    ]);
  });

  it('finds a command and a field inside a list item, keeping them in the item', () => {
    const steps = parse([
      '<!-- bwat:step id=a flows=local title="A" -->',
      '1. Run it.', '', '   ```sh {bwat-run=prep}', '   ./bwat prep', '   ```', '',
      '2. Paste it.', '', '   <!-- bwat:secret ZOOM_CLIENT_SECRET -->',
      '<!-- bwat:end -->',
    ].join('\n')).steps;
    assert.deepEqual(steps[0]!.runs, [{ id: 'prep', command: './bwat prep' }]);
    assert.deepEqual(steps[0]!.secrets, ['ZOOM_CLIENT_SECRET']);
    assert.match(steps[0]!.html, /<li><p>Paste it.<\/p>\n<div class="bwat-secret" data-key="ZOOM_CLIENT_SECRET"><\/div>/);
    assert.match(steps[0]!.html, /<li><p>Run it.<\/p>\n<div class="bwat-run" data-run="prep">/);
  });

  it('refuses a repeated bwat-run id', () => {
    const errors = errorsOf([
      '<!-- bwat:step id=a flows=local title="A" -->',
      '```sh {bwat-run=prep}', './bwat prep', '```',
      '```sh {bwat-run=prep}', './bwat prep --check', '```',
      '<!-- bwat:end -->',
    ].join('\n'));
    assert.deepEqual(errors, ['docs/test.md:5: bwat-run id prep is used twice']);
  });
});

describe('the master\'s click paths, conditions and parts', () => {
  const def = '<!-- bwat:path zoom-new-app date=2026-10 -->the blue + > Build app<!-- bwat:end-path -->';
  const use = '<!-- bwat:path zoom-new-app -->';
  const step = (...lines: string[]) => ['<!-- bwat:step id=a flows=local title="A" -->', ...lines, '<!-- bwat:end -->'].join('\n');

  it("parses a path definition and places later uses by name, dated once at the step's end", () => {
    const master = parse(step(`Click ${def}.`, '', `Again: ${use}.`));
    assert.deepEqual(master.paths.get('zoom-new-app'), { name: 'zoom-new-app', path: 'the blue + > Build app', date: '2026-10' });
    const html = master.steps[0]!.html;
    assert.equal(html.split('the blue + &gt; Build app').length, 3, html);
    assert.equal(html.split('as of October 2026').length, 2, html);
    assert.match(master.steps[0]!.markdown, /Again: the blue \+ > Build app\.\n\n_Click paths as of October 2026\._$/);
    assert.doesNotMatch(master.steps[0]!.markdown, /bwat:path/);
  });

  it("names every month and year a step's paths were checked in, once", () => {
    assert.equal(checkedLine(['2026-11', '2026-10', '2026-10']), '_Click paths as of October and November 2026._');
    assert.equal(checkedLine(['2027-01', '2026-12']), '_Click paths as of December 2026 and January 2027._');
  });

  it('refuses a path used before or without its definition, defined twice, or spelled out where a name exists', () => {
    assert.deepEqual(errorsOf(step(`Use ${use}.`)), ['docs/test.md:2: path zoom-new-app is not defined']);
    assert.deepEqual(errorsOf(step(def, def)), ['docs/test.md:3: path zoom-new-app is defined twice']);
    assert.deepEqual(errorsOf(step(def, 'Click the blue + > Build app now.')),
      ['docs/test.md:3: spells out path zoom-new-app; use <!-- bwat:path zoom-new-app -->']);
  });

  it('reads when= on a step and bwat:when blocks, and refuses an unknown condition', () => {
    const master = parse([
      '<!-- bwat:step id=a flows=local when=board-app title="A" -->',
      'Always.', '', '<!-- bwat:when production -->', 'Only in production.', '<!-- bwat:end-when -->',
      '<!-- bwat:end -->',
    ].join('\n'));
    const [a] = master.steps;
    assert.equal(a!.when, 'board-app');
    assert.match(a!.markdown, /<!-- bwat:when production -->\nOnly in production\.\n<!-- bwat:end-when -->/);
    assert.match(a!.html, /<div class="bwat-when" data-when="production">\s*<p>Only in production\.<\/p>\s*<\/div>/);
    assert.equal(parse(step('x')).steps[0]!.when, null);
    assert.deepEqual(errorsOf('<!-- bwat:step id=a flows=local when=moon title="A" -->\n<!-- bwat:end -->'), ['docs/test.md:1: unknown condition moon']);
    assert.deepEqual(errorsOf(step('<!-- bwat:when moon -->', 'x', '<!-- bwat:end-when -->')), ['docs/test.md:2: unknown condition moon']);
  });

  it('keeps a bwat:flows block for the flows it names, in a step or a part', () => {
    const master = parse([
      '<!-- bwat:step id=a flows=local,server title="A" -->',
      'Everyone.', '<!-- bwat:flows server -->', 'Only **servers**.', '<!-- bwat:end-flows -->',
      '<!-- bwat:end -->',
      '<!-- bwat:part p title="P" -->', '<!-- bwat:flows local -->', 'Just me.', '<!-- bwat:end-flows -->', '<!-- bwat:end -->',
    ].join('\n'));
    assert.match(master.steps[0]!.html, /<div class="bwat-flows" data-flows="server">\s*<p>Only <strong>servers<\/strong>\.<\/p>\s*<\/div>/);
    assert.match(master.steps[0]!.markdown, /<!-- bwat:flows server -->\nOnly \*\*servers\*\*\.\n<!-- bwat:end-flows -->/);
    assert.match(master.parts[0]!.html, /<div class="bwat-flows" data-flows="local">\s*<p>Just me\.<\/p>\s*<\/div>/);
  });

  it('refuses a bwat:flows block with no or an unknown flow, unclosed, or crossing a when or a more', () => {
    assert.deepEqual(errorsOf(step('<!-- bwat:flows -->', 'x', '<!-- bwat:end-flows -->')), ['docs/test.md:2: bwat:flows names no flow']);
    assert.deepEqual(errorsOf(step('<!-- bwat:flows moon -->', 'x', '<!-- bwat:end-flows -->')), ['docs/test.md:2: unknown flow moon']);
    assert.deepEqual(errorsOf(step('<!-- bwat:flows server -->', 'x')), ['docs/test.md:2: bwat:flows is never closed with bwat:end-flows']);
    assert.deepEqual(errorsOf(step('<!-- bwat:end-flows -->')), ['docs/test.md:2: bwat:end-flows without bwat:flows']);
    assert.deepEqual(errorsOf(step('<!-- bwat:flows server -->', '<!-- bwat:flows local -->', '<!-- bwat:end-flows -->', '<!-- bwat:end-flows -->')),
      ['docs/test.md:3: bwat:flows starts inside bwat:flows']);
    assert.deepEqual(errorsOf(step('<!-- bwat:flows server -->', '<!-- bwat:when production -->', '<!-- bwat:end-flows -->', '<!-- bwat:end-when -->')),
      ['docs/test.md:4: bwat:end-flows inside bwat:when: close the when first']);
    assert.deepEqual(errorsOf(step('<!-- bwat:more title="M" -->', '<!-- bwat:flows server -->', '<!-- bwat:end-more -->', '<!-- bwat:end-flows -->')),
      ['docs/test.md:4: bwat:end-more inside bwat:flows: close the flows first']);
    // Nested either way, closed in order, is fine.
    assert.deepEqual(errorsOf(step('<!-- bwat:more title="M" -->', '<!-- bwat:flows server -->', 'x', '<!-- bwat:end-flows -->', '<!-- bwat:end-more -->')), []);
    assert.deepEqual(errorsOf(step('<!-- bwat:flows server -->', '<!-- bwat:when production -->', 'x', '<!-- bwat:end-when -->', '<!-- bwat:end-flows -->')), []);
  });

  it('keeps a bwat:os block for the computers it names, and refuses an unknown one', () => {
    const master = parse(step('<!-- bwat:os mac,apple-silicon -->', 'Use Docker Desktop.', '<!-- bwat:end-os -->'));
    assert.match(master.steps[0]!.html, /<div class="bwat-os" data-os="mac,apple-silicon">\s*<p>Use Docker Desktop\.<\/p>\s*<\/div>/);
    assert.deepEqual(errorsOf(step('<!-- bwat:os amiga -->', 'x', '<!-- bwat:end-os -->')), ['docs/test.md:2: unknown platform amiga']);
    assert.deepEqual(errorsOf(step('<!-- bwat:os mac -->', 'x')), ['docs/test.md:2: bwat:os is never closed with bwat:end-os']);
    assert.deepEqual(errorsOf(step('<!-- bwat:os mac -->', '<!-- bwat:flows server -->', '<!-- bwat:end-os -->', '<!-- bwat:end-flows -->')),
      ['docs/test.md:4: bwat:end-os inside bwat:flows: close the flows first']);
    assert.deepEqual(errorsOf(step('<!-- bwat:flows server -->', '<!-- bwat:os mac -->', 'x', '<!-- bwat:end-os -->', '<!-- bwat:end-flows -->')), []);
  });

  it('folds a bwat:more block into a titled, collapsed box, in a step or a part', () => {
    const master = parse([
      '<!-- bwat:step id=a flows=local title="A" -->',
      'Do this.', '<!-- bwat:more title="Why <this>" -->', 'Because **it** matters.', '<!-- bwat:end-more -->',
      '<!-- bwat:more title="More" -->', 'Again.', '<!-- bwat:end-more -->',
      '<!-- bwat:end -->',
      '<!-- bwat:part p title="P" -->', '<!-- bwat:more title="Detail" -->', 'Hidden.', '<!-- bwat:end-more -->', '<!-- bwat:end -->',
    ].join('\n'));
    const [a] = master.steps;
    assert.match(a!.html, /<details class="bwat-more" data-more="a-0"><summary>Why &lt;this&gt;<\/summary>\s*<p>Because <strong>it<\/strong> matters\.<\/p>\s*<\/details>/);
    assert.match(a!.html, /data-more="a-1"><summary>More<\/summary>/);
    assert.match(a!.markdown, /<!-- bwat:more title="Why <this>" -->\nBecause \*\*it\*\* matters\.\n<!-- bwat:end-more -->/);
    assert.match(master.parts[0]!.html, /<details class="bwat-more" data-more="p-0"><summary>Detail<\/summary>\s*<p>Hidden\.<\/p>\s*<\/details>/);
  });

  it('refuses a bwat:more block without a title, unclosed, nested, crossing a when, or hiding a field, a check or a command', () => {
    const more = (...lines: string[]) => step('<!-- bwat:more title="M" -->', ...lines, '<!-- bwat:end-more -->');
    assert.deepEqual(errorsOf(step('<!-- bwat:more -->', 'x', '<!-- bwat:end-more -->')), ['docs/test.md:2: bwat:more has no title']);
    assert.deepEqual(errorsOf(step('<!-- bwat:more title="M" -->', 'x')), ['docs/test.md:2: bwat:more is never closed with bwat:end-more']);
    assert.deepEqual(errorsOf(step('<!-- bwat:end-more -->')), ['docs/test.md:2: bwat:end-more without bwat:more']);
    assert.deepEqual(errorsOf(more('<!-- bwat:more title="N" -->', 'x', '<!-- bwat:end-more -->')), ['docs/test.md:3: bwat:more starts inside bwat:more']);
    assert.deepEqual(errorsOf(step('<!-- bwat:when production -->', '<!-- bwat:more title="M" -->', '<!-- bwat:end-when -->', '<!-- bwat:end-more -->')),
      ['docs/test.md:4: bwat:end-when inside bwat:more: close the more first']);
    assert.deepEqual(errorsOf(more('<!-- bwat:answer BWAT_PUBLIC_URL -->')), ['docs/test.md:3: bwat:answer inside bwat:more: a step\'s fields stay in view']);
    assert.deepEqual(errorsOf(more('<!-- bwat:check prep-complete -->')), ['docs/test.md:3: bwat:check inside bwat:more: a step\'s fields stay in view']);
    assert.deepEqual(errorsOf(more('```sh {bwat-run=go}', './bwat prep', '```')), ['docs/test.md:3: bwat-run inside bwat:more: a step\'s commands stay in view']);
  });

  it('parses a part', () => {
    const master = parse(`<!-- bwat:part troubleshooting title="If something doesn't work" -->\nCheck the log.\n<!-- bwat:end -->\n`);
    assert.deepEqual(master.parts.map(({ id, title, markdown }) => ({ id, title, markdown })), [{ id: 'troubleshooting', title: "If something doesn't work", markdown: 'Check the log.' }]);
    assert.match(master.parts[0]!.html, /<p>Check the log\.<\/p>/);
    assert.deepEqual(master.steps, []);
    assert.deepEqual(errorsOf(step('<!-- bwat:part p title="P" -->')), ['docs/test.md:2: part p starts inside step a']);
  });

  it('reads a use followed by a definition on one line as two paths', () => {
    const master = parse(step(def, `Open ${use}, then <!-- bwat:path zoom-other -->X > Y<!-- bwat:end-path -->.`));
    assert.deepEqual(master.paths.get('zoom-other'), { name: 'zoom-other', path: 'X > Y', date: null });
    assert.equal(master.paths.get('zoom-new-app')!.path, 'the blue + > Build app');
    assert.match(master.steps[0]!.markdown, /Open the blue \+ > Build app, then X > Y\./);
  });

  it('places a step inside a part, its markdown and its html, wherever the step is defined', () => {
    const master = parse([
      '<!-- bwat:part team title="For everyone else" -->', 'Sign in.', '', '<!-- bwat:place connect -->', '', 'Then meet.', '<!-- bwat:end -->',
      '<!-- bwat:step id=connect flows=local title="Connect" -->', 'Run `/bwat:login`.', '<!-- bwat:end -->',
    ].join('\n'));
    const [part] = master.parts;
    assert.equal(part!.markdown, 'Sign in.\n\nRun `/bwat:login`.\n\nThen meet.');
    assert.match(part!.html, /<p>Sign in\.<\/p>\s*<p>Run <code>\/bwat:login<\/code>\.<\/p>\s*<p>Then meet\.<\/p>/);
    assert.doesNotMatch(part!.html + part!.markdown, /bwat:place|bwat-place/);
  });

  it('refuses a place of an unknown step, or a place outside a part', () => {
    assert.deepEqual(errorsOf('<!-- bwat:part p title="P" -->\n<!-- bwat:place nowhere -->\n<!-- bwat:end -->'),
      ['docs/test.md:2: bwat:place nowhere: no such step']);
    assert.deepEqual(errorsOf(step('<!-- bwat:place a -->')), ['docs/test.md:2: bwat:place outside a part']);
  });

  it('refuses a bad date, and a date on a use instead of the definition', () => {
    const bad = (date: string) => step(`Go <!-- bwat:path aws-iam date=${date} -->the IAM console<!-- bwat:end-path -->.`);
    for (const date of ['2026-13', '2026-1', 'soon']) assert.deepEqual(errorsOf(bad(date)), [`docs/test.md:2: path aws-iam has a bad date ${date}`]);
    assert.deepEqual(errorsOf(step(def, 'Again <!-- bwat:path zoom-new-app date=2026-11 -->.')),
      ['docs/test.md:3: path zoom-new-app: date= belongs on the definition, not on a use']);
  });

  it('knows only its own conditions and flows, not names every object inherits', () => {
    assert.deepEqual(errorsOf('<!-- bwat:step id=a flows=local when=constructor title="A" -->\n<!-- bwat:end -->'), ['docs/test.md:1: unknown condition constructor']);
    assert.deepEqual(errorsOf(step('<!-- bwat:when toString -->', 'x', '<!-- bwat:end-when -->')), ['docs/test.md:2: unknown condition toString']);
    assert.deepEqual(errorsOf('<!-- bwat:step id=a flows=constructor title="A" -->\n<!-- bwat:end -->'), ['docs/test.md:1: unknown flow constructor']);
  });

  it('an unchecked path has a null date and claims no date', () => {
    const master = parse(step('Go to <!-- bwat:path aws-iam -->the IAM console<!-- bwat:end-path -->.'));
    assert.equal(master.paths.get('aws-iam')!.date, null);
    assert.match(master.steps[0]!.html, /the IAM console\./);
    assert.doesNotMatch(master.steps[0]!.markdown, /as of|not yet checked/);
  });
});

describe('answerKeys', () => {
  it('reads the template setup/prep writes, telling secrets from plain answers', () => {
    const { plain, secret } = answerKeys();
    assert.ok(plain.has('BWAT_PUBLIC_URL'));
    assert.ok(plain.has('BWAT_GOOGLE_CLIENT_ID'));
    assert.ok(secret.has('BWAT_GOOGLE_CLIENT_SECRET'));
    assert.ok(secret.has('OPENROUTER_API_KEY'));
    assert.ok(!plain.has('OPENROUTER_API_KEY'));
    assert.ok(!secret.has('BWAT_PUBLIC_URL'));
  });
});

describe('docs/onboarding/shots/shots.json', () => {
  it('names each shot once, with its page and caption; a saved image has its labels and capture date', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const dir = new URL('../../../docs/onboarding/shots/', import.meta.url);
    const shots = JSON.parse(readFileSync(new URL('shots.json', dir), 'utf8')) as Record<string, unknown>[];
    const names = new Set<string>();
    for (const s of shots) {
      assert.match(String(s.name), /^[a-z0-9-]{1,64}$/);
      assert.ok(!names.has(String(s.name)), `${s.name} twice`);
      names.add(String(s.name));
      assert.match(String(s.url), /^https:\/\//, String(s.name));
      assert.ok(typeof s.caption === 'string' && s.caption, String(s.name));
      assert.ok(Array.isArray(s.labels) && s.labels.every((l) => typeof l === 'string' && l), String(s.name));
      if (existsSync(new URL(`${s.name}.png`, dir))) assert.match(String(s.captured), /^\d{4}-\d{2}-\d{2}$/, `${s.name}: captured`);
    }
  });
});

describe('the master', () => {
  const master = () => loadMaster();
  const IDS = ['prerequisites', 'answers-file', 'address-server', 'company',
    'google-web', 'google-desktop', 'zoom-main', 'zoom-sdk', 'zoom-s2s', 'zoom-board', 'zoom-board-everyone',
    'model-key', 'check-answers', 'install', 'sign-in', 'zoom-validate', 'zoom-account', 'auto-join',
    'connect-claude', 'share', 'first-meeting'];

  it('the master parses with no problems', () => {
    const { steps, parts } = master();
    assert.ok(steps.every((s) => s.guide === 'docs/onboarding/master.md'), 'loaded from docs/onboarding/master.md');
    for (const flow of ['local', 'server']) assert.ok(steps.some((s) => s.flows.includes(flow)), flow);
    const byId = new Map(steps.map((s) => [s.id, s]));
    for (const id of [...IDS, 'before-you-start']) assert.ok(byId.has(id), `step ${id}`);
    assert.deepEqual(byId.get('install')!.runs, [{ id: 'setup', command: './bwat setup -y' }]);
    assert.deepEqual(parts.map((p) => p.id).sort(), ['address-intro', 'delete-answers', 'download', 'google-intro', 'modes', 'start', 'teammates', 'troubleshooting', 'who-can-sign-in', 'zoom-intro']);
  });

  // Answers no step asks for: the chosen way sets the mode and the tier, and the apps' name is
  // the contact's first name unless a terminal reader of bwat.answers changes it.
  const NOT_ASKED = ['BWAT_EDGE_PORT', 'BWAT_MODE', 'BWAT_TIER', 'BWAT_ZOOM_OWNER_NAME'];
  it('every key of the bwat.answers template is asked for by some step, and no step asks for a key the template lacks', () => {
    const { steps } = master();
    const keys = answerKeys();
    assert.deepEqual([...new Set(steps.flatMap((s) => s.answers))].sort(), [...keys.plain].filter((k) => !NOT_ASKED.includes(k)).sort());
    assert.deepEqual([...new Set(steps.flatMap((s) => s.secrets))].sort(), [...keys.secret].sort());
  });

  it('every vendor path is defined once, with a date or unchecked', () => {
    for (const p of master().paths.values()) {
      assert.ok(p.path.trim(), p.name);
      assert.ok(p.date === null || /^\d{4}-(0[1-9]|1[0-2])$/.test(p.date), `${p.name}: ${p.date}`);
    }
  });

  it('the master names at least these paths', () => {
    const names = master().paths;
    for (const name of ['google-overview', 'google-clients', 'zoom-new-app', 'zoom-manifest-upload', 'zoom-app-credentials',
      'zoom-event-secret', 'zoom-sdk-download', 'zoom-beta-test', 'zoom-add-for-others', 'zoom-auto-open', 'zoom-s2s-new',
      'openrouter-keys']) assert.ok(names.has(name), name);
  });

  // The server flow is always production with https, so its steps need no when=.
  it('the board, event and auto-join steps are server-only, with no when=', () => {
    const byId = new Map(master().steps.map((s) => [s.id, s]));
    for (const id of ['zoom-board', 'zoom-board-everyone', 'zoom-validate', 'auto-join']) {
      assert.equal(byId.get(id)!.when, null, id);
      assert.deepEqual(byId.get(id)!.flows, ['server'], id);
    }
  });

  it('the first step is before-you-start, in every flow', () => {
    const { steps } = master();
    for (const flow of ['local', 'server']) {
      const first = steps.find((s) => s.flows.includes(flow))!;
      assert.equal(first.id, 'before-you-start', flow);
    }
    const before = steps[0]!;
    assert.deepEqual([before.answers, before.secrets, before.checks, before.runs], [[], [], [], []]);
  });

  it('connects this computer with ./bwat plugin, ticked once Claude Code checks in, right after the owner signs in', () => {
    const steps = master().steps;
    const here = steps.find((s) => s.id === 'claude-here')!;
    // The setup page starts these runs by their ids (page.js), so the ids are pinned too.
    assert.deepEqual(here.runs, [{ id: 'plugin', command: './bwat plugin' }, { id: 'plugin-repoint', command: './bwat plugin --repoint' }]);
    assert.deepEqual(here.checks, ['claude-connected']);
    const ids = steps.map((s) => s.id);
    assert.equal(ids.indexOf('claude-here'), ids.indexOf('sign-in') + 1);
  });

  it('shows connect-claude and first-meeting as full steps, their Claude Code commands as text', () => {
    const byId = new Map(master().steps.map((s) => [s.id, s]));
    for (const cmd of ['claude plugin marketplace add', 'claude plugin install bwat@', '/bwat:login', '/bwat:status']) {
      assert.ok(byId.get('connect-claude')!.markdown.includes(cmd), cmd);
    }
    for (const cmd of ['/bwat:join', 'Send to Claude']) assert.ok(byId.get('first-meeting')!.markdown.includes(cmd), cmd);
    // bwat-plugin has /bwat:inbox-on and /bwat:inbox-off but no /bwat:inbox: a hand-off wakes the session by itself.
    assert.doesNotMatch(readFileSync(new URL('../../../docs/onboarding/master.md', import.meta.url), 'utf8'), /\/bwat:inbox(?!-o)/);
    assert.deepEqual(byId.get('connect-claude')!.runs, []);
    assert.deepEqual(byId.get('first-meeting')!.checks, ['first-card']);
  });

  it('the teammates part places connect-claude, written once', async () => {
    const { readFileSync } = await import('node:fs');
    const { steps, parts } = master();
    const connect = steps.find((s) => s.id === 'connect-claude')!;
    const teammates = parts.find((p) => p.id === 'teammates')!;
    assert.ok(teammates.markdown.includes(connect.markdown));
    assert.ok(teammates.html.includes(connect.html));
    const text = readFileSync(new URL('../../../docs/onboarding/master.md', import.meta.url), 'utf8');
    assert.equal(text.split('claude plugin install bwat@').length, 2, 'the plugin commands are written once');
  });

  it('refuses prose outside a step or a part, but allows headings, blank lines and comments', () => {
    const body = '<!-- bwat:step id=a flows=local title="A" -->\nText.\n<!-- bwat:end -->';
    assert.deepEqual(errorsOf(`# Title\n\n## Group\n\n<!-- a note\nover two lines -->\n\n${body}\n`), []);
    assert.deepEqual(errorsOf(`# Title\n\nA loose paragraph.\n\n${body}`),
      ['docs/test.md:3: text outside a step or a part: put it in a part (<!-- bwat:part ID title="..." -->)']);
  });
});
