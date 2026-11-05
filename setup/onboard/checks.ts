// The checks that tick a step on their own (flow.ts CHECKS). Each reads a fact of this
// install: the page's prep --check exit code, the edge's /health, OpenRouter's answer to
// the saved key, the answers a step asks for, and the backend's GET /v1/install/status,
// which the onboarding page's credential (bwi_) reads. setup cannot hand the page that
// credential, so the page mints one with the backend's own script once bwat answers, and
// keeps it in .bwat/onboard/state.json.
import { execFile } from 'node:child_process';
import { readAnswers } from './answers.ts';
import { flowOf, type CHECKS } from './flow.ts';
import type { Paths } from './routes.ts';
import { readState, writeState, type State } from './state.ts';

export type CheckId = typeof CHECKS[number];
/** Steps only the person can say are done: the page cannot see Zoom's manifest upload or Add, so filled fields never tick them. */
export const PERSON_CONFIRMS: ReadonlySet<string> = new Set(['zoom-main']);
export type CheckResult = { ok: boolean; detail: string };
export type InstallStatus = {
  owner_signed_in: boolean;
  /** Whether a Claude Code session signed in to bwat has registered (the plugin's /sessions). */
  claude_connected?: boolean;
  zoom: { ready: boolean; problems: string[] };
  meeting_transcribed: boolean;
  cards: number | null;
};

export type ChecksDeps = {
  paths: Paths;
  cwd: string;
  fetch?: typeof fetch;
  /** Runs a command in cwd and resolves with its stdout; the default runs it with no shell. */
  exec?: (file: string, args: string[]) => Promise<string>;
  /** The meeting bot's build (sdk.ts), for bot-built. */
  sdk?: { check(): Promise<CheckResult> };
};

const defaultExec = (cwd: string) => (file: string, args: string[]) => new Promise<string>((done, fail) => {
  execFile(file, args, { cwd, timeout: 60_000 }, (error, stdout) => (error ? fail(error) : done(stdout)));
});

/** Where this install answers: its public address, else this machine's edge. */
export function edgeBases(env: Map<string, string>) {
  const bases: string[] = [];
  const url = env.get('BWAT_PUBLIC_URL');
  if (url) bases.push(url.replace(/\/$/, ''));
  bases.push(`http://127.0.0.1:${env.get('BWAT_EDGE_PORT') || '8080'}`);
  return [...new Set(bases)];
}

export function createChecks({ paths, cwd, fetch: fetchFn = fetch, exec = defaultExec(cwd), sdk }: ChecksDeps) {
  async function reach(path: string, init: RequestInit = {}) {
    for (const base of edgeBases(readAnswers(paths.env))) {
      try {
        const res = await fetchFn(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
        return res;
      } catch { /* the next address */ }
    }
    return undefined;
  }

  /** The page's credential, minted once bwat answers at its address (setup ran, on the page or in a terminal). */
  async function credential(state: State): Promise<string | undefined> {
    if (state.install?.credential) return state.install.credential;
    if (!(await reach('/health'))?.ok) return undefined;
    try {
      const out = await exec('docker', ['compose', 'exec', '-T', 'backend', 'node', 'dist/scripts/install-credential.js', '--label', 'onboard']);
      const token = out.trim().split('\n').pop() ?? '';
      if (!/^bwi_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      writeState(paths.state, { ...readState(paths.state), install: { credential: token } });
      return token;
    } catch {
      return undefined;
    }
  }

  async function status(state: State): Promise<InstallStatus | undefined> {
    const token = await credential(state);
    if (!token) return undefined;
    const res = await reach('/v1/install/status', { headers: { authorization: `Bearer ${token}` } });
    return res?.ok ? (await res.json()) as InstallStatus : undefined;
  }

  /** Whether OpenRouter takes the key saved in bwat.answers; a blank one is not sent, and a
   * key OpenRouter took once is not sent again. */
  let verified: string | undefined;
  async function modelKey() {
    const key = readAnswers(paths.answers).get('OPENROUTER_API_KEY');
    if (!key) return false;
    if (key === verified) return true;
    const res = await fetchFn('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    if (res?.status === 200) verified = key;
    return key === verified;
  }

  /** Runs every check, ticks the steps whose check passes, and answers each result. A step
   * of the chosen flow with fields and no check is done once every field is set. */
  async function run(steps: { id: string; checks: string[]; flows?: string[]; answers?: string[]; secrets?: string[] }[]): Promise<Record<CheckId, CheckResult>> {
    const state = readState(paths.state);
    const [healthy, facts, bot, model] = await Promise.all([
      reach('/health'), status(state), sdk ? sdk.check() : Promise.resolve({ ok: false, detail: 'No Zoom Meeting SDK file yet.' }), modelKey(),
    ]);
    const waiting = 'Waits for bwat to be installed and running.';
    const results: Record<CheckId, CheckResult> = {
      'prep-complete': state.runs?.['prep-check']?.exit === 0
        ? { ok: true, detail: './bwat prep --check says complete.' }
        : { ok: false, detail: 'Run ./bwat prep --check until it says complete.' },
      'bot-built': bot,
      'edge-healthy': healthy?.ok
        ? { ok: true, detail: 'bwat answers at its address.' }
        : { ok: false, detail: 'bwat does not answer at its address yet.' },
      'owner-signed-in': !facts ? { ok: false, detail: waiting } : facts.owner_signed_in
        ? { ok: true, detail: 'The owner has signed in.' }
        : { ok: false, detail: 'Nobody has signed in yet: sign in first, and you become the owner.' },
      'claude-connected': !facts ? { ok: false, detail: waiting } : facts.claude_connected
        ? { ok: true, detail: 'Claude Code is connected to bwat.' }
        : { ok: false, detail: 'No Claude Code session has connected yet: run ./bwat plugin, restart Claude Code and type /bwat:login.' },
      'zoom-ready': !facts ? { ok: false, detail: waiting } : facts.zoom.ready
        ? { ok: true, detail: 'bwat has verified the Zoom setup.' }
        : { ok: false, detail: facts.zoom.problems.join(' ') },
      'first-card': !facts ? { ok: false, detail: waiting } : (facts.cards ?? 0) > 0
        ? { ok: true, detail: 'bwat has written its first card.' }
        : { ok: false, detail: facts.meeting_transcribed ? 'bwat has transcribed a meeting; no card yet.' : 'No meeting transcribed yet.' },
      'openrouter-key': model
        ? { ok: true, detail: 'OpenRouter takes the saved key.' }
        : { ok: false, detail: 'Connect OpenRouter, or paste a key, until OpenRouter takes it.' },
    };
    const latest = readState(paths.state);
    const values = readAnswers(paths.answers);
    const ticked = { ...latest.steps };
    let changed = false;
    for (const step of steps) {
      if (ticked[step.id] || PERSON_CONFIRMS.has(step.id)) continue;
      const fields = [...step.answers ?? [], ...step.secrets ?? []];
      if (step.checks.length ? step.checks.every((c) => results[c as CheckId]?.ok)
        : fields.length > 0 && Boolean(step.flows?.includes(flowOf(latest))) && fields.every((key) => values.get(key))) {
        ticked[step.id] = { state: 'done', by: 'check', at: new Date().toISOString() };
        changed = true;
      }
    }
    if (changed) writeState(paths.state, { ...latest, steps: ticked });
    return results;
  }

  /** Sends the page's open steps to the admin panel's "Finish setting up" list. */
  async function sendChecklist(items: { id: string; title: string; detail: string; link: string | null }[]) {
    const token = await credential(readState(paths.state));
    if (!token) return { ok: false, detail: 'Install bwat first: the admin panel exists once setup has run.' };
    const res = await reach('/v1/install/checklist', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    return res?.ok ? { ok: true, detail: 'The admin panel lists them under Finish setting up.' }
      : { ok: false, detail: 'bwat did not take the list; check that it is running, then try again.' };
  }

  /** Revokes the page's credential at the backend; true once it no longer works. */
  async function revoke(token: string) {
    const res = await reach('/v1/install/revoke', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    return Boolean(res && (res.status === 204 || res.status === 401));
  }

  return { run, status, credential, sendChecklist, revoke };
}
