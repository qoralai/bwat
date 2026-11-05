import { expect, it } from 'vitest';
import {
  botPost,
  claimRow,
  heldClaim,
  lapsingLease,
  occurrenceUuid,
  postAllocation,
  raceBehindLock,
  registerBot,
  resetAllocationsBeforeEach,
  untilLapsed,
  useApp,
} from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting, pushTranscript, segment } from './meetings.ts';

describeDb('POST /assignment/release (QOR-4571)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  const release = (token: string, payload: object) => botPost(t, '/assignment/release', token, payload);

  it("ends the bot's own claim and stores its reason", async () => {
    const { bot, claimId } = await heldClaim(t, '230000001');
    const res = await release(bot.bot_token, { claim_id: claimId, generation: 1, reason: 'could_not_join' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'released' });
    expect(await claimRow(t, claimId)).toMatchObject({
      state: 'done',
      refused_reason: 'could_not_join',
      lease_until: null,
      meeting_ended_at: null,
      ended_at: expect.any(Date),
    });
  });

  it('answers 409 stale_claim for a claim the bot does not hold at that generation, and changes nothing', async () => {
    const { bot, claimId } = await heldClaim(t, '230000002');
    const res = await release(bot.bot_token, { claim_id: claimId, generation: 2, reason: 'could_not_join' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_claim' });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'claimed', refused_reason: null });
  });

  it('leaves a tombstone at meeting end that refuses a late re-delivered start of that occurrence', async () => {
    const uuid = occurrenceUuid();
    const first = await heldClaim(t, '230000003');
    const promote = (token: string, claim_id: string) =>
      botPost(t, '/assignment/occurrence', token, { claim_id, generation: 1, occurrence_uuid: uuid });
    expect((await promote(first.bot.bot_token, first.claimId)).statusCode).toBe(200);
    const res = await release(first.bot.bot_token, { claim_id: first.claimId, generation: 1, meeting_ended: true });
    expect(res.json()).toEqual({ status: 'released' });
    expect(await claimRow(t, first.claimId)).toMatchObject({ state: 'done', meeting_ended_at: expect.any(Date) });

    // The same meeting sent again: a new claim (on the same, now free, bot), but it cannot
    // walk into the ended sitting.
    const again = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/230000003' })).json();
    expect(again).toMatchObject({ claim_state: 'claimed' });
    const late = await promote(first.bot.bot_token, again.id);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ error: 'meeting_already_ended' });
  });

  it("ends the bot's meeting at a meeting-end release, though its final push never landed (QOR-4719)", async () => {
    const uuid = occurrenceUuid();
    const bot = await botInMeeting(t, uuid, '230000010');
    expect((await pushTranscript(t, uuid, bot.bot_token, { epoch: 1, segments: [segment(0)] })).statusCode).toBe(204);
    const meeting = `SELECT ended_at, finalization FROM meetings WHERE occurrence_uuid = $1`;
    expect((await t.pool.query(meeting, [uuid])).rows[0]).toEqual({ ended_at: null, finalization: 'open' });

    await release(bot.bot_token, { claim_id: bot.claim_id, generation: 1, meeting_ended: true });
    expect((await t.pool.query(meeting, [uuid])).rows[0]).toEqual({ ended_at: expect.any(Date), finalization: 'open' });
  });

  it('re-runs allocation after a release: the freed bot takes the waiting claim', async () => {
    const { bot, claimId } = await heldClaim(t, '230000004');
    const waiting = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/230000005' })).json();
    expect(waiting.claim_state).toBe('pending');
    await release(bot.bot_token, { claim_id: claimId, generation: 1 });
    expect(await claimRow(t, waiting.id)).toMatchObject({ state: 'claimed', bot_id: bot.bot_id });
  });

  it('requeues a claim from a bot being stopped: pending again, next generation, the reason ignored, another bot takes it', async () => {
    const { bot, claimId } = await heldClaim(t, '230000006');
    const res = await release(bot.bot_token, { claim_id: claimId, generation: 1, requeue: true, reason: 'draining' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'requeued' });
    expect(await claimRow(t, claimId)).toMatchObject({
      state: 'pending',
      bot_id: null,
      generation: 2,
      refused_reason: null,
      lease_until: null,
    });
    // The stopping bot is withdrawn, so it is not handed its meeting back.
    expect((await t.pool.query(`SELECT ready_at FROM bots WHERE id = $1`, [bot.bot_id])).rows[0].ready_at).toBeNull();
    const next = await registerBot(t);
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'claimed', bot_id: next.bot_id, generation: 3 });
  });

  it('judges the lease after it holds the claim: a requeue whose lease lapsed while a lock that changed nothing held it is refused', async () => {
    const { bot, claimId } = await heldClaim(t, '230000015');
    // A plain row lock updates nothing, so PostgreSQL never re-reads the release's
    // predicate once it gets the row: a clock in that predicate was read before the wait.
    await lapsingLease(t, claimId, 1500);
    const res = await raceBehindLock(
      t,
      { sql: `SELECT 1 FROM claims WHERE id = $1 FOR UPDATE`, params: [claimId] },
      () => release(bot.bot_token, { claim_id: claimId, generation: 1, requeue: true }),
      () => untilLapsed(t, claimId),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_claim' });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'claimed', generation: 1 });
  });

  it("never spends the meeting's allocation attempts on a requeue: its third bot being stopped hands it to a fourth", async () => {
    const { bot, claimId } = await heldClaim(t, '230000008');
    await t.pool.query(`UPDATE claims SET allocation_count = 3 WHERE id = $1`, [claimId]);
    const res = await release(bot.bot_token, { claim_id: claimId, generation: 1, requeue: true });
    expect(res.json()).toEqual({ status: 'requeued' });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'pending', allocation_count: 2, refused_reason: null });
    const next = await registerBot(t);
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'claimed', bot_id: next.bot_id, allocation_count: 3 });
  });

  it('requeues a failed placement by its reason: pending again for another bot, the attempt counted, the reason kept', async () => {
    const { bot, claimId } = await heldClaim(t, '230000009');
    const other = await registerBot(t);
    const res = await release(bot.bot_token, { claim_id: claimId, generation: 1, reason: 'waiting_room_timeout' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'requeued' });
    // The failing bot goes to the back of the queue, so the other ready bot takes the meeting.
    expect(await claimRow(t, claimId)).toMatchObject({
      state: 'claimed',
      bot_id: other.bot_id,
      generation: 3,
      allocation_count: 2,
      refused_reason: null,
      last_placement_failure: 'waiting_room_timeout',
    });
    // The bot that failed is still ready: it said nothing about itself.
    expect((await t.pool.query(`SELECT ready_at FROM bots WHERE id = $1`, [bot.bot_id])).rows[0].ready_at).not.toBeNull();
  });

  it('requeues each of the five failed-placement reasons, and a lone bot is retried with a fresh pending bound', async () => {
    for (const [i, reason] of [
      'waiting_for_host_timeout',
      'waiting_room_timeout',
      'unable_to_connect',
      'sdk_auth_failed',
      'obf_user_not_in_meeting',
    ].entries()) {
      await t.pool.query(`UPDATE bots SET ready_at = NULL`);
      const { bot, claimId } = await heldClaim(t, `23000002${i}`);
      // The claim's first bound has lapsed: a requeue that kept it would be refused by the sweep.
      await t.pool.query(`UPDATE claims SET pending_until = now() - interval '1 second' WHERE id = $1`, [claimId]);
      const res = await release(bot.bot_token, { claim_id: claimId, generation: 1, reason });
      expect(res.json(), reason).toEqual({ status: 'requeued' });
      expect(await claimRow(t, claimId), reason).toMatchObject({ state: 'claimed', bot_id: bot.bot_id, generation: 3, allocation_count: 2 });
      await release(bot.bot_token, { claim_id: claimId, generation: 3, meeting_ended: true });
    }
  });

  it('abandons a failed placement out of attempts as allocations_exhausted, keeps the last failure, and tells the bot released', async () => {
    const { bot, claimId } = await heldClaim(t, '230000010');
    await t.pool.query(`UPDATE claims SET allocation_count = 3 WHERE id = $1`, [claimId]);
    const res = await release(bot.bot_token, { claim_id: claimId, generation: 1, reason: 'unable_to_connect' });
    expect(res.json()).toEqual({ status: 'released' });
    expect(await claimRow(t, claimId)).toMatchObject({
      state: 'abandoned',
      refused_reason: 'allocations_exhausted',
      last_placement_failure: 'unable_to_connect',
      bot_id: bot.bot_id,
      lease_until: null,
      ended_at: expect.any(Date),
    });
  });

  it('never requeues a meeting-end release, whatever its reason', async () => {
    const { bot, claimId } = await heldClaim(t, '230000011');
    const res = await release(bot.bot_token, { claim_id: claimId, generation: 1, reason: 'sdk_auth_failed', meeting_ended: true });
    expect(res.json()).toEqual({ status: 'released' });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'done', meeting_ended_at: expect.any(Date) });
  });

  it('answers 400 for a reason that is not a code, a requeue at meeting end, or a generation that is not a 32-bit count', async () => {
    const { bot, claimId } = await heldClaim(t, '230000007');
    for (const bad of [
      { claim_id: claimId, generation: 1, reason: 'Left: host said bye' },
      { claim_id: claimId, generation: 1, reason: 'a'.repeat(65) },
      { claim_id: claimId, generation: 1, requeue: true, meeting_ended: true },
      { claim_id: claimId, generation: 2147483648 },
      { claim_id: claimId, generation: -1 },
    ]) {
      expect((await release(bot.bot_token, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await claimRow(t, claimId)).state).toBe('claimed');
  });
});
