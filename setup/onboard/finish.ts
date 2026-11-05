// The page's last step: every check of the chosen way passes again, and only then may the
// installer delete what the page kept on this computer: bwat.answers (it holds the
// secrets in plain text), .bwat/onboard/ and the page's own logs. .env stays: the running
// install needs it. The page's credential is revoked first, so nothing it left can be used.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readAnswers } from './answers.ts';
import { conditionStates, whenApplies } from './conditions.ts';
import type { CheckId, CheckResult } from './checks.ts';
import { Refused } from './http.ts';
import type { Paths } from './routes.ts';
import { flowOf } from './flow.ts';
import { readState } from './state.ts';

type Steps = { id: string; flows: string[]; when?: string | null; checks: string[] }[];
type Checks = {
  run(steps: { id: string; checks: string[] }[]): Promise<Record<CheckId, CheckResult>>;
  revoke(token: string): Promise<boolean>;
};

export function createFinish({ paths, steps: wanted, checks }: { paths: Paths; steps: Steps | (() => Steps); checks: Checks }) {
  async function summary() {
    const flow = flowOf(readState(paths.state));
    const steps = typeof wanted === 'function' ? wanted() : wanted;
    const results = await checks.run(steps);
    // A step whose condition is false is not needed; one not yet known is (unknown answers excuse nothing).
    const states = conditionStates(readAnswers(paths.answers));
    const needed = [...new Set(steps.filter((s) => s.flows.includes(flow) && whenApplies(s.when, states)).flatMap((s) => s.checks))] as CheckId[];
    const waiting = needed.filter((id) => !results[id]?.ok);
    return { ready: waiting.length === 0, needed, waiting, results };
  }

  /** `only`: the checks that must pass, instead of every check of the chosen way. */
  async function destroy(only?: CheckId[]) {
    const { ready, results } = await summary();
    if (!(only ? only.every((id) => results[id]?.ok) : ready)) throw new Refused('every check of your way of running bwat must pass first', 409);
    const credential = readState(paths.state).install?.credential;
    if (credential && !(await checks.revoke(credential))) {
      throw new Refused('bwat did not revoke the setup page\'s credential; check that it is running, then try again', 502);
    }
    rmSync(paths.answers, { force: true });
    rmSync(dirname(paths.state), { recursive: true, force: true });
    for (const name of existsSync(paths.logs) ? readdirSync(paths.logs) : []) if (/^onboard-.*\.log$/.test(name)) rmSync(join(paths.logs, name), { force: true });
  }

  return { summary, destroy };
}
