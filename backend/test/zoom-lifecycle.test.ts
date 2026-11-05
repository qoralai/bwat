import { beforeEach, expect, it } from 'vitest';
import { allocate } from '../src/claims.ts';
import type { ZoomConfig } from '../src/config.ts';
import {
  bearer,
  botPost,
  claimRow,
  heldClaim,
  occurrenceUuid,
  PERSON,
  postAllocation,
  raceBehindLock,
  registerBot,
  resetAllocationsBeforeEach,
  signedIn,
  until,
  type TestApp,
} from './app.ts';
import { describeDb } from './db/harness.ts';
import { meetingIdOf, pushTranscript, segment } from './meetings.ts';
import { deliver, storedSwitch, useZoomApp, zoomEvent } from './zoom.ts';
import { ADMIN, ADMIN_ID, withRoles } from './people.ts';

const ON: ZoomConfig = { autoJoin: true, requireHost: false };

const promoteOn = (t: TestApp, token: string, claimId: string, uuid: string) =>
  botPost(t, '/assignment/occurrence', token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid });
const started = (meeting: string, uuid: string) =>
  zoomEvent('meeting.started', { id: meeting, uuid, host_id: 'host-1', start_time: new Date().toISOString() });
const endedEvent = (meeting: string, uuid?: string) => zoomEvent('meeting.ended', { id: meeting, ...(uuid ? { uuid } : {}) });
const occurrenceEpoch = async (t: TestApp, uuid: string) =>
  (await t.pool.query(`SELECT highest_epoch FROM occurrence_epochs WHERE occurrence_uuid = $1`, [uuid])).rows[0]?.highest_epoch;

/**
 * One record says an occurrence's meeting has ended, whoever learnt it first: Zoom's
 * meeting.ended or a bot's meeting_ended release. The lifecycle's promotion check and
 * auto-join's late-start refusal both read it, so they agree.
 */
describeDb("a meeting's end is one record, shared by Zoom and the claim lifecycle (QOR-4576)", () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);
  beforeEach(() => {
    storedSwitch(t).value = true;
  });

  const promote = (token: string, claimId: string, uuid: string) =>
    botPost(t, '/assignment/occurrence', token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid });
  const openClaims = async (meeting: string) =>
    (await t.pool.query(`SELECT id FROM claims WHERE meeting_number = $1 AND state IN ('pending', 'claimed', 'attending')`, [meeting]))
      .rows;

  it("Zoom's end releases an open claim as a bot's meeting_ended release would: a later claim cannot be promoted onto it", async () => {
    const uuid = occurrenceUuid();
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/240000001' })).json();
    // Stamped by a Zoom start, as the end of the occurrence finds it.
    await t.pool.query(`UPDATE claims SET occurrence_uuid = $2 WHERE id = $1`, [sent.id, uuid]);
    expect((await deliver(t, zoomEvent('meeting.ended', { id: 240000001, uuid }))).json()).toEqual({ status: 'released' });
    expect(await claimRow(t, sent.id)).toMatchObject({
      state: 'done',
      refused_reason: 'meeting_ended',
      occurrence_uuid: uuid,
      meeting_ended_at: expect.any(Date),
    });

    const { bot, claimId } = await heldClaim(t, '240000001');
    const res = await promote(bot.bot_token, claimId, uuid);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'meeting_already_ended' });
  });

  it('Zoom ending an occurrence no claim knew of refuses a later promotion onto it: 409 meeting_already_ended', async () => {
    const uuid = occurrenceUuid();
    // A meeting a person sent bwat to before, so auto-join could open it and its end is recorded.
    await t.pool.query(`INSERT INTO claims (meeting_number, state, briefing, ended_at) VALUES ('240000002', 'done', '{}', now())`);
    expect((await deliver(t, zoomEvent('meeting.ended', { id: 240000002, uuid }))).json()).toEqual({ status: 'tombstoned' });

    const { bot, claimId } = await heldClaim(t, '240000002');
    const res = await promote(bot.bot_token, claimId, uuid);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'meeting_already_ended' });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'done', refused_reason: 'meeting_already_ended', occurrence_uuid: null });
  });

  it("a bot's meeting_ended release refuses a late Zoom start for that occurrence: no claim opens", async () => {
    const uuid = occurrenceUuid();
    const { bot, claimId } = await heldClaim(t, '240000003');
    expect((await promote(bot.bot_token, claimId, uuid)).statusCode).toBe(200);
    const released = await botPost(t, '/assignment/release', bot.bot_token, { claim_id: claimId, generation: 1, meeting_ended: true });
    expect(released.json()).toEqual({ status: 'released' });
    await registerBot(t);

    expect((await deliver(t, zoomEvent('meeting.started', { id: 240000003, uuid }))).json()).toEqual({ status: 'already_ended' });
    expect(await openClaims('240000003')).toEqual([]);
  });
});

/**
 * A Zoom start stamps a claim's occurrence through
 * the same locked transition a bot's promotion takes, and an end closes only the claims
 * that name its occurrence.
 */
describeDb('a Zoom start stamps, and a Zoom end closes, only by the claim lifecycle (QOR-4576)', () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);
  beforeEach(() => {
    storedSwitch(t).value = true;
  });

  it('a start never overwrites the occurrence a bot promoted the claim to while the start waited on it', async () => {
    const [a, b] = [occurrenceUuid(), occurrenceUuid()];
    const { bot, claimId } = await heldClaim(t, '240000011');
    const res = await raceBehindLock(
      t,
      { sql: `SELECT 1 FROM claims WHERE id = $1 FOR UPDATE`, params: [claimId] },
      () => deliver(t, started('240000011', a)),
      (holder) => holder.query(`UPDATE claims SET occurrence_uuid = $2 WHERE id = $1`, [claimId, b]),
    );
    expect(res.json()).toEqual({ status: 'already_claimed' });
    expect((await claimRow(t, claimId)).occurrence_uuid).toBe(b);
    expect((await promoteOn(t, bot.bot_token, claimId, b)).statusCode).toBe(200);
  });

  it("a start stamping a claim registers its epoch as the occurrence's, as a promotion would", async () => {
    const a = occurrenceUuid();
    const { bot, claimId } = await heldClaim(t, '240000012');
    const beat = await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 5 });
    expect(beat.statusCode).toBe(200);
    expect((await deliver(t, started('240000012', a))).json()).toEqual({ status: 'already_claimed' });
    expect(await claimRow(t, claimId)).toMatchObject({ occurrence_uuid: a, transcript_epoch: 5 });
    expect(await occurrenceEpoch(t, a)).toBe(5);

    expect((await promoteOn(t, bot.bot_token, claimId, a)).statusCode).toBe(200);
    const assigned = await t.app.inject({ method: 'GET', url: '/assignment', headers: bearer(bot.bot_token) });
    expect(assigned.json()).toMatchObject({ claim_id: claimId, occurrence_uuid: a, transcript_epoch: 5 });
  });

  it('a start stamping a claim drops an epoch the occurrence already used, as a promotion would', async () => {
    const a = occurrenceUuid();
    await t.pool.query(`INSERT INTO occurrence_epochs (occurrence_uuid, highest_epoch) VALUES ($1, 7)`, [a]);
    const { bot, claimId } = await heldClaim(t, '240000013');
    await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 5 });
    expect((await deliver(t, started('240000013', a))).json()).toEqual({ status: 'already_claimed' });
    expect(await claimRow(t, claimId)).toMatchObject({ occurrence_uuid: a, transcript_epoch: null });
    expect(await occurrenceEpoch(t, a)).toBe(7);
  });

  it("an earlier occurrence's delayed end leaves a claim not yet promoted open: it then promotes onto the next", async () => {
    const [a, b] = [occurrenceUuid(), occurrenceUuid()];
    const { bot, claimId } = await heldClaim(t, '240000014');
    expect((await deliver(t, endedEvent('240000014', a))).json()).toEqual({ status: 'tombstoned' });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'claimed', occurrence_uuid: null, meeting_ended_at: null });
    expect((await promoteOn(t, bot.bot_token, claimId, b)).statusCode).toBe(200);
  });

  it('a claim not yet promoted whose bot then reports the ended occurrence is refused, and ends', async () => {
    const a = occurrenceUuid();
    const { bot, claimId } = await heldClaim(t, '240000015');
    await deliver(t, endedEvent('240000015', a));
    const res = await promoteOn(t, bot.bot_token, claimId, a);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'meeting_already_ended' });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'done', refused_reason: 'meeting_already_ended' });
  });

  it('an end naming no occurrence closes nothing', async () => {
    const { claimId } = await heldClaim(t, '240000016');
    expect((await deliver(t, endedEvent('240000016'))).json()).toEqual({ status: 'ignored_no_meeting' });
    expect((await claimRow(t, claimId)).state).toBe('claimed');
  });
});

/** Backends of this database waiting on `event` (pg_stat_activity.wait_event): 'transactionid' a row, 'advisory' a meeting's lock. */
const waitingOn = async (t: TestApp, event: string) =>
  (
    await t.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = $1 AND datname = current_database()`,
      [event],
    )
  ).rows[0]!.n;

/** Starts `go` and returns once it waits on `event` or has answered, whichever comes first; `running` is its answer. */
async function pausedAt<T>(t: TestApp, go: () => Promise<T>, event: string): Promise<{ running: Promise<T> }> {
  let settled = false;
  const running = go().finally(() => {
    settled = true;
  });
  if (!(await until(async () => settled || (await waitingOn(t, event)) > 0, { tries: 200, ms: 10 }))) {
    throw new Error(`never waited on ${event}, nor answered`);
  }
  return { running };
}

/** Live claims naming an occurrence Zoom reported ended: the state neither order of the race may leave. */
const liveOnEnded = async (t: TestApp) =>
  (
    await t.pool.query(
      `SELECT c.id FROM claims c JOIN zoom_ended_occurrences z USING (meeting_number, occurrence_uuid)
        WHERE c.state IN ('claimed', 'attending')`,
    )
  ).rows;

/**
 * Zoom's end skips a claim not yet promoted, so a
 * bot promoting it onto the ending occurrence must take turns with the end on the
 * meeting's lock; otherwise the promotion lands between the end's UPDATE and its
 * tombstone and leaves a live claim on an ended occurrence. Each test pauses the first
 * party on a row a test transaction holds, after it has the meeting's lock.
 */
describeDb("a bot's promotion and Zoom's end of the occurrence take turns (QOR-4576)", () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);
  beforeEach(() => {
    storedSwitch(t).value = true;
  });

  it('end first: the promotion waits for the end, then is refused 409 meeting_already_ended, and its claim ends', async () => {
    const a = occurrenceUuid();
    const { bot, claimId } = await heldClaim(t, '240000017');
    const holder = await t.pool.connect();
    try {
      await holder.query('BEGIN');
      // The end's tombstone insert waits on this one: the end is paused after its UPDATE.
      await holder.query(`INSERT INTO zoom_ended_occurrences (meeting_number, occurrence_uuid) VALUES ($1, $2)`, ['240000017', a]);
      const end = await pausedAt(t, () => deliver(t, endedEvent('240000017', a)), 'transactionid');
      const promotion = await pausedAt(t, () => promoteOn(t, bot.bot_token, claimId, a), 'advisory');
      await holder.query('ROLLBACK');
      const [ended, promoted] = [await end.running, await promotion.running];

      expect(await liveOnEnded(t)).toEqual([]);
      expect(ended.json()).toEqual({ status: 'tombstoned' });
      expect(promoted.statusCode).toBe(409);
      expect(promoted.json()).toEqual({ error: 'meeting_already_ended' });
      expect(await claimRow(t, claimId)).toMatchObject({ state: 'done', refused_reason: 'meeting_already_ended', occurrence_uuid: null });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('promotion first: the end waits for the promotion, then records the end and leaves the held claim live to drain', async () => {
    const a = occurrenceUuid();
    const { bot, claimId } = await heldClaim(t, '240000018');
    // An epoch, so the promotion writes the occurrence's epoch row after its meetingEnded check.
    const beat = await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 5 });
    expect(beat.statusCode).toBe(200);
    const holder = await t.pool.connect();
    try {
      await holder.query('BEGIN');
      // The promotion's epoch insert waits on this one: it is paused after its check, claim locked.
      await holder.query(`INSERT INTO occurrence_epochs (occurrence_uuid, highest_epoch) VALUES ($1, 1)`, [a]);
      const promotion = await pausedAt(t, () => promoteOn(t, bot.bot_token, claimId, a), 'transactionid');
      const end = await pausedAt(t, () => deliver(t, endedEvent('240000018', a)), 'advisory');
      await holder.query('ROLLBACK');
      const [promoted, ended] = [await promotion.running, await end.running];

      expect(promoted.statusCode).toBe(200);
      expect(promoted.json()).toMatchObject({ claim_id: claimId, occurrence_uuid: a });
      // The end is recorded, and the held claim stays live until its bot's final push or its end.
      expect(ended.json()).toEqual({ status: 'tombstoned' });
      expect(await liveOnEnded(t)).toEqual([{ id: claimId }]);
      expect(await claimRow(t, claimId)).toMatchObject({ state: 'claimed', occurrence_uuid: a, meeting_ended_at: null });
      const pushed = await pushTranscript(t, a, bot.bot_token, { epoch: 5, segments: [segment(0)] });
      expect(pushed.statusCode).toBe(204);
      const state = async () =>
        (await t.app.inject({ method: 'GET', url: `/meetings/${await meetingIdOf(t, a)}/transcript`, headers: PERSON })).json();
      expect(await state()).toMatchObject({ complete: false, occurrence_state: 'live' });
      expect((await pushTranscript(t, a, bot.bot_token, { epoch: 5, complete: true, segments: [] })).statusCode).toBe(204);
      expect(await state()).toMatchObject({ complete: true, occurrence_state: 'ended' });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});

/** B3: every verified end is recorded, and kept, whatever auto-join says and whatever claim is open. */
describeDb("an occurrence's end is recorded for good, with auto-join off (QOR-4576)", () => {
  const t = useZoomApp({
    authenticatePerson: async req => (await withRoles(req)) ?? signedIn(req),
    zoom: { ...ON, autoJoin: false },
    autoJoinCacheMs: 0,
  });
  resetAllocationsBeforeEach(t);

  /** A fresh bot holding a fresh claim for the meeting: no other bot ready to take it. */
  const freshHeld = async (meeting: string) => {
    await t.pool.query(`UPDATE bots SET ready_at = NULL`);
    return heldClaim(t, meeting);
  };
  const promoteFresh = async (meeting: string, uuid: string) => {
    const { bot, claimId } = await freshHeld(meeting);
    const res = await promoteOn(t, bot.bot_token, claimId, uuid);
    return { status: res.statusCode, claim: await claimRow(t, claimId) };
  };

  it('a promoted claim is recalled, then Zoom ends it: the occurrence has ended, and still has a day later', async () => {
    await t.pool.query(`INSERT INTO members (id, email, role, activated_at)
      VALUES ($1, 'lifecycle-admin@test.invalid', 'admin', now()) ON CONFLICT (id) DO NOTHING`, [ADMIN_ID]);
    const a = occurrenceUuid();
    const first = await freshHeld('240000021');
    expect((await promoteOn(t, first.bot.bot_token, first.claimId, a)).statusCode).toBe(200);
    const recall = await t.app.inject({
      method: 'PATCH',
      url: `/allocations/${first.claimId}`,
      headers: ADMIN,
      payload: { recall: true },
    });
    expect(recall.json()).toMatchObject({ claim_state: 'refused', refused_reason: 'recalled' });

    expect((await deliver(t, endedEvent('240000021', a))).json()).toEqual({ status: 'tombstoned' });
    expect(await promoteFresh('240000021', a)).toMatchObject({
      status: 409,
      claim: { state: 'done', refused_reason: 'meeting_already_ended' },
    });

    const owner = await t.db.connect('owner');
    try {
      await owner.query(`UPDATE bwat.zoom_ended_occurrences SET ended_at = now() - interval '2 days' WHERE occurrence_uuid = $1`, [a]);
    } finally {
      await owner.end();
    }
    // Another end: the only write that could sweep old records.
    await deliver(t, endedEvent('240000022', occurrenceUuid()));
    expect((await promoteFresh('240000021', a)).status).toBe(409);
  });
});

/**
 * Zoom's end while a bot holds a claim on the occurrence: the bot
 * sees the end through the Zoom SDK, drains, pushes complete:true, then releases with
 * meeting_ended. So the end records the occurrence and ends only the claims with no bot to
 * drain (pending); a held claim stays live until its final push or its own end.
 */
describeDb("Zoom's end leaves a held claim live to drain its transcript (QOR-4577)", () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);

  /** A bot holding a claim promoted to a fresh occurrence at epoch 1, with one segment stored. */
  async function draining(meeting: string) {
    const { bot, claimId } = await heldClaim(t, meeting);
    const a = occurrenceUuid();
    expect((await promoteOn(t, bot.bot_token, claimId, a)).statusCode).toBe(200);
    expect((await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 1 })).statusCode).toBe(200);
    expect((await pushTranscript(t, a, bot.bot_token, { epoch: 1, segments: [segment(0)] })).statusCode).toBe(204);
    return { bot, claimId, a };
  }
  const read = async (a: string) =>
    (await t.app.inject({ method: 'GET', url: `/meetings/${await meetingIdOf(t, a)}/transcript`, headers: PERSON })).json();

  it("stores the bot's final batch after Zoom's end: live until complete:true, then ended", async () => {
    const { bot, claimId, a } = await draining('250000001');
    expect((await deliver(t, endedEvent('250000001', a))).json()).toEqual({ status: 'tombstoned' });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'claimed', meeting_ended_at: null });
    expect(await read(a)).toMatchObject({ complete: false, occurrence_state: 'live' });

    const final = await pushTranscript(t, a, bot.bot_token, { epoch: 1, complete: true, segments: [segment(1), segment(2)] });
    expect(final.statusCode).toBe(204);
    const after = await read(a);
    expect(after).toMatchObject({ complete: true, occurrence_state: 'ended' });
    expect(after.segments.map((x: { seq: number }) => x.seq)).toEqual([0, 1, 2]);
    // Its heartbeat and its meeting_ended release still work.
    expect((await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1 })).statusCode).toBe(200);
    const released = await botPost(t, '/assignment/release', bot.bot_token, { claim_id: claimId, generation: 1, meeting_ended: true });
    expect(released.json()).toEqual({ status: 'released' });
    expect(await read(a)).toMatchObject({ complete: true, occurrence_state: 'ended' });
  });

  it('ends a held claim whose bot never pushes again by its lease lapsing: abandoned, and the occurrence ended', async () => {
    const { claimId, a } = await draining('250000002');
    await deliver(t, endedEvent('250000002', a));
    expect(await read(a)).toMatchObject({ occurrence_state: 'live' });
    await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE id = $1`, [claimId]);
    await allocate(t.pool); // the sweep's retire step
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'abandoned', refused_reason: 'lease_expired' });
    expect(await read(a)).toMatchObject({ complete: false, occurrence_state: 'ended' });
  });

  it('ends a pending claim stamped with the occurrence: it has no bot to drain', async () => {
    const a = occurrenceUuid();
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/250000003' })).json();
    expect(sent.claim_state).toBe('pending');
    await t.pool.query(`UPDATE claims SET occurrence_uuid = $2 WHERE id = $1`, [sent.id, a]);
    expect((await deliver(t, endedEvent('250000003', a))).json()).toEqual({ status: 'released' });
    expect(await claimRow(t, sent.id)).toMatchObject({ state: 'done', refused_reason: 'meeting_ended', meeting_ended_at: expect.any(Date) });
  });
});

/**
 * The drain after Zoom's end is bounded. A bot
 * that keeps heartbeating without completing would otherwise hold the ended occurrence
 * live for good. Zoom's end gives each held claim on the occurrence 300 s
 * (drain_until); past it the claim ends (done, drain_expired) at its bot's next call or
 * the sweep, whichever is first.
 */
describeDb("a held claim's drain after Zoom's end is bounded (QOR-4577)", () => {
  const DRAIN = 120;
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: { ...ON, drainSeconds: DRAIN }, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);

  async function ended(meeting: string) {
    const { bot, claimId } = await heldClaim(t, meeting);
    const a = occurrenceUuid();
    expect((await promoteOn(t, bot.bot_token, claimId, a)).statusCode).toBe(200);
    expect((await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 1 })).statusCode).toBe(200);
    expect((await pushTranscript(t, a, bot.bot_token, { epoch: 1, segments: [segment(0)] })).statusCode).toBe(204);
    expect((await deliver(t, endedEvent(meeting, a))).json()).toEqual({ status: 'tombstoned' });
    return { bot, claimId, a };
  }
  /** As though the end were recorded longer ago than the bound. */
  const pastTheBound = (claimId: string) =>
    t.pool.query(`UPDATE claims SET drain_until = clock_timestamp() - interval '1 second' WHERE id = $1`, [claimId]);
  const state = async (a: string) =>
    (await t.app.inject({ method: 'GET', url: `/meetings/${encodeURIComponent(a)}/transcript`, headers: PERSON })).json();
  const storedSeqs = async (a: string) =>
    (await state(a)).segments.map((x: { seq: number }) => x.seq);

  it('gives the held claim the configured bound from the end, and accepts the final push within it', async () => {
    const { bot, claimId, a } = await ended('250000011');
    const drainUntil = (await claimRow(t, claimId)).drain_until.getTime();
    expect(drainUntil).toBeGreaterThan(Date.now() + (DRAIN - 10) * 1000);
    expect(drainUntil).toBeLessThan(Date.now() + (DRAIN + 10) * 1000);
    expect((await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1 })).statusCode).toBe(200);
    expect((await pushTranscript(t, a, bot.bot_token, { epoch: 1, complete: true, segments: [segment(1)] })).statusCode).toBe(204);
    expect(await state(a)).toMatchObject({ complete: true, occurrence_state: 'ended' });
  });

  it('a second end of the occurrence never extends the bound', async () => {
    const { claimId, a } = await ended('250000012');
    const first = (await claimRow(t, claimId)).drain_until.getTime();
    await deliver(t, endedEvent('250000012', a));
    expect((await claimRow(t, claimId)).drain_until.getTime()).toBe(first);
  });

  it('past the bound, a heartbeat is 409 stale_claim and ends the claim (done, drain_expired): the occurrence reads ended', async () => {
    const { bot, claimId, a } = await ended('250000013');
    await pastTheBound(claimId);
    expect(await state(a)).toMatchObject({ occurrence_state: 'live' }); // until the claim ends
    const res = await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_claim' });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'done', refused_reason: 'drain_expired', lease_until: null });
    expect(await state(a)).toMatchObject({ complete: false, occurrence_state: 'ended' });
  });

  it('past the bound, a push is 409 stale_claim, stores nothing and ends the claim: the occurrence reads ended', async () => {
    const { bot, claimId, a } = await ended('250000014');
    await pastTheBound(claimId);
    const res = await pushTranscript(t, a, bot.bot_token, { epoch: 1, complete: true, segments: [segment(1)] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_claim' });
    expect(await storedSeqs(a)).toEqual([0]);
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'done', refused_reason: 'drain_expired' });
    expect(await state(a)).toMatchObject({ complete: false, occurrence_state: 'ended' });
  });

  it('past the bound, the sweep retires the claim (done, drain_expired) though its lease still runs', async () => {
    const { claimId, a } = await ended('250000015');
    await pastTheBound(claimId);
    expect((await claimRow(t, claimId)).lease_until.getTime()).toBeGreaterThan(Date.now());
    await allocate(t.pool); // the sweep's retire step
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'done', refused_reason: 'drain_expired', lease_until: null });
    expect(await state(a)).toMatchObject({ occurrence_state: 'ended' });
  });
});
