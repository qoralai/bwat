// The onboarding guides as steps. The guides are ordinary Markdown for GitHub readers;
// HTML comments mark the parts the onboarding page works with:
//
//   <!-- bwat:step id=address flows=local,server title="Choose your address" -->
//   ...the step's text...
//   <!-- bwat:answer KEY -->     a plain answer, written to bwat.answers
//   <!-- bwat:secret KEY -->     a secret field (static/secret-field.js)
//   <!-- bwat:check ID -->       a check that ticks the step on its own
//   <!-- bwat:shot NAME -->      an annotated screenshot (docs/onboarding/shots/shots.json)
//   ```sh {bwat-run=ID}          a command the page may run; the page sends only its ID
//   <!-- bwat:end -->
//
// Also in the master:
//   <!-- bwat:path NAME date=YYYY-MM -->PATH TEXT<!-- bwat:end-path -->   a vendor click path, defined once,
//                               inline; later <!-- bwat:path NAME --> places it. A step or part that
//                               places a dated path ends with one line saying when its paths were checked
//   when=NAME                   on a step line: the step applies only under that condition (conditions.ts)
//   ask="QUESTION?"             on a step line: an optional step; the page asks first and shows
//                               the step on a yes, and a no skips it
//   <!-- bwat:when NAME --> ... <!-- bwat:end-when -->   the same for a block inside a step
//   <!-- bwat:more title="..." --> ... <!-- bwat:end-more -->   detail folded under its title, in a
//                               step or a part; never a step's fields, checks or commands
//   <!-- bwat:flows local,server --> ... <!-- bwat:end-flows -->   text for those ways of running bwat
//                               only, in a step or a part
//   <!-- bwat:os mac,windows --> ... <!-- bwat:end-os -->   text for those computers only (platform.ts)
//                               when, more, flows and os blocks nest in any order, never crossing
//   <!-- bwat:part ID title="..." --> ... <!-- bwat:end -->   text that is not a step, for a template to place
//   <!-- bwat:place STEP_ID -->   inside a part: that step's text, written once, placed there too
//
// Text outside a step or part is for GitHub readers only.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Marked, Renderer, type Tokens } from './vendor/marked.esm.js';
import { ROOT } from './root.ts';
import { CONDITIONS } from './conditions.ts';
import { PLATFORMS } from './platform.ts';

export const FLOWS = {
  local: 'Try it on this computer (local)',
  server: 'Production on a cloud server',
} as const;
/** The ways the setup page offers. A server install runs on the server itself, by the
 * production steps of docs/onboarding.md, so it is not a page flow: the page points there. */
export const PAGE_FLOWS = ['local'] as const;
export const SERVER_GUIDE = 'https://github.com/qoralai/bwat/blob/main/docs/onboarding.md#for-the-installer';

/** The way the page shows: a blank flow, or one it no longer offers (a saved "team"), is local. */
export function flowOf(state: { flow: string | null }): string {
  return state.flow && (PAGE_FLOWS as readonly string[]).includes(state.flow) ? state.flow : 'local';
}

/** Why the page will not take this flow, or null when it will. */
export function flowRefusal(flow: unknown): string | null {
  if (flow === 'server') return `A server install is not on this setup page: run it on the server, following ${SERVER_GUIDE}`;
  return typeof flow === 'string' && (PAGE_FLOWS as readonly string[]).includes(flow) ? null : 'unknown flow';
}

export const CHECKS =['prep-complete', 'bot-built', 'edge-healthy', 'owner-signed-in', 'claude-connected', 'zoom-ready', 'first-card', 'openrouter-key'] as const;
/** The master: the one source; docs/onboarding.md and the other formats are made from it. */
export const MASTER = 'docs/onboarding/master.md';

export type Step = {
  id: string;
  title: string;
  flows: string[];
  guide: string;
  when: string | null;
  ask: string | null;
  html: string;
  markdown: string;
  answers: string[];
  secrets: string[];
  checks: string[];
  shots: string[];
  runs: { id: string; command: string }[];
};
export type ClickPath = { name: string; path: string; date: string | null };
export type Part = { id: string; title: string; markdown: string; html: string };
export type Master = { steps: Step[]; parts: Part[]; paths: Map<string, ClickPath> };
export type Keys = { plain: Set<string>; secret: Set<string> };

const DIRECTIVE = /^\s*<!--\s*bwat:([\w-]+)(.*?)-->\s*$/;
// A path definition (with its text) or a use (alone), inline in a line.
// A definition's text never crosses another comment, so a use followed by a definition stays two paths.
const PATH = /<!--\s*bwat:path\s+([a-z0-9-]+)((?:\s+date=\S+)?)\s*-->(?:((?:(?!<!--).)*?)<!--\s*bwat:end-path\s*-->)?/g;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RUN_FENCE = /^(\s*)```sh \{bwat-run=([a-z0-9-]+)\}\s*$/;
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// The blocks that keep text for some installs only, with the names each takes and the noun
// its errors use; the page hides one whose names miss this install's (page.js forThisInstall).
const SCOPES: Record<string, { names: Record<string, string>; noun: string }> = {
  flows: { names: FLOWS, noun: 'flow' },
  os: { names: PLATFORMS, noun: 'platform' },
};

export const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

export function attributes(text: string) {
  const found: Record<string, string> = {};
  for (const m of text.matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/g)) found[m[1]!] = m[2] ?? m[3]!;
  return found;
}

/** The keys of the bwat.answers template setup/prep writes; a secret's line follows a "# secret:" comment. */
export function answerKeys(): Keys {
  const prep = readFileSync(join(ROOT, 'setup/prep'), 'utf8');
  const template = prep.slice(prep.indexOf('cat > "$file" <<EOF'), prep.indexOf('\nEOF\n'));
  const keys: Keys = { plain: new Set(), secret: new Set() };
  let previous = '';
  for (const line of template.split('\n')) {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    if (key) (previous.startsWith('# secret:') ? keys.secret : keys.plain).add(key);
    previous = line;
  }
  return keys;
}

export function shotNames(): Set<string> {
  const shots = JSON.parse(readFileSync(join(ROOT, 'docs/onboarding/shots/shots.json'), 'utf8')) as { name: string }[];
  return new Set(shots.map((s) => s.name));
}

function markdown() {
  const renderer = new Renderer();
  renderer.link = function ({ href, title, tokens }: Tokens.Link) {
    const text = this.parser.parseInline(tokens);
    const external = /^https?:\/\//.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ''}${external}>${text}</a>`;
  };
  renderer.code = ({ text, lang }: Tokens.Code) => {
    const run = lang?.match(/^sh \{bwat-run=([a-z0-9-]+)\}$/);
    if (run) return `<div class="bwat-run" data-run="${run[1]}"><pre><code>${escape(text)}</code></pre></div>\n`;
    const language = lang?.split(/\s/)[0];
    return `<pre><code${language ? ` class="language-${escape(language)}"` : ''}>${escape(text)}</code></pre>\n`;
  };
  return new Marked({ gfm: true, renderer });
}

/** When a step's or part's click paths were checked, from their YYYY-MM dates: "October and November 2026". */
export function checkedLine(dates: Iterable<string>): string {
  const byYear = new Map<string, Set<number>>();
  for (const d of [...dates].sort()) byYear.set(d.slice(0, 4), (byYear.get(d.slice(0, 4)) ?? new Set()).add(Number(d.slice(5))));
  const said = [...byYear].map(([year, months]) => {
    const names = [...months].map((m) => MONTHS[m - 1]!);
    return `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]} ${year}`;
  });
  return `_Click paths as of ${said.join(' and ')}._`;
}

export function parseMaster(path: string, text: string, { keys, shots }: { keys: Keys; shots: Set<string> }): Master {
  const errors: string[] = [];
  const steps: Step[] = [];
  const parts: Part[] = [];
  const paths = new Map<string, ClickPath>();
  const stripped: [number, string][] = [];
  let part: { id: string; title: string } | undefined;
  // Parts as read; each place is filled in once every step is known.
  const rawParts: { id: string; title: string; md: string; body: string; places: [number, string][] }[] = [];
  let places: [number, string][] = [];
  const sentinel = (id: string) => `<!--bwat-place:${id}-->`;
  let note = false;
  // The dates of the dated click paths the open step or part places.
  let checked = new Set<string>();
  let when: string | undefined;
  let whenLine = 0;
  let more: { line: number } | undefined;
  // The open bwat:when, bwat:more and bwat:flows blocks, innermost last: they nest in any
  // order, and each closes before the block around it.
  const blocks: string[] = [];
  const close = (n: number, kind: string) => {
    const top = blocks[blocks.length - 1];
    if (top !== kind) fail(n, `bwat:end-${kind} inside bwat:${top}: close the ${top} first`);
    blocks.splice(blocks.lastIndexOf(kind), 1);
  };
  let mores = 0;
  // A refused nested bwat:more: its own end-more is skipped, so it reports once.
  let refusedMores = 0;
  // Each open bwat:flows or bwat:os block's line, and refused nested ones whose ends are skipped.
  let scopeLines: Record<string, number> = {};
  let refusedScopes: Record<string, number> = {};
  let md: string[] = [];
  const ids = new Set<string>();
  const runIds = new Set<string>();
  const marked = markdown();
  let step: Step | undefined;
  let start = 0;
  let body: string[] = [];
  const lines = text.split('\n');
  const fail = (line: number, message: string) => errors.push(`${path}:${line}: ${message}`);
  const open = () => step ?? part;

  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i]!;
    const run = line.match(RUN_FENCE);
    if (run) {
      const [, indent, id] = run as unknown as [string, string, string];
      const end = lines.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l));
      const command = lines.slice(i + 1, end < 0 ? undefined : end).map((l) => l.slice(indent.length)).join('\n');
      if (!step) fail(n, 'bwat-run outside a step');
      else if (more) fail(n, "bwat-run inside bwat:more: a step's commands stay in view");
      else if (runIds.has(id)) fail(n, `bwat-run id ${id} is used twice`);
      else if (!/^(\.\/bwat |setup\/)/.test(command)) fail(n, 'a bwat-run command must start with ./bwat or setup/');
      else step.runs.push({ id, command });
      runIds.add(id);
      if (open()) { body.push(...lines.slice(i, end < 0 ? undefined : end + 1)); md.push(...lines.slice(i, end < 0 ? undefined : end + 1)); }
      i = end < 0 ? lines.length : end;
      continue;
    }
    // Click paths sit inline in a line of a step or a part: placed as text, with the date they were checked.
    if (new RegExp(PATH.source).test(line)) {
      if (!open()) { fail(n, 'bwat:path outside a step or a part'); continue; }
      const mdLine = line.replace(PATH, (_, name: string, dateAttr: string, text?: string) => {
        if (text === undefined) {
          const known = paths.get(name);
          if (!known) { fail(n, `path ${name} is not defined`); return ''; }
          if (dateAttr.trim()) fail(n, `path ${name}: date= belongs on the definition, not on a use`);
          if (known.date) checked.add(known.date);
          return known.path;
        }
        if (paths.has(name)) { fail(n, `path ${name} is defined twice`); return text; }
        const date = dateAttr.trim().slice('date='.length) || null;
        if (date !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(date)) fail(n, `path ${name} has a bad date ${date}`);
        const found = { name, path: text, date };
        paths.set(name, found);
        if (date) checked.add(date);
        return text;
      });
      const htmlLine = line.replace(PATH, (_, name: string) => {
        const found = paths.get(name);
        return found ? escape(found.path) : '';
      });
      body.push(htmlLine);
      md.push(mdLine);
      stripped.push([n, line.replace(PATH, '')]);
      continue;
    }
    const directive = line.match(DIRECTIVE);
    if (!open() && !directive) {
      // The master holds no free prose: a heading is for its own readers, a comment is a note.
      if (note) { if (line.includes('-->')) note = false; continue; }
      if (line.trim() === '' || /^#{1,6}\s/.test(line)) continue;
      if (line.trimStart().startsWith('<!--')) { note = !line.includes('-->'); continue; }
      fail(n, 'text outside a step or a part: put it in a part (<!-- bwat:part ID title="..." -->)');
      continue;
    }
    if (!directive) {
      if (open()) { body.push(line); md.push(line); stripped.push([n, line]); }
      continue;
    }
    const [, kind, rest] = directive as unknown as [string, string, string];
    const value = rest.trim();
    // A placeholder keeps the directive's indent, so one inside a list item stays in it.
    const place = (html: string) => body.push('', line.match(/^\s*/)![0] + html, '');
    if (kind === 'step' || kind === 'part') {
      const a = attributes(rest);
      const id = kind === 'step' ? a.id ?? '' : value.split(/\s/)[0] ?? '';
      const inside = step ?? part;
      if (inside) { fail(n, `${kind} ${id} starts inside ${step ? 'step' : 'part'} ${inside.id}`); continue; }
      if (ids.has(id)) fail(n, `${kind} id ${id} is used twice`);
      ids.add(id);
      body = [];
      md = [];
      checked = new Set();
      start = n;
      mores = 0;
      refusedMores = 0;
      refusedScopes = {};
      if (kind === 'part') {
        if (!a.title) fail(n, `part ${id} has no title`);
        part = { id, title: a.title ?? '' };
        continue;
      }
      const flows = (a.flows ?? '').split(',').filter(Boolean);
      for (const flow of flows) if (!Object.hasOwn(FLOWS, flow)) fail(n, `unknown flow ${flow}`);
      if (!a.title) fail(n, `step ${id} has no title`);
      if (a.when && !Object.hasOwn(CONDITIONS, a.when)) fail(n, `unknown condition ${a.when}`);
      step = { id, title: a.title ?? '', flows, guide: path, when: a.when ?? null, ask: a.ask ?? null, html: '', markdown: '', answers: [], secrets: [], checks: [], shots: [], runs: [] };
      continue;
    }
    if (kind === 'end') {
      if (!step && !part) { fail(n, 'bwat:end outside a step or a part'); continue; }
      if (when) { fail(whenLine, `bwat:when ${when} is never closed with bwat:end-when`); when = undefined; }
      if (more) { fail(more.line, 'bwat:more is never closed with bwat:end-more'); more = undefined; }
      for (const [k, l] of Object.entries(scopeLines)) if (l) fail(l, `bwat:${k} is never closed with bwat:end-${k}`);
      scopeLines = {};
      blocks.length = 0;
      if (checked.size) { md.push('', checkedLine(checked)); body.push('', checkedLine(checked)); }
      if (step) {
        step.html = marked.parse(body.join('\n'), { async: false });
        step.markdown = md.join('\n').trim();
        steps.push(step);
        step = undefined;
      } else {
        rawParts.push({ id: part!.id, title: part!.title, md: md.join('\n').trim(), body: body.join('\n'), places });
        places = [];
        part = undefined;
      }
      continue;
    }
    if (kind === 'place') {
      if (!part) { fail(n, 'bwat:place outside a part'); continue; }
      places.push([n, value]);
      md.push(sentinel(value));
      body.push('', sentinel(value), '');
      continue;
    }
    if (kind === 'when') {
      if (!step) { fail(n, 'bwat:when outside a step'); continue; }
      if (when) { fail(n, `bwat:when ${value} starts inside bwat:when ${when}`); continue; }
      if (!Object.hasOwn(CONDITIONS, value)) fail(n, `unknown condition ${value}`);
      when = value;
      blocks.push('when');
      whenLine = n;
      md.push(line);
      place(`<div class="bwat-when" data-when="${value}">`);
      continue;
    }
    if (kind === 'end-when') {
      if (!when) { fail(n, 'bwat:end-when without bwat:when'); continue; }
      close(n, 'when');
      when = undefined;
      md.push(line);
      place('</div>');
      continue;
    }
    if (Object.hasOwn(SCOPES, kind)) {
      const scope = SCOPES[kind]!;
      if (!open()) { fail(n, `bwat:${kind} outside a step or a part`); continue; }
      if (scopeLines[kind]) { fail(n, `bwat:${kind} starts inside bwat:${kind}`); refusedScopes[kind] = (refusedScopes[kind] ?? 0) + 1; continue; }
      const names = value.split(',').map((f) => f.trim()).filter(Boolean);
      if (!names.length) fail(n, `bwat:${kind} names no ${scope.noun}`);
      for (const name of names) if (!Object.hasOwn(scope.names, name)) fail(n, `unknown ${scope.noun} ${name}`);
      scopeLines[kind] = n;
      blocks.push(kind);
      md.push(line);
      place(`<div class="bwat-${kind}" data-${kind}="${names.join(',')}">`);
      continue;
    }
    const ended = kind.startsWith('end-') ? kind.slice('end-'.length) : '';
    if (Object.hasOwn(SCOPES, ended)) {
      if (refusedScopes[ended]) { refusedScopes[ended]!--; continue; }
      if (!scopeLines[ended]) { fail(n, `bwat:${kind} without bwat:${ended}`); continue; }
      close(n, ended);
      scopeLines[ended] = 0;
      md.push(line);
      place('</div>');
      continue;
    }
    if (kind === 'more') {
      const owner = open();
      if (!owner) { fail(n, 'bwat:more outside a step or a part'); continue; }
      if (more) { fail(n, 'bwat:more starts inside bwat:more'); refusedMores++; continue; }
      const title = attributes(rest).title;
      if (!title) fail(n, 'bwat:more has no title');
      more = { line: n };
      blocks.push('more');
      md.push(line);
      place(`<details class="bwat-more" data-more="${owner.id}-${mores++}"><summary>${escape(title ?? '')}</summary>`);
      continue;
    }
    if (kind === 'end-more') {
      if (refusedMores) { refusedMores--; continue; }
      if (!more) { fail(n, 'bwat:end-more without bwat:more'); continue; }
      close(n, 'more');
      more = undefined;
      md.push(line);
      place('</details>');
      continue;
    }
    if (!['answer', 'secret', 'check', 'shot'].includes(kind)) { fail(n, `unknown directive bwat:${kind}`); continue; }
    if (!step) { fail(n, `bwat:${kind} outside a step`); continue; }
    if (more && kind !== 'shot') { fail(n, `bwat:${kind} inside bwat:more: a step's fields stay in view`); continue; }
    md.push(line);
    if (kind === 'answer') {
      if (keys.secret.has(value)) fail(n, `${value} is a secret: use bwat:secret`);
      else if (!keys.plain.has(value)) fail(n, `${value} is not a line of the bwat.answers template`);
      else { step.answers.push(value); place(`<div class="bwat-answer" data-key="${value}"></div>`); }
    } else if (kind === 'secret') {
      if (keys.plain.has(value)) fail(n, `${value} is not a secret: use bwat:answer`);
      else if (!keys.secret.has(value)) fail(n, `${value} is not a line of the bwat.answers template`);
      else { step.secrets.push(value); place(`<div class="bwat-secret" data-key="${value}"></div>`); }
    } else if (kind === 'check') {
      if (!(CHECKS as readonly string[]).includes(value)) fail(n, `unknown check ${value}`);
      else { step.checks.push(value); place(`<div class="bwat-check" data-check="${value}"></div>`); }
    } else {
      if (!shots.has(value)) fail(n, `no shot named ${value} in docs/onboarding/shots/shots.json`);
      else { step.shots.push(value); place(`<figure class="bwat-shot" data-shot="${value}"></figure>`); }
    }
  }
  if (more) fail(more.line, 'bwat:more is never closed with bwat:end-more');
  for (const [k, l] of Object.entries(scopeLines)) if (l) fail(l, `bwat:${k} is never closed with bwat:end-${k}`);
  if (step) fail(start, `step ${step.id} is never closed with bwat:end`);
  if (part) fail(start, `part ${part.id} is never closed with bwat:end`);
  // A path the master names is placed by name, never spelled out again.
  for (const [n, text] of stripped) {
    for (const found of paths.values()) {
      if (text.includes(found.path)) fail(n, `spells out path ${found.name}; use <!-- bwat:path ${found.name} -->`);
    }
  }
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const raw of rawParts) {
    let { md: text, body: html } = raw;
    for (const [n, id] of raw.places) {
      const placed = byId.get(id);
      if (!placed) { fail(n, `bwat:place ${id}: no such step`); continue; }
      text = text.split(sentinel(id)).join(placed.markdown);
    }
    html = marked.parse(html, { async: false });
    for (const [, id] of raw.places) {
      const placed = byId.get(id);
      if (placed) html = html.split(sentinel(id)).join(placed.html);
    }
    parts.push({ id: raw.id, title: raw.title, markdown: text, html });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { steps, parts, paths };
}

export function loadMaster(file?: string): Master {
  return parseMaster(file ?? MASTER, readFileSync(file ?? join(ROOT, MASTER), 'utf8'), { keys: answerKeys(), shots: shotNames() });
}

/**
 * The master as the page server reads it: parsed again whenever the file changes, so an
 * edit shows on the next request. A master that no longer parses leaves the last good
 * model in place and prints the error to stderr once per change of the file.
 */
export function masterReader(file?: string): () => Master {
  let seen = '';
  let model: Master | undefined;
  return () => {
    const path = file ?? join(ROOT, MASTER);
    let version: string;
    try {
      const { mtimeMs, size } = statSync(path);
      version = `${path}:${mtimeMs}:${size}`;
    } catch (error) {
      // Deleted or unreadable while running: keep the last good guide, say so once.
      if (!model) throw error;
      version = `${path}:missing`;
      if (version !== seen) console.error(`bwat setup page: ${path} cannot be read; showing the last good guide.\n${(error as Error).message}`);
      seen = version;
      return model;
    }
    if (model && version === seen) return model;
    try {
      model = loadMaster(file);
    } catch (error) {
      if (!model) throw error;
      console.error(`bwat setup page: ${path} does not parse; showing the last good guide.\n${(error as Error).message}`);
    }
    seen = version;
    return model;
  };
}
