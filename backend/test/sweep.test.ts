import { describe, expect, it } from 'vitest';
import { repeat } from '../src/repeat.ts';
import { start } from '../src/server.ts';
import { claimRow, postAllocation, registerBot, resetAllocationsBeforeEach, until, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';

describeDb('the sweep (QOR-4571)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);


  it('runs on its own in a started server: a lapsed lease is retired with no request, and the waiting claim takes the freed bot', async () => {
    const bot = await registerBot(t);
    const held = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/270000001' })).json();
    const waiting = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/270000002' })).json();
    const expired = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/270000003' })).json();
    const exhausted = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/270000004' })).json();
    await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE id = $1`, [held.id]);
    await t.pool.query(`UPDATE claims SET pending_until = now() - interval '1 second' WHERE id = $1`, [expired.id]);
    await t.pool.query(`UPDATE claims SET allocation_count = 3 WHERE id = $1`, [exhausted.id]);

    const app = await start({ BWAT_DB_URL: t.db.url('runtime'), PORT: '0', NODE_ENV: 'test' }, { sweepMs: 100 });
    try {
      await until(async () => (await claimRow(t, waiting.id)).state === 'claimed');
    } finally {
      await app.close();
    }
    expect(await claimRow(t, held.id)).toMatchObject({ state: 'abandoned', refused_reason: 'lease_expired' });
    expect(await claimRow(t, expired.id)).toMatchObject({ state: 'abandoned', refused_reason: 'no_bot_available' });
    expect(await claimRow(t, exhausted.id)).toMatchObject({ state: 'abandoned', refused_reason: 'allocations_exhausted' });
    expect(await claimRow(t, waiting.id)).toMatchObject({ state: 'claimed', bot_id: bot.bot_id });
  });
});

describe('the sweep timer (QOR-4571 simplify)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('never overlaps itself: a run slower than the interval delays the next instead of starting a second', async () => {
    let active = 0;
    let most = 0;
    let runs = 0;
    const sweep = repeat(async () => {
      runs++;
      most = Math.max(most, ++active);
      await sleep(60);
      active--;
    }, 5);
    await sleep(300);
    await sweep.stop();
    expect(most).toBe(1);
    expect(runs).toBeGreaterThan(1);
  });

  it('stop() waits for the run in flight and schedules nothing after it', async () => {
    let runs = 0;
    let finished = 0;
    const sweep = repeat(async () => {
      runs++;
      await sleep(50);
      finished++;
    }, 1);
    await until(async () => runs === 1, { tries: 100, ms: 2 });
    await sweep.stop();
    expect(finished).toBe(1);
    await sleep(50);
    expect(runs).toBe(1);
  });
});
