// The page's API: the guide, the progress, the plain answers, the secrets' masks, and the
// guide's commands with their output; and Connect OpenRouter, whose return is a page.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readAnswers, writeAnswer } from './answers.ts';
import { conditionStates, whenApplies } from './conditions.ts';
import { platformTags } from './platform.ts';
import { createChecks } from './checks.ts';
import { createFinish } from './finish.ts';
import { answerKeys, FLOWS, flowOf, flowRefusal, masterReader, PAGE_FLOWS } from './flow.ts';
import { body, HEADERS, json, object, Refused, send, TYPES, type Handler } from './http.ts';
import { addLlmRoutes, createBus } from './llm.ts';
import { ROOT } from './root.ts';
import { createRunner, type Runner } from './runner.ts';
import { createSdk } from './sdk.ts';
import { saveSecret, secretStatus } from './secrets.ts';
import { readState, writeState, type State } from './state.ts';

// signinCode: where setup, run from the page with no terminal, leaves a new local sign-in code
// (setup/bwat); by default beside the logs folder.
// sdk: where a Zoom Meeting SDK file dropped on the page goes, which setup/zoom-sdk searches first.
export type Paths = { state: string; answers: string; env: string; logs: string; signinCode?: string; sdk?: string };
export const defaultPaths = (): Paths => ({
  state: join(ROOT, '.bwat/onboard/state.json'),
  answers: join(ROOT, 'bwat.answers'),
  env: join(ROOT, '.env'),
  logs: join(ROOT, '.bwat/logs'),
});

// Every secret value a command might print: the answers file's secrets, and .env's
// passwords, keys, tokens and credentials (its other values, such as a port, stay readable).
function secretValues(paths: Paths, secretKeys: Set<string>) {
  const values: string[] = [];
  for (const [key, value] of readAnswers(paths.answers)) if (secretKeys.has(key) && value) values.push(value);
  for (const [key, value] of readAnswers(paths.env)) {
    if (/SECRET|PASSWORD|KEY|TOKEN|CREDENTIAL/.test(key) && value.length >= 8) values.push(value);
  }
  return values;
}

const GUIDE_URL = 'https://github.com/qoralai/bwat/blob/main/docs/onboarding.md';

/** The chosen way's steps still open (not done, not skipped), without those whose condition is false. */
export function openChecklist(state: State, steps: { id: string; title: string; flows: string[]; when?: string | null }[], answers: Map<string, string>) {
  const flow = flowOf(state);
  const states = conditionStates(answers);
  return steps.filter((s) => s.flows.includes(flow) && !state.steps[s.id] && whenApplies(s.when, states))
    .map((s) => ({ id: s.id, title: s.title, detail: `From the setup page: ${FLOWS[flow as keyof typeof FLOWS]}.`, link: GUIDE_URL }));
}

/** route adds a route: one under /api/ answers only with the token; a GET outside /api/ needs none. */
export function addRoutes(route: (key: string, handler: Handler) => void, paths: Paths,
  options: {
    commands?: Map<string, string>; cwd?: string; fetch?: typeof fetch;
    exec?: (file: string, args: string[]) => Promise<string>;
    /** Called once the installer has deleted the page's records: the server then stops. */
    onDestroyed?: () => void;
    /** How long an LLM's request waits for the person (tests shorten it). */
    waitMs?: number;
    /** Write bwat.answers with ./bwat prep at start when it is missing (the real page). */
    prep?: boolean;
    /** A master other than docs/onboarding/master.md (tests). */
    master?: string;
    /** The SDK's commands, and whether a finished file starts the bot's build (tests: off). */
    sdk?: { exec?: (file: string, args: string[]) => Promise<string>; auto?: boolean; maxBytes?: number };
  } = {}): Runner {
  // The master is a file of this clone; the reader parses it again whenever it changes, so
  // every use below asks for the current model.
  const readMaster = masterReader(options.master);
  readMaster(); // a master that does not parse stops the server at start
  const stepIds = () => new Set(readMaster().steps.map((s) => s.id));
  const keys = answerKeys();
  const platform = platformTags(); // this computer does not change while the page runs
  // Each shot of shots.json, with its image once a maintainer has saved one as
  // docs/onboarding/shots/<name>.png: taken by hand, personal data covered, numbered marks
  // drawn, then the shot's labels (one per mark, in order) and capture date written into
  // shots.json. Read on each request, so a saved image shows at once.
  const shotDir = join(ROOT, 'docs/onboarding/shots');
  type ShotEntry = { name: string; url: string; caption: string; labels?: string[]; captured?: string };
  const shots = () => (JSON.parse(readFileSync(join(shotDir, 'shots.json'), 'utf8')) as ShotEntry[])
    .map(({ name, url, caption, labels = [], captured }) => (existsSync(join(shotDir, `${name}.png`))
      ? { name, url, caption, image: `/shots/${name}.png`, captured: captured ?? null, labels }
      : { name, url, caption, image: null, labels: [] }));
  const commands = () => options.commands ?? new Map(readMaster().steps.flatMap((s) => s.runs.map((r) => [r.id, r.command] as const)));
  const runner = createRunner({ commands, cwd: options.cwd ?? ROOT, logs: paths.logs, secrets: () => secretValues(paths, keys.secret) });
  runner.on((event) => {
    if (event.type !== 'exit') return;
    const run = runner.last(event.id)!;
    const state = readState(paths.state);
    writeState(paths.state, { ...state, runs: { ...state.runs, [event.id]: { exit: event.exit, started: run.started, ended: run.ended! } } });
    applyPendingMode();
  });

  // The meeting bot's build runs beside the page's commands, never in their one slot.
  const sdk = createSdk({
    dir: paths.sdk ?? join(dirname(paths.logs), 'sdk'), cwd: options.cwd ?? ROOT, logs: paths.logs, busy: () => runner.running(),
    ...(options.sdk?.exec ? { exec: options.sdk.exec } : {}), ...(options.sdk?.auto === false ? { auto: false } : {}), ...(options.sdk?.maxBytes ? { maxBytes: options.sdk.maxBytes } : {}),
  });

  const bus = createBus();
  // The local flow, chosen on the page, is developer mode on the local tier (D202): this computer with no
  // Google. One chosen before bwat.answers has its BWAT_MODE line (prep not run yet) is remembered
  // in the state and applied when the server next reads the answers. Only the key goes on the bus.
  const applyPendingMode = () => {
    const { modePending, ...state } = readState(paths.state);
    if (!modePending) return;
    const answers = readAnswers(paths.answers);
    if (!answers.has('BWAT_MODE')) return;
    writeState(paths.state, state);
    const want: Record<string, string> = { BWAT_MODE: 'developer', BWAT_TIER: 'local' };
    // Trying it on this computer has nothing to choose: localhost at the port prep picked.
    // An address the person saved is theirs, so the defaults go in only over a blank or
    // localhost one, and a look at this tab loses nothing.
    if (/^(|http:\/\/localhost:\d+)$/.test(answers.get('BWAT_PUBLIC_URL') ?? '')) {
      Object.assign(want, { BWAT_PUBLIC_URL: `http://localhost:${answers.get('BWAT_EDGE_PORT') || '8080'}`, BWAT_TLS: 'external' });
    }
    for (const [key, value] of Object.entries(want)) {
      if (!answers.has(key)) continue;
      if (answers.get(key) !== value) writeAnswer(paths.answers, key, value);
      bus.emit({ type: 'answer', key });
    }
  };
  const chooseMode = (flow: string) => {
    writeState(paths.state, { ...readState(paths.state), modePending: flow });
    applyPendingMode();
  };
  addLlmRoutes(route, {
    bus, runner, commands,
    ...(options.waitMs ? { waitMs: options.waitMs } : {}),
  });
  // The page asks nothing of the answers file: the server writes it (./bwat prep) at start,
  // writes the Zoom manifest again once the names are in, and the page is local unless chosen.
  const prep = () => { if (!runner.running() && commands().has('prep-manifests')) runner.start('prep-manifests'); };
  if (!readState(paths.state).flow) { writeState(paths.state, { ...readState(paths.state), flow: 'local' }); chooseMode('local'); }
  if (!existsSync(paths.answers) && options.prep) prep();
  const NAMES = ['BWAT_ZOOM_COMPANY', 'BWAT_ZOOM_CONTACT_NAME', 'BWAT_ZOOM_CONTACT_EMAIL'];

  const fetchFn = options.fetch ?? fetch;
  const checks = createChecks({ paths, cwd: options.cwd ?? ROOT, sdk, fetch: fetchFn, ...(options.exec ? { exec: options.exec } : {}) });
  // Runs every check and ticks the steps whose checks pass; the page asks every 15 seconds.
  route('GET /api/checks', async ({ res }) => { applyPendingMode(); await sdk.tick(); json(res, 200, await checks.run(readMaster().steps)); });

  // The Zoom Meeting SDK: what is here and the bot's build; a file dropped on the page; a
  // build asked for (one that failed is not retried on its own until the file changes).
  route('GET /api/sdk', async ({ res }) => json(res, 200, await sdk.status()));
  route('POST /api/sdk', async ({ req, res }) => json(res, 200, await sdk.upload(req)));
  route('POST /api/sdk/build', ({ res }) => { const run = sdk.build(); json(res, 202, { id: run.id, started: run.started }); });

  // The chosen way's steps not yet ticked, for the admin panel to keep.
  const openSteps = () => openChecklist(readState(paths.state), readMaster().steps, readAnswers(paths.answers));
  const finish = createFinish({ paths, steps: () => readMaster().steps, checks });
  route('GET /api/finish', async ({ res }) => json(res, 200, await finish.summary()));
  // A local install's sign-in code (D202), shown once: answered and deleted in one go, then 404.
  // A lost code: ./bwat setup --new-code in a terminal shows a new one.
  const signinCode = paths.signinCode ?? join(dirname(paths.logs), 'signin-code');
  route('POST /api/signin-code', ({ res }) => {
    let code: string;
    try {
      code = readFileSync(signinCode, 'utf8').trim();
    } catch {
      return json(res, 404, { error: 'no_code' });
    }
    // Deleted once the answer has gone out, so a reply that never left keeps the code.
    res.on('finish', () => rmSync(signinCode, { force: true }));
    return json(res, 200, { code });
  });
  // What stops this computer from running bwat, from the preflight: Docker, git, Rosetta.
  const execFn = options.exec ?? ((file: string, args: string[]) => new Promise<string>((done, fail) => {
    execFile(file, args, { cwd: options.cwd ?? ROOT, timeout: 30_000 }, (error, stdout) => (error ? fail(error) : done(stdout)));
  }));
  route('GET /api/preflight', async ({ res }) => {
    const ok = (file: string, args: string[]) => execFn(file, args).then(() => true, () => false);
    const [docker, git, rosetta] = await Promise.all([
      ok('docker', ['info']), ok('git', ['--version']),
      platform.includes('apple-silicon') ? ok('bash', ['setup/docker-rosetta', './bwat setup --web']) : Promise.resolve(true),
    ]);
    const problems = [
      ...docker ? [] : ['Docker is not running: start Docker Desktop.'],
      ...git ? [] : ['git is missing: install it.'],
      ...rosetta ? [] : ["Docker Desktop's Rosetta emulation is on: turn it off in Docker Desktop > Settings > General."],
    ];
    json(res, 200, { problems });
  });

  // Once bwat runs, the owner has signed in and Claude Code has connected, the page deletes
  // what setup kept here.
  route('POST /api/destroy', async ({ res }) => {
    await finish.destroy(['edge-healthy', 'owner-signed-in', 'claude-connected']);
    json(res, 200, { ok: true });
    options.onDestroyed?.();
  });
  route('POST /api/finish-later', async ({ res }) => json(res, 200, await checks.sendChecklist(openSteps())));

  route('GET /api/guide', ({ res }) => {
    applyPendingMode();
    const master = readMaster();
    json(res, 200, {
      flows: Object.fromEntries(PAGE_FLOWS.map((flow) => [flow, FLOWS[flow]])), steps: master.steps, parts: master.parts.map(({ id, title, html }) => ({ id, title, html })),
      shots: shots(), conditions: conditionStates(readAnswers(paths.answers)), platform,
    });
  });

  // The page's own credential stays on this computer: the browser never needs it.
  route('GET /api/state', ({ res }) => {
    const { install: _credential, ...state } = readState(paths.state);
    json(res, 200, state);
  });

  route('POST /api/flow', async ({ req, res }) => {
    const flow = object(await body(req)).flow;
    const refusal = flowRefusal(flow);
    if (refusal || typeof flow !== 'string') throw new Refused(refusal ?? 'unknown flow');
    const state = readState(paths.state);
    writeState(paths.state, { ...state, flow });
    chooseMode(flow);
    json(res, 200, { ok: true });
  });


  route('POST /api/step', async ({ req, res }) => {
    const { id, state: wanted } = object(await body(req));
    if (typeof id !== 'string' || !stepIds().has(id)) throw new Refused('unknown step');
    if (wanted !== 'done' && wanted !== 'skipped' && wanted !== 'todo') throw new Refused('a step is done, skipped or todo');
    const state = readState(paths.state);
    const next = { ...state.steps };
    if (wanted === 'todo') delete next[id];
    else next[id] = { state: wanted, by: 'person', at: new Date().toISOString() };
    writeState(paths.state, { ...state, steps: next });
    json(res, 200, { ok: true });
  });

  // Plain answers only: a secret's key is left out altogether, set or not.
  route('GET /api/answers', ({ res }) => {
    const values: Record<string, string> = {};
    for (const [key, value] of readAnswers(paths.answers)) if (keys.plain.has(key)) values[key] = value;
    // Once setup has run, its address wins: it moves bwat past a port something else holds.
    const env = readAnswers(paths.env);
    for (const key of ['BWAT_PUBLIC_URL', 'BWAT_EDGE_PORT']) if (env.get(key)) values[key] = env.get(key)!;
    json(res, 200, { file: existsSync(paths.answers), values });
  });

  route('POST /api/answer', async ({ req, res }) => {
    const { key, value } = object(await body(req));
    if (typeof key !== 'string' || !keys.plain.has(key)) throw new Refused('not a plain answer of bwat.answers');
    if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Refused('an answer is one line of at most 512 characters');
    }
    // The port as ./bwat setup takes it (port_refused), so the address below names a real one.
    if (key === 'BWAT_EDGE_PORT' && value !== '' && !(/^[1-9]\d*$/.test(value) && Number(value) <= 65535)) {
      throw new Refused('BWAT_EDGE_PORT must be a number from 1 to 65535');
    }
    if (!existsSync(paths.answers)) throw new Refused('there is no bwat.answers yet: run ./bwat prep first', 409);
    writeAnswer(paths.answers, key, value);
    // A localhost address names the port: a new port moves it, as ./bwat setup would.
    const address = readAnswers(paths.answers).get('BWAT_PUBLIC_URL') ?? '';
    if (key === 'BWAT_EDGE_PORT' && value !== '' && /^http:\/\/localhost:\d+$/.test(address)) {
      writeAnswer(paths.answers, 'BWAT_PUBLIC_URL', `http://localhost:${value}`);
      bus.emit({ type: 'answer', key: 'BWAT_PUBLIC_URL' });
    }
    // On this computer Zoom's contact is the owner, so the owner's email is the contact's too.
    if (key === 'BWAT_FIRST_OWNER_EMAIL' && readAnswers(paths.answers).has('BWAT_ZOOM_CONTACT_EMAIL')) {
      writeAnswer(paths.answers, 'BWAT_ZOOM_CONTACT_EMAIL', value);
      bus.emit({ type: 'answer', key: 'BWAT_ZOOM_CONTACT_EMAIL' });
    }
    if (NAMES.includes(key) || key === 'BWAT_FIRST_OWNER_EMAIL') {
      const answers = readAnswers(paths.answers);
      if (NAMES.every((name) => answers.get(name))) prep();
    }
    if (key === 'BWAT_MODE') { const { modePending: _chosen, ...state } = readState(paths.state); writeState(paths.state, state); }
    bus.emit({ type: 'answer', key });
    json(res, 200, { ok: true });
  });

  // Whether each secret is set, and its mask's parts: never a value.
  route('GET /api/secrets', ({ res }) => json(res, 200, secretStatus(paths.answers, keys.secret)));

  const storeSecret = async (key: string, value: string) => {
    const mask = await saveSecret(paths.answers, key, value);
    bus.emit({ type: 'answer', key });
    return mask;
  };
  route('POST /api/secret', async ({ req, res }) => {
    const { key, value } = object(await body(req));
    if (typeof key !== 'string' || !keys.secret.has(key)) throw new Refused('not a secret of bwat.answers');
    if (typeof value !== 'string') throw new Refused('no value');
    if (!existsSync(paths.answers)) throw new Refused('there is no bwat.answers yet: run ./bwat prep first', 409);
    json(res, 200, { key, set: true, ...await storeSecret(key, value) });
  });

  // Connect OpenRouter (OAuth with PKCE): the page asks for the link with its token, and
  // opens it in a new tab. OpenRouter sends the person back to /openrouter/callback with a
  // code and the state, each state taken once; the server swaps the code for a key and
  // saves it as a pasted one is saved. The key stays on the server; the tab only hears it worked.
  const verifiers = new Map<string, string>();
  route('POST /api/openrouter/start', ({ res, url }) => {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    verifiers.set(state, verifier);
    const auth = new URL('https://openrouter.ai/auth');
    auth.searchParams.set('callback_url', `http://localhost:${url.port}/openrouter/callback`);
    auth.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    auth.searchParams.set('code_challenge_method', 'S256');
    auth.searchParams.set('state', state);
    json(res, 200, { url: auth.href });
  });
  route('GET /openrouter/callback', async ({ res, url }) => {
    const state = url.searchParams.get('state') ?? '';
    const verifier = verifiers.get(state);
    if (!verifier) throw new Refused('this OpenRouter link was used already: press Connect OpenRouter again');
    verifiers.delete(state);
    const reply = await fetchFn('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: url.searchParams.get('code'), code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    const { key } = await reply.json().catch(() => ({})) as { key?: unknown };
    if (!reply.ok || typeof key !== 'string') throw new Refused('OpenRouter did not hand over a key: press Connect OpenRouter again');
    await storeSecret('OPENROUTER_API_KEY', key);
    send(res, 200, '<!doctype html><meta charset="utf-8"><title>bwat</title><p>OpenRouter is connected. You can close this tab.</p>', TYPES['.html']);
  });

  route('POST /api/run', async ({ req, res }) => {
    const { id, command } = object(await body(req));
    if (typeof id !== 'string') throw new Refused('no command id');
    if (typeof command !== 'string') throw new Refused('command is the text shown on the page');
    const run = runner.start(id, command);
    json(res, 202, { id: run.id, started: run.started });
  });

  route('GET /api/runs', ({ res }) => json(res, 200, { running: runner.running(), runs: [...runner.all(), ...sdk.runner.all()] }));

  // Server-sent events: each command's start, lines, progress and exit. The page reads
  // them with fetch, since EventSource cannot send the token's header.
  route('GET /api/events', ({ req, res }) => {
    res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const write = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const off = runner.on(write);
    const offBuild = sdk.runner.on(write);
    const offPage = bus.on(write);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { off(); offBuild(); offPage(); clearInterval(ping); });
  });

  return { ...runner, stop() { runner.stop(); sdk.runner.stop(); } };
}
