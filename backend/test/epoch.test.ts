import { expect, it } from 'vitest';
import {
  bearer,
  botPost,
  claimRow,
  expectNotRenewed,
  occurrenceUuid,
  postAllocation,
  registerBot,
  resetAllocationsBeforeEach,
  shortLease,
  useApp,
} from './app.ts';
import { describeDb } from './db/harness.ts';

describeDb('the transcript epoch is per occurrence (QOR-4571)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  const post = (url: string, token: string, payload: object) => botPost(t, url, token, payload);
  const beat = (token: string, payload: object) => post('/assignment/heartbeat', token, payload);
  const assignment = async (token: string) =>
    (await t.app.inject({ method: 'GET', url: '/assignment', headers: bearer(token) })).json();

  /** A ready bot holding a fresh claim for `meeting` (generation 1), promoted onto `uuid`. */
  const promoted = async (meeting: string, uuid: string) => {
    const bot = await registerBot(t);
    const claimId = (await postAllocation(t, { zoom_url: `https://zoom.us/j/${meeting}` })).json().id as string;
    const generation = (await claimRow(t, claimId)).generation as number;
    const res = await post('/assignment/occurrence', bot.bot_token, { claim_id: claimId, generation, occurrence_uuid: uuid });
    expect(res.statusCode).toBe(200);
    return { bot, claimId, generation };
  };

  it("accepts the claim's current epoch or one above the occurrence's highest, and refuses anything else without renewing", async () => {
    const uuid = occurrenceUuid();
    const { bot, claimId } = await promoted('230000001', uuid);
    expect(await assignment(bot.bot_token)).toMatchObject({ claim_id: claimId, transcript_epoch: null });

    const first = await beat(bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 1 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ claim_id: claimId, transcript_epoch: 1 });
    expect(await beat(bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 1 })).toHaveProperty('statusCode', 200);
    expect((await beat(bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 3 })).json()).toMatchObject({
      transcript_epoch: 3,
    });

    await shortLease(t, claimId);
    for (const stale of [2, 1, 0]) {
      const res = await beat(bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: stale });
      expect(res.statusCode, `epoch ${stale}`).toBe(409);
      expect(res.json()).toEqual({ error: 'stale_epoch' });
    }
    await expectNotRenewed(t, claimId);
    expect((await claimRow(t, claimId)).transcript_epoch).toBe(3);
    expect(await assignment(bot.bot_token)).toMatchObject({ transcript_epoch: 3 });
    // A beat with no epoch only renews.
    expect((await beat(bot.bot_token, { claim_id: claimId, generation: 1 })).json()).toMatchObject({ transcript_epoch: 3 });
  });

  it('a new holder of a requeued claim cannot reuse the epoch of the bot before it', async () => {
    const uuid = occurrenceUuid();
    const { bot: first, claimId } = await promoted('230000002', uuid);
    expect((await beat(first.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 4 })).statusCode).toBe(200);
    expect((await post('/assignment/release', first.bot_token, { claim_id: claimId, generation: 1, requeue: true })).json()).toEqual({
      status: 'requeued',
    });
    expect((await claimRow(t, claimId)).transcript_epoch).toBeNull();

    const next = await registerBot(t);
    // The requeue took generation 2, the new placement 3.
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'claimed', bot_id: next.bot_id, generation: 3, occurrence_uuid: uuid });
    expect(await assignment(next.bot_token)).toMatchObject({ claim_id: claimId, transcript_epoch: 4 });

    await shortLease(t, claimId);
    for (const stale of [4, 3]) {
      const res = await beat(next.bot_token, { claim_id: claimId, generation: 3, transcript_epoch: stale });
      expect(res.statusCode, `epoch ${stale}`).toBe(409);
      expect(res.json()).toEqual({ error: 'stale_epoch' });
    }
    await expectNotRenewed(t, claimId);
    expect((await claimRow(t, claimId)).transcript_epoch).toBeNull();
    expect((await beat(next.bot_token, { claim_id: claimId, generation: 3, transcript_epoch: 5 })).json()).toMatchObject({
      transcript_epoch: 5,
    });
    expect((await claimRow(t, claimId)).transcript_epoch).toBe(5);
  });

  it('a new holder of a claim retried after a failed placement cannot reuse the epoch', async () => {
    const uuid = occurrenceUuid();
    const { bot: first, claimId } = await promoted('230000003', uuid);
    expect((await beat(first.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 2 })).statusCode).toBe(200);
    const released = await post('/assignment/release', first.bot_token, { claim_id: claimId, generation: 1, reason: 'unable_to_connect' });
    expect(released.json()).toEqual({ status: 'requeued' });
    expect((await claimRow(t, claimId)).transcript_epoch).toBeNull();
  });

  it('a restarted bot on a new claim for the same occurrence cannot reuse an epoch, even one it declared before promotion', async () => {
    const uuid = occurrenceUuid();
    const { bot: before, claimId: oldClaim } = await promoted('230000004', uuid);
    expect((await beat(before.bot_token, { claim_id: oldClaim, generation: 1, transcript_epoch: 2 })).statusCode).toBe(200);
    // The bot dies: its lease lapses and the claim is retired.
    await t.pool.query(`UPDATE claims SET state = 'abandoned', ended_at = now(), lease_until = NULL WHERE id = $1`, [oldClaim]);
    await t.pool.query(`UPDATE bots SET ready_at = NULL WHERE id = $1`, [before.bot_id]);

    // Restarted, it registers as a new bot and is sent to the same meeting on a new claim.
    const after = await registerBot(t);
    const claimId = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/230000004' })).json().id as string;
    expect(claimId).not.toBe(oldClaim);
    // No epoch on a new claim: the transcript push, which checks this column, takes nothing yet.
    expect((await claimRow(t, claimId)).transcript_epoch).toBeNull();
    // Before promotion the epoch is claim-local and taken as sent.
    expect((await beat(after.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 2 })).statusCode).toBe(200);
    expect(await assignment(after.bot_token)).toMatchObject({ transcript_epoch: null });

    const res = await post('/assignment/occurrence', after.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid });
    expect(res.json()).toMatchObject({ claim_id: claimId, occurrence_uuid: uuid, transcript_epoch: 2 });
    // Epoch 2 is already the occurrence's: promotion drops it from the claim.
    expect((await claimRow(t, claimId)).transcript_epoch).toBeNull();

    await shortLease(t, claimId);
    for (const stale of [2, 0]) {
      const refused = await beat(after.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: stale });
      expect(refused.statusCode, `epoch ${stale}`).toBe(409);
      expect(refused.json()).toEqual({ error: 'stale_epoch' });
    }
    await expectNotRenewed(t, claimId);
    expect((await beat(after.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 3 })).json()).toMatchObject({
      transcript_epoch: 3,
    });
  });

  it('keeps an epoch declared before promotion when it is above the occurrence highest, and raises the highest', async () => {
    const uuid = occurrenceUuid();
    const bot = await registerBot(t);
    const claimId = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/230000005' })).json().id as string;
    expect((await beat(bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 6 })).statusCode).toBe(200);
    const res = await post('/assignment/occurrence', bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid });
    expect(res.json()).toMatchObject({ transcript_epoch: 6 });
    expect((await claimRow(t, claimId)).transcript_epoch).toBe(6);
    expect((await beat(bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 6 })).statusCode).toBe(200);
  });
  it('refuses an epoch above 1000000 with 400 and renews nothing, leaving headroom below the int4 ceiling', async () => {
    const uuid = occurrenceUuid();
    const { bot, claimId } = await promoted('230000006', uuid);
    await shortLease(t, claimId);
    for (const over of [1_000_001, 2147483647]) {
      const res = await beat(bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: over });
      expect(res.statusCode, `epoch ${over}`).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_body' });
    }
    await expectNotRenewed(t, claimId);
    expect((await claimRow(t, claimId)).transcript_epoch).toBeNull();
    const top = await beat(bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 1_000_000 });
    expect(top.json()).toMatchObject({ transcript_epoch: 1_000_000 });
  });
});
