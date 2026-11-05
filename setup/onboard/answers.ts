// bwat.answers, the file ./bwat prep writes and ./bwat setup reads: one KEY=value per line.
// The page writes plain answers here; secrets go through setup/secret (secrets.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function readAnswers(path: string): Map<string, string> {
  const answers = new Map<string, string>();
  if (!existsSync(path)) return answers;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.replace(/\r$/, '').match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) answers.set(m[1]!, m[2]!);
  }
  return answers;
}

/** Replaces KEY's line in place, so the file keeps its mode and every other line. */
export function writeAnswer(path: string, key: string, value: string) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const at = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (at < 0) throw new Error(`bwat.answers has no ${key}= line`);
  lines[at] = `${key}=${value}`;
  writeFileSync(path, lines.join('\n'));
}
