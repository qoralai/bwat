// Secrets for bwat.answers. The server takes a value from the page once, checks it, and
// hands it to setup/secret on stdin, the one code that writes a secret to the file. It
// never sends a value back: only its mask's parts (static/mask.js has the same rule).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readAnswers } from './answers.ts';
import { Refused } from './http.ts';
import { ROOT } from './root.ts';

export type Mask = { hidden: number; last4: string | null };

// The characters setup/bwat accepts in a pasted credential.
export const SECRET_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;

export function maskParts(value: string): Mask {
  return value.length - 4 >= 12 ? { hidden: value.length - 4, last4: value.slice(-4) } : { hidden: value.length, last4: null };
}

/** The unfocused form, for logs and command output. */
export function masked(value: string) {
  const parts = maskParts(value);
  return '*'.repeat(parts.hidden) + (parts.last4 ?? '');
}

export function secretStatus(answers: string, keys: Iterable<string>) {
  const values = readAnswers(answers);
  const status: Record<string, { set: boolean } & Mask> = {};
  for (const key of keys) {
    const value = values.get(key) ?? '';
    status[key] = value ? { set: true, ...maskParts(value) } : { set: false, hidden: 0, last4: null };
  }
  return status;
}

/** Saves through bash setup/secret KEY -, so the value is never in argv or a log; bash, so
 * it saves on Windows too, where a script cannot be started on its own. */
export function saveSecret(answers: string, key: string, value: string) {
  if (!SECRET_PATTERN.test(value)) {
    throw new Refused('that does not look like a credential: letters, digits and . _ ~ - only, at most 512; paste it again');
  }
  return new Promise<Mask>((done, fail) => {
    const child = spawn('bash', [join(ROOT, 'setup/secret'), key, '-'], {
      env: { ...process.env, BWAT_ANSWERS: answers }, stdio: ['pipe', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done(maskParts(value)) : fail(new Refused(error.trim() || 'setup/secret failed'))));
    child.stdin.end(value);
  });
}
