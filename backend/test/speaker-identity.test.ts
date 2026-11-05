import { expect, it } from 'vitest';
import { PERSON, registerBot, resetAllocations, resetAllocationsBeforeEach, signedIn } from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting, meetingIdOf, pushTranscript, segment } from './meetings.ts';
import { autoJoined, deliver, storedSwitch, useAutoJoinApp, useZoomApp, zoomEvent } from './zoom.ts';
import { deleteMeeting } from '../src/meetings.ts';
import { inviteOccurrence } from '../src/claims.ts';
import { runRetention } from '../src/retention.ts';
import { recordZoomSpeaker } from '../src/zoom-speakers.ts';

describeDb('verified Zoom speakers', () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: { autoJoin: false, requireHost: false } });
  resetAllocationsBeforeEach(t);
  const member = '00000000-0000-4000-8000-0000000000a1';
  const arrival = (occurrence: string, node: string, account: string) => zoomEvent('meeting.participant_joined', {
    id: '911222350', uuid: occurrence,
    participant: { user_id: node, participant_user_id: account, user_name: 'Misleading name' },
  });
  const link = () => t.pool.query(`INSERT INTO members (id, email, role, zoom_user_id, activated_at)
    VALUES ($1, 'ada@test.invalid', 'member', 'zoom-ada', now())
    ON CONFLICT (id) DO UPDATE SET activated_at = now()`, [member]);

  it('maps signed arrivals even with auto-join off and returns the stored identity on retries', async () => {
    await link();
    const occurrence = 'speaker-known';
    const bot = await botInMeeting(t, occurrence, '911222350');
    const event = arrival(occurrence, '16778240', 'zoom-ada');
    expect((await deliver(t, event, { signature: null })).statusCode).toBe(401);
    const push = (over = {}) => pushTranscript(t, occurrence, bot.bot_token, {
      epoch: 1, return_segments: true, segments: [segment(0, { speaker_zoom_id: '16778240', ...over })],
    });
    const first = await push();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().segments[0].speaker_member_id).toBeNull();
    expect((await deliver(t, event)).statusCode).toBe(200);
    await deliver(t, event);
    const retry = await push({ speaker_zoom_id: '99', text: 'changed' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().segments[0]).toMatchObject({ speaker_member_id: member, speaker_zoom_id: '16778240', text: 'segment 0' });
    const read = await t.app.inject({ method: 'GET', url: `/meetings/${await meetingIdOf(t, occurrence)}/transcript`, headers: PERSON });
    expect(read.json().segments[0].speaker).toEqual({ label: 'Ada Lovelace', member_id: member, zoom_id: '16778240' });
  });

  it('handles new rejoin IDs, isolates occurrences, and refuses guessed or conflicting identities', async () => {
    await link();
    const occurrence = 'speaker-isolation';
    const bot = await botInMeeting(t, occurrence, '911222350');
    await deliver(t, arrival('unattended', '10', 'zoom-ada'));
    expect((await t.pool.query(`SELECT 1 FROM zoom_speakers WHERE occurrence_uuid = 'unattended'`)).rowCount).toBe(0);
    await t.pool.query(`INSERT INTO meetings (occurrence_uuid, meeting_number) VALUES ('another-occurrence', '911222350')`);
    await deliver(t, arrival('another-occurrence', '10', 'zoom-ada'));
    await deliver(t, arrival(occurrence, '11', 'zoom-ada'));
    await deliver(t, arrival(occurrence, '12', 'zoom-ada'));
    await deliver(t, arrival(occurrence, '13', 'zoom-ada'));
    await deliver(t, arrival(occurrence, '13', 'other-account'));
    await deliver(t, arrival(occurrence, '13', 'zoom-ada')); // replay cannot undo ambiguity
    await deliver(t, arrival(occurrence, '14', '')); // guest, even if their name matches
    const res = await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, return_segments: true,
      segments: ['10', '11', '12', '13', '14'].map((id, seq) => segment(seq, { speaker_zoom_id: id, speaker_member_id: member })) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().segments.map((s: { speaker_member_id: string | null }) => s.speaker_member_id)).toEqual([null, member, member, null, null]);
    await t.pool.query(`UPDATE members SET activated_at = NULL WHERE id = $1`, [member]);
    const inactive = await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, return_segments: true,
      segments: [segment(5, { speaker_zoom_id: '11' })] });
    expect(inactive.json().segments[0].speaker_member_id).toBeNull();
  });

  it("never lets a client-supplied participant id change a mapping, but a later join event still conflicts it", async () => {
    const occurrence = 'speaker-client';
    await botInMeeting(t, occurrence, '911222350');
    const row = async () => (await t.pool.query(
      `SELECT zoom_user_id, conflicted FROM zoom_speakers WHERE occurrence_uuid = $1 AND speaker_zoom_id = '7'`, [occurrence])).rows;
    await deliver(t, arrival(occurrence, '7', 'zoom-ada'));
    await recordZoomSpeaker(t.pool, '911222350', occurrence, { user_id: '7', participant_user_id: 'zoom-mallory' }, { clientSupplied: true });
    expect(await row()).toEqual([{ zoom_user_id: 'zoom-ada', conflicted: false }]);
    await t.pool.query(`DELETE FROM zoom_speakers WHERE occurrence_uuid = $1`, [occurrence]);
    await recordZoomSpeaker(t.pool, '911222350', occurrence, { user_id: '7', participant_user_id: 'zoom-mallory' }, { clientSupplied: true });
    await deliver(t, arrival(occurrence, '7', 'zoom-ada'));
    expect(await row()).toEqual([{ zoom_user_id: 'zoom-mallory', conflicted: true }]);
  });

  it('deletion and retention remove the mapping and late arrivals cannot restore it', async () => {
    for (const expire of [false, true]) {
      await resetAllocations(t);
      const occurrence = `speaker-erased-${expire}`;
      const bot = await botInMeeting(t, occurrence, '911222350');
      const event = arrival(occurrence, '42', 'zoom-ada');
      await deliver(t, event);
      await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0, { speaker_zoom_id: '42' })] });
      await t.pool.query(`UPDATE claims SET state = 'done', ended_at = now() WHERE id = $1`, [bot.claim_id]);
      const id = await meetingIdOf(t, occurrence);
      if (expire) {
        await t.pool.query(`UPDATE meetings SET started_at = now() - interval '100 days' WHERE id = $1`, [id]);
        await runRetention(t.pool, 90);
      } else {
        expect(await deleteMeeting(t.pool, id, null)).toBeTruthy();
      }
      await deliver(t, event);
      expect((await t.pool.query('SELECT 1 FROM zoom_speakers WHERE occurrence_uuid = $1', [occurrence])).rowCount).toBe(0);
    }
  });
});

describeDb('host arrival speaker after auto-join lookup', () => {
  const t = useAutoJoinApp({ zoom: { autoJoin: true, requireHost: true } });
  it('keeps the host identity once the readiness check opens the claim', async () => {
    await registerBot(t);
    storedSwitch(t).value = true;
    const event = zoomEvent('meeting.participant_joined', { id: '911222351', uuid: 'host-trigger', host_id: 'zoom-host',
      participant: { user_id: '42', participant_user_id: 'zoom-host' } });
    expect(await autoJoined(t, event)).toBe('claim_opened');
    expect((await t.pool.query(`SELECT speaker_zoom_id, zoom_user_id FROM zoom_speakers WHERE occurrence_uuid = 'host-trigger'`)).rows)
      .toEqual([{ speaker_zoom_id: '42', zoom_user_id: 'zoom-host' }]);
  });
});

describeDb('arrivals before the host while auto-join waits for them', () => {
  const t = useAutoJoinApp({ zoom: { autoJoin: true, requireHost: true }, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);
  const joined = (occurrence: string, node: string, account: string) => zoomEvent('meeting.participant_joined', {
    id: '911222352', uuid: occurrence, host_id: 'zoom-host', start_time: new Date().toISOString(),
    participant: { user_id: node, participant_user_id: account } });
  const speakers = async (occurrence: string) => (await t.pool.query(
    `SELECT speaker_zoom_id, zoom_user_id FROM zoom_speakers WHERE occurrence_uuid = $1 ORDER BY speaker_zoom_id`, [occurrence])).rows;

  it('keeps an early arrival and the host both once the host opens the claim', async () => {
    await registerBot(t);
    storedSwitch(t).value = true;
    expect((await deliver(t, joined('early', '41', 'zoom-early'))).json()).toEqual({ status: 'not_host' });
    expect(await autoJoined(t, joined('early', '42', 'zoom-host'))).toBe('claim_opened');
    expect(await speakers('early')).toEqual([
      { speaker_zoom_id: '41', zoom_user_id: 'zoom-early' }, { speaker_zoom_id: '42', zoom_user_id: 'zoom-host' }]);
  });

  it('keeps nothing while the stored switch is off', async () => {
    storedSwitch(t).value = false;
    expect((await deliver(t, joined('switched-off', '41', 'zoom-early'))).json()).toEqual({ status: 'not_host' });
    expect(await speakers('switched-off')).toEqual([]);
  });

  it('forgets early arrivals when the meeting ends without bwat, and after a day without a claim', async () => {
    await registerBot(t);
    storedSwitch(t).value = true;
    await deliver(t, joined('never-claimed', '41', 'zoom-early'));
    expect(await speakers('never-claimed')).toHaveLength(1);
    await deliver(t, zoomEvent('meeting.ended', { id: '911222352', uuid: 'never-claimed' }));
    expect(await speakers('never-claimed')).toEqual([]);

    await deliver(t, joined('missed-end', '41', 'zoom-early'));
    await deliver(t, joined('claimed-late', '41', 'zoom-early'));
    expect(await autoJoined(t, joined('claimed-late', '42', 'zoom-host'))).toBe('claim_opened');
    expect(await speakers('claimed-late')).toHaveLength(2);
    await t.pool.query(`UPDATE zoom_speakers SET received_at = now() - interval '25 hours' WHERE occurrence_uuid IN ('missed-end', 'claimed-late')`);
    await runRetention(t.pool, 90);
    expect(await speakers('missed-end')).toEqual([]);
    expect(await speakers('claimed-late')).toHaveLength(2);
    await deliver(t, zoomEvent('meeting.ended', { id: '911222352', uuid: 'claimed-late' }));
    expect(await speakers('claimed-late')).toHaveLength(2);
  });
});

describeDb('meeting.ended when forgetting early arrivals fails', () => {
  const t = useZoomApp({ zoom: { autoJoin: false, requireHost: false } });
  resetAllocationsBeforeEach(t);
  it('still releases the claim and answers', async () => {
    await inviteOccurrence(t.pool, { meetingNumber: '911222353', occurrenceUuid: 'cleanup-fails', briefing: {} });
    const owner = await t.db.connect('owner');
    try {
      await owner.query(`CREATE FUNCTION bwat.refuse_forget() RETURNS trigger LANGUAGE plpgsql AS $$
                           BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = '57014'; END $$`);
      await owner.query(`CREATE TRIGGER refuse_forget BEFORE DELETE ON bwat.zoom_speakers
                           FOR EACH STATEMENT EXECUTE FUNCTION bwat.refuse_forget()`);
      const res = await deliver(t, zoomEvent('meeting.ended', { id: '911222353', uuid: 'cleanup-fails' }));
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('released');
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS refuse_forget ON bwat.zoom_speakers`);
      await owner.query(`DROP FUNCTION IF EXISTS bwat.refuse_forget()`);
      await owner.end();
    }
  });
});
