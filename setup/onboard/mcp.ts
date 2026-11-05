// The onboarding page's MCP server, for an LLM that helps a person through setup: the page
// leads and the LLM only answers. It reads where the person is and what a command printed,
// and can ask to run one of the guide's commands; it never moves the page or fills it in.
// ./bwat onboard mcp runs it over stdio (newline-delimited JSON-RPC, as MCP's stdio
// transport has it). Each tool forwards to the running page server (server.ts) with the
// port and token in .bwat/onboard/session; the LLM never sees the token or a secret value.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ROOT } from './root.ts';

type Session = { port: number; token: string };
type Tool = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  call(args: Record<string, unknown>, api: Api): Promise<unknown>;
};
type Api = (path: string, body?: unknown) => Promise<unknown>;

const string = (description: string) => ({ type: 'string', description });

export const TOOLS: Tool[] = [
  {
    name: 'get_state',
    description: 'The chosen way of running bwat, every ticked step, which secrets are saved (each as its mask only), and the last exit code of each command.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async call(_args, api) {
      const [state, secrets, runs] = await Promise.all([api('/api/state'), api('/api/secrets'), api('/api/runs')]) as
        [unknown, unknown, { running: boolean; runs: { id: string; exit?: number }[] }];
      return { state, secrets, running: runs.running, runs: runs.runs.map((r) => ({ id: r.id, exit: r.exit ?? null })) };
    },
  },
  {
    name: 'get_guide',
    description: 'Every step of the setup guide: its id, title, which ways of running bwat it belongs to, its answers, secrets, commands and checks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async call(_args, api) {
      const guide = await api('/api/guide') as { flows: unknown; steps: { id: string; title: string; flows: string[]; answers: string[]; secrets: string[]; runs: { id: string; command: string }[]; checks: string[] }[] };
      return { flows: guide.flows, steps: guide.steps.map(({ id, title, flows, answers, secrets, runs, checks }) => ({ id, title, flows, answers, secrets, runs, checks })) };
    },
  },
  {
    name: 'run_command',
    description: 'Asks the person to allow one of the guide\'s commands on the page; if they do, runs it and answers its exit code and last 50 lines (secrets masked), or, after a minute, that it still runs.',
    inputSchema: { type: 'object', properties: { id: string('The command\'s id, from get_guide (a step\'s runs).') }, required: ['id'], additionalProperties: false },
    call: (args, api) => api('/api/llm/run', { id: args.id }),
  },
  {
    name: 'command_output',
    description: 'A command\'s run so far: whether it still runs, its exit code, the installer\'s "Step N of 7" progress, and its last 50 lines.',
    inputSchema: { type: 'object', properties: { id: string('The command\'s id.') }, required: ['id'], additionalProperties: false },
    call: (args, api) => api('/api/llm/output', { id: args.id }),
  },
];

function session(path: string): Session | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Session>;
  return typeof parsed.port === 'number' && typeof parsed.token === 'string' ? { port: parsed.port, token: parsed.token } : undefined;
}

function apiFor({ port, token }: Session): Api {
  const origin = `http://127.0.0.1:${port}`;
  return async (path, body) => {
    const res = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const reply = await res.json() as { error?: string };
    if (!res.ok) throw new Error(reply.error ?? `${path}: ${res.status}`);
    return reply;
  };
}

type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown> };

/** Answers one JSON-RPC message, or nothing for a notification. */
export async function handle(message: Message, sessionPath: string): Promise<object | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.id === undefined) return undefined;
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'bwat-onboard', version: '1' },
        instructions: 'Reads the bwat setup page the person has open (./bwat setup --web). The page leads: the person does each step on it, and you answer their questions. Never ask for a secret in chat: they type each one into the page.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === message.params?.name);
      if (!tool) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown tool ${String(message.params?.name)}` } };
      const found = session(sessionPath);
      if (!found) return reply({ isError: true, content: [{ type: 'text', text: 'The setup page is not running: ask the person to run ./bwat setup --web first.' }] });
      try {
        const result = await tool.call((message.params?.arguments ?? {}) as Record<string, unknown>, apiFor(found));
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (error) {
        return reply({ isError: true, content: [{ type: 'text', text: (error as Error).message }] });
      }
    }
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${String(message.method)}` } };
  }
}

function main() {
  const sessionPath = process.env.BWAT_ONBOARD_SESSION ?? join(ROOT, '.bwat/onboard/session');
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let message: Message;
    try { message = JSON.parse(line) as Message; } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    void handle(message, sessionPath).then((answer) => { if (answer) process.stdout.write(JSON.stringify(answer) + '\n'); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
