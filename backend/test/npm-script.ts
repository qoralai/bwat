import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** Runs one of the package's own npm scripts, exactly as package.json declares it (`node <args>`). */
export async function runNpmScript(name: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const backend = join(import.meta.dirname, '..');
  const script: string = JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8')).scripts[name];
  if (!script?.startsWith('node ')) throw new Error(`npm script ${name} is missing or does not start with node`);
  const [, ...scriptArgs] = script.split(' ');
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [...scriptArgs, ...args], { cwd: backend, env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** The environment without BWAT_DB_URL, for a script run that sets its own. */
export const envWithoutDb = () => {
  const env = { ...process.env };
  delete env.BWAT_DB_URL;
  return env;
};
