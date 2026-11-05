import { expect, it } from 'vitest';
import { issueFleetCredential } from '../src/credentials.ts';
import { deleteMeeting } from '../src/meetings.ts';
import {
  botPost,
  PERSON,
  heldClaim,
  lapsingLease,
  occurrenceUuid,
  raceBehindLock,
  registerBot,
  resetAllocationsBeforeEach,
  untilLapsed,
  useApp,
} from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting, meetingIdOf, pushTranscript, segment, withSlowSegmentInserts } from './meetings.ts';

describeDb('POST /meetings/{occurrenceId}/transcript (QOR-4577)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  it('preserves original wording and dictionary version alongside corrected text, including on retry', async () => {
    const occurrence = 'dictionary-correction';
    const bot = await botInMeeting(t, occurrence, '911222350');
    const corrected = { ...segment(0), text: 'Bwat is ready', original_text: 'Boat is ready',
      original_speaker_label: 'Ada', dictionary_version: '2026-10-06.1' };
    expect((await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [corrected] })).statusCode).toBe(204);
    await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [{ ...corrected, original_text: 'changed' }] });
    const rows = (await t.pool.query(`SELECT text, original_text, original_speaker_label, dictionary_version
      FROM transcript_segments WHERE meeting_id = $1`, [await meetingIdOf(t, occurrence)])).rows;
    expect(rows).toEqual([{ text: 'Bwat is ready', original_text: 'Boat is ready', original_speaker_label: 'Ada', dictionary_version: '2026-10-06.1' }]);
    const read = await t.app.inject({ method: 'GET', url: `/meetings/${await meetingIdOf(t, occurrence)}/transcript`, headers: PERSON });
    expect(read.json().segments[0]).toMatchObject(rows[0]);
  });

  const stored = async (occurrence: string) =>
    (
      await t.pool.query(
        `SELECT s.epoch, s.seq, s.speaker_label, s.speaker_member_id, s.text, s.start_ms, s.end_ms, s.source
           FROM transcript_segments s JOIN meetings m ON m.id = s.meeting_id
          WHERE m.occurrence_uuid = $1 ORDER BY s.epoch, s.seq`,
        [occurrence],
      )
    ).rows;

  it('refuses a caller with no credential, an unknown one, or a fleet credential', async () => {
    const body = { epoch: 1, segments: [segment(0)] };
    const anon = await t.app.inject({ method: 'POST', url: '/meetings/occ-x/transcript', payload: body });
    expect(anon.statusCode).toBe(401);
    expect((await pushTranscript(t, 'occ-x', `bwb_${'A'.repeat(43)}`, body)).statusCode).toBe(401);
    const fleet = await pushTranscript(t, 'occ-x', await issueFleetCredential(t.pool), body);
    expect(fleet.statusCode).toBe(409);
    expect(fleet.json()).toEqual({ error: 'unregistered_bot' });
  });

  it("stores the epoch owner's segments and opens the meeting from its claim", async () => {
    const occurrence = 'aB3/xY+9qQ==';
    const bot = await botInMeeting(t, occurrence, '911222333', 3);
    const member = '00000000-0000-4000-8000-0000000000a1';
    const res = await pushTranscript(t, occurrence, bot.bot_token, {
      epoch: 3,
      segments: [segment(0, { speaker_member_id: member }), segment(1, { speaker_label: 'Speaker 2' })],
    });
    expect(res.statusCode).toBe(204);
    expect(await stored(occurrence)).toEqual([
      { epoch: 3, seq: 0, speaker_label: 'Ada Lovelace', speaker_member_id: member, text: 'segment 0', start_ms: 0, end_ms: 900, source: 'asr' },
      { epoch: 3, seq: 1, speaker_label: 'Speaker 2', speaker_member_id: null, text: 'segment 1', start_ms: 1000, end_ms: 1900, source: 'asr' },
    ]);
    const meeting = (await t.pool.query(`SELECT * FROM meetings WHERE occurrence_uuid = $1`, [occurrence])).rows[0];
    expect(meeting).toMatchObject({ meeting_number: '911222333', finalization: 'open', ended_at: null });
  });

  it("stores chat lines alongside asr in the epoch's one seq space, asr by default", async () => {
    const occurrence = 'chat-occ';
    const bot = await botInMeeting(t, occurrence, '911222342');
    const res = await pushTranscript(t, occurrence, bot.bot_token, {
      epoch: 1,
      segments: [segment(0), segment(1, { source: 'chat', text: 'link in chat', start_ms: 1500, end_ms: 1500 }), segment(2, { source: 'asr' })],
    });
    expect(res.statusCode).toBe(204);
    // A chat line reusing a seq already taken by speech is a retry of that seq: nothing new.
    await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0, { source: 'chat', text: 'clash' })] });
    expect((await stored(occurrence)).map((s) => [s.seq, s.source, s.text, s.start_ms, s.end_ms])).toEqual([
      [0, 'asr', 'segment 0', 0, 900],
      [1, 'chat', 'link in chat', 1500, 1500],
      [2, 'asr', 'segment 2', 2000, 2900],
    ]);
  });

  it('is idempotent by seq: a repeated push stores nothing new and keeps the first text', async () => {
    const occurrence = 'idem-occ';
    const bot = await botInMeeting(t, occurrence, '911222334');
    expect((await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0), segment(1)] })).statusCode).toBe(204);
    const again = await pushTranscript(t, occurrence, bot.bot_token, {
      epoch: 1,
      segments: [segment(1, { text: 'changed' }), segment(2)],
    });
    expect(again.statusCode).toBe(204);
    expect((await stored(occurrence)).map((s) => s.text)).toEqual(['segment 0', 'segment 1', 'segment 2']);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM meetings WHERE occurrence_uuid = $1`, [occurrence])).rows[0].n).toBe(1);
  });

  it('stores a re-pushed segment that is missing, whatever erased_segments holds (QOR-4616)', async () => {
    const occurrence = 'repush-occ';
    const bot = await botInMeeting(t, occurrence, '911222343');
    expect((await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0), segment(1)] })).statusCode).toBe(204);
    const meetingId = await meetingIdOf(t, occurrence);
    // A record left by the removed per-person erasure no longer keeps a segment out.
    await t.pool.query(`DELETE FROM transcript_segments WHERE meeting_id = $1 AND seq = 1`, [meetingId]);
    await t.pool.query(`INSERT INTO erased_segments (meeting_id, epoch, seq) VALUES ($1, 1, 1)`, [meetingId]);
    expect((await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(1)] })).statusCode).toBe(204);
    expect((await stored(occurrence)).map((s) => s.text)).toEqual(['segment 0', 'segment 1']);
  });

  it('refuses a missing segment once the transcript is complete, whatever erased_segments holds (QOR-4616)', async () => {
    const occurrence = 'repush-complete-occ';
    const bot = await botInMeeting(t, occurrence, '911222344');
    const final = { epoch: 1, complete: true, segments: [segment(0), segment(1)] };
    expect((await pushTranscript(t, occurrence, bot.bot_token, final)).statusCode).toBe(204);
    const meetingId = await meetingIdOf(t, occurrence);
    await t.pool.query(`DELETE FROM transcript_segments WHERE meeting_id = $1 AND seq = 1`, [meetingId]);
    await t.pool.query(`INSERT INTO erased_segments (meeting_id, epoch, seq) VALUES ($1, 1, 1)`, [meetingId]);
    const retry = await pushTranscript(t, occurrence, bot.bot_token, final);
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toEqual({ error: 'transcript_complete' });
    expect((await stored(occurrence)).map((s) => s.text)).toEqual(['segment 0']);
  });

  it('refuses a stale epoch with 409 and stores nothing', async () => {
    const occurrence = 'stale-occ';
    const bot = await botInMeeting(t, occurrence, '911222335', 2);
    for (const epoch of [1, 3]) {
      const res = await pushTranscript(t, occurrence, bot.bot_token, { epoch, segments: [segment(0)] });
      expect(res.statusCode, `epoch ${epoch}`).toBe(409);
      expect(res.json()).toEqual({ error: 'stale_epoch' });
    }
    expect(await stored(occurrence)).toEqual([]);
  });

  it('refuses a bot that holds no live claim on this occurrence', async () => {
    const occurrence = 'owned-occ';
    await botInMeeting(t, occurrence, '911222336');
    const idle = await registerBot(t);
    const res = await pushTranscript(t, occurrence, idle.bot_token, { epoch: 1, segments: [segment(0)] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_epoch' });
    expect(await stored(occurrence)).toEqual([]);
  });

  it("refuses a bot whose claim on the occurrence has ended", async () => {
    const occurrence = 'ended-occ';
    const bot = await botInMeeting(t, occurrence, '911222337');
    await t.pool.query(`UPDATE claims SET state = 'done', ended_at = now() WHERE id = $1`, [bot.claim_id]);
    const res = await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] });
    expect(res.statusCode).toBe(409);
    expect(await stored(occurrence)).toEqual([]);
  });

  it('refuses a push once the lease has lapsed, before the sweep retires the claim', async () => {
    const occurrence = 'lapsed-occ';
    const bot = await botInMeeting(t, occurrence, '911222345');
    await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE id = $1`, [bot.claim_id]);
    const res = await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_epoch' });
    expect(await stored(occurrence)).toEqual([]);
  });

  it('admits the epoch a real bot holds: promoted to the occurrence and declared on its heartbeat', async () => {
    const { bot, claimId } = await heldClaim(t, '911222346');
    const occurrence = occurrenceUuid();
    const ref = { claim_id: claimId, generation: 1 };
    expect((await botPost(t, '/assignment/occurrence', bot.bot_token, { ...ref, occurrence_uuid: occurrence })).statusCode).toBe(200);
    expect((await botPost(t, '/assignment/heartbeat', bot.bot_token, { ...ref, transcript_epoch: 4 })).statusCode).toBe(200);
    expect((await pushTranscript(t, occurrence, bot.bot_token, { epoch: 4, segments: [segment(0)] })).statusCode).toBe(204);
    const old = await pushTranscript(t, occurrence, bot.bot_token, { epoch: 3, segments: [segment(1)] });
    expect(old.json()).toEqual({ error: 'stale_epoch' });
    expect((await stored(occurrence)).map((x) => [x.epoch, x.seq])).toEqual([[4, 0]]);
  });

  // Each race holds the claim's row lock while the push waits on it; the push is then
  // judged on the claim as the holder committed it.
  for (const [what, end] of [
    ['a release', `state = 'done', refused_reason = 'meeting_ended', meeting_ended_at = now()`],
    ['a recall', `state = 'abandoned', refused_reason = 'recalled'`],
  ] as const) {
    it(`stores nothing when ${what} commits while the push waits on the claim`, async () => {
      const occurrence = `race-end-${what.slice(2)}`;
      const bot = await botInMeeting(t, occurrence, '911222347');
      const res = await raceBehindLock(
        t,
        { sql: `UPDATE claims SET ${end}, ended_at = now(), lease_until = NULL WHERE id = $1`, params: [bot.claim_id] },
        () => pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] }),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'stale_epoch' });
      expect(await stored(occurrence)).toEqual([]);
    });
  }

  it('judges the lease when the push runs, not when it began: one that lapsed while it waited is refused', async () => {
    const occurrence = 'race-lapse-occ';
    const bot = await botInMeeting(t, occurrence, '911222348');
    // The lease is live when the push starts. An update holds the claim while it lapses,
    // so the push reads the claim again, as committed, once it gets it.
    await lapsingLease(t, bot.claim_id, 1500);
    const res = await raceBehindLock(
      t,
      { sql: `UPDATE claims SET updated_at = now() WHERE id = $1`, params: [bot.claim_id] },
      () => pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] }),
      () => untilLapsed(t, bot.claim_id),
    );
    expect(res.statusCode).toBe(409);
    expect(await stored(occurrence)).toEqual([]);
  });

  it('judges the lease after it holds the claim: one that lapsed while a lock that changed nothing held it is refused', async () => {
    const occurrence = 'race-lapse-locked-occ';
    const bot = await botInMeeting(t, occurrence, '911222349');
    // A plain row lock updates nothing, so PostgreSQL never re-reads the push's predicate
    // once it gets the row: a clock in that predicate was read before the wait.
    await lapsingLease(t, bot.claim_id, 1500);
    const res = await raceBehindLock(
      t,
      { sql: `SELECT 1 FROM claims WHERE id = $1 FOR UPDATE`, params: [bot.claim_id] },
      () => pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] }),
      () => untilLapsed(t, bot.claim_id),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_epoch' });
    expect(await stored(occurrence)).toEqual([]);
    expect((await t.pool.query(`SELECT 1 FROM meetings WHERE occurrence_uuid = $1`, [occurrence])).rows).toEqual([]);
  });

  it('marks the transcript complete on the final push', async () => {
    const occurrence = 'final-occ';
    const bot = await botInMeeting(t, occurrence, '911222338');
    await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] });
    const res = await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, complete: true, segments: [] });
    expect(res.statusCode).toBe(204);
    const meeting = (await t.pool.query(`SELECT * FROM meetings WHERE occurrence_uuid = $1`, [occurrence])).rows[0];
    expect(meeting.finalization).toBe('transcript_complete');
    expect(meeting.ended_at).toBeInstanceOf(Date);
  });

  it('refuses new segments once the transcript is complete, and still accepts a retried final push', async () => {
    const occurrence = 'after-final-occ';
    const bot = await botInMeeting(t, occurrence, '911222344');
    const final = { epoch: 1, complete: true, segments: [segment(0), segment(1)] };
    expect((await pushTranscript(t, occurrence, bot.bot_token, final)).statusCode).toBe(204);
    expect((await pushTranscript(t, occurrence, bot.bot_token, final)).statusCode).toBe(204);
    expect((await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [] })).statusCode).toBe(204);
    const late = await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(1), segment(2)] });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ error: 'transcript_complete' });
    expect((await stored(occurrence)).map((s) => s.seq)).toEqual([0, 1]);
  });

  it('waits for an epoch change in flight and then refuses the old epoch', async () => {
    const occurrence = 'race-occ';
    const bot = await botInMeeting(t, occurrence, '911222340');
    const other = await t.db.connect('runtime');
    try {
      await other.query('BEGIN');
      await other.query(`UPDATE bwat.claims SET transcript_epoch = 2 WHERE id = $1`, [bot.claim_id]);
      const push = pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await other.query('COMMIT');
      expect((await push).statusCode).toBe(409);
    } finally {
      await other.end();
    }
    expect(await stored(occurrence)).toEqual([]);
  });

  it('routes an occurrence of up to 128 characters, even when every one is URL-encoded', async () => {
    const occurrence = '/+='.repeat(43).slice(0, 128);
    const bot = await botInMeeting(t, occurrence, '911222342');
    expect((await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] })).statusCode).toBe(204);
    expect(await stored(occurrence)).toHaveLength(1);
    // One character more than any occurrence: the router refuses it before the handler.
    const tooLong = await pushTranscript(t, `${occurrence}a`, bot.bot_token, { epoch: 1, segments: [segment(1)] });
    expect(tooLong.statusCode).toBe(414);
  });

  it('refuses to delete the meeting while a push stores into it: its bot is live', async () => {
    const occurrence = 'delete-race-occ';
    const bot = await botInMeeting(t, occurrence, '911222343');
    await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] });
    const meetingId = await meetingIdOf(t, occurrence);
    await withSlowSegmentInserts(t, async () => {
      // A new seq, then a retried one (seq 0) that the delete takes first.
      const push = pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(1), segment(0)] });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const deleted = deleteMeeting(t.pool, meetingId, null);
      expect((await push).statusCode).toBe(204);
      expect(await deleted).toBe('meeting_live');
    });
    expect((await stored(occurrence)).map((x) => x.seq)).toEqual([0, 1]);
  });

  it('rejects a malformed body', async () => {
    const occurrence = 'bad-occ';
    const bot = await botInMeeting(t, occurrence, '911222339');
    for (const payload of [
      {},
      { epoch: -1, segments: [] },
      { epoch: 1, segments: [segment(0, { seq: -1 })] },
      { epoch: 1, segments: [segment(0, { end_ms: -5 })] },
      { epoch: 1, segments: [segment(1, { end_ms: 500 })] },
      { epoch: 1, segments: [segment(0, { source: 'self' })] },
      { epoch: 1, segments: [segment(0, { speaker_member_id: 'nope' })] },
      { epoch: 1, segments: [segment(0, { text: 'x'.repeat(20_001) })] },
      { epoch: 1, segments: Array.from({ length: 501 }, (_, i) => segment(i)) },
    ]) {
      const res = await pushTranscript(t, occurrence, bot.bot_token, payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
    expect(await stored(occurrence)).toEqual([]);
  });
});

describeDb('transcript push logs (QOR-4577)', () => {
  const lines: string[] = [];
  const t = useApp({
    authenticatePerson: async () => ({ id: 'p' }),
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
  });

  it('records the event, ids and counts, never the text or the speaker', async () => {
    const occurrence = 'log-occ';
    const bot = await botInMeeting(t, occurrence, '911222341');
    await pushTranscript(t, occurrence, bot.bot_token, {
      epoch: 1,
      segments: [
        segment(0, { speaker_label: 'Grace Hopper', text: 'the secret launch date' }),
        segment(1, { source: 'chat', speaker_label: 'Alan Turing', text: 'chat password hunter2' }),
      ],
    });
    await pushTranscript(t, occurrence, bot.bot_token, { epoch: 9, segments: [segment(1, { text: 'stale words' })] });
    const log = lines.join('');
    expect(log).toContain('"event":"transcript.stored"');
    expect(log).toContain('"event":"transcript.stale_epoch"');
    for (const content of ['Grace Hopper', 'Alan Turing', 'secret launch', 'hunter2', 'stale words', '911222341']) expect(log).not.toContain(content);
  });
});
