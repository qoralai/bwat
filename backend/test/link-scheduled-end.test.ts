import { beforeEach, expect, it } from 'vitest';
import { postAllocation, resetAllocationsBeforeEach, signedIn } from './app.ts';
import { describeDb } from './db/harness.ts';
import { ZOOM_APP, ZOOM_S2S } from './fake-zoom.ts';
import { useAutoJoinApp } from './zoom.ts';

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

describeDb("a meeting sent by link gets its scheduled end from Zoom's meeting record", () => {
  const t = useAutoJoinApp({ authenticatePerson: signedIn, zoom: { autoJoin: false, requireHost: false } });
  resetAllocationsBeforeEach(t);
  beforeEach(() => {
    t.secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    t.zoom.answer = undefined;
  });

  /** Zoom answers the meeting's record with `schedule` added to the standard one. */
  const scheduled = (schedule: Record<string, unknown>) => {
    t.zoom.answer = (call) => {
      const standard = t.zoom.standard(call);
      return /\/v2\/meetings\/\d+$/.test(call.url) ? { ...standard, body: { ...(standard.body as object), ...schedule } } : standard;
    };
  };
  const send = async (meeting: string) => {
    const res = await postAllocation(t, { zoom_url: `https://zoom.us/j/${meeting}?pwd=linkpass` });
    expect(res.statusCode).toBe(202);
    return (await t.pool.query(`SELECT briefing FROM claims WHERE id = $1`, [res.json().id])).rows[0].briefing;
  };

  it("is a one-off meeting's booked start plus its duration, with the link's passcode kept", async () => {
    const now = Date.now();
    scheduled({ type: 2, start_time: iso(now - 10 * MINUTE), duration: 30 });
    expect(await send('290000001')).toEqual({ passcode: 'linkpass', scheduled_end: iso(now + 20 * MINUTE) });
  });

  it('is the end of a sitting about to start, but none for one booked further ahead: a wrong end is worse than none', async () => {
    const now = Date.now();
    const recurring = (startsIn: number) => ({
      type: 8,
      start_time: iso(now - 7 * 24 * 60 * MINUTE),
      duration: 30,
      occurrences: [
        { occurrence_id: '1', start_time: iso(now - 24 * 60 * MINUTE), duration: 30, status: 'available' },
        { occurrence_id: '2', start_time: iso(now + startsIn), duration: 30, status: 'available' },
      ],
    });
    scheduled(recurring(10 * MINUTE));
    expect((await send('290000006')).scheduled_end).toBe(iso(now + 40 * MINUTE));
    scheduled(recurring(24 * 60 * MINUTE));
    expect(await send('290000007')).toEqual({ passcode: 'linkpass' });
    scheduled({ type: 2, start_time: iso(now + 2 * 60 * MINUTE), duration: 30 });
    expect(await send('290000008')).toEqual({ passcode: 'linkpass' });
  });

  it('is the end of the sitting in progress for a recurring meeting at a fixed time, not the series start', async () => {
    const now = Date.now();
    scheduled({
      type: 8,
      start_time: iso(now - 7 * 24 * 60 * MINUTE),
      duration: 30,
      occurrences: [
        { occurrence_id: '1', start_time: iso(now - 24 * 60 * MINUTE), duration: 30, status: 'available' },
        { occurrence_id: '2', start_time: iso(now - 10 * MINUTE), duration: 30, status: 'available' },
        { occurrence_id: '3', start_time: iso(now + 24 * 60 * MINUTE), duration: 30, status: 'available' },
      ],
    });
    expect((await send('290000002')).scheduled_end).toBe(iso(now + 20 * MINUTE));
  });

  it('skips a sitting Zoom lists as deleted: a cancelled sitting is not happening', async () => {
    const now = Date.now();
    const recurring = (laterIn: number) => ({
      type: 8,
      start_time: iso(now - 7 * 24 * 60 * MINUTE),
      duration: 30,
      occurrences: [
        { occurrence_id: '1', start_time: iso(now + 5 * MINUTE), duration: 30, status: 'deleted' },
        { occurrence_id: '2', start_time: iso(now + laterIn), duration: 30, status: 'available' },
      ],
    });
    scheduled(recurring(24 * 60 * MINUTE));
    expect(await send('290000009')).toEqual({ passcode: 'linkpass' });
    scheduled(recurring(10 * MINUTE));
    expect((await send('290000010')).scheduled_end).toBe(iso(now + 40 * MINUTE));
  });

  it('is absent for a personal room or an instant meeting', async () => {
    for (const [meeting, type] of [['290000003', 4], ['290000004', 1]] as const) {
      scheduled({ type, start_time: '2026-10-19T15:30:00Z', duration: 30 });
      expect(await send(meeting), String(type)).toEqual({ passcode: 'linkpass' });
    }
  });

  it('is absent, and the send still goes ahead, when Zoom cannot be asked', async () => {
    t.zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 503 } : undefined);
    expect(await send('290000005')).toEqual({ passcode: 'linkpass' });
  });
});

describeDb("the link send's schedule lookup is best effort, within the Zoom bucket per client address", () => {
  const t = useAutoJoinApp({
    authenticatePerson: signedIn,
    zoom: { autoJoin: false, requireHost: false },
    rateLimits: { signInFailuresPerMin: 30, zoomPerMin: 2 },
  });
  resetAllocationsBeforeEach(t);

  it('sends without a scheduled end once the bucket is spent, and only a valid signed-in send spends it', async () => {
    t.secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    const now = Date.now();
    t.zoom.answer = (call) => {
      const standard = t.zoom.standard(call);
      const schedule = { type: 2, start_time: iso(now - 10 * MINUTE), duration: 30 };
      return /\/v2\/meetings\/\d+$/.test(call.url) ? { ...standard, body: { ...(standard.body as object), ...schedule } } : standard;
    };
    for (let i = 0; i < 3; i++) {
      expect((await postAllocation(t, { zoom_url: 'https://zoom.us/j/291000009' }, {})).statusCode).toBe(401);
      expect((await postAllocation(t, { zoom_url: 'not a link' })).statusCode).toBe(422);
    }
    const ends = [];
    for (const meeting of ['291000001', '291000002', '291000003']) {
      const res = await postAllocation(t, { zoom_url: `https://zoom.us/j/${meeting}` });
      expect(res.statusCode, meeting).toBe(202);
      ends.push((await t.pool.query(`SELECT briefing FROM claims WHERE id = $1`, [res.json().id])).rows[0].briefing.scheduled_end);
    }
    expect(ends).toEqual([iso(now + 20 * MINUTE), iso(now + 20 * MINUTE), undefined]);
    expect(t.zoom.apiCalls()).toHaveLength(2);
  });
});
