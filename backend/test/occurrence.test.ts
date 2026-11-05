import { expect, it } from 'vitest';
import {
  PERSON,
  botPost,
  claimRow,
  heldClaim,
  lapsingLease,
  occurrenceUuid,
  postAllocation,
  raceBehindLock,
  resetAllocationsBeforeEach,
  untilLapsed,
  useApp,
} from './app.ts';
import { describeDb } from './db/harness.ts';

describeDb('POST /assignment/occurrence (QOR-4571)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  const promote = (token: string, payload: object) => botPost(t, '/assignment/occurrence', token, payload);

  it('promotes the occurrence onto the bot own claim and answers the claim', async () => {
    const { bot, claimId } = await heldClaim(t, '220000001');
    const uuid = occurrenceUuid();
    const res = await promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ claim_id: claimId, occurrence_uuid: uuid });
    expect((await claimRow(t, claimId)).occurrence_uuid).toBe(uuid);
  });

  it('opens the meeting as the bot reports its occurrence: listed and live before its first transcript line', async () => {
    const { bot, claimId } = await heldClaim(t, '220000011');
    const uuid = occurrenceUuid();
    expect((await promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid })).statusCode).toBe(200);
    const history = (await t.app.inject({ method: 'GET', url: '/meetings', headers: PERSON })).json();
    const listed = history.meetings.find((m: { occurrence_id: string }) => m.occurrence_id === uuid);
    expect(listed).toMatchObject({ transcript_available: false, ended_at: null, occurrence_state: 'live' });
    const read = await t.app.inject({ method: 'GET', url: `/meetings/${listed.id}/transcript`, headers: PERSON });
    expect(read.json()).toMatchObject({ occurrence_state: 'live', segments: [] });
    // The same occurrence again opens nothing more.
    await promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid });
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM meetings WHERE occurrence_uuid = $1`, [uuid])).rows[0].n).toBe(1);
  });

  it('answers 409 stale_claim, and records nothing, for a generation the bot does not hold', async () => {
    const { bot, claimId } = await heldClaim(t, '220000002');
    const res = await promote(bot.bot_token, { claim_id: claimId, generation: 2, occurrence_uuid: occurrenceUuid() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_claim' });
    expect((await claimRow(t, claimId)).occurrence_uuid).toBeNull();
  });

  it('answers 200 to the same occurrence again, and 409 occurrence_conflict to a different one', async () => {
    const { bot, claimId } = await heldClaim(t, '220000003');
    const uuid = occurrenceUuid();
    await promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid });
    expect((await promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid })).statusCode).toBe(200);
    const other = await promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: occurrenceUuid() });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toEqual({ error: 'occurrence_conflict' });
    expect((await claimRow(t, claimId)).occurrence_uuid).toBe(uuid);
  });

  it('refuses an occurrence whose meeting already ended: 409 meeting_already_ended', async () => {
    const uuid = occurrenceUuid();
    // The tombstone a meeting-end release leaves behind.
    await t.pool.query(
      `INSERT INTO claims (meeting_number, occurrence_uuid, state, ended_at, meeting_ended_at)
       VALUES ('220000004', $1, 'done', now(), now())`,
      [uuid],
    );
    const { bot, claimId } = await heldClaim(t, '220000004');
    const res = await promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'meeting_already_ended' });
    expect((await claimRow(t, claimId)).occurrence_uuid).toBeNull();
    expect((await t.pool.query(`SELECT 1 FROM meetings WHERE occurrence_uuid = $1`, [uuid])).rows).toEqual([]);
  });

  it('ends the claim sent into an ended meeting: its bot is told to leave and takes the next meeting', async () => {
    const uuid = occurrenceUuid();
    await t.pool.query(
      `INSERT INTO claims (meeting_number, occurrence_uuid, state, ended_at, meeting_ended_at)
       VALUES ('220000008', $1, 'done', now(), now())`,
      [uuid],
    );
    const { bot, claimId } = await heldClaim(t, '220000008');
    const waiting = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/220000009' })).json();
    expect(waiting.claim_state).toBe('pending');

    expect((await promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid })).statusCode).toBe(409);
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'done', refused_reason: 'meeting_already_ended', lease_until: null });
    const beat = await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1 });
    expect(beat.json()).toEqual({ error: 'stale_claim' });
    expect(await claimRow(t, waiting.id)).toMatchObject({ state: 'claimed', bot_id: bot.bot_id });
  });

  it('a claim released without the meeting ending is no tombstone: its occurrence can be promoted again', async () => {
    const uuid = occurrenceUuid();
    await t.pool.query(
      `INSERT INTO claims (meeting_number, occurrence_uuid, state, ended_at, refused_reason)
       VALUES ('220000005', $1, 'done', now(), 'could_not_join')`,
      [uuid],
    );
    const { bot, claimId } = await heldClaim(t, '220000005');
    expect((await promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid })).statusCode).toBe(200);
  });

  it('answers 400 for a generation that is not a 32-bit count', async () => {
    const { bot, claimId } = await heldClaim(t, '220000007');
    for (const generation of [-1, 2147483648]) {
      const res = await promote(bot.bot_token, { claim_id: claimId, generation, occurrence_uuid: occurrenceUuid() });
      expect(res.statusCode, String(generation)).toBe(400);
    }
  });

  it('answers 400 for an occurrence that is not a Zoom UUID', async () => {
    const { bot, claimId } = await heldClaim(t, '220000006');
    for (const occurrence_uuid of ['', 'has space', 'x'.repeat(129), 'quote"']) {
      const res = await promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid });
      expect(res.statusCode, occurrence_uuid).toBe(400);
    }
  });
  it('answers what it commits when the lease lapses between the fence and the write: promoted, with the epoch it raised', async () => {
    const { bot, claimId } = await heldClaim(t, '220000010');
    const uuid = occurrenceUuid();
    await t.pool.query(`INSERT INTO occurrence_epochs (occurrence_uuid, highest_epoch) VALUES ($1, 1)`, [uuid]);
    // Declared before promotion, so promotion raises the occurrence's epoch.
    expect((await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 4 })).statusCode).toBe(200);
    // The occurrence's row lock is the one promotion takes after passing the fence on the claim's.
    const res = await raceBehindLock(
      t,
      { sql: `SELECT 1 FROM occurrence_epochs WHERE occurrence_uuid = $1 FOR UPDATE`, params: [uuid] },
      // The lease is set as the call starts, so it is live when the fence is read.
      async () => (await lapsingLease(t, claimId, 1500), promote(bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid })),
      () => untilLapsed(t, claimId),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ claim_id: claimId, occurrence_uuid: uuid, transcript_epoch: 4 });
    expect(await claimRow(t, claimId)).toMatchObject({ occurrence_uuid: uuid, transcript_epoch: 4 });
    const highest = (await t.pool.query(`SELECT highest_epoch FROM occurrence_epochs WHERE occurrence_uuid = $1`, [uuid])).rows[0];
    expect(highest).toEqual({ highest_epoch: 4 });
  });
});
