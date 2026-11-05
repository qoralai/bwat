import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { CONDITIONS } from '../conditions.ts';
import { ROOT } from '../root.ts';

const answers = (o: Record<string, string>) => new Map(Object.entries(o));
const test = (name: string, o: Record<string, string>) => CONDITIONS[name]!.test(answers(o));

describe('board-app', () => {
  it('is true for an https address, false for http://localhost, null while it is blank', () => {
    assert.equal(test('board-app', { BWAT_PUBLIC_URL: 'https://x.example' }), true);
    assert.equal(test('board-app', { BWAT_PUBLIC_URL: 'http://localhost:8079' }), false);
    assert.equal(test('board-app', {}), null);
    assert.equal(test('board-app', { BWAT_PUBLIC_URL: ' ' }), null);
    assert.equal(CONDITIONS['board-app']!.label, 'the address is https');
  });

  it('agrees with setup/zoom-manifest --board', () => {
    for (const url of ['http://localhost:8079', 'https://x.example']) {
      const run = spawnSync('bash', ['setup/zoom-manifest', '--board'], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, BWAT_PUBLIC_URL: url, BWAT_ZOOM_COMPANY: 'Acme', BWAT_ZOOM_CONTACT_NAME: 'Ann', BWAT_ZOOM_CONTACT_EMAIL: 'ann@example.com' },
      });
      assert.equal(run.status !== 0, test('board-app', { BWAT_PUBLIC_URL: url }) === false, `${url}: ${run.stderr}`);
    }
  });
});

describe('production', () => {
  it('is true for production, false for another mode, null while blank', () => {
    assert.equal(test('production', { BWAT_MODE: 'production' }), true);
    assert.equal(test('production', { BWAT_MODE: 'developer' }), false);
    assert.equal(test('production', {}), null);
    assert.equal(CONDITIONS.production!.label, 'BWAT_MODE is production');
  });
});
