import { readyBusyBot } from './zoom-readiness-fixture.ts';
import { beforeEach, expect, it } from 'vitest';
import type { ZoomConfig } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import { runRetention } from '../src/retention.ts';
import { buildServer } from '../src/server.ts';
import { apiBase, bearer, postAllocation, registerBot, resetAllocationsBeforeEach, signedIn, type TestApp } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { fakeZoom, ZOOM_APP, ZOOM_S2S, zoomSecrets } from './fake-zoom.ts';
import { autoJoined, deliver, lookupLogged, storedSwitch, useAutoJoinApp, zoomEvent } from './zoom.ts';

const ON: ZoomConfig = { autoJoin: true, requireHost: false };

const started = (id: string, uuid: string) =>
  zoomEvent('meeting.started', { id, uuid, host_id: 'host-1', topic: 'Quarterly numbers', start_time: new Date().toISOString() });
const ended = (id: string, uuid: string) => zoomEvent('meeting.ended', { id, uuid, topic: 'Quarterly numbers' });

const claimsFor = async (t: TestApp, meeting: string) =>
  (await t.pool.query(`SELECT * FROM claims WHERE meeting_number = $1 ORDER BY created_at, id`, [meeting])).rows;

describeDb('auto-join looks every meeting up in Zoom before it opens a claim: passcode and recording (QOR-4581, D71)', () => {
  const t = useAutoJoinApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  const { zoom, secrets } = t;
  resetAllocationsBeforeEach(t);
  beforeEach(() => readyBusyBot(t));
  beforeEach(() => {
    storedSwitch(t).value = true;
    secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    secrets.unreadable = [];
    zoom.calls.length = 0;
    zoom.answer = undefined;
    zoom.passcode = 'looked-up-pass';
    zoom.recording = 'cloud';
    t.lines.length = 0;
  });

  it('answers at once, then looks the meeting up and opens the claim with its passcode, stamped with the occurrence', async () => {
    const bot = await registerBot(t);
    const res = await deliver(t, started('260000001', 'occ-L1=='));
    expect(res.json()).toEqual({ status: 'meeting_lookup' });
    expect(await lookupLogged(t)).toMatchObject({ outcome: 'claim_opened' });
    const [claim] = await claimsFor(t, '260000001');
    expect(claim).toMatchObject({ state: 'claimed', bot_id: bot.bot_id, occurrence_uuid: 'occ-L1==', briefing: { passcode: 'looked-up-pass' } });
    expect(zoom.apiCalls().map((c) => c.url)).toEqual(['https://api.zoom.us/v2/meetings/260000001']);
    const assignment = (await t.app.inject({ method: 'GET', url: '/assignment', headers: bearer(bot.bot_token) })).json();
    expect(assignment).toMatchObject({ claim_id: claim.id, briefing: { passcode: 'looked-up-pass' } });
  });

  it('joins a meeting scheduled to record locally or to the cloud', async () => {
    for (const [meeting, recording] of [['260000020', 'local'], ['260000021', 'cloud']] as const) {
      zoom.recording = recording;
      expect(await autoJoined(t, started(meeting, `occ-${meeting}==`)), recording).toBe('claim_opened');
      expect(await claimsFor(t, meeting), recording).toHaveLength(1);
    }
  });

  it('joins a meeting with automatic recording disabled', async () => {
    zoom.recording = 'none';
    expect(await autoJoined(t, started('260000022', 'occ-L22=='))).toBe('claim_opened');
    expect(await claimsFor(t, '260000022')).toHaveLength(1);
  });

  it('joins when Zoom omits the automatic recording setting', async () => {
    zoom.recording = undefined;
    expect(await autoJoined(t, started('260000023', 'occ-L23=='))).toBe('claim_opened');
    expect(await claimsFor(t, '260000023')).toHaveLength(1);
  });

  it("looks up the current passcode even when a previous invitation supplied one", async () => {
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/260000024?pwd=SentPass' })).json();
    await t.pool.query(`UPDATE claims SET state = 'done', ended_at = now() WHERE id = $1`, [sent.id]);
    zoom.calls.length = 0;
    zoom.recording = 'none';
    expect(await autoJoined(t, started('260000024', 'occ-L24=='))).toBe('claim_opened');
    expect(zoom.apiCalls().map((c) => c.url)).toEqual(['https://api.zoom.us/v2/meetings/260000024']);
    expect((await claimsFor(t, '260000024')).map((c) => c.state)).toEqual(['done', 'pending']);
  });

  it('opens the claim with no passcode for a meeting that has none', async () => {
    zoom.passcode = '';
    expect(await autoJoined(t, started('260000002', 'occ-L2=='))).toBe('claim_opened');
    expect((await claimsFor(t, '260000002'))[0].briefing).toEqual({});
  });

  it('answers Zoom before the lookup ends, however slow Zoom is', async () => {
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { ...zoom.standard(call), delayMs: 1500 } : undefined);
    const begun = Date.now();
    expect((await deliver(t, started('260000003', 'occ-L3=='))).json()).toEqual({ status: 'meeting_lookup' });
    expect(Date.now() - begun).toBeLessThan(1000);
    expect(await lookupLogged(t)).toMatchObject({ outcome: 'claim_opened' });
  });

  it('opens nothing and calls nothing while the S2S app is not configured (recording_unknown)', async () => {
    secrets.values = {};
    expect((await deliver(t, started('260000004', 'occ-L4=='))).json()).toEqual({ status: 'recording_unknown' });
    expect(zoom.calls).toEqual([]);
    expect(await claimsFor(t, '260000004')).toEqual([]);
  });

  it('opens nothing, logging the code only, when the S2S credentials cannot be read', async () => {
    secrets.unreadable = ['zoom.s2s_client_secret'];
    expect((await deliver(t, started('260000005', 'occ-L5=='))).json()).toEqual({ status: 'recording_unknown' });
    expect(await lookupLogged(t)).toMatchObject({ outcome: 'secret_unavailable' });
    expect(zoom.calls).toEqual([]);
    expect(await claimsFor(t, '260000005')).toEqual([]);
  });

  it('opens nothing when Zoom fails (a 5xx, or a meeting it cannot read), logging the code and status only', async () => {
    for (const [meeting, status] of [['260000006', 503], ['260000007', 404]] as const) {
      const from = t.lines.length;
      zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status } : undefined);
      expect((await deliver(t, started(meeting, `occ-${meeting}==`))).json()).toEqual({ status: 'meeting_lookup' });
      expect(await lookupLogged(t, from), String(status)).toMatchObject({ outcome: 'zoom_unavailable', status });
      expect(await claimsFor(t, meeting)).toEqual([]);
    }
  });

  it('opens nothing when the meeting ended while it was being looked up', async () => {
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { ...zoom.standard(call), delayMs: 300 } : undefined);
    expect((await deliver(t, started('260000008', 'occ-L8=='))).json()).toEqual({ status: 'meeting_lookup' });
    expect((await deliver(t, ended('260000008', 'occ-L8=='))).json()).toEqual({ status: 'tombstoned' });
    expect(await lookupLogged(t)).toMatchObject({ outcome: 'already_ended' });
    expect(await claimsFor(t, '260000008')).toEqual([]);
  });

  it('looks up once for a start Zoom delivers twice', async () => {
    const start = started('260000009', 'occ-L9==');
    expect((await deliver(t, start)).json()).toEqual({ status: 'meeting_lookup' });
    expect((await deliver(t, start)).json()).toEqual({ status: 'duplicate' });
    await lookupLogged(t);
    expect(zoom.apiCalls()).toHaveLength(1);
    expect(await claimsFor(t, '260000009')).toHaveLength(1);
  });

  it("looks up again once retention erased a sent meeting's passcode: the erased briefing is unknown, not 'no passcode'", async () => {
    await t.pool.query(
      `INSERT INTO claims (meeting_number, state, briefing, ended_at) VALUES ('260000012', 'done', '{"passcode":"OldPass"}', now() - interval '40 days')`,
    );
    expect(await runRetention(t.pool, 30)).toMatchObject({ claims_scrubbed: 1 });
    expect((await deliver(t, started('260000012', 'occ-L12=='))).json()).toEqual({ status: 'meeting_lookup' });
    expect(await lookupLogged(t)).toMatchObject({ outcome: 'claim_opened' });
    expect(zoom.apiCalls().map((c) => c.url)).toEqual(['https://api.zoom.us/v2/meetings/260000012']);
    expect((await claimsFor(t, '260000012')).at(-1)).toMatchObject({ occurrence_uuid: 'occ-L12==', briefing: { passcode: 'looked-up-pass' } });
  });

  it('never looks up while auto-join is switched off', async () => {
    storedSwitch(t).value = false;
    expect((await deliver(t, started('260000010', 'occ-L10=='))).json()).toEqual({ status: 'switched_off' });
    expect(zoom.calls).toEqual([]);
  });
});

describeDb('the server waits for a meeting lookup still running before it closes (QOR-4581)', () => {
  const db = useTestDb();

  it('opens the claim before close() resolves, though Zoom answered after the delivery did', async () => {
    const pool = createPool(db.url('runtime'));
    const zoom = fakeZoom();
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { ...zoom.standard(call), delayMs: 400 } : undefined);
    const app = apiBase(
      buildServer({
        pool,
        zoom: ON,
        autoJoinCacheMs: 0,
        getSecret: zoomSecrets({ ...ZOOM_APP, ...ZOOM_S2S }),
        zoomFetch: zoom.fetch,
        readAutoJoinSwitch: async () => true,
      }),
    );
    await readyBusyBot({ app, pool });
    try {
      expect((await deliver({ app }, started('260000011', 'occ-L11=='))).json()).toEqual({ status: 'meeting_lookup' });
    } finally {
      await app.close();
    }
    try {
      const { rows } = await pool.query(`SELECT briefing FROM claims WHERE meeting_number = '260000011'`);
      expect(rows).toEqual([{ briefing: { passcode: 'looked-up-pass' } }]);
    } finally {
      await pool.end();
    }
  });
});
