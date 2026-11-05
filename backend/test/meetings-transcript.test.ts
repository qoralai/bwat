import { beforeAll, expect, it } from 'vitest';
import { PERSON, resetAllocationsBeforeEach, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting, meetingIdOf, pushTranscript, segment } from './meetings.ts';

/** When the backend stored the segment, as ISO 8601 (QOR-4769). */
const CREATED_AT = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

describeDb('GET /meetings/{meetingId}/transcript (QOR-4577)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);
  let meetingId: string;
  const occurrence = 'read/occ+1==';

  beforeAll(async () => {
    const bot = await botInMeeting(t, occurrence, '922333444', 1);
    const member = '00000000-0000-4000-8000-0000000000b2';
    await pushTranscript(t, occurrence, bot.bot_token, {
      epoch: 1,
      segments: [segment(0, { speaker_member_id: member }), segment(1, { speaker_label: 'Speaker 2' }), segment(2)],
    });
    await t.pool.query(`UPDATE claims SET transcript_epoch = 2 WHERE id = $1`, [bot.claim_id]);
    await pushTranscript(t, occurrence, bot.bot_token, {
      epoch: 2,
      complete: true,
      segments: [segment(0, { text: 'after reconnect' }), segment(1, { source: 'chat', text: 'typed in chat' })],
    });
    meetingId = await meetingIdOf(t, occurrence);
    // Another meeting's transcript, which must never show up in this one.
    const other = await botInMeeting(t, 'other-occ', '922333445', 1);
    await pushTranscript(t, 'other-occ', other.bot_token, { epoch: 1, segments: [segment(5, { text: 'elsewhere' })] });
  });

  const read = (id: string, query = '', headers: Record<string, string> = PERSON) =>
    t.app.inject({ method: 'GET', url: `/meetings/${id}/transcript${query}`, headers });

  it("serves each segment's created_at, the time the backend stored it (QOR-4769)", async () => {
    const { rows } = await t.pool.query<{ created_at: Date }>(
      `SELECT created_at FROM transcript_segments WHERE meeting_id = $1 ORDER BY epoch, seq`,
      [meetingId],
    );
    const segments = (await read(meetingId)).json().segments as { created_at: string }[];
    expect(segments.map((s) => s.created_at)).toEqual(rows.map((r) => r.created_at.toISOString()));
  });

  // QOR-5023 (Z3): the download the board links, as text, built where the transcript is.
  it('answers the whole transcript as a text download, one "speaker: text" line a segment', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/meetings/${meetingId}/transcript.txt`, headers: PERSON });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="transcript-${meetingId}.txt"`);
    expect(res.body).toBe('Ada Lovelace: segment 0\nSpeaker 2: segment 1\nAda Lovelace: segment 2\n'
      + 'Ada Lovelace: after reconnect\nAda Lovelace: typed in chat\n');
    const unknown = await t.app.inject({ method: 'GET', url: '/meetings/00000000-0000-4000-8000-000000000999/transcript.txt', headers: PERSON });
    expect(unknown.statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/meetings/${meetingId}/transcript.txt` })).statusCode).toBe(401);
  });

  it('writes a transcript longer than one read (500 segments) whole, in order', async () => {
    const bot = await botInMeeting(t, 'long/occ==', '922333446', 1);
    const segments = Array.from({ length: 501 }, (_, i) => segment(i, { text: `line ${i}` }));
    await pushTranscript(t, 'long/occ==', bot.bot_token, { epoch: 1, segments: segments.slice(0, 500) });
    await pushTranscript(t, 'long/occ==', bot.bot_token, { epoch: 1, segments: segments.slice(500) });
    const long = await meetingIdOf(t, 'long/occ==');
    const res = await t.app.inject({ method: 'GET', url: `/meetings/${long}/transcript.txt`, headers: PERSON });
    const lines = res.body.split('\n').filter(Boolean);
    expect(lines).toHaveLength(501);
    expect(lines.map((l) => l.split(': ')[1])).toEqual(segments.map((_, i) => `line ${i}`));
  });

  it('needs a signed-in person', async () => {
    const res = await read(meetingId, '', {});
    expect(res.statusCode).toBe(401);
  });

  it('answers the segments in (epoch, seq) order with speaker, text and offsets', async () => {
    const res = await read(meetingId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      meeting_id: meetingId,
      occurrence_id: occurrence,
      finalization: 'transcript_complete',
      complete: true,
      occurrence_state: 'ended',
      transcript_expired: false,
      transcript_expired_at: null,
      segments: [
        { epoch: 1, seq: 0, speaker: { label: 'Ada Lovelace', member_id: '00000000-0000-4000-8000-0000000000b2' }, text: 'segment 0', start_ms: 0, end_ms: 900, source: 'asr', created_at: CREATED_AT },
        { epoch: 1, seq: 1, speaker: { label: 'Speaker 2', member_id: null }, text: 'segment 1', start_ms: 1000, end_ms: 1900, source: 'asr', created_at: CREATED_AT },
        { epoch: 1, seq: 2, speaker: { label: 'Ada Lovelace', member_id: null }, text: 'segment 2', start_ms: 2000, end_ms: 2900, source: 'asr', created_at: CREATED_AT },
        { epoch: 2, seq: 0, speaker: { label: 'Ada Lovelace', member_id: null }, text: 'after reconnect', start_ms: 0, end_ms: 900, source: 'asr', created_at: CREATED_AT },
        { epoch: 2, seq: 1, speaker: { label: 'Ada Lovelace', member_id: null }, text: 'typed in chat', start_ms: 1000, end_ms: 1900, source: 'chat', created_at: CREATED_AT },
      ],
      next_cursor: null,
    });
  });

  it("looks the transcript up by Zoom occurrence too, URL-encoded ('/', '+' and '=' included), the bot feed's key", async () => {
    const byId = await read(meetingId);
    const byOccurrence = await read(encodeURIComponent(occurrence));
    expect(byOccurrence.statusCode).toBe(200);
    expect(byOccurrence.json()).toEqual(byId.json());
    // Paging works the same way by occurrence.
    const first = (await read(encodeURIComponent(occurrence), '?limit=3')).json();
    const rest = (await read(encodeURIComponent(occurrence), `?limit=3&cursor=${encodeURIComponent(first.next_cursor)}`)).json();
    expect([...first.segments, ...rest.segments]).toEqual(byId.json().segments);
  });

  it('answers 404 for an occurrence no meeting has', async () => {
    for (const unknown of ['never/seen+1==', 'read', 'read%2Focc']) {
      const res = await read(encodeURIComponent(unknown));
      expect(res.statusCode, unknown).toBe(404);
      expect(res.json(), unknown).toEqual({ error: 'not_found' });
    }
  });

  it("answers the newest lines only with tail, oldest of them first: the board's transcript footer", async () => {
    const all = (await read(meetingId)).json().segments;
    const res = await read(meetingId, '?tail=2');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ meeting_id: meetingId, segments: all.slice(-2), next_cursor: null });
    expect((await read(meetingId, '?tail=50')).json().segments).toEqual(all);
    for (const tail of ['0', '501', 'x']) expect((await read(meetingId, `?tail=${tail}`)).statusCode, tail).toBe(400);
  });

  it('pages with an opaque cursor across epochs', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await read(meetingId, `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      seen.push(...body.segments.map((s: { epoch: number; seq: number }) => `${s.epoch}.${s.seq}`));
      cursor = body.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(['1.0', '1.1', '1.2', '2.0', '2.1']);
    expect(pages).toBe(2);
  });

  it('answers 404 for a meeting that does not exist, and 400 for a bad limit or cursor', async () => {
    expect((await read('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await read('not-a-uuid')).statusCode).toBe(404);
    for (const q of ['?limit=0', '?limit=501', '?cursor=nope']) expect((await read(meetingId, q)).statusCode, q).toBe(400);
  });

  it('answers 400, not 500, for a cursor past the int range', async () => {
    for (const key of ['[3000000000,0]', '[0,3000000000]', '[1e20,0]']) {
      const res = await read(meetingId, `?cursor=${Buffer.from(key).toString('base64url')}`);
      expect(res.statusCode, key).toBe(400);
      expect(res.json(), key).toEqual({ error: 'invalid_query' });
    }
  });
});
