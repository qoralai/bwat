import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SERVER_GUIDE, loadMaster, parseMaster } from '../flow.ts';
import { ROOT } from '../root.ts';
import { TOOLS } from '../mcp.ts';
import { generatedBy, outputs, render } from '../generate.ts';

const keys = { plain: new Set(['BWAT_PUBLIC_URL']), secret: new Set(['ZOOM_CLIENT_SECRET']) };
const shots = new Set(['zoom-credentials']);

const master = parseMaster('docs/test.md', `<!-- bwat:step id=zoom flows=server title="Create the Zoom app" -->
Make the app in the Zoom marketplace.

<!-- bwat:answer BWAT_PUBLIC_URL -->

Your address, such as \`https://bwat.example.com\`.

<!-- bwat:secret ZOOM_CLIENT_SECRET -->

App Credentials | Client Secret.

<!-- bwat:when production -->
- Also set the event URL.
<!-- bwat:end-when -->

\`\`\`sh {bwat-run=prep}
./bwat prep
\`\`\`

<!-- bwat:shot zoom-credentials -->
<!-- bwat:check prep-complete -->
<!-- bwat:end -->

<!-- bwat:step id=board flows=local,server when=board-app title="Create the board app" -->
Board.
<!-- bwat:end -->
`, { keys, shots });

describe('a bwat:more block', () => {
  const folded = parseMaster('docs/test.md', `<!-- bwat:step id=fold flows=local title="Fold" -->
<!-- bwat:more title="Why <it>" -->
This is the hidden reason for it.
<!-- bwat:end-more -->
Run the helper once now.

1. Open it.
   <!-- bwat:more title="Detail" -->
   Nested in the item.
   <!-- bwat:end-more -->
<!-- bwat:end -->
`, { keys, shots });

  it('shows on GitHub as a collapsed <details> box with its title, the Markdown inside it rendered, kept in its list item', () => {
    const text = render('{{steps ids=fold level=4}}', folded, 'guide');
    assert.match(text, /<details>\n<summary>Why &lt;it&gt;<\/summary>\n\nThis is the hidden reason for it\.\n\n<\/details>/);
    assert.match(text, /\n {3}<details>\n {3}<summary>Detail<\/summary>\n\n {3}Nested in the item\.\n\n {3}<\/details>/);
  });

  it('never gives a Claude prompt its step summary', () => {
    for (const format of ['claude-page', 'claude-terminal']) {
      const text = render(`{{steps format=${format}}}`, folded, 'guide');
      assert.match(text, /Run the helper once now\./, format);
      assert.doesNotMatch(text, /hidden reason/, format);
    }
  });
});

describe('a bwat:flows block', () => {
  const scoped = parseMaster('docs/test.md', `<!-- bwat:step id=scoped flows=local,server title="Scoped" -->
<!-- bwat:flows server -->
Servers point a domain for this.
<!-- bwat:end-flows -->
Everyone does this step now.
<!-- bwat:end -->
`, { keys, shots });

  it('says on GitHub which computers a bwat:os block is for', () => {
    const os = parseMaster('docs/test.md', '<!-- bwat:step id=os flows=local title="OS" -->\n<!-- bwat:os windows,wsl -->\nInstall Docker Desktop.\n<!-- bwat:end-os -->\n<!-- bwat:end -->\n', { keys, shots });
    assert.match(render('{{steps ids=os level=4}}', os, 'guide'), /\*\*On Windows or WSL:\*\*\n\nInstall Docker Desktop\./);
  });

  it('says on GitHub which ways of running bwat it is for', () => {
    const text = render('{{steps ids=scoped level=4}}', scoped, 'guide');
    assert.match(text, /Production on a cloud server:\n\nServers point a domain for this\./);
  });

  it('never gives a Claude prompt its step summary, which every flow reads', () => {
    const text = render('{{steps format=claude-page}}', scoped, 'guide');
    assert.match(text, /Everyone does this step now\./);
    assert.doesNotMatch(text, /domain/);
  });

  it('takes no summary from a scoped block still open around a nested one', () => {
    const nested = parseMaster('docs/test.md', `<!-- bwat:step id=nested flows=local,server title="Nested" -->
<!-- bwat:os windows -->
<!-- bwat:flows server -->
Servers on Windows only.
<!-- bwat:end-flows -->
Windows only, every flow.
<!-- bwat:end-os -->
Everyone does this step now.
<!-- bwat:end -->
`, { keys, shots });
    const text = render('{{steps format=claude-page}}', nested, 'guide');
    assert.match(text, /Everyone does this step now\./);
    assert.doesNotMatch(text, /Windows only/);
  });

  it('leaves out of a Claude prompt the fields a flows= slot never reaches', () => {
    const mixed = parseMaster('docs/test.md', `<!-- bwat:step id=mixed flows=local,server title="Mixed" -->
<!-- bwat:secret ZOOM_CLIENT_SECRET -->
Everyone saves this one.
<!-- bwat:flows server -->
<!-- bwat:answer BWAT_PUBLIC_URL -->
Servers only.
<!-- bwat:end-flows -->
<!-- bwat:end -->
`, { keys, shots });
    const local = render('{{steps format=claude-page flows=local}}', mixed, 'guide');
    assert.match(local, /they type ZOOM_CLIENT_SECRET into the page/);
    assert.doesNotMatch(local, /BWAT_PUBLIC_URL/);
    assert.match(render('{{steps format=claude-page flows=server}}', mixed, 'guide'), /they fill BWAT_PUBLIC_URL on the page/);
    assert.match(render('{{steps format=claude-page}}', mixed, 'guide'), /they fill BWAT_PUBLIC_URL on the page/);
  });
});

describe('a page for one way of running bwat', () => {
  const tiered = parseMaster('docs/test.md', `<!-- bwat:step id=both flows=local,server title="Both" -->
Everyone does this step now.
<!-- bwat:flows server -->
Servers point a domain for this.
<!-- bwat:more title="Detail" -->
Server detail.
<!-- bwat:end-more -->
<!-- bwat:end-flows -->
<!-- bwat:flows local -->
This computer only.
<!-- bwat:end-flows -->
<!-- bwat:end -->

<!-- bwat:step id=fold flows=local,server title="Fold" -->
Fold text for everyone here.
<!-- bwat:more title="Server fold" -->
<!-- bwat:flows server -->
Server folded.
<!-- bwat:end-flows -->
<!-- bwat:end-more -->
<!-- bwat:end -->

<!-- bwat:step id=fence flows=local,server title="Fence" -->
Run this.
<!-- bwat:flows server -->
\`\`\`sh {bwat-run=server-cmd}
./bwat server-only-command
\`\`\`
<!-- bwat:end-flows -->
<!-- bwat:end -->

<!-- bwat:step id=server-only flows=server title="Server only" -->
Only on a server.
<!-- bwat:end -->

<!-- bwat:part intro title="Intro" -->
Shared words.
<!-- bwat:flows local -->
Local words.
<!-- bwat:end-flows -->
<!-- bwat:end -->
`, { keys, shots });

  it("keeps its own way's text, unlabelled, and drops the other way's", () => {
    const local = render('{{steps level=3}}\n\n{{part intro}}', tiered, 'guide', '', 'local');
    assert.match(local, /Everyone does this step now\.\n+This computer only\./);
    assert.match(local, /Local words\./);
    assert.doesNotMatch(local, /Servers point|Server detail|Only on a server|### Server only/);
    assert.doesNotMatch(local, /^For[: ]/m);
    const server = render('{{steps level=3}}', tiered, 'guide', '', 'server');
    assert.match(server, /Everyone does this step now\.\n+Servers point a domain for this\./);
    assert.match(server, /### Server only\n\nOnly on a server\./);
    assert.doesNotMatch(server, /This computer only/);
    assert.match(server, /<summary>Server fold<\/summary>\n\nServer folded\./);
    assert.doesNotMatch(local, /Server fold|<details>\n<summary>[^<]*<\/summary>\n\n<\/details>/, 'no fold left empty');
    assert.doesNotMatch(server, /^For[: ]/m);
  });

  it("drops a command block that sits in the other way's text", () => {
    const local = render('{{steps level=3}}', tiered, 'guide', '', 'local');
    assert.match(local, /Run this\./);
    assert.doesNotMatch(local, /server-only-command/);
    const server = render('{{steps level=3}}', tiered, 'guide', '', 'server');
    assert.match(server, /bwat server-only-command/);
  });

  it('beside the other way on the page for every way: two columns, local first, with no "For …" label', () => {
    const text = render('{{steps ids=both level=3}}', tiered, 'guide');
    assert.match(text, /<table>\n<tr><th>Local<\/th><th>Production<\/th><\/tr>\n<tr>\n<td valign="top">\n\nThis computer only\.\n\n<\/td>\n<td valign="top">\n\nServers point a domain for this\./);
    assert.match(text, /<summary>Detail<\/summary>\n\nServer detail\.[\s\S]*<\/td>\n<\/tr>\n<\/table>/, 'a fold inside a column stays in it');
    assert.doesNotMatch(text, /^For[: ]/m);
  });

  it('inside a list item on the page for every way: labelled, not in columns, so the list goes on', () => {
    const listed = parseMaster('docs/test.md', `<!-- bwat:step id=listed flows=local,server title="Listed" -->
1. First.
   <!-- bwat:flows local -->
   Local way.
   <!-- bwat:end-flows -->
   <!-- bwat:flows server -->
   Server way.
   <!-- bwat:end-flows -->
2. Second.
<!-- bwat:end -->
`, { keys, shots });
    const text = render('{{steps ids=listed level=3}}', listed, 'guide');
    assert.doesNotMatch(text, /<table>/);
    assert.match(text, /   For Try it on this computer \(local\):\n\n   Local way\./);
  });

  it('alone on the page for every way: labelled, not in columns', () => {
    const text = render('{{steps ids=fold level=3}}', tiered, 'guide');
    assert.doesNotMatch(text, /<table>/);
    assert.match(text, /For Production on a cloud server:\n\nServer folded\./);
  });
});

describe('docs/onboarding.md', () => {
  it('is the one guide, for every way, holding every step', () => {
    const made = outputs().map((o) => o.path);
    assert.ok(made.includes('docs/onboarding.md'));
    assert.deepEqual(made.filter((p) => /onboarding-/.test(p)), []);
    const text = outputs().find((o) => o.path === 'docs/onboarding.md')!.content;
    const titles = new Set(text.split('\n').filter((l) => /^#{2,6} /.test(l)).map((l) => l.replace(/^#+ /, '')));
    const untitled = new Set(['first-meeting', ...[...readFileSync(join(ROOT, 'docs/onboarding/master.md'), 'utf8').matchAll(/bwat:place ([\w-]+)/g)].map((m) => m[1]!)]);
    for (const step of loadMaster().steps) if (!untitled.has(step.id)) assert.ok(titles.has(step.title), step.title);
    assert.match(text, /<th>Local<\/th><th>Production<\/th>/);
  });
});

describe('the guide', () => {
  const text = render('{{steps ids=zoom,board level=4}}', master, 'guide');

  it('shows a field as a row of its key and value, a secret marked 🔒, a condition as "Only when …", and no setup-page tick', () => {
    assert.match(text, /#### Create the Zoom app/);
    assert.match(text, /\| `BWAT_PUBLIC_URL` \| Your address, such as `https:\/\/bwat\.example\.com`\. \|/);
    assert.match(text, /\| 🔒 `ZOOM_CLIENT_SECRET` \| App Credentials \\\| Client Secret\. \|/);
    assert.equal(text.match(/\| Field \|/g)?.length, 1, 'both rows share one table');
    assert.match(text, /Only when BWAT_MODE is production:\n\n- Also set the event URL\./);
    assert.match(text, /Only when the address is https\./);
    assert.match(text, /```sh\n\.\/bwat prep\n```/);
    assert.doesNotMatch(text, /ticks itself/);
    assert.doesNotMatch(text, /bwat:|bwat-run/);
    assert.doesNotMatch(text, /!\[/, 'no image while the PNG is not saved');
  });

  it('keeps the headings other files link to', () => {
    const pages = {
      'docs/onboarding.md': ['## For the installer', '## Your first meeting', '## For everyone else', "## If something doesn't work", '#### Download the Meeting SDK', '#### Create the board app'],
    };
    for (const [path, headings] of Object.entries(pages)) {
      const guide = readFileSync(join(ROOT, path), 'utf8');
      for (const heading of headings) assert.ok(guide.split('\n').includes(heading), `${path}: ${heading}`);
    }
  });

  it('places every step of the master', () => {
    const template = readFileSync(join(ROOT, 'docs/onboarding/templates/guide.md'), 'utf8');
    const placed = new Set([...template.matchAll(/ids=(\S+?)[ }]/g)].flatMap((m) => m[1]!.split(',')));
    const masterText = readFileSync(join(ROOT, 'docs/onboarding/master.md'), 'utf8');
    // A step a part places (bwat:place) is in the guide wherever that part is.
    for (const [, id] of masterText.matchAll(/bwat:place ([\w-]+)/g)) placed.add(id!);
    for (const [, id] of masterText.matchAll(/bwat:step id=([\w-]+)/g)) assert.ok(placed.has(id!), `step ${id} is in no {{steps ids=…}} slot of the guide template, nor placed by a part`);
  });
});

describe('template slots', () => {
  it('refuse an unknown slot, argument, show value, flow or level', () => {
    for (const slot of ['{{paths}}', '{{steps idz=zoom}}', '{{steps show=colour}}', '{{steps flows=moon}}', '{{steps level=9}}', '{{steps level=x}}', '{{steps ids=nowhere}}', '{{part nowhere}}', '{{part start level=7}}']) {
      assert.throws(() => render(slot, master, 'guide'), Error, slot);
    }
  });
});

describe('generated files', () => {
  it('every generated file matches what the master makes; else run ./bwat docs', () => {
    for (const { path, content } of outputs()) {
      assert.equal(readFileSync(join(ROOT, path), 'utf8'), content, `${path} is out of step with docs/onboarding/master.md: run ./bwat docs`);
    }
  });

  it('a generated file starts with the generated-by line', () => {
    assert.equal(generatedBy('guide.md'), '<!-- Generated by ./bwat docs from docs/onboarding/master.md and docs/onboarding/templates/guide.md; edit those, then run ./bwat docs. -->');
    for (const { path, content } of outputs().filter((o) => !o.path.endsWith('.tsv'))) assert.match(content, /^<!-- Generated by \.\/bwat docs from docs\/onboarding\/master\.md and docs\/onboarding\/templates\/[\w.-]+; edit those, then run \.\/bwat docs\. -->\n/, path);
  });
});

describe('paths.tsv', () => {
  const file = outputs().find((o) => o.path === 'setup/onboard/paths.tsv');

  it('lists every master path, sorted, tab-separated', () => {
    assert.ok(file, 'outputs() makes setup/onboard/paths.tsv');
    const [first, ...lines] = file.content.replace(/\n$/, '').split('\n');
    assert.match(first!, /^# Generated by \.\/bwat docs from docs\/onboarding\/master\.md; edit that, then run \.\/bwat docs\.$/);
    const master = loadMaster().paths;
    const names = lines.map((l) => l.split('\t')[0]!);
    assert.deepEqual(names, [...master.keys()].sort());
    for (const line of lines) {
      const [name, path, date] = line.split('\t');
      assert.equal(line.split('\t').length, 3, line);
      assert.equal(path, master.get(name!)!.path);
      assert.equal(date, master.get(name!)!.date ?? '');
    }
  });
});

describe('the Claude guide', () => {
  const file = outputs().find((o) => o.path === 'docs/setup-with-claude.md');
  const guide = file?.content ?? '';
  const prompts = [...guide.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  const page = prompts.find((p) => p.includes('- model-key: '))!;
  const real = loadMaster();

  it('opens with the one line a person pastes, which names this guide', () => {
    assert.ok(file, 'outputs() makes docs/setup-with-claude.md');
    assert.doesNotMatch(prompts[0]!, /\n/);
    assert.match(prompts[0]!, /git clone|clone https:\/\/github\.com\/qoralai\/bwat/);
    assert.match(prompts[0]!, /docs\/setup-with-claude\.md$/);
  });

  it('every step line names a step of the local flow by its id, once', () => {
    assert.ok(page, 'a step list for the setup page');
    const named = [...page.matchAll(/^- ([\w-]+): /gm)].map((m) => m[1]!);
    assert.ok(named.length > 5);
    assert.equal(new Set(named).size, named.length);
    for (const id of named) assert.ok(real.steps.find((s) => s.id === id)?.flows.includes('local'), `${id} is no local step`);
  });

  it("every tool the step list names is one of mcp.ts's TOOLS", () => {
    const names = TOOLS.map((t) => t.name);
    const used = new Set([...(page ?? '').matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)].map((m) => m[1]!).filter((w) => !w.startsWith('bwat')));
    assert.ok(used.size > 0);
    for (const name of used) assert.ok(names.includes(name), `${name} is not an onboarding tool`);
  });

  it('never tells Claude to steer the page: the person does each step on it', () => {
    for (const gone of ['show_step', 'open_link', 'set_answer', 'set_flow', 'request_secret', 'tick_step']) assert.doesNotMatch(guide, new RegExp(gone), gone);
    assert.match(guide, /The\s+page\s+leads/);
  });

  it('the step list runs no command: the page writes the answers and starts the install itself', () => {
    assert.doesNotMatch(page ?? '', /^\s+run_command /m);
  });

  it('gives Claude the rules', () => {
    for (const rule of [/Never\s+ask\s+for\s+a\s+secret/, /One\s+step\s+at\s+a\s+time/, /Never\s+read\s+`bwat\.answers`/, /Never\s+run\s+`\.\/bwat\s+setup`/,
      /Never\s+download\s+the\s+Zoom\s+Meeting\s+SDK/, /Never\s+open,\s+read\s+or\s+screenshot\s+a\s+page\s+that\s+shows\s+a\s+secret/, /App\s+Credentials/,
      /OpenRouter's\s+key\s+page/, /Never\s+open\s+openrouter\.ai/, /Explain,\s+then\s+act/]) assert.match(guide, rule);
  });

  it('sends a server install to the production steps the setup page links to', () => {
    const onboarding = readFileSync(join(ROOT, 'docs/onboarding.md'), 'utf8');
    const slugs = [...onboarding.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]!.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-'));
    assert.match(SERVER_GUIDE, /^https:\/\/github\.com\/[\w-]+\/bwat\/blob\/main\/docs\/onboarding\.md#/);
    // The setup page's script can't import flow.ts: its copy must match.
    const page = readFileSync(join(ROOT, 'setup/onboard/static/page.js'), 'utf8');
    assert.equal(page.match(/var SERVER_GUIDE = '([^']+)';/)?.[1], SERVER_GUIDE);
    assert.ok(slugs.includes(SERVER_GUIDE.split('#')[1]!), SERVER_GUIDE);
    assert.match(guide, /never stop this computer's setup page to start one/);
  });

  it('puts whole sentences, without path dates, in every step line', () => {
    for (const format of ['claude-page', 'claude-terminal']) {
      const text = render(`{{steps format=${format}}}`, real, 'guide');
      for (const line of text.split('\n')) {
        assert.doesNotMatch(line, /:$/, line);
        assert.doesNotMatch(line, /\(not yet checked\)|\(as of /, line);
        assert.doesNotMatch(line, /``/, line);
      }
      for (const line of text.split('\n').filter((l) => /^- /.test(l))) {
        assert.match(line, /[.!?]$/, line);
        const sentence = line.replace(/^- ([\w-]+: )?/, '').replace(/^.*?[^.]\. (?=[A-Z`])/, '');
        assert.ok(sentence.split(' ').length >= 4 || line.endsWith('step.'), `a fragment: ${line}`);
      }
    }
  });

  it('refuses a keep block without its end marker, with or without a committed block', () => {
    const open = 'Top\n<!-- bwat:keep aws -->\nseed\nRest';
    assert.throws(() => render(open, master, 'guide', '<!-- bwat:keep aws -->\nold\n<!-- bwat:end-keep -->'), /keep block aws/);
    assert.throws(() => render(open, master, 'guide'), /keep block aws/);
  });

  it('renders fields, secrets, commands, checks and conditions as lines under each step', () => {
    const t = '```text\n{{steps ids=zoom,board format=claude-page}}\n```\n```text\n{{steps ids=zoom,board format=claude-terminal}}\n```';
    const [a, b] = [...render(t, master, 'guide').matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
    assert.match(a!, /^- zoom: Create the Zoom app\. Make the app in the Zoom marketplace\.\n  \(only for: Production on a cloud server\)\n  they fill BWAT_PUBLIC_URL on the page\n  they type ZOOM_CLIENT_SECRET into the page\n  run_command prep\n  \(ticks itself when /m);
    assert.match(a!, /\(only when /);
    assert.match(b!, /^- Create the Zoom app\. Make the app in the Zoom marketplace\.\n  \(only for: Production on a cloud server\)\n  fill BWAT_PUBLIC_URL in bwat\.answers\n  I save it with \.\/bwat secret ZOOM_CLIENT_SECRET\n  run \.\/bwat prep/m);
    assert.throws(() => render('{{steps format=moon}}', master, 'guide'), Error);
  });

  it('leaves out what show= leaves out, in a prompt too: commands the page runs by itself', () => {
    for (const format of ['claude-page', 'claude-terminal']) {
      const text = render(`{{steps ids=zoom format=${format} show=title,text,fields,checks,when}}`, master, 'guide');
      assert.doesNotMatch(text, /run_command|run \.\/bwat/, format);
      assert.match(text, /BWAT_PUBLIC_URL/, format);
      assert.match(text, /\(ticks itself when /, format);
    }
  });

  // A template with an empty keep block, as the AWS one was: its content lives only in the committed output.
  const KEEP = 'A\n{{steps format=guide}}\n<!-- bwat:keep x -->\n<!-- bwat:end-keep -->\nB';
  const COMMITTED = 'old\n<!-- bwat:keep x -->\nHand-written.\n<!-- bwat:end-keep -->\nold';

  it('refuses to write an empty keep block: the committed one is missing or emptied', () => {
    assert.throws(() => render(KEEP, real, 'guide'), /keep block x has no committed content/);
    assert.throws(() => render(KEEP, real, 'guide', 'no markers here'), /keep block x has no committed content/);
    const emptied = COMMITTED.replace('Hand-written.\n', '');
    assert.throws(() => render(KEEP, real, 'guide', emptied), /keep block x is empty/);
    assert.ok(render('A\n<!-- bwat:keep x -->\nseed\n<!-- bwat:end-keep -->\nB', real, 'guide').includes('seed'));
  });

  it('the keep block survives regeneration byte for byte', () => {
    const block = COMMITTED.match(/<!-- bwat:keep x -->[\s\S]*?<!-- bwat:end-keep -->/)![0];
    const changed = { ...real, steps: real.steps.map((s) => ({ ...s, title: `${s.title} (changed)` })) };
    const out = render(KEEP, changed, 'guide', COMMITTED);
    assert.ok(out.includes(block));
    assert.match(out, /\(changed\)/);
    const edited = COMMITTED.replace('<!-- bwat:end-keep -->', 'Hand edit.\n<!-- bwat:end-keep -->');
    assert.ok(render(KEEP, changed, 'guide', edited).includes('Hand edit.'));
  });
});

describe('facts the master must keep', () => {
  const guide = readFileSync(join(ROOT, 'docs/onboarding.md'), 'utf8');
  // The board app's other APIs and its scopes are left to its manifest, which sets them.
  it('the port rules, the board app APIs bwat checks, and the optional providers', () => {
    assert.match(guide, /Setup moves bwat to the next free port when something else holds its port/);
    assert.match(guide, /A port you give in the environment [^\n]* is never moved/);
    for (const name of ['getAppContext', 'getMeetingUUID', 'getUserContext']) assert.ok(guide.includes(`\`${name}\``), name);
    assert.match(guide, /Other model providers are optional; set them in the admin panel\./);
  });

  it('every step the installer names exists by its title', () => {
    const titles = new Set(loadMaster().steps.map((s) => s.title));
    const text = readFileSync(join(ROOT, 'setup/bwat'), 'utf8');
    const named = [...text.matchAll(/the \\?"([^"\\]+)\\?" step of docs\/onboarding\.md/g)].map((m) => m[1]!);
    assert.ok(named.length > 0);
    for (const title of named) assert.ok(titles.has(title), `setup/bwat names the step "${title}", which the master lacks`);
  });
});

describe('reference documents', () => {
  const files = ['README.md', 'backend/README.md', 'web/README.md', 'bot/sdk/README.md'];
  const paths = (outputs().find((o) => o.path === 'setup/onboard/paths.tsv')?.content ?? '')
    .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')[1]!);

  it('repeat no click path: the guide holds them, the files link to it', () => {
    assert.ok(paths.length > 20);
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const p of paths) if (text.includes(p)) found.push(`${file} repeats "${p}"`);
      text.split('\n').forEach((line, i) => {
        if (/\b(?:Zoom|Google|OpenRouter|Marketplace|Account Settings|Zoom Apps)\b[^\n]* > [A-Za-z"][^\n]* > [A-Za-z"]/.test(line)) found.push(`${file}:${i + 1} looks like a click path`);
      });
    }
    assert.deepEqual(found, []);
  });

  it('link only to headings the guide has', () => {
    const slugs = (page: string) => new Set([...readFileSync(join(ROOT, 'docs', page), 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]!.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-')));
    const bad: string[] = [];
    let links = 0;
    for (const file of [...files, 'docs/hosting.md', 'docs/speaker-identity.md', 'docs/setup-with-claude.md']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const [, target, page, slug] of text.matchAll(/\]\(((?:\.\.?\/)*(?:docs\/)?(onboarding\.md))#([\w-]+)\)/g)) {
        links++;
        if (!existsSync(join(ROOT, 'docs', page!)) || !slugs(page!).has(slug!)) bad.push(`${file} links ${target}#${slug}`);
      }
    }
    assert.deepEqual(bad, []);
    assert.ok(links > 5, 'the files link to the guide');
  });
});
