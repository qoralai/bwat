import { expect, it, vi } from 'vitest';
import { issueFleetCredential } from '../src/credentials.ts';
import { bearer, postAllocation, registerBot, resetAllocationsBeforeEach, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';

describeDb('GET /assignment (QOR-4571)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  const assignment = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/assignment', headers });
  const send = (zoom_url: string) => postAllocation(t, { zoom_url });

  it('refuses a caller with no credential or an unknown one', async () => {
    expect((await assignment({})).statusCode).toBe(401);
    expect((await assignment(bearer(`bwb_${'A'.repeat(43)}`))).statusCode).toBe(401);
  });

  it('answers 409 unregistered_bot to a fleet credential', async () => {
    const res = await assignment(bearer(await issueFleetCredential(t.pool)));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'unregistered_bot' });
  });

  it('answers null to a bot with no claim', async () => {
    const bot = await registerBot(t);
    const res = await assignment(bearer(bot.bot_token));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it("gives a bot its own claim: the meeting and the briefing", async () => {
    const bot = await registerBot(t);
    const other = await registerBot(t, { ready: false });
    const sent = (await send('https://zoom.us/j/987654321?pwd=pass1')).json();

    const res = await assignment(bearer(bot.bot_token));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      claim_id: sent.id,
      generation: 1,
      feed_token: null,
      lease_until: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      meeting_number: '987654321',
      occurrence_uuid: null,
      transcript_epoch: null,
      briefing: { passcode: 'pass1' },
    });
    expect((await assignment(bearer(other.bot_token))).json()).toBeNull();
  });

  it('answers a bot in one query: its credential and its live claim together', async () => {
    const bot = await registerBot(t);
    const sent = (await send('https://zoom.us/j/987654323')).json();
    const query = vi.spyOn(t.pool, 'query');
    try {
      const res = await assignment(bearer(bot.bot_token));
      expect(res.json().claim_id).toBe(sent.id);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
  });

  it('counts a poll as liveness: a ready bot that only polls for over 45 s is still allocated', async () => {
    const bot = await registerBot(t);
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() - interval '46 seconds' WHERE id = $1`, [bot.bot_id]);
    expect((await assignment(bearer(bot.bot_token))).json()).toBeNull();
    const sent = (await send('https://zoom.us/j/987654324')).json();
    expect(sent.claim_state).toBe('claimed');
    expect((await assignment(bearer(bot.bot_token))).json().claim_id).toBe(sent.id);
  });

  it('no longer gives a claim that has ended', async () => {
    const bot = await registerBot(t);
    const sent = (await send('https://zoom.us/j/987654322')).json();
    await t.pool.query(`UPDATE claims SET state = 'done', ended_at = now() WHERE id = $1`, [sent.id]);
    expect((await assignment(bearer(bot.bot_token))).json()).toBeNull();
  });
});
