import { expect, it } from 'vitest';
import { MEETING_LOCK } from '../src/claims.ts';
import type { ZoomConfig } from '../src/config.ts';
import { deleteMeeting } from '../src/meetings.ts';
import { runRetention } from '../src/retention.ts';
import { botPost, claimRow, heldClaim, postAllocation, raceBehindLock, resetAllocationsBeforeEach, signedIn } from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting, meetingIdOf, pushTranscript, segment } from './meetings.ts';
import { deliver, storedSwitch, useZoomApp, zoomEvent } from './zoom.ts';

const ON: ZoomConfig = { autoJoin: true, requireHost: false };

/**
 * A deleted meeting's occurrence is fenced for good
 * (deleted_occurrences): no push, promotion or Zoom start opens it again. Retention no
 * longer deletes the meeting (D163, QOR-4600): it expires the transcript, and an expired
 * occurrence is closed the same way (a push is 409 transcript_expired, and it counts as
 * ended). Both take the meeting's lock, the one promotion and Zoom's start and end take,
 * and skip a meeting a claim is open for.
 */
describeDb('the deletion fence (QOR-4577)', () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);

  const meetingRows = async (occurrence: string) =>
    (await t.pool.query(`SELECT id FROM meetings WHERE occurrence_uuid = $1`, [occurrence])).rows;
  const segmentCount = async (occurrence: string) =>
    (
      await t.pool.query(
        `SELECT count(*)::int AS n FROM transcript_segments s JOIN meetings m ON m.id = s.meeting_id WHERE m.occurrence_uuid = $1`,
        [occurrence],
      )
    ).rows[0].n;
  const fenced = async (occurrence: string) =>
    (await t.pool.query(`SELECT 1 FROM deleted_occurrences WHERE occurrence_uuid = $1`, [occurrence])).rows.length === 1;
  const expired = async (occurrence: string) =>
    (await t.pool.query(`SELECT 1 FROM meetings WHERE occurrence_uuid = $1 AND transcript_expired_at IS NOT NULL`, [occurrence])).rows
      .length === 1;
  const endClaim = (id: string) =>
    t.pool.query(`UPDATE claims SET state = 'abandoned', refused_reason = 'recalled', ended_at = now(), lease_until = NULL WHERE id = $1`, [
      id,
    ]);
  /** As though a claim were live on the occurrence again: what the fence must stop on its own. */
  const revive = (id: string) =>
    t.pool.query(
      `UPDATE claims SET state = 'claimed', refused_reason = NULL, ended_at = NULL, lease_until = now() + interval '90 seconds' WHERE id = $1`,
      [id],
    );
  const backdate = (occurrence: string) =>
    t.pool.query(`UPDATE meetings SET started_at = now() - interval '100 days' WHERE occurrence_uuid = $1`, [occurrence]);
  const openClaimsOn = async (meeting: string) =>
    (await t.pool.query(`SELECT id FROM claims WHERE meeting_number = $1 AND state IN ('pending', 'claimed', 'attending')`, [meeting]))
      .rows;

  /** A meeting with one stored segment whose bot has gone: its claim ended, nothing recorded its end (abandoned). */
  async function abandonedMeeting(occurrence: string, meetingNumber: string) {
    const bot = await botInMeeting(t, occurrence, meetingNumber);
    const push = { epoch: 1, segments: [segment(0)] };
    expect((await pushTranscript(t, occurrence, bot.bot_token, push)).statusCode).toBe(204);
    await endClaim(bot.claim_id);
    await t.pool.query(`UPDATE bots SET ready_at = NULL WHERE id = $1`, [bot.bot_id]); // gone: no later send goes to it
    return { bot, push, meetingId: await meetingIdOf(t, occurrence) };
  }

  // An admin's delete removes the meeting and fences it; retention keeps the meeting and
  // expires its transcript, unfenced (D163). Either way the occurrence stays closed.
  const deleters = [
    ['an admin deletes it', async (_occurrence: string, meetingId: string) => deleteMeeting(t.pool, meetingId, null), 'meeting_deleted', 0],
    ['retention expires it', async (occurrence: string) => (await backdate(occurrence), runRetention(t.pool, 90)), 'transcript_expired', 1],
  ] as const;

  for (const [how, remove, refusal, rowsLeft] of deleters) {
    const tag = how.split(' ')[0];
    const closed = async (occurrence: string) => (refusal === 'meeting_deleted' ? fenced(occurrence) : expired(occurrence));

    it(`${how}: an exact retry under a live claim is 409 ${refusal}, storing nothing`, async () => {
      const occurrence = `fence-retry-${tag}`;
      const { bot, push, meetingId } = await abandonedMeeting(occurrence, '944555601');
      await remove(occurrence, meetingId);
      expect(await meetingRows(occurrence)).toHaveLength(rowsLeft);
      expect(await fenced(occurrence)).toBe(refusal === 'meeting_deleted');
      expect(await closed(occurrence)).toBe(true);

      // The bot's own claim ended: its retry is stale, and recreates nothing.
      const stale = await pushTranscript(t, occurrence, bot.bot_token, push);
      expect(stale.json()).toEqual({ error: 'stale_epoch' });
      // Even a live claim on the occurrence cannot reopen it.
      await revive(bot.claim_id);
      const res = await pushTranscript(t, occurrence, bot.bot_token, push);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: refusal });
      expect(await meetingRows(occurrence)).toHaveLength(rowsLeft);
      expect((await t.pool.query(`SELECT 1 FROM transcript_segments`)).rows).toEqual([]);
      await endClaim(bot.claim_id);
    });

    it(`${how}: a bot later sent to the meeting cannot be promoted onto the occurrence; its claim ends`, async () => {
      const occurrence = `fence-promote-${tag}`;
      const { meetingId } = await abandonedMeeting(occurrence, '944555602');
      await remove(occurrence, meetingId);
      const { bot, claimId } = await heldClaim(t, '944555602');
      const res = await botPost(t, '/assignment/occurrence', bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: occurrence });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'meeting_already_ended' });
      expect(await claimRow(t, claimId)).toMatchObject({ state: 'done', refused_reason: 'meeting_already_ended', occurrence_uuid: null });
    });

    it(`${how}: a late Zoom start for the occurrence opens no claim`, async () => {
      storedSwitch(t).value = true;
      const occurrence = `fence-start-${tag}`;
      // No claim ever named this occurrence (its tombstone would refuse the start on its
      // own): the meeting's only claim, for its passcode, was another occurrence's.
      await t.pool.query(
        `INSERT INTO claims (meeting_number, occurrence_uuid, state, briefing, ended_at)
         VALUES ('944555603', 'earlier-occ', 'done', '{"passcode":"p"}', now())`,
      );
      const meetingId = (
        await t.pool.query(`INSERT INTO meetings (occurrence_uuid, meeting_number) VALUES ($1, '944555603') RETURNING id`, [occurrence])
      ).rows[0].id;
      await remove(occurrence, meetingId);
      expect(await closed(occurrence)).toBe(true);
      const res = await deliver(t, zoomEvent('meeting.started', { id: 944555603, uuid: occurrence, host_id: 'h' }));
      expect(res.json()).toEqual({ status: 'already_ended' });
      expect(await openClaimsOn('944555603')).toEqual([]);
    });
  }

  it('retention skips a meeting a claim is open for, held or sent and not yet promoted, and takes it once the claim ends', async () => {
    const held = await botInMeeting(t, 'keep-held-occ', '944555604');
    expect((await pushTranscript(t, 'keep-held-occ', held.bot_token, { epoch: 1, segments: [segment(0)] })).statusCode).toBe(204);
    await abandonedMeeting('keep-pending-occ', '944555605');
    await t.pool.query(`UPDATE bots SET ready_at = NULL`); // no bot: the new send stays pending
    expect((await postAllocation(t, { zoom_url: 'https://zoom.us/j/944555605' })).statusCode).toBeLessThan(300);
    await backdate('keep-held-occ');
    await backdate('keep-pending-occ');

    await runRetention(t.pool, 90);
    for (const occurrence of ['keep-held-occ', 'keep-pending-occ']) {
      expect(await segmentCount(occurrence)).toBe(1);
      expect(await expired(occurrence)).toBe(false);
    }
    // Still live: the held claim's bot pushes on, nothing resurrected or lost.
    expect((await pushTranscript(t, 'keep-held-occ', held.bot_token, { epoch: 1, segments: [segment(1)] })).statusCode).toBe(204);
    expect(await segmentCount('keep-held-occ')).toBe(2);

    await endClaim(held.claim_id);
    await t.pool.query(`UPDATE claims SET state = 'abandoned', ended_at = now() WHERE meeting_number = '944555605' AND state = 'pending'`);
    await runRetention(t.pool, 90);
    expect(await expired('keep-held-occ')).toBe(true);
    expect(await expired('keep-pending-occ')).toBe(true);
    expect(await segmentCount('keep-held-occ')).toBe(0);
  });

  for (const [who, number, run] of [
    ['an admin delete', '944555606', (meetingId: string): Promise<unknown> => deleteMeeting(t.pool, meetingId, null)],
    ['retention', '944555607', (): Promise<unknown> => runRetention(t.pool, 90)],
  ] as const) {
    it(`${who} waits for the meeting's lock, then sees a claim opened on the occurrence under it, and deletes nothing`, async () => {
      const occurrence = `fence-race-${number}`;
      const { meetingId } = await abandonedMeeting(occurrence, number);
      await backdate(occurrence);
      // The holder is a promotion or a Zoom start: under the meeting's lock it opens a
      // claim on the occurrence, and commits once the delete waits on the lock.
      const result = await raceBehindLock(
        t,
        { sql: `SELECT pg_advisory_xact_lock($1, hashtext($2))`, params: [MEETING_LOCK, number] },
        () => run(meetingId),
        (holder) =>
          holder.query(`INSERT INTO claims (meeting_number, occurrence_uuid, briefing) VALUES ($1, $2, '{}')`, [
            number,
            occurrence,
          ]),
      );
      if (who !== 'retention') expect(result).toBe('meeting_live');
      expect(await segmentCount(occurrence)).toBe(1);
      expect(await fenced(occurrence)).toBe(false);
      expect(await expired(occurrence)).toBe(false);
    });
  }
});
