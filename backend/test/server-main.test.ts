import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('running the server directly (D143)', () => {
  it('names itself bwat when it fails to start, and exits 1', async () => {
    const server = join(import.meta.dirname, '..', 'src', 'server.ts');
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', BWAT_TRUST_PROXY: '1' };
    delete env.BWAT_DEV_PERSON_TOKEN;
    const run = await promisify(execFile)(process.execPath, ['--experimental-strip-types', server], { env }).then(
      () => ({ code: 0, stderr: '' }),
      (err: { code: number; stderr: string }) => err,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('bwat-backend failed to start: BWAT_TRUST_PROXY must be');
  }, 30_000);
});
