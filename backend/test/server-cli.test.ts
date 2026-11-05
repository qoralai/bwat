import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const BACKEND = join(import.meta.dirname, '..');

describe('the server run as a program, without a database (D143)', () => {
  it('fails under the bwat name', async () => {
    const env = { ...process.env };
    delete env.BWAT_DB_URL;
    delete env.BWAT_DB_URL_FILE;
    const run = await promisify(execFile)(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { cwd: BACKEND, env }).then(
      () => ({ code: 0, stderr: '' }),
      (err: { code: number; stderr: string }) => ({ code: err.code, stderr: err.stderr }),
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('bwat-backend failed to start:');
  }, 30_000);
});

describe('the package (D143)', () => {
  it('is named bwat-backend, in package.json and in its lockfile', () => {
    const read = (file: string) => JSON.parse(readFileSync(join(BACKEND, file), 'utf8'));
    const lock = read('package-lock.json');
    expect([read('package.json').name, lock.name, lock.packages[''].name]).toEqual(['bwat-backend', 'bwat-backend', 'bwat-backend']);
  });
});
