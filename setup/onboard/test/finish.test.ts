import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createFinish } from '../finish.ts';
import { openChecklist } from '../routes.ts';
import { writeState } from '../state.ts';

const CREDENTIAL = 'bwi_' + 'k'.repeat(43);
const steps = [
  { id: 'check-answers', flows: ['local', 'server'], checks: ['prep-complete'] },
  { id: 'auto-join', flows: ['server'], checks: ['zoom-ready'] },
  { id: 'first-meeting', flows: ['local', 'server'], checks: ['first-card'] },
  { id: 'company', flows: ['local', 'server'], checks: [] },
  { id: 'webhook', flows: ['local', 'server'], when: 'production', checks: ['edge-healthy'] },
];
const pass = { ok: true, detail: 'fine' };
const fail = { ok: false, detail: 'not yet' };

function setup(results: Record<string, { ok: boolean; detail: string }>, flow = 'local', answers = 'OPENROUTER_API_KEY=sk-or-v1-secret\nBWAT_MODE=developer\n') {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-finish-'));
  const paths = { state: join(dir, 'onboard/state.json'), answers: join(dir, 'bwat.answers'), env: join(dir, '.env'), logs: join(dir, 'logs') };
  writeFileSync(paths.answers, answers);
  writeFileSync(paths.env, 'BWAT_MODE=developer\n');
  mkdirSync(paths.logs);
  writeFileSync(join(paths.logs, 'onboard-1-prep.log'), 'x');
  writeFileSync(join(paths.logs, 'setup-1.log'), 'kept');
  writeState(paths.state, { version: 1, flow, steps: {}, install: { credential: CREDENTIAL } });
  writeFileSync(join(dir, 'onboard/session'), '{}');
  const revoked: string[] = [];
  const finish = createFinish({
    paths,
    steps,
    checks: { run: async () => results as never, revoke: async (token: string) => { revoked.push(token); return true; } },
  });
  return { dir, paths, revoked, finish };
}

describe('finish', () => {
  it('needs every check of the chosen way to pass before it deletes anything', async () => {
    const t = setup({ 'prep-complete': pass, 'first-card': fail, 'zoom-ready': fail });
    const summary = await t.finish.summary();
    assert.equal(summary.ready, false);
    assert.deepEqual(summary.waiting, ['first-card']);
    await assert.rejects(t.finish.destroy(), /every check/);
    assert.ok(existsSync(t.paths.answers));
    assert.deepEqual(t.revoked, []);
  });

  it('ignores the checks of steps outside the chosen way', async () => {
    const t = setup({ 'prep-complete': pass, 'first-card': pass, 'zoom-ready': fail });
    assert.equal((await t.finish.summary()).ready, true);
  });

  it('a step that does not apply is not needed for Finish; one not yet known is', async () => {
    const results = { 'prep-complete': pass, 'first-card': pass, 'edge-healthy': fail };
    const no = await setup(results, 'local', 'BWAT_MODE=developer\n').finish.summary();
    assert.deepEqual(no.needed, ['prep-complete', 'first-card']);
    assert.equal(no.ready, true);
    const unknown = await setup(results, 'local', 'BWAT_MODE=\n').finish.summary();
    assert.deepEqual(unknown.waiting, ['edge-healthy']);
    const yes = await setup(results, 'local', 'BWAT_MODE=production\n').finish.summary();
    assert.deepEqual(yes.waiting, ['edge-healthy']);
  });

  it('then deletes bwat.answers, the page\'s records and its logs, revokes its credential, and keeps .env and setup\'s logs', async () => {
    const t = setup({ 'prep-complete': pass, 'first-card': pass, 'zoom-ready': pass }, 'server');
    await t.finish.destroy();
    assert.equal(existsSync(t.paths.answers), false);
    assert.equal(existsSync(join(t.dir, 'onboard')), false);
    assert.equal(existsSync(join(t.paths.logs, 'onboard-1-prep.log')), false);
    assert.equal(readFileSync(join(t.paths.logs, 'setup-1.log'), 'utf8'), 'kept');
    assert.equal(readFileSync(t.paths.env, 'utf8'), 'BWAT_MODE=developer\n');
    assert.deepEqual(t.revoked, [CREDENTIAL]);
  });
});

describe('the Finish later checklist', () => {
  it('leaves out a step whose condition does not apply, and what is ticked or skipped', () => {
    const list = [
      { id: 'a', title: 'A', flows: ['local'], when: null },
      { id: 'b', title: 'B', flows: ['local'], when: 'production' },
      { id: 'c', title: 'C', flows: ['local'], when: 'board-app' },
      { id: 'd', title: 'D', flows: ['local'], when: null },
      { id: 'e', title: 'E', flows: ['local'], when: null },
    ];
    const state = { version: 1 as const, flow: 'local', steps: { d: { state: 'done' as const, by: 'person' as const, at: '' }, e: { state: 'skipped' as const, by: 'person' as const, at: '' } } };
    const items = openChecklist(state, list, new Map([['BWAT_MODE', 'developer']]));
    assert.deepEqual(items.map((i) => i.id), ['a', 'c']);
  });

});
