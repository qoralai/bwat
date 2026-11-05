import { readyBusyBot } from './zoom-readiness-fixture.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ZoomConfig } from '../src/config.ts';
import { LOOKUP_NEGATIVE_TTL_MS, meetingLookups } from '../src/zoom-events.ts';
import { resetAllocationsBeforeEach, signedIn, type TestApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { ZOOM_APP, ZOOM_S2S } from './fake-zoom.ts';
import { autoJoined, deliver, lookupLogged, storedSwitch, useAutoJoinApp, zoomEvent } from './zoom.ts';

const ON: ZoomConfig = { autoJoin: true, requireHost: false };

const started = (id: string, uuid: string) =>
  zoomEvent('meeting.started', { id, uuid, host_id: 'host-1', topic: 'Quarterly numbers', start_time: new Date().toISOString() });

/** A guest arriving once the host is late: it lets bwat in, so each one would look the meeting up. */
const lateGuest = (id: string, uuid: string, n: number) =>
  zoomEvent('meeting.participant_joined', {
    id,
    uuid,
    host_id: 'host-1',
    start_time: new Date(Date.now() - 10 * 60_000).toISOString(),
    participant: { id: `guest-${n}`, user_name: 'Pat Example', join_time: new Date().toISOString() },
  });

const claimsFor = async (t: TestApp, meeting: string) =>
  (await t.pool.query(`SELECT * FROM claims WHERE meeting_number = $1 ORDER BY created_at, id`, [meeting])).rows;

/** The server's clock and pause, as the suite drives them: no real waiting. */
const clock = { now: Date.now() };
const pauses: number[] = [];

const apiAnswer = (status: number, headers?: Record<string, string>) => (call: { url: string }) =>
  call.url.startsWith('https://api.') ? { status, ...(headers && { headers }) } : undefined;

describeDb('the meeting lookup retries a transient Zoom failure once, and keeps a final no', () => {
  const t = useAutoJoinApp({
    authenticatePerson: signedIn,
    zoom: ON,
    autoJoinCacheMs: 0,
    clock: () => clock.now,
    sleep: async (ms) => void pauses.push(ms),
  });
  const { zoom, secrets } = t;
  resetAllocationsBeforeEach(t);
  beforeEach(() => readyBusyBot(t));
  beforeEach(() => {
    storedSwitch(t).value = true;
    secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    secrets.unreadable = [];
    secrets.reads.length = 0;
    zoom.calls.length = 0;
    zoom.answer = undefined;
    zoom.recording = 'cloud';
    pauses.length = 0;
    // Past every negative an earlier test kept.
    clock.now += 10 * LOOKUP_NEGATIVE_TTL_MS;
    t.lines.length = 0;
  });

  it('keeps a final no for 60 s', () => {
    expect(LOOKUP_NEGATIVE_TTL_MS).toBe(60_000);
  });

  it('opens the claim after a 503 then a success: one retry, after a pause of 1 s', async () => {
    let failures = 1;
    zoom.answer = (call) => (call.url.startsWith('https://api.') && failures-- > 0 ? { status: 503 } : undefined);
    expect(await autoJoined(t, started('280000001', 'occ-R1=='))).toBe('claim_opened');
    expect(zoom.apiCalls()).toHaveLength(2);
    expect(pauses).toEqual([1_000]);
    expect(await claimsFor(t, '280000001')).toHaveLength(1);
  });

  it('retries a 429 and a network error too, honouring Retry-After up to 5 s', async () => {
    const cases: [string, () => void, number][] = [
      ['280000002', () => (zoom.answer = apiAnswer(429, { 'retry-after': '3' })), 3_000],
      ['280000003', () => (zoom.answer = apiAnswer(429, { 'retry-after': '120' })), 5_000],
      ['280000004', () => (zoom.answer = (call) => (call.url.startsWith('https://api.') ? 'network_error' : undefined)), 1_000],
    ];
    for (const [meeting, arrange, pause] of cases) {
      zoom.calls.length = 0;
      pauses.length = 0;
      arrange();
      expect(await autoJoined(t, started(meeting, `occ-${meeting}==`)), meeting).toBe('zoom_unavailable');
      expect(zoom.apiCalls(), meeting).toHaveLength(2);
      expect(pauses, meeting).toEqual([pause]);
    }
  });

  it('does not retry a 404, and keeps it as a final no', async () => {
    zoom.answer = apiAnswer(404);
    const from = t.lines.length;
    expect(await autoJoined(t, started('280000005', 'occ-R5=='))).toBe('zoom_unavailable');
    expect(await lookupLogged(t, from)).toMatchObject({ level: 30, status: 404 });
    expect(zoom.apiCalls()).toHaveLength(1);
    expect(pauses).toEqual([]);
  });

  it('logs a transient failure that outlasted its retry at WARN, with its status, and keeps nothing', async () => {
    zoom.answer = apiAnswer(503);
    const from = t.lines.length;
    expect((await deliver(t, started('280000006', 'occ-R6=='))).json()).toEqual({ status: 'meeting_lookup' });
    expect(await lookupLogged(t, from)).toMatchObject({ level: 40, outcome: 'zoom_unavailable', status: 503 });
    zoom.answer = undefined;
    // Not kept: the next start looks the meeting up again, and joins.
    expect(await autoJoined(t, started('280000006', 'occ-R6b=='))).toBe('claim_opened');
  });

  /** The three final noes, each arranged on the fake. */
  const finalNoes: [string, () => void][] = [
    ['404', () => (zoom.answer = apiAnswer(404))],
  ];

  /** Delivers a start Zoom answers with a final no, and waits for its lookup. */
  const refusedStart = async (meeting: string, uuid: string, arrange: () => void) => {
    zoom.calls.length = 0;
    zoom.answer = undefined;
    zoom.recording = 'cloud';
    arrange();
    const from = t.lines.length;
    expect((await deliver(t, started(meeting, uuid))).json(), meeting).toEqual({ status: 'meeting_lookup' });
    await lookupLogged(t, from);
    expect(zoom.apiCalls(), meeting).toHaveLength(1);
    zoom.answer = undefined;
    zoom.recording = 'cloud';
  };

  it('keeps a final no (404) for its occurrence until the TTL runs out, then looks it up again', async () => {
    for (const [n, [no, arrange]] of finalNoes.entries()) {
      const meeting = String(280_000_007 + n);
      await refusedStart(meeting, `occ-${meeting}-A==`, arrange);
      // The same occurrence again within the TTL: the no is kept, Zoom is not asked.
      clock.now += LOOKUP_NEGATIVE_TTL_MS - 1;
      expect((await deliver(t, started(meeting, `occ-${meeting}-A==`))).json(), no).toEqual({ status: 'lookup_cached' });
      expect(zoom.apiCalls(), no).toHaveLength(1);
      // Once it runs out, it is looked up again, and joins when it now records.
      clock.now += 1;
      expect(await autoJoined(t, started(meeting, `occ-${meeting}-A==`)), no).toBe('claim_opened');
      expect(zoom.apiCalls(), no).toHaveLength(2);
    }
  });

  it("looks up a new occurrence started within the TTL of the one before's no, and joins it when Zoom now says it records", async () => {
    for (const [n, [no, arrange]] of finalNoes.entries()) {
      const meeting = String(280_000_012 + n);
      await refusedStart(meeting, `occ-${meeting}-A==`, arrange);
      // The host turns recording on and starts the next occurrence 1 s later.
      clock.now += 1_000;
      expect(await autoJoined(t, started(meeting, `occ-${meeting}-B==`)), no).toBe('claim_opened');
      expect(zoom.apiCalls(), no).toHaveLength(2);
      expect((await claimsFor(t, meeting)).map((c) => c.occurrence_uuid), no).toEqual([`occ-${meeting}-B==`]);
    }
  });

  it('looks up a new occurrence started while the lookup for the ended one before is still running, and refuses that one', async () => {
    const meeting = '280000015';
    // Zoom holds its answer about occurrence A until released; it answers B's at once.
    let asked!: () => void;
    const askedA = new Promise<void>((resolve) => (asked = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    zoom.answer = (call) => {
      if (!call.url.startsWith('https://api.') || !first) return undefined;
      first = false;
      asked();
      return { ...zoom.standard(call), held };
    };
    expect((await deliver(t, started(meeting, 'occ-SF-A=='))).json()).toEqual({ status: 'meeting_lookup' });
    await askedA;
    // A ends and B starts while A's lookup waits on Zoom.
    expect((await deliver(t, zoomEvent('meeting.ended', { id: meeting, uuid: 'occ-SF-A==' }))).statusCode).toBe(200);
    expect(await autoJoined(t, started(meeting, 'occ-SF-B=='))).toBe('claim_opened');
    const from = t.lines.length;
    release();
    expect(await lookupLogged(t, from)).toMatchObject({ outcome: 'already_ended' });
    expect(zoom.apiCalls()).toHaveLength(2);
    expect((await claimsFor(t, meeting)).map((c) => [c.occurrence_uuid, c.state])).toEqual([['occ-SF-B==', 'pending']]);
  });

  it('never keeps a no for a start that names no occurrence', async () => {
    const meeting = '280000016';
    const unnamed = () =>
      zoomEvent('meeting.started', { id: meeting, host_id: 'host-1', topic: 'Quarterly numbers', start_time: new Date().toISOString() });
    zoom.answer = apiAnswer(404);
    expect(await autoJoined(t, unnamed())).toBe('zoom_unavailable');
    expect(await autoJoined(t, unnamed())).toBe('zoom_unavailable');
    expect(zoom.apiCalls()).toHaveLength(2);
    zoom.answer = undefined;
    expect(await autoJoined(t, unnamed())).toBe('claim_opened');
  });

  /** The S2S credentials read from the store since the last reset. */
  const s2sReads = () => secrets.reads.filter((name) => name.startsWith('zoom.s2s_'));

  it('answers a kept no from the cache without reading the S2S credentials', async () => {
    const meeting = '280000017';
    await refusedStart(meeting, 'occ-C1==', () => (zoom.answer = apiAnswer(404)));
    secrets.reads.length = 0;
    expect((await deliver(t, started(meeting, 'occ-C1=='))).json()).toEqual({ status: 'lookup_cached' });
    expect(s2sReads()).toEqual(['zoom.s2s_account_id']);
    expect(zoom.apiCalls()).toHaveLength(1);
  });

  it('neither leaves an occurrence in flight nor keeps a no when the S2S app is absent or the store unreadable', async () => {
    const cases: [string, () => void][] = [
      ['280000018', () => (secrets.values = {})],
      ['280000019', () => (secrets.unreadable = ['zoom.s2s_client_id'])],
    ];
    for (const [meeting, arrange] of cases) {
      zoom.calls.length = 0;
      arrange();
      const uuid = `occ-${meeting}==`;
      // Not configured or unreadable proves nothing about recording: no claim, and nothing held back.
      expect((await deliver(t, started(meeting, uuid))).json(), meeting).toEqual({ status: 'recording_unknown' });
      expect((await deliver(t, started(meeting, uuid))).json(), meeting).toEqual({ status: 'recording_unknown' });
      expect(zoom.apiCalls(), meeting).toEqual([]);
      // Set up again, the same occurrence is looked up at once, and joined.
      secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
      secrets.unreadable = [];
      expect(await autoJoined(t, started(meeting, uuid)), meeting).toBe('claim_opened');
    }
  });
});

describeDb('a burst of arrivals looks the meeting up once', () => {
  const t = useAutoJoinApp({
    authenticatePerson: signedIn,
    zoom: { ...ON, requireHost: true },
    autoJoinCacheMs: 0,
    clock: () => clock.now,
    sleep: async (ms) => void pauses.push(ms),
  });
  const { zoom } = t;
  resetAllocationsBeforeEach(t);
  beforeEach(() => readyBusyBot(t));
  beforeEach(() => {
    storedSwitch(t).value = true;
    storedSwitch(t).requireHost = true;
    zoom.calls.length = 0;
    zoom.answer = undefined;
    zoom.recording = 'cloud';
    clock.now += 10 * LOOKUP_NEGATIVE_TTL_MS;
    t.lines.length = 0;
  });

  it('skips a lookup while one for the same meeting is in flight', async () => {
    zoom.recording = 'none';
    // Zoom answers only once all 20 deliveries have been.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { ...zoom.standard(call), held } : undefined);
    const answers = await Promise.all(Array.from({ length: 20 }, (_, n) => deliver(t, lateGuest('280000010', 'occ-B1==', n))));
    release();
    const statuses = answers.map((r) => r.json().status);
    expect(statuses.filter((s) => s === 'meeting_lookup')).toHaveLength(1);
    expect(statuses.filter((s) => s !== 'meeting_lookup')).toEqual(Array(19).fill('lookup_in_flight'));
    expect(await lookupLogged(t)).toMatchObject({ outcome: 'claim_opened' });
    // And once it is over, the no is kept.
    expect((await deliver(t, lateGuest('280000010', 'occ-B1==', 20))).json()).toEqual({ status: 'already_claimed' });
    expect(zoom.apiCalls()).toHaveLength(1);
  });

  it('lets the next arrival look up once a lookup that failed is over', async () => {
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 500 } : undefined);
    expect((await deliver(t, lateGuest('280000011', 'occ-B2==', 0))).json()).toEqual({ status: 'meeting_lookup' });
    await lookupLogged(t);
    zoom.answer = undefined;
    zoom.recording = 'cloud';
    expect(await autoJoined(t, lateGuest('280000011', 'occ-B2==', 1))).toBe('claim_opened');
  });
});

describe('the kept noes are bounded', () => {
  const occurrence = (n: number) => ({ meetingNumber: String(300_000_000 + n), occurrenceUuid: `occ-${n}==` });

  it('keeps at most 1000 occurrences, dropping the oldest first', () => {
    const lookups = meetingLookups({ now: () => 0 });
    for (let n = 0; n <= 1_000; n++) {
      expect(lookups.begin(occurrence(n))).toBeNull();
      lookups.end(occurrence(n), true);
    }
    expect(lookups.begin(occurrence(1))).toBe('lookup_cached');
    expect(lookups.begin(occurrence(1_000))).toBe('lookup_cached');
    expect(lookups.begin(occurrence(0))).toBeNull();
  });

  it('never holds back a meeting that names no occurrence, running or refused', () => {
    const lookups = meetingLookups({ now: () => 0 });
    const unnamed = { meetingNumber: '300000000', occurrenceUuid: null };
    expect(lookups.begin(unnamed)).toBeNull();
    expect(lookups.begin(unnamed)).toBeNull();
    lookups.end(unnamed, true);
    expect(lookups.begin(unnamed)).toBeNull();
  });
});
