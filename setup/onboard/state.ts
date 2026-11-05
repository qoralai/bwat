// The page's progress, kept in .bwat/onboard/state.json (mode 600) so it survives a
// restart of the server. It holds no secret of bwat.answers; its one credential is the
// page's own (checks.ts), which reaches only the backend's /install routes.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type StepState = { state: 'done' | 'skipped'; by: 'person' | 'check'; at: string };
export type RunRecord = { exit: number; started: string; ended: string };
export type State = {
  version: 1;
  flow: string | null;
  /** A chosen flow whose BWAT_MODE is not written yet (bwat.answers did not exist): applied once it has the line. */
  modePending?: string;
  steps: Record<string, StepState>;
  runs?: Record<string, RunRecord>;
  install?: { credential: string };
};

const empty = (): State => ({ version: 1, flow: null, steps: {} });

export function readState(path: string): State {
  if (!existsSync(path)) return empty();
  const state = JSON.parse(readFileSync(path, 'utf8')) as State;
  return state.version === 1 ? state : empty();
}

/** Written to a temporary file first, so a crash never leaves half a file. */
export function writeState(path: string, state: State) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
