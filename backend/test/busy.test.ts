import { expect, it } from 'vitest';
import type { BusyProtection } from '../src/busy.ts';
import { botPost, PERSON, postAllocation, registerBot, resetAllocationsBeforeEach, type TestApp } from './app.ts';
import { useAdminApp } from './people.ts';
import { describeDb } from './db/harness.ts';

/** Whether GET /fleet shows this bot busy. */
const busyOf = async (t: TestApp, id: string) =>
  (await t.app.inject({ method: 'GET', url: '/fleet', headers: PERSON })).json().fleet.find((r: { bot_id: string }) => r.bot_id === id).busy;

describeDb('busy protection seam (QOR-4571)', () => {
  const calls: string[] = [];
  const recorder: BusyProtection = {
    markBusy: async (botId) => void calls.push(`busy ${botId}`),
  };
  const t = useAdminApp({ busy: recorder });
  resetAllocationsBeforeEach(t);

  const release = (token: string, payload: object) => botPost(t, '/assignment/release', token, payload);

  it('marks a bot busy when it is given a claim, and tells the seam nothing when it releases', async () => {
    calls.length = 0;
    const bot = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/280000001' })).json();
    expect(calls).toEqual([`busy ${bot.bot_id}`]);
    await release(bot.bot_token, { claim_id: sent.id, generation: 1 });
    expect(calls).toEqual([`busy ${bot.bot_id}`]);
  });
});

describeDb('busy on the fleet: derived from the live claim (QOR-4571)', () => {
  const t = useAdminApp();
  resetAllocationsBeforeEach(t);

  it('shows a bot busy on the fleet from its claim until its release', async () => {
    const bot = await registerBot(t);
    expect(await busyOf(t, bot.bot_id)).toBe(false);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/280000006' })).json();
    expect(await busyOf(t, bot.bot_id)).toBe(true);
    await botPost(t, '/assignment/release', bot.bot_token, { claim_id: sent.id, generation: 1 });
    expect(await busyOf(t, bot.bot_id)).toBe(false);
  });
});

describeDb('busy protection that fails (QOR-4571)', () => {
  const lines: string[] = [];
  const failing: BusyProtection = {
    markBusy: async () => {
      throw Object.assign(new Error('protect failed for meeting 280000007'), { code: 'ThrottlingException' });
    },
  };
  const t = useAdminApp({
    busy: failing,
    logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
  });
  resetAllocationsBeforeEach(t);

  it('never fails the request: the claim is placed and released, and only the code is logged', async () => {
    const bot = await registerBot(t);
    const sent = await postAllocation(t, { zoom_url: 'https://zoom.us/j/280000007' });
    expect(sent.json().claim_state).toBe('claimed');
    const res = await botPost(t, '/assignment/release', bot.bot_token, { claim_id: sent.json().id, generation: 1 });
    expect(res.statusCode).toBe(200);
    const log = lines.join('');
    expect(log).toContain('"event":"busy.failed"');
    expect(log).toContain('"code":"ThrottlingException"');
    expect(log).not.toContain('280000007');
  });

  it('still shows the truth on the fleet: busy is the live claim, not what the seam managed to record', async () => {
    const bot = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/280000008' })).json();
    expect(await busyOf(t, bot.bot_id)).toBe(true);
    await t.app.inject({ method: 'PATCH', url: `/allocations/${sent.id}`, headers: PERSON, payload: { recall: true } });
    expect(await busyOf(t, bot.bot_id)).toBe(false);
  });
});
