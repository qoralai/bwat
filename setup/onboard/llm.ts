// What an LLM may do through the MCP bridge (mcp.ts) besides reading: ask to run one of the
// guide's commands, which runs only once the person allows it on the page, and read a
// command's output. The page leads: an LLM never moves it, fills it in or ticks a step.
// Output is masked, so an LLM never gets a secret value.
import { randomUUID } from 'node:crypto';
import { body, json, object, Refused, type Handler } from './http.ts';
import type { Runner } from './runner.ts';

export type PageEvent =
  | { type: 'allow'; request: string; id: string; command: string }
  | { type: 'allowed'; request: string; allow: boolean }
  | { type: 'answer'; key: string };

// Under fetch's 5-minute wait for an answer, so the MCP bridge hears back; the LLM asks again.
const WAIT_MS = 4 * 60_000;
// How long run waits for the command to end before answering that it still runs.
const RUN_WAIT_MS = 60_000;

export function createBus() {
  const listeners = new Set<(event: PageEvent) => void>();
  return {
    emit(event: PageEvent) { for (const listener of listeners) listener(event); },
    on(listener: (event: PageEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
export type Bus = ReturnType<typeof createBus>;

export function addLlmRoutes(route: (key: string, handler: Handler) => void, { bus, runner, commands, waitMs = WAIT_MS, runWaitMs = RUN_WAIT_MS }: {
  bus: Bus;
  runner: Runner;
  commands: () => Map<string, string>;
  waitMs?: number;
  runWaitMs?: number;
}) {
  const pending = new Map<string, (allow: boolean | null) => void>();

  // The person answers an LLM's run request on the page.
  route('POST /api/allow', async ({ req, res }) => {
    const { request, allow } = object(await body(req));
    const answer = typeof request === 'string' ? pending.get(request) : undefined;
    if (!answer) throw new Refused('no such request', 404);
    answer(allow === true);
    json(res, 200, { ok: true });
  });

  // Asks the person to allow the command, runs it if they do, and answers its end.
  route('POST /api/llm/run', async ({ req, res }) => {
    const { id } = object(await body(req));
    const command = typeof id === 'string' ? commands().get(id) : undefined;
    if (!command || typeof id !== 'string') throw new Refused(`unknown command ${String(id)}`);
    const request = randomUUID();
    const allowed = await new Promise<boolean | null>((done) => {
      const timer = setTimeout(() => finish(null), waitMs);
      const finish = (allow: boolean | null) => { clearTimeout(timer); pending.delete(request); bus.emit({ type: 'allowed', request, allow: allow === true }); done(allow); };
      pending.set(request, finish);
      bus.emit({ type: 'allow', request, id, command });
    });
    // No answer is not a refusal: the person may not have seen the page yet.
    if (allowed === null) return json(res, 200, { id, ran: false, detail: 'No answer yet: ask the person to look at the page.' });
    if (!allowed) return json(res, 200, { id, ran: false, detail: 'The person did not allow it.' });
    // The person allowed the text they were shown: run nothing if the guide has since changed it.
    if (commands().get(id) !== command) return json(res, 200, { id, ran: false, detail: 'The command changed while waiting; ask again.' });
    const exited = new Promise<number | null>((done) => {
      const timer = setTimeout(() => { off(); done(null); }, runWaitMs);
      const off = runner.on((event) => { if (event.type === 'exit' && event.id === id) { clearTimeout(timer); off(); done(event.exit); } });
    });
    runner.start(id, command);
    const exit = await exited;
    const lines = (runner.last(id)?.lines ?? []).slice(-50);
    if (exit === null) return json(res, 200, { id, ran: true, running: true, lines, detail: 'Still running: call command_output to follow it.' });
    json(res, 200, { id, ran: true, exit, lines });
  });

  // A command's record so far: whether it still runs, its exit code and its last 50 lines.
  route('POST /api/llm/output', async ({ req, res }) => {
    const { id } = object(await body(req));
    const run = typeof id === 'string' ? runner.last(id) : undefined;
    if (!run) throw new Refused(`no run of ${String(id)} yet`, 404);
    json(res, 200, { id: run.id, running: run.exit === undefined, exit: run.exit ?? null, progress: run.progress ?? null, lines: run.lines.slice(-50) });
  });

}
