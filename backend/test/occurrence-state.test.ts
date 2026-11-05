import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { endMeeting } from '../src/claims.ts';
import { runRetention } from '../src/retention.ts';
import { PERSON, postAllocation, resetAllocationsBeforeEach, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting, meetingIdOf, pushTranscript, segment } from './meetings.ts';

/**
 * GET /meetings/{meetingId}/transcript reports `complete` and `occurrence_state`, derived
 * at read time from the meeting and the claims for its occurrence:
 *   ended      the transcript is complete, or the meeting's end is recorded (meetingEnded:
 *              a claim's meeting_ended_at, Zoom's meeting.ended record, or its transcript
 *              expired, QOR-4600) and no claim is open on the occurrence: a write fence that
 *              stays ended;
 *   live       a claim is open (pending or held) for it;
 *   abandoned  not ended, and every claim is terminal.
 */
describeDb('the occurrence state on a transcript read', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  // The card service's view (QOR-4601, migration 0010, replaced by 0011) defines occurrence_state again, in
  // SQL: every state read here is read through it too, as the card login, and must match.
  let cards: pg.Client;
  beforeAll(async () => {
    cards = await t.db.connect('cards');
  });
  afterAll(async () => {
    await cards?.end();
  });

  const stateOf = async (occurrence: string) => {
    const meetingId = await meetingIdOf(t, occurrence);
    const res = await t.app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}/transcript`,
      headers: PERSON,
    });
    expect(res.statusCode).toBe(200);
    const { complete, occurrence_state } = res.json();
    const view = await cards.query(`SELECT occurrence_state FROM bwat.v_cards_occurrences WHERE meeting_id = $1`, [meetingId]);
    expect(view.rows).toEqual([{ occurrence_state }]);
    return { complete, occurrence_state };
  };

  /** A meeting opened by one push from a bot holding a claim on it. */
  async function meetingWithPush(occurrence: string, meetingNumber: string) {
    const bot = await botInMeeting(t, occurrence, meetingNumber, 1);
    expect((await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] })).statusCode).toBe(204);
    return bot;
  }

  /** Ends a claim as the lifecycle track does: done (released) or abandoned, with a reason; a meeting_ended release records the end (meeting_ended_at). */
  const endClaim = (claimId: string, state: 'done' | 'abandoned', reason: string) =>
    t.pool.query(
      `UPDATE claims SET state = $2, refused_reason = $3, ended_at = now(), lease_until = NULL,
              meeting_ended_at = CASE WHEN $3 = 'meeting_ended' THEN now() END
        WHERE id = $1`,
      [claimId, state, reason],
    );

  /** A new claim on the same occurrence, held by `botId` at `epoch` (a reconnect, or a second send). */
  const holdAgain = async (botId: string, occurrence: string, meetingNumber: string, epoch: number) =>
    (
      await t.pool.query(
        `INSERT INTO claims (meeting_number, occurrence_uuid, state, bot_id, generation, transcript_epoch, lease_until)
         VALUES ($1, $2, 'attending', $3, 1, $4, now() + interval '10 minutes') RETURNING id`,
        [meetingNumber, occurrence, botId, epoch],
      )
    ).rows[0].id as string;

  it('is live and not complete while the claim is held', async () => {
    await meetingWithPush('st-live', '966000001');
    expect(await stateOf('st-live')).toEqual({ complete: false, occurrence_state: 'live' });
  });

  it('is ended and complete once the final push is stored, even with the claim still held', async () => {
    const bot = await meetingWithPush('st-complete', '966000002');
    expect((await pushTranscript(t, 'st-complete', bot.bot_token, { epoch: 1, complete: true, segments: [] })).statusCode).toBe(204);
    expect(await stateOf('st-complete')).toEqual({ complete: true, occurrence_state: 'ended' });
  });

  it('is ended, not complete, after a meeting_ended release with no claim open, and refuses a push', async () => {
    const bot = await meetingWithPush('st-released', '966000003');
    await endClaim(bot.claim_id, 'done', 'meeting_ended');
    expect(await stateOf('st-released')).toEqual({ complete: false, occurrence_state: 'ended' });
    const late = await pushTranscript(t, 'st-released', bot.bot_token, { epoch: 1, segments: [segment(1)] });
    expect(late.statusCode).toBe(409);
  });

  it('is abandoned when every claim is terminal and the meeting did not end', async () => {
    const bot = await meetingWithPush('st-abandoned', '966000004');
    await endClaim(bot.claim_id, 'abandoned', 'lease_expired');
    expect(await stateOf('st-abandoned')).toEqual({ complete: false, occurrence_state: 'abandoned' });
  });

  it('is abandoned after a release for any other reason', async () => {
    const bot = await meetingWithPush('st-recalled', '966000005');
    await endClaim(bot.claim_id, 'done', 'removed_by_host');
    expect(await stateOf('st-recalled')).toEqual({ complete: false, occurrence_state: 'abandoned' });
  });

  it('goes from abandoned to live when a new claim opens for the meeting (pending, no occurrence yet)', async () => {
    const bot = await meetingWithPush('st-reopen', '966000006');
    await endClaim(bot.claim_id, 'abandoned', 'lease_expired');
    expect((await stateOf('st-reopen')).occurrence_state).toBe('abandoned');
    await t.pool.query(`UPDATE bots SET ready_at = NULL`); // no bot to place it on: it stays pending
    const opened = await postAllocation(t, { zoom_url: 'https://zoom.us/j/966000006' });
    expect(opened.statusCode).toBeLessThan(300);
    const claim = (await t.pool.query(`SELECT state, occurrence_uuid FROM claims WHERE id = $1`, [opened.json().id])).rows[0];
    expect(claim).toEqual({ state: 'pending', occurrence_uuid: null });
    expect(await stateOf('st-reopen')).toEqual({ complete: false, occurrence_state: 'live' });
  });

  it('is not made live by a claim open for another meeting', async () => {
    const bot = await meetingWithPush('st-other', '966000007');
    await endClaim(bot.claim_id, 'abandoned', 'lease_expired');
    await postAllocation(t, { zoom_url: 'https://zoom.us/j/966000008' });
    expect((await stateOf('st-other')).occurrence_state).toBe('abandoned');
  });

  it('stays ended after a meeting_ended release when a pending claim (no occurrence yet) opens for the number', async () => {
    const bot = await meetingWithPush('st-ended-next', '966000012');
    await endClaim(bot.claim_id, 'done', 'meeting_ended');
    await t.pool.query(`UPDATE bots SET ready_at = NULL`);
    expect((await postAllocation(t, { zoom_url: 'https://zoom.us/j/966000012' })).statusCode).toBeLessThan(300);
    expect(await stateOf('st-ended-next')).toEqual({ complete: false, occurrence_state: 'ended' });
  });

  it('is not made live by a claim held on another occurrence of the same meeting number', async () => {
    const bot = await meetingWithPush('st-week1', '966000011');
    await endClaim(bot.claim_id, 'abandoned', 'lease_expired');
    await holdAgain(bot.bot_id, 'st-week2', '966000011', 1);
    expect((await stateOf('st-week1')).occurrence_state).toBe('abandoned');
  });

  it('the final push with the claim held: live, then ended, then a late push is refused, and a meeting_ended release keeps it ended', async () => {
    const occ = 'st-sequence';
    const bot = await meetingWithPush(occ, '966000009');
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'live' });

    const final = await pushTranscript(t, occ, bot.bot_token, { epoch: 1, complete: true, segments: [segment(1)] });
    expect(final.statusCode).toBe(204);
    expect(await stateOf(occ)).toEqual({ complete: true, occurrence_state: 'ended' });

    const late = await pushTranscript(t, occ, bot.bot_token, { epoch: 1, segments: [segment(2)] });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ error: 'transcript_complete' });

    await endClaim(bot.claim_id, 'done', 'meeting_ended');
    expect(await stateOf(occ)).toEqual({ complete: true, occurrence_state: 'ended' });
  });

  /** Zoom's meeting.ended for the occurrence, as the webhook records it. */
  const zoomEnds = (meetingNumber: string, occurrence: string) =>
    endMeeting(t.pool, { meetingNumber, occurrenceUuid: occurrence, deliveryKey: randomBytes(32) });

  const storedCount = async (occ: string) =>
    (
      await t.pool.query(
        `SELECT count(*)::int AS n FROM transcript_segments s JOIN meetings m ON m.id = s.meeting_id WHERE m.occurrence_uuid = $1`,
        [occ],
      )
    ).rows[0].n;

  it('is ended once Zoom records the end with no claim open, and stores no push after it', async () => {
    const occ = 'st-zoom-ended';
    const bot = await meetingWithPush(occ, '966000014');
    await endClaim(bot.claim_id, 'abandoned', 'lease_expired');
    expect((await stateOf(occ)).occurrence_state).toBe('abandoned');
    await zoomEnds('966000014', occ);
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'ended' });
    // No live claim can hold an ended occurrence: Zoom's end releases it and promotion refuses it.
    expect((await pushTranscript(t, occ, bot.bot_token, { epoch: 1, segments: [segment(1)] })).statusCode).toBe(409);
    expect(await storedCount(occ)).toBe(1);
  });

  it("stays live when Zoom ends the meeting under a held claim, until the bot's final push lands", async () => {
    const occ = 'st-zoom-held';
    const bot = await meetingWithPush(occ, '966000015');
    expect((await stateOf(occ)).occurrence_state).toBe('live');
    await zoomEnds('966000015', occ);
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'live' });
    expect((await pushTranscript(t, occ, bot.bot_token, { epoch: 1, complete: true, segments: [segment(1)] })).statusCode).toBe(204);
    expect(await stateOf(occ)).toEqual({ complete: true, occurrence_state: 'ended' });
    expect(await storedCount(occ)).toBe(2);
  });

  it('stays live while a claim is still held on an occurrence whose end Zoom recorded, until its final push', async () => {
    const occ = 'st-zoom-final';
    const bot = await meetingWithPush(occ, '966000016');
    await endClaim(bot.claim_id, 'abandoned', 'lease_expired');
    await zoomEnds('966000016', occ);
    // A claim held on the occurrence after the record (the only way here is by hand).
    await holdAgain(bot.bot_id, occ, '966000016', 2);
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'live' });
    expect((await pushTranscript(t, occ, bot.bot_token, { epoch: 2, segments: [segment(1)] })).statusCode).toBe(204);
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'live' });
    expect((await pushTranscript(t, occ, bot.bot_token, { epoch: 2, complete: true, segments: [] })).statusCode).toBe(204);
    expect(await stateOf(occ)).toEqual({ complete: true, occurrence_state: 'ended' });
    expect(await storedCount(occ)).toBe(2);
  });

  it('stays live while a claim is still held on an occurrence whose end a release recorded, until that claim ends', async () => {
    const occ = 'st-fence';
    const bot = await meetingWithPush(occ, '966000013');
    await endClaim(bot.claim_id, 'done', 'meeting_ended');
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'ended' });

    const again = await holdAgain(bot.bot_id, occ, '966000013', 2);
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'live' });

    await endClaim(again, 'abandoned', 'lease_expired');
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'ended' });
    expect((await pushTranscript(t, occ, bot.bot_token, { epoch: 2, segments: [segment(1)] })).statusCode).toBe(409);
    expect(await storedCount(occ)).toBe(1);
  });

  /** Ages the meeting (its start and any recorded end), and any Zoom end record for it, past 90 days and runs retention (QOR-4600, D163). */
  async function expireOld(occ: string) {
    await t.pool.query(
      `UPDATE meetings SET started_at = started_at - interval '100 days', ended_at = ended_at - interval '100 days' WHERE occurrence_uuid = $1`,
      [occ],
    );
    const owner = await t.db.connect('owner'); // the runtime role cannot update Zoom's records
    try {
      await owner.query(`UPDATE bwat.zoom_ended_occurrences SET ended_at = now() - interval '100 days' WHERE occurrence_uuid = $1`, [occ]);
    } finally {
      await owner.end();
    }
    expect(await runRetention(t.pool, 90)).toMatchObject({ transcripts_expired: 1 });
  }

  it('is ended once retention expires a transcript that was never finalized (QOR-4600)', async () => {
    const occ = 'st-expired';
    const bot = await meetingWithPush(occ, '966000017');
    await endClaim(bot.claim_id, 'abandoned', 'lease_expired');
    expect((await stateOf(occ)).occurrence_state).toBe('abandoned');
    await expireOld(occ);
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'ended' });
    // A pending claim (no occurrence yet) for the number does not make it live again.
    await t.pool.query(`UPDATE bots SET ready_at = NULL`);
    expect((await postAllocation(t, { zoom_url: 'https://zoom.us/j/966000017' })).statusCode).toBeLessThan(300);
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'ended' });
  });

  it('stays ended once retention expires the transcript and prunes the Zoom end record that ended it (QOR-4600)', async () => {
    const occ = 'st-expired-zoom';
    const bot = await meetingWithPush(occ, '966000018');
    await endClaim(bot.claim_id, 'abandoned', 'lease_expired');
    await zoomEnds('966000018', occ);
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'ended' });
    await expireOld(occ);
    expect((await t.pool.query(`SELECT 1 FROM zoom_ended_occurrences WHERE occurrence_uuid = $1`, [occ])).rowCount).toBe(0);
    expect(await stateOf(occ)).toEqual({ complete: false, occurrence_state: 'ended' });
  });

  it('goes from abandoned to ended: a new holder, then its final push', async () => {
    const occ = 'st-abandoned-ended';
    const bot = await meetingWithPush(occ, '966000010');
    await endClaim(bot.claim_id, 'abandoned', 'lease_expired');
    expect((await stateOf(occ)).occurrence_state).toBe('abandoned');
    await holdAgain(bot.bot_id, occ, '966000010', 2);
    expect((await stateOf(occ)).occurrence_state).toBe('live');
    expect((await pushTranscript(t, occ, bot.bot_token, { epoch: 2, complete: true, segments: [] })).statusCode).toBe(204);
    expect(await stateOf(occ)).toEqual({ complete: true, occurrence_state: 'ended' });
  });
});
