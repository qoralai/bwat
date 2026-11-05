import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { retentionFromSettings, runRetention, startRetention } from '../src/retention.ts';
import { botPost, claimRow, postAllocation, registerBot, resetAllocations, resetAllocationsBeforeEach, type TestApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { meetingIdOf, pushTranscript, segment } from './meetings.ts';
import { ADMIN, MEMBER, useRoles } from './people.ts';

/**
 * QOR-4600, D163: when the retention period passes, only the transcript expires. The
 * meeting row and its cards stay until an admin deletes the meeting; keep forever is an
 * explicit choice the job skips; old hand-off keys are pruned with the same window.
 */

/** A bot holding a live claim on `occurrence`, epoch 1, that has pushed two segments. */
async function meetingWithTranscript(t: TestApp, occurrence: string, meetingNumber: string) {
  const bot = await registerBot(t);
  const claim = (await postAllocation(t, { zoom_url: `https://zoom.us/j/${meetingNumber}` }, MEMBER)).json();
  await t.pool.query(`UPDATE claims SET occurrence_uuid = $2, transcript_epoch = 1 WHERE id = $1`, [claim.id, occurrence]);
  const push = { epoch: 1, segments: [segment(0), segment(1, { source: 'chat' })] };
  expect((await pushTranscript(t, occurrence, bot.bot_token, push)).statusCode).toBe(204);
  return { bot, claimId: claim.id as string, push, meetingId: await meetingIdOf(t, occurrence) };
}

const endClaim = (t: TestApp, id: string) =>
  t.pool.query(`UPDATE claims SET state = 'abandoned', refused_reason = 'recalled', ended_at = now(), lease_until = NULL WHERE id = $1`, [id]);
const revive = (t: TestApp, id: string) =>
  t.pool.query(
    `UPDATE claims SET state = 'claimed', refused_reason = NULL, ended_at = NULL, lease_until = now() + interval '90 seconds' WHERE id = $1`,
    [id],
  );
const backdate = (t: TestApp, meetingId: string, days = 100) =>
  t.pool.query(`UPDATE meetings SET started_at = now() - make_interval(days => $2) WHERE id = $1`, [meetingId, days]);

/** An old meeting with a transcript and a card, its bot gone: what retention takes the transcript of. */
async function oldMeeting(t: TestApp, occurrence: string, meetingNumber: string) {
  const m = await meetingWithTranscript(t, occurrence, meetingNumber);
  await endClaim(t, m.claimId);
  await backdate(t, m.meetingId);
  const cards = await t.db.connect('cards');
  try {
    await cards.query(`INSERT INTO cards.cards (meeting_id, kind, display_number, title) VALUES ($1, 'risk', nextval('cards.risk_numbers'), 'r')`, [
      m.meetingId,
    ]);
  } finally {
    await cards.end();
  }
  return m;
}

const segmentCount = async (t: TestApp, meetingId: string) =>
  (await t.pool.query(`SELECT count(*)::int AS n FROM transcript_segments WHERE meeting_id = $1`, [meetingId])).rows[0].n as number;
const meetingRow = async (t: TestApp, meetingId: string) =>
  (await t.pool.query(`SELECT id, transcript_expired_at FROM meetings WHERE id = $1`, [meetingId])).rows[0] as
    | { id: string; transcript_expired_at: Date | null }
    | undefined;
/** The meeting's cards, read as the owner: the runtime role holds nothing on cards.*. */
async function cardCount(t: TestApp, meetingId: string): Promise<number> {
  const owner = await t.db.connect('owner');
  try {
    return (await owner.query(`SELECT count(*)::int AS n FROM cards.cards WHERE meeting_id = $1`, [meetingId])).rows[0].n;
  } finally {
    await owner.end();
  }
}
/** Hand-off keys `days` old for the owner, named by their request_key. */
async function handoffsAged(t: TestApp, ...ages: number[]) {
  await t.pool.query(`DELETE FROM handoffs`);
  for (const age of ages) {
    await t.pool.query(
      `INSERT INTO handoffs (sender_member_id, request_key, created_at)
       SELECT id, $1, now() - make_interval(days => $2::int) FROM members WHERE email = 'owner@test.invalid'`,
      [`key-${age}`, age],
    );
  }
}
const handoffKeys = async (t: TestApp) => (await t.pool.query(`SELECT request_key FROM handoffs ORDER BY request_key`)).rows.map((r) => r.request_key);

describeDb('retention expires the transcript only (QOR-4600, D163)', () => {
  const t = useRoles();
  resetAllocationsBeforeEach(t);

  it('keeps an old meeting and its cards, deletes its segments, and marks it expired', async () => {
    const { meetingId } = await oldMeeting(t, 'expire-keeps-row', '966000101');
    expect(await runRetention(t.pool, 90)).toMatchObject({ transcripts_expired: 1 });
    expect(await segmentCount(t, meetingId)).toBe(0);
    expect((await meetingRow(t, meetingId))?.transcript_expired_at).toBeInstanceOf(Date);
    expect(await cardCount(t, meetingId)).toBe(1);
  });

  // QOR-5023: the text download answers an expired transcript as the read above does: no lines,
  // and when it expired.
  it('answers the text download 200 with no lines and when the transcript expired', async () => {
    const { meetingId } = await oldMeeting(t, 'expire-download', '966000109');
    await runRetention(t.pool, 90);
    const res = await t.app.inject({ method: 'GET', url: `/meetings/${meetingId}/transcript.txt`, headers: MEMBER });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    const { transcript_expired_at } = (await meetingRow(t, meetingId))!;
    expect(res.headers['x-transcript-expired-at']).toBe(transcript_expired_at!.toISOString());
  });

  it('answers the transcript read 200 with no segments and transcript_expired, and lists the meeting as expired', async () => {
    const { meetingId } = await oldMeeting(t, 'expire-read', '966000102');
    await runRetention(t.pool, 90);
    const res = await t.app.inject({ method: 'GET', url: `/meetings/${meetingId}/transcript`, headers: MEMBER });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ meeting_id: meetingId, transcript_expired: true, segments: [], next_cursor: null, occurrence_state: 'ended' });
    expect(Date.parse(body.transcript_expired_at)).not.toBeNaN();
    const list = (await t.app.inject({ method: 'GET', url: '/meetings?limit=100', headers: MEMBER })).json();
    const entry = list.meetings.find((m: { id: string }) => m.id === meetingId);
    expect(entry).toMatchObject({ transcript_available: false, transcript_expired: true });
    expect(entry.transcript_expired_at).toBe(body.transcript_expired_at);
  });

  it('reads the state and the page from one snapshot: an expiry committed between them shows in neither', async () => {
    const { meetingId } = await oldMeeting(t, 'expire-between', '966000110');
    // Retention commits after the meeting's state is read and before its page is (the one
    // query ordered by epoch, seq); pool.query runs through Client.query too.
    const query = pg.Client.prototype.query as (...args: unknown[]) => unknown;
    let fired = false;
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
      if (fired || !text?.includes('ORDER BY s.epoch, s.seq')) return query.apply(this, args);
      fired = true;
      return runRetention(t.pool, 90).then(() => query.apply(this, args)) as never;
    } as never);
    try {
      const body = (await t.app.inject({ method: 'GET', url: `/meetings/${meetingId}/transcript`, headers: MEMBER })).json();
      expect(fired).toBe(true);
      expect(await segmentCount(t, meetingId)).toBe(0);
      expect(body).toMatchObject({ transcript_expired: false, occurrence_state: 'abandoned' });
      expect(body.segments).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('reads a transcript not expired as transcript_expired false, transcript_expired_at null', async () => {
    const { meetingId, claimId } = await meetingWithTranscript(t, 'expire-not-yet', '966000103');
    const body = (await t.app.inject({ method: 'GET', url: `/meetings/${meetingId}/transcript`, headers: MEMBER })).json();
    expect(body).toMatchObject({ transcript_expired: false, transcript_expired_at: null });
    expect(body.segments).toHaveLength(2);
    await endClaim(t, claimId);
  });

  it('refuses a push after expiry 409 transcript_expired, storing nothing, even an empty one under a live claim', async () => {
    const { meetingId, claimId, bot, push } = await oldMeeting(t, 'expire-push', '966000104');
    await runRetention(t.pool, 90);
    // Nothing reopens an expired occurrence; stand in for a claim that somehow did.
    await revive(t, claimId);
    for (const payload of [push, { epoch: 1, segments: [] }, { epoch: 1, complete: true, segments: [] }]) {
      const res = await pushTranscript(t, 'expire-push', bot.bot_token, payload);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'transcript_expired' });
    }
    expect(await segmentCount(t, meetingId)).toBe(0);
    await endClaim(t, claimId);
  });

  it("a new occurrence of an expired meeting's number is sent, promoted and records: expiry ends only its own occurrence", async () => {
    const { bot } = await oldMeeting(t, 'expire-recurring-old', '966000109');
    await runRetention(t.pool, 90);
    const claimId = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/966000109' }, MEMBER)).json().id as string;
    expect((await claimRow(t, claimId)).bot_id).toBe(bot.bot_id);
    const next = 'expire-recurring-new';
    const promoted = await botPost(t, '/assignment/occurrence', bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: next });
    expect(promoted.statusCode).toBe(200);
    const beat = await botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 1 });
    expect(beat.statusCode).toBe(200);
    expect((await pushTranscript(t, next, bot.bot_token, { epoch: 1, segments: [segment(0)] })).statusCode).toBe(204);
    const meetingId = await meetingIdOf(t, next);
    expect(await segmentCount(t, meetingId)).toBe(1);
    // Its own end is not recorded: a claim ended without one leaves it abandoned, not ended.
    await endClaim(t, claimId);
    const read = (await t.app.inject({ method: 'GET', url: `/meetings/${meetingId}/transcript`, headers: MEMBER })).json();
    expect(read).toMatchObject({ transcript_expired: false, occurrence_state: 'abandoned' });
    expect(read.segments).toHaveLength(1);
  });

  it('leaves a meeting a claim is open for untouched', async () => {
    const { meetingId, claimId } = await meetingWithTranscript(t, 'expire-open-claim', '966000105');
    await backdate(t, meetingId);
    expect(await runRetention(t.pool, 90)).toMatchObject({ transcripts_expired: 0 });
    expect(await segmentCount(t, meetingId)).toBe(2);
    expect((await meetingRow(t, meetingId))?.transcript_expired_at).toBeNull();
    await endClaim(t, claimId);
  });

  it("an admin's delete still removes the meeting and its cards, expired or not, and its fence refuses a later push", async () => {
    for (const [occurrence, number, expire] of [
      ['delete-expired', '966000106', true],
      ['delete-fresh', '966000107', false],
    ] as const) {
      await resetAllocations(t);
      const { meetingId, claimId, bot, push } = await oldMeeting(t, occurrence, number);
      if (expire) await runRetention(t.pool, 90);
      const res = await t.app.inject({ method: 'DELETE', url: `/meetings/${meetingId}`, headers: ADMIN });
      expect(res.statusCode, occurrence).toBe(200);
      expect(await meetingRow(t, meetingId)).toBeUndefined();
      expect(await cardCount(t, meetingId)).toBe(0);
      await revive(t, claimId);
      const late = await pushTranscript(t, occurrence, bot.bot_token, push);
      expect(late.json()).toEqual({ error: 'meeting_deleted' });
      expect(await meetingRow(t, meetingId)).toBeUndefined();
      await endClaim(t, claimId);
    }
  });

  it('is idempotent: a second run expires nothing more and leaves transcript_expired_at as the first set it', async () => {
    const { meetingId } = await oldMeeting(t, 'expire-twice', '966000108');
    await handoffsAged(t, 40);
    expect(await runRetention(t.pool, 30, 1)).toMatchObject({ transcripts_expired: 1, handoffs_deleted: 1 });
    const first = (await meetingRow(t, meetingId))!.transcript_expired_at!;
    expect(await runRetention(t.pool, 30, 1)).toMatchObject({ transcripts_expired: 0, handoffs_deleted: 0 });
    expect((await meetingRow(t, meetingId))!.transcript_expired_at!.getTime()).toBe(first.getTime());
  });
});

describeDb('retention prunes old hand-off keys (QOR-4600)', () => {
  const t = useRoles();

  it('deletes hand-off keys older than the window, in batches, and keeps younger ones', async () => {
    await handoffsAged(t, 40, 41, 42, 5);
    expect(await runRetention(t.pool, 30, 2)).toMatchObject({ handoffs_deleted: 3 });
    expect(await handoffKeys(t)).toEqual(['key-5']);
  });
});

describeDb('keep forever (QOR-4600)', () => {
  const t = useRoles();
  resetAllocationsBeforeEach(t);
  let stop: (() => Promise<void>) | undefined;
  afterEach(() => stop?.());
  const settingsView = async () => (await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER })).json().settings;
  const save = async (changes: Record<string, unknown>) => {
    const settings = await settingsView();
    const body = Object.fromEntries(
      Object.entries(changes).map(([key, value]) => [key, { value, expectedRevision: settings[key].revision }]),
    );
    return t.app.inject({ method: 'PUT', url: '/console/settings/retention', headers: ADMIN, payload: { changes: body } });
  };

  it('is a retention setting, on by default (QOR-4760); days stay from 1 and keep forever takes only a boolean', async () => {
    const settings = await settingsView();
    expect(settings.transcript_keep_forever).toMatchObject({ default: true });
    expect(settings.transcript_retention_days).toMatchObject({ default: 90 });
    expect((await save({ transcript_retention_days: 0 })).statusCode).toBe(400);
    expect((await save({ transcript_keep_forever: 'yes' })).statusCode).toBe(400);
    expect((await save({ transcript_keep_forever: 0 })).statusCode).toBe(400);
    expect(await retentionFromSettings(t.pool).keepForever()).toBe(true);
  });

  it('when on, keeps the content but still scrubs ended claims’ passcodes and prunes Zoom’s records (D168); off, everything runs', async () => {
    const { meetingId } = await oldMeeting(t, 'keep-forever', '966000201');
    await handoffsAged(t, 40);
    await t.pool.query(`DELETE FROM inbox_messages`);
    await t.pool.query(
      `INSERT INTO inbox_messages (recipient_member_id, sender_member_id, handoff_id, target_client_session, source_kind, source_id, subject, body, created_at)
       SELECT id, id, gen_random_uuid(), 'session-1', 'card', gen_random_uuid(), 's', 'b', now() - interval '40 days'
         FROM members WHERE email = 'owner@test.invalid'`,
    );
    await t.pool.query(`DELETE FROM zoom_ended_occurrences`);
    await t.pool.query(
      `INSERT INTO zoom_ended_occurrences (meeting_number, occurrence_uuid, ended_at) VALUES ('966000201', 'keep-forever-zoom', now() - interval '40 days')`,
    );
    await t.pool.query(
      `INSERT INTO claims (meeting_number, state, ended_at, briefing) VALUES ('966000202', 'done', now() - interval '40 days', '{"passcode":"p"}')`,
    );
    const briefing = async () =>
      (await t.pool.query(`SELECT briefing FROM claims WHERE meeting_number = '966000202'`)).rows[0]!.briefing;
    expect((await save({ transcript_keep_forever: true, transcript_retention_days: 30 })).statusCode).toBe(200);
    expect(await retentionFromSettings(t.pool).keepForever()).toBe(true);

    const events: Record<string, unknown>[] = [];
    const log = { info: (o: object) => void events.push(o as Record<string, unknown>), error: (o: object) => void events.push(o as Record<string, unknown>) };
    stop = startRetention(t.pool, retentionFromSettings(t.pool), log, 60_000);
    await expect.poll(() => events.length, { timeout: 3000 }).toBe(1);
    await stop();
    expect(events[0]).toEqual({ event: 'retention.ran', days: 30, keep_forever: true, claims_scrubbed: 1, ended_occurrences_deleted: 1 });
    // The content stays: the transcript, the inbox brief and the hand-off key.
    expect(await segmentCount(t, meetingId)).toBe(2);
    expect((await meetingRow(t, meetingId))?.transcript_expired_at).toBeNull();
    expect(await handoffKeys(t)).toEqual(['key-40']);
    expect((await t.pool.query(`SELECT 1 FROM inbox_messages`)).rows).toHaveLength(1);
    // The passcode and Zoom's record go on the window whatever keep forever says.
    expect(await briefing()).toEqual({});
    expect((await t.pool.query(`SELECT 1 FROM zoom_ended_occurrences`)).rows).toHaveLength(0);

    expect((await save({ transcript_keep_forever: false })).statusCode).toBe(200);
    events.length = 0;
    stop = startRetention(t.pool, retentionFromSettings(t.pool), log, 60_000);
    await expect.poll(() => events.length, { timeout: 3000 }).toBe(1);
    expect(events[0]).toMatchObject({
      event: 'retention.ran',
      days: 30,
      keep_forever: false,
      transcripts_expired: 1,
      inbox_messages_deleted: 1,
      handoffs_deleted: 1,
    });
    expect(await segmentCount(t, meetingId)).toBe(0);
    expect((await t.pool.query(`SELECT 1 FROM inbox_messages`)).rows).toHaveLength(0);
  });

  it('a stored value that is not a boolean is ignored: the default, keep forever, applies', async () => {
    await t.pool.query(
      `INSERT INTO settings (key, value, revision) VALUES ('transcript_keep_forever', '"yes"'::jsonb, 1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    expect(await retentionFromSettings(t.pool).keepForever()).toBe(true);
    await t.pool.query(`UPDATE settings SET value = 'null'::jsonb WHERE key = 'transcript_keep_forever'`);
  });
});
