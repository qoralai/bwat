// Runs the guide's commands for the page, one at a time. The page sends only a command's
// id from a ```sh {bwat-run=ID} block; the text that runs is the guide's own. A command
// gets no stdin, so it can never wait for an answer. Its output is masked (secrets.ts)
// before it is streamed or written to .bwat/logs/onboard-*.log.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Refused } from './http.ts';
import { masked } from './secrets.ts';

export type Progress = { step: number; of: number; title: string };
export type RunEvent =
  | { type: 'start'; id: string; command: string }
  | { type: 'line'; id: string; line: string }
  | { type: 'progress'; id: string } & Progress
  | { type: 'exit'; id: string; exit: number };
export type Run = { id: string; command: string; started: string; ended?: string; exit?: number; lines: string[]; progress?: Progress };

const KEEP = 200;
const STEP = /^Step (\d+) of (\d+): (.+)$/;

export function createRunner({ commands, cwd, logs, secrets }: {
  /** Read at each start, so a guide that changes is followed. */
  commands: Map<string, string> | (() => Map<string, string>);
  cwd: string;
  logs: string;
  /** Every secret value to mask, read afresh for each run. */
  secrets: () => string[];
}) {
  const listeners = new Set<(event: RunEvent) => void>();
  const runs = new Map<string, Run>();
  let child: ChildProcess | undefined;
  const emit = (event: RunEvent) => { for (const listener of listeners) listener(event); };

  /** `expected`: the text the person was shown; a guide that has changed since refuses to run. */
  function start(id: string, expected?: string) {
    const command = (typeof commands === 'function' ? commands() : commands).get(id);
    if (command === undefined) throw new Refused(`unknown command ${id}`);
    if (expected !== undefined && command !== expected) throw new Refused('The command changed since it was shown; reload the page and ask again.', 409);
    if (child) throw new Refused('a command is still running; wait for it to finish', 409);
    // Longest first, so a secret that contains another is masked whole.
    const hide = secrets().filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
    const mask = (line: string) => hide.reduce((text, secret) => text.split(secret).join(masked(secret)), line);
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const log = join(logs, `onboard-${new Date().toISOString().replace(/[:.]/g, '')}-${id}.log`);
    appendFileSync(log, `$ ${mask(command)}\n`, { mode: 0o600 });
    const run: Run = { id, command: mask(command), started: new Date().toISOString(), lines: [] };
    runs.set(id, run);
    emit({ type: 'start', id, command: run.command });
    const proc = spawn('bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BWAT_NO_BROWSER: '1', BWAT_ONBOARD_PAGE: '1' } });
    child = proc;
    const read = (stream: NodeJS.ReadableStream) => {
      createInterface({ input: stream }).on('line', (raw) => {
        const line = mask(raw.replace(/\r$/, ''));
        appendFileSync(log, line + '\n');
        run.lines.push(line);
        if (run.lines.length > KEEP) run.lines.shift();
        emit({ type: 'line', id, line });
        const step = line.match(STEP);
        if (step) {
          run.progress = { step: Number(step[1]), of: Number(step[2]), title: step[3]! };
          emit({ type: 'progress', id, ...run.progress });
        }
      });
    };
    read(proc.stdout);
    read(proc.stderr);
    proc.on('close', (code, signal) => {
      run.exit = code ?? (signal ? 128 : 1);
      run.ended = new Date().toISOString();
      appendFileSync(log, `exit ${run.exit}\n`);
      child = undefined;
      emit({ type: 'exit', id, exit: run.exit });
    });
    return run;
  }

  return {
    start,
    last: (id: string) => runs.get(id),
    all: () => [...runs.values()],
    running: () => child !== undefined,
    on(listener: (event: RunEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    stop() { child?.kill('SIGTERM'); },
  };
}

export type Runner = ReturnType<typeof createRunner>;
