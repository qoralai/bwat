import { readyBusyBot } from './zoom-readiness-fixture.ts';
import { beforeEach, expect, it } from 'vitest';
import { MEETING_LOCK } from '../src/claims.ts';
import type { ZoomConfig } from '../src/config.ts';
import { bearer, botPost, postAllocation, registerBot, resetAllocationsBeforeEach, signedIn, type TestApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting, pushTranscript, segment } from './meetings.ts';
import { ZOOM_APP, ZOOM_S2S } from './fake-zoom.ts';
import { autoJoined, deliver, lookupLogged, storedSwitch, useAutoJoinApp, useZoomApp, zoomEvent } from './zoom.ts';

const ON: ZoomConfig = { autoJoin: true, requireHost: false };

const claimsFor = async (t: TestApp, meeting: string) =>
  (await t.pool.query(`SELECT * FROM claims WHERE meeting_number = $1 ORDER BY created_at, id`, [meeting])).rows;
const assignment = async (t: TestApp, botToken: string) =>
  (await t.app.inject({ method: 'GET', url: '/assignment', headers: bearer(botToken) })).json();

const endedFor = async (t: TestApp, meeting: string) =>
  (
    await t.pool.query(`SELECT occurrence_uuid FROM zoom_ended_occurrences WHERE meeting_number = $1 ORDER BY occurrence_uuid`, [
      meeting,
    ])
  ).rows.map((r) => r.occurrence_uuid);

/**
 * A meeting a person sent bwat to before: an ended claim from their link, with `passcode`
 * or none. Auto-join never reads it: it looks every meeting up in Zoom.
 */
async function known(t: TestApp, meeting: number | string, passcode?: string) {
  await t.pool.query(`INSERT INTO claims (meeting_number, state, briefing, ended_at) VALUES ($1, 'done', $2, now())`, [
    String(meeting),
    passcode === undefined ? {} : { passcode },
  ]);
}

/** The bot's own meeting_ended release, after Zoom's end: a held claim is not released by Zoom (it drains first). */
const leaves = (t: TestApp, botToken: string, claimId: string) =>
  botPost(t, '/assignment/release', botToken, { claim_id: claimId, generation: 1, meeting_ended: true });

/** A bot reports the occurrence of the claim it holds (generation 1). */
async function promote(t: TestApp, botToken: string, claimId: string, uuid: string) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/assignment/occurrence',
    headers: bearer(botToken),
    payload: { claim_id: claimId, generation: 1, occurrence_uuid: uuid },
  });
  expect(res.statusCode).toBe(200);
}

const ended = (id: number | string, uuid?: string) =>
  zoomEvent('meeting.ended', { id, ...(uuid === undefined ? {} : { uuid }), topic: 'Quarterly numbers' });

describeDb('meeting.ended releases the meeting and leaves a tombstone (QOR-4576)', () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);
  beforeEach(() => readyBusyBot(t));

  it('records the end and leaves a held claim naming the occurrence live, for its bot to drain', async () => {
    const bot = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/210000001' })).json();
    expect(sent.claim_state).toBe('claimed');
    await promote(t, bot.bot_token, sent.id, 'occ-A==');

    const res = await deliver(t, ended(210000001, 'occ-A=='));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'tombstoned' });
    expect(await claimsFor(t, '210000001')).toEqual([
      expect.objectContaining({ id: sent.id, state: 'claimed', occurrence_uuid: 'occ-A==', refused_reason: null, ended_at: null }),
    ]);
    expect(await assignment(t, bot.bot_token)).toMatchObject({ claim_id: sent.id });
    expect(await endedFor(t, '210000001')).toEqual(['occ-A==']);
  });

  it("ends bwat's meeting for the occurrence at once, and a later final push keeps that end (QOR-4719)", async () => {
    const bot = await botInMeeting(t, 'occ-M==', '210000010');
    expect((await pushTranscript(t, 'occ-M==', bot.bot_token, { epoch: 1, segments: [segment(0)] })).statusCode).toBe(204);
    const meeting = async () =>
      (await t.pool.query(`SELECT ended_at, finalization FROM meetings WHERE occurrence_uuid = 'occ-M=='`)).rows[0];

    await deliver(t, ended(210000010, 'occ-M=='));
    const { ended_at } = await meeting();
    expect(ended_at).toBeInstanceOf(Date);
    expect((await claimsFor(t, '210000010'))[0]).toMatchObject({ state: 'claimed' });

    expect((await pushTranscript(t, 'occ-M==', bot.bot_token, { epoch: 1, complete: true, segments: [] })).statusCode).toBe(204);
    expect(await meeting()).toEqual({ ended_at, finalization: 'transcript_complete' });
  });

  it('releases a claim still pending too, when it names the occurrence (a Zoom start stamped it)', async () => {
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/210000002' })).json();
    await t.pool.query(`UPDATE claims SET occurrence_uuid = 'occ-B==' WHERE id = $1`, [sent.id]);
    expect((await deliver(t, ended('210000002', 'occ-B=='))).json()).toEqual({ status: 'released' });
    expect((await claimsFor(t, '210000002'))[0]).toMatchObject({ state: 'done', refused_reason: 'meeting_ended' });
  });

  it('records the end of an occurrence that had no open claim outside claims', async () => {
    await known(t, 210000003);
    expect((await deliver(t, ended(210000003, 'occ-C=='))).json()).toEqual({ status: 'tombstoned' });
    expect((await claimsFor(t, '210000003')).map((c) => c.occurrence_uuid)).toEqual([null]);
    expect(await endedFor(t, '210000003')).toEqual(['occ-C==']);
  });

  it('records the end of a meeting nobody sent bwat to as well, once', async () => {
    expect((await deliver(t, ended(210000009, 'occ-H=='))).json()).toEqual({ status: 'tombstoned' });
    expect((await deliver(t, ended(210000009, 'occ-H=='))).json()).toEqual({ status: 'already_ended' });
    expect(await claimsFor(t, '210000009')).toEqual([]);
    expect(await endedFor(t, '210000009')).toEqual(['occ-H==']);
  });

  it('keeps ended occurrences past a day: only the retention job prunes them', async () => {
    await t.pool.query(
      `INSERT INTO zoom_ended_occurrences (meeting_number, occurrence_uuid, ended_at)
       VALUES ('210000007', 'occ-old', now() - interval '25 hours'), ('210000007', 'occ-recent', now() - interval '23 hours')`,
    );
    await known(t, 210000008);
    await deliver(t, ended(210000008, 'occ-G=='));
    expect(await endedFor(t, '210000007')).toEqual(['occ-old', 'occ-recent']);
  });

  it('leaves alone a claim for another occurrence of the same meeting', async () => {
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/210000004' })).json();
    await t.pool.query(`UPDATE claims SET occurrence_uuid = 'occ-later' WHERE id = $1`, [sent.id]);
    expect((await deliver(t, ended(210000004, 'occ-earlier'))).json()).toEqual({ status: 'tombstoned' });
    const rows = await claimsFor(t, '210000004');
    expect(rows.find((c) => c.id === sent.id)).toMatchObject({ state: 'pending', occurrence_uuid: 'occ-later' });
  });

  it("gives the bot the next waiting meeting once it leaves the ended one", async () => {
    const bot = await registerBot(t);
    const first = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/210000005' })).json();
    await promote(t, bot.bot_token, first.id, 'occ-D==');
    const waiting = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/210000006' })).json();
    expect(waiting.claim_state).toBe('pending');
    await deliver(t, ended(210000005, 'occ-D=='));
    expect((await assignment(t, bot.bot_token))?.claim_id).toBe(first.id);
    expect((await leaves(t, bot.bot_token, first.id)).statusCode).toBe(200);
    expect((await assignment(t, bot.bot_token))?.claim_id).toBe(waiting.id);
  });

  it('ignores an end without a usable meeting number', async () => {
    for (const id of ['12', 'abc', null]) {
      const res = await deliver(t, ended(id as string, 'occ-E=='));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ignored_no_meeting' });
    }
  });
});

describeDb('meeting.ended with auto-join off (QOR-4576)', () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: { ...ON, autoJoin: false }, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);
  beforeEach(() => readyBusyBot(t));

  it('still releases: the end of a meeting always does', async () => {
    storedSwitch(t).value = false;
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/220000001' })).json();
    await t.pool.query(`UPDATE claims SET occurrence_uuid = 'occ-F==' WHERE id = $1`, [sent.id]);
    expect((await deliver(t, ended(220000001, 'occ-F=='))).json()).toEqual({ status: 'released' });
    expect((await claimsFor(t, '220000001'))[0]).toMatchObject({ state: 'done' });
  });

  it('still records the ended occurrence', async () => {
    await known(t, 220000002);
    expect((await deliver(t, ended(220000002, 'occ-F2'))).json()).toEqual({ status: 'tombstoned' });
    expect(await endedFor(t, '220000002')).toEqual(['occ-F2']);
  });
});

const started = (id: number | string, uuid: string, { eventTs }: { eventTs?: number } = {}) =>
  zoomEvent(
    'meeting.started',
    { id, uuid, host_id: 'host-1', topic: 'Quarterly numbers', start_time: new Date().toISOString() },
    eventTs === undefined ? {} : { eventTs },
  );

/** Sets what the settings reader answers for the switch: `value` is JSON text, as bwat.settings holds it. */
function storeSwitch(t: TestApp, value: string) {
  storedSwitch(t).value = JSON.parse(value);
}

describeDb('meeting.started on a fresh install (QOR-4576)', () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });

  it('opens nothing on a fresh install: joining starts off', async () => {
    expect((await deliver(t, started(230000009, 'occ-9'))).json()).toEqual({ status: 'switched_off' });
    expect(await claimsFor(t, '230000009')).toEqual([]);
  });
});

describeDb('meeting.started sends bwat on its own (QOR-4576)', () => {
  const t = useAutoJoinApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);
  beforeEach(() => readyBusyBot(t));
  beforeEach(() => {
    storeSwitch(t, 'true');
    t.secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    t.lines.length = 0;
  });

  it('opens a claim for the occurrence once an admin has turned the switch on, and a ready bot takes it', async () => {
    const bot = await registerBot(t);
    const res = await deliver(t, started(230000001, 'occ-1=='));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'meeting_lookup' });
    expect(await lookupLogged(t)).toMatchObject({ outcome: 'claim_opened' });
    const claim = (await claimsFor(t, '230000001')).at(-1);
    expect(claim).toMatchObject({ state: 'claimed', bot_id: bot.bot_id, occurrence_uuid: 'occ-1==', briefing: { passcode: 'looked-up-pass' } });
    expect((await assignment(t, bot.bot_token))?.claim_id).toBe(claim.id);
  });

  it('opens nothing without the S2S app: auto-join cannot tell whether the meeting records', async () => {
    await registerBot(t);
    t.secrets.values = {};
    expect((await deliver(t, started(230000005, 'occ-5'))).json()).toEqual({ status: 'recording_unknown' });
    expect(await claimsFor(t, '230000005')).toEqual([]);
  });

  it("gives its bot the passcode Zoom answers, not the one in the meeting's last link", async () => {
    const bot = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/230000006?pwd=OldPass' })).json();
    await promote(t, bot.bot_token, sent.id, 'occ-6a');
    await deliver(t, ended(230000006, 'occ-6a'));
    await leaves(t, bot.bot_token, sent.id);
    expect(await autoJoined(t, started(230000006, 'occ-6b'))).toBe('claim_opened');
    expect((await assignment(t, bot.bot_token))?.briefing).toEqual({ passcode: 'looked-up-pass' });
  });

  it('opens no second claim for a meeting that has one open', async () => {
    await postAllocation(t, { zoom_url: 'https://zoom.us/j/230000002' });
    expect((await deliver(t, started(230000002, 'occ-2=='))).json()).toEqual({ status: 'already_claimed' });
    expect(await claimsFor(t, '230000002')).toHaveLength(1);
  });

  it('refuses a start delivered after the end of its occurrence', async () => {
    await known(t, 230000003);
    await deliver(t, ended(230000003, 'occ-3=='));
    expect((await deliver(t, started(230000003, 'occ-3=='))).json()).toEqual({ status: 'already_ended' });
    expect((await claimsFor(t, '230000003')).map((c) => c.occurrence_uuid)).toEqual([null]);
  });

  it('still opens a claim for the next occurrence of a meeting that ended', async () => {
    await known(t, 230000004);
    await deliver(t, ended(230000004, 'occ-4a'));
    expect(await autoJoined(t, started(230000004, 'occ-4b'))).toBe('claim_opened');
  });

  it('opens nothing for explicit false or malformed stored values', async () => {
    let n = 230000020;
    for (const value of ['false', '"true"', '1', '"on"', '{}']) {
      await storeSwitch(t, value);
      expect((await deliver(t, started(++n, `occ-${n}`))).json(), value).toEqual({ status: 'switched_off' });
      expect(await claimsFor(t, String(n)), value).toEqual([]);
    }
    await storeSwitch(t, 'true');
  });

  it('opens nothing when the switch cannot be read, and acts on the retry once it can', async () => {
    const event = started(230000030, 'occ-30');
    storedSwitch(t).failing = true;
    try {
      const failed = await deliver(t, event);
      expect(failed.statusCode).toBe(500);
      expect(await claimsFor(t, '230000030')).toEqual([]);
    } finally {
      storedSwitch(t).failing = false;
    }
    expect(await autoJoined(t, event)).toBe('claim_opened');
  });

  it('ignores a start more than ten minutes old (a retry from long ago)', async () => {
    const res = await deliver(t, started(230000040, 'occ-40', { eventTs: Date.now() - 11 * 60_000 }));
    expect(res.json()).toEqual({ status: 'stale_event' });
    expect(await claimsFor(t, '230000040')).toEqual([]);
  });

  it('ignores a start without a usable meeting number', async () => {
    expect((await deliver(t, started('1234', 'occ-41'))).json()).toEqual({ status: 'ignored_no_meeting' });
  });
});

describeDb('meeting.started under a deployment with auto-join off (QOR-4576)', () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: { ...ON, autoJoin: false }, autoJoinCacheMs: 0 });

  it('opens nothing, whatever the stored switch says: the env is the ceiling', async () => {
    await storeSwitch(t, 'true');
    expect((await deliver(t, started(240000001, 'occ-a'))).json()).toEqual({ status: 'auto_join_off' });
    expect(await claimsFor(t, '240000001')).toEqual([]);
  });
});

describeDb('meeting.started when the host must be present (QOR-4576)', () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: { ...ON, requireHost: true }, autoJoinCacheMs: 0 });

  it('waits for the host instead of opening a claim', async () => {
    expect((await deliver(t, started(250000001, 'occ-h'))).json()).toEqual({ status: 'waiting_for_host' });
    expect(await claimsFor(t, '250000001')).toEqual([]);
  });
});

describeDb("a meeting's start and end take turns (QOR-4576)", () => {
  const t = useZoomApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  beforeEach(() => storeSwitch(t, 'true'));
  const until = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 250 && !(await done()); i++) await new Promise((r) => setTimeout(r, 20));
  };
  const waitingOnLock = async () =>
    (
      await t.pool.query(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      )
    ).rows[0].n > 0;

  /** Runs `during` while another transaction holds the meeting's lock and has done `meanwhile`, then commits it. */
  async function whileHeld(
    meeting: string,
    meanwhile: string,
    params: unknown[],
    during: () => Promise<unknown>,
    queued: () => Promise<void> = async () => {},
  ) {
    const a = await t.pool.connect();
    try {
      await a.query('BEGIN');
      await a.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [MEETING_LOCK, meeting]);
      await a.query(meanwhile, params);
      let settled = false;
      const pending = during().finally(() => (settled = true));
      // Until it is queued behind the lock, or (were it not to take the lock) done already.
      await until(async () => settled || (await waitingOnLock()));
      await queued();
      await a.query('COMMIT');
      return await pending;
    } finally {
      a.release();
    }
  }

  it('a start waits for an end in progress, then sees its tombstone', async () => {
    const res = (await whileHeld(
      '260000001',
      `INSERT INTO zoom_ended_occurrences (meeting_number, occurrence_uuid) VALUES ($1, 'occ-r1')`,
      ['260000001'],
      () => deliver(t, started(260000001, 'occ-r1')),
    )) as Awaited<ReturnType<typeof deliver>>;
    expect(res.json()).toEqual({ status: 'already_ended' });
    expect(await claimsFor(t, '260000001')).toEqual([]);
  });

  it('records a delivery only with the change it makes: not while that change waits its turn', async () => {
    // A person's send, still open: the start stamps it with the occurrence.
    await t.pool.query(`INSERT INTO claims (meeting_number) VALUES ('260000003')`);
    const recorded = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM zoom_deliveries`)).rows[0].n;
    const before = await recorded();
    let during = -1;
    const res = (await whileHeld('260000003', `SELECT 1`, [], () => deliver(t, started(260000003, 'occ-r3')), async () => {
      during = await recorded();
    })) as Awaited<ReturnType<typeof deliver>>;
    expect(res.json()).toEqual({ status: 'already_claimed' });
    expect((await claimsFor(t, '260000003')).map((c) => c.occurrence_uuid)).toEqual(['occ-r3']);
    expect(during).toBe(before);
    expect(await recorded()).toBe(before + 1);
  });

  it('an end waits for a start in progress, then releases its claim', async () => {
    const res = (await whileHeld(
      '260000002',
      `INSERT INTO claims (meeting_number, occurrence_uuid) VALUES ($1, 'occ-r2')`,
      ['260000002'],
      () => deliver(t, ended(260000002, 'occ-r2')),
    )) as Awaited<ReturnType<typeof deliver>>;
    expect(res.json()).toEqual({ status: 'released' });
    expect((await claimsFor(t, '260000002')).map((c) => c.state)).toEqual(['done']);
  });
});

const joined = (
  id: number | string,
  uuid: string,
  participant: Record<string, unknown>,
  { startedAgoMs = 60_000, hostId = 'host-1' as string | undefined } = {},
) =>
  zoomEvent('meeting.participant_joined', {
    id,
    uuid,
    ...(hostId === undefined ? {} : { host_id: hostId }),
    topic: 'Quarterly numbers',
    start_time: new Date(Date.now() - startedAgoMs).toISOString(),
    participant: { user_name: 'Pat Example', email: 'pat@example.com', join_time: new Date().toISOString(), ...participant },
  });

describeDb('meeting.participant_joined: waiting for the host (QOR-4576)', () => {
  const HOST = { ...ON, requireHost: true };
  const t = useAutoJoinApp({ authenticatePerson: signedIn, zoom: HOST, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);
  beforeEach(() => readyBusyBot(t));
  beforeEach(() => storeSwitch(t, 'true'));

  it('opens the claim when the host arrives, and a ready bot takes it', async () => {
    const bot = await registerBot(t);
    expect((await deliver(t, started(270000001, 'occ-j1'))).json()).toEqual({ status: 'waiting_for_host' });
    expect(await autoJoined(t, joined(270000001, 'occ-j1', { id: 'host-1' }))).toBe('claim_opened');
    expect((await claimsFor(t, '270000001')).at(-1)).toMatchObject({ state: 'claimed', bot_id: bot.bot_id, occurrence_uuid: 'occ-j1' });
  });

  it("opens the claim when the host arrives named by participant_user_id (Zoom's recommended field) alone", async () => {
    expect(await autoJoined(t, joined(270000009, 'occ-j9', { participant_user_id: 'host-1' }))).toBe('claim_opened');
  });

  it('keeps waiting for another user named by participant_user_id', async () => {
    const res = await deliver(t, joined(270000010, 'occ-j10', { participant_user_id: 'someone-else' }));
    expect(res.json()).toEqual({ status: 'not_host' });
  });

  it('keeps waiting for anyone else: a guest without an id, another user, or no host on record', async () => {
    expect((await deliver(t, joined(270000002, 'occ-j2', {}))).json()).toEqual({ status: 'not_host' });
    expect((await deliver(t, joined(270000002, 'occ-j2', { id: 'someone-else' }))).json()).toEqual({ status: 'not_host' });
    expect((await deliver(t, joined(270000002, 'occ-j2', {}, { hostId: undefined }))).json()).toEqual({ status: 'not_host' });
    expect((await deliver(t, joined(270000002, 'occ-j2', { id: '' }, { hostId: '' }))).json()).toEqual({ status: 'not_host' });
    expect(await claimsFor(t, '270000002')).toEqual([]);
  });

  it('opens no second claim when the host joins again', async () => {
    expect(await autoJoined(t, joined(270000003, 'occ-j3', { id: 'host-1' }))).toBe('claim_opened');
    expect((await deliver(t, joined(270000003, 'occ-j3', { id: 'host-1' }))).json()).toEqual({ status: 'already_claimed' });
    expect(await claimsFor(t, '270000003')).toHaveLength(1);
  });

  it('stops waiting four minutes after the start: then anyone arriving opens it', async () => {
    const late = joined(270000004, 'occ-j4', { id: 'someone-else' }, { startedAgoMs: 4 * 60_000 + 30_000 });
    expect(await autoJoined(t, late)).toBe('claim_opened');
  });

  it('refuses a host who joins after the occurrence ended', async () => {
    await known(t, 270000005);
    await deliver(t, ended(270000005, 'occ-j5'));
    expect((await deliver(t, joined(270000005, 'occ-j5', { id: 'host-1' }))).json()).toEqual({ status: 'already_ended' });
  });

  it('does not send bwat back into an occurrence whose claim lapsed (the host removed it)', async () => {
    await registerBot(t);
    expect(await autoJoined(t, joined(270000007, 'occ-j7', { id: 'host-1' }))).toBe('claim_opened');
    await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE meeting_number = '270000007' AND state = 'claimed'`);
    expect((await deliver(t, joined(270000007, 'occ-j7', { id: 'host-1' }))).json()).toEqual({ status: 'already_ended' });
    expect((await claimsFor(t, '270000007')).map((c) => c.state)).toEqual(['abandoned']);
  });

  it("does not send bwat back into an occurrence where a person's send lapsed", async () => {
    await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/270000008' })).json();
    expect((await deliver(t, joined(270000008, 'occ-j8', { id: 'host-1' }))).json()).toEqual({ status: 'already_claimed' });
    await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE id = $1`, [sent.id]);
    expect((await deliver(t, joined(270000008, 'occ-j8', { id: 'host-1' }))).json()).toEqual({ status: 'already_ended' });
    expect(await claimsFor(t, '270000008')).toEqual([
      expect.objectContaining({ id: sent.id, state: 'abandoned', occurrence_uuid: 'occ-j8' }),
    ]);
  });

  it('opens nothing for the host while the stored switch is off', async () => {
    storeSwitch(t, 'false');
    try {
      expect((await deliver(t, joined(270000006, 'occ-j6', { id: 'host-1' }))).json()).toEqual({ status: 'switched_off' });
    } finally {
      storeSwitch(t, 'true');
    }
  });
});

describeDb('meeting.participant_joined when the host need not be present, or auto-join is off (QOR-4576)', () => {
  const noWait = useZoomApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  const off = useZoomApp({ authenticatePerson: signedIn, zoom: { ...ON, requireHost: true, autoJoin: false }, autoJoinCacheMs: 0 });

  it('ignores joins when the start already decided', async () => {
    expect((await deliver(noWait, joined(280000001, 'occ-k1', { id: 'host-1' }))).json()).toEqual({ status: 'ignored' });
    expect(await claimsFor(noWait, '280000001')).toEqual([]);
  });

  it('opens nothing for the host when the deployment has auto-join off', async () => {
    expect((await deliver(off, joined(280000002, 'occ-k2', { id: 'host-1' }))).json()).toEqual({ status: 'auto_join_off' });
    expect(await claimsFor(off, '280000002')).toEqual([]);
  });
});

describeDb('a settings write reaches auto-join at once through invalidate (QOR-4576)', () => {
  // The default cache window (60 s): only the invalidation can make the change seen.
  const t = useAutoJoinApp({ authenticatePerson: signedIn, zoom: ON });

  it('a fresh pre-claim read sees off even while the initial check is cached', async () => {
    await readyBusyBot(t);
    storeSwitch(t, 'true');
    expect(await autoJoined(t, started(290000001, 'occ-w1'))).toBe('claim_opened');
    storeSwitch(t, 'false');
    expect(await autoJoined(t, started(290000002, 'occ-w2'))).toBe('switched_off');
    t.app.autoJoinSwitch.invalidate();
    expect(await autoJoined(t, started(290000003, 'occ-w3'))).toBe('switched_off');
    storeSwitch(t, 'true');
    t.app.autoJoinSwitch.invalidate();
    expect(await autoJoined(t, started(290000004, 'occ-w4'))).toBe('claim_opened');
  });
});

describeDb("the stored auto_join_require_host under the env's ceiling (QOR-4576, A109)", () => {
  // The env requires the host (its default); the panel can relax that.
  const envHost = useAutoJoinApp({ authenticatePerson: signedIn, zoom: { ...ON, requireHost: true }, autoJoinCacheMs: 0 });
  // The env does not (the deployment sees no host arrivals); the panel cannot force it on.
  const envNoHost = useAutoJoinApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  beforeEach(() => {
    for (const t of [envHost, envNoHost]) {
      storedSwitch(t).value = true;
      storedSwitch(t).requireHost = undefined;
    }
  });

  it('a stored false lets the start decide, though the env would wait for the host', async () => {
    await registerBot(envHost);
    storedSwitch(envHost).requireHost = false;
    expect(await autoJoined(envHost, started(300000001, 'occ-r1'))).toBe('claim_opened');
    expect((await deliver(envHost, joined(300000002, 'occ-r2', { id: 'host-1' }))).json()).toEqual({ status: 'ignored' });
  });

  it('nothing stored, null or true: the env decides, so it waits for the host', async () => {
    for (const value of [undefined, null, true]) {
      storedSwitch(envHost).requireHost = value;
      expect((await deliver(envHost, started(300000003, 'occ-r3'))).json(), String(value)).toEqual({ status: 'waiting_for_host' });
    }
  });

  it('a stored true cannot make a deployment that does not wait for the host wait', async () => {
    await registerBot(envNoHost);
    storedSwitch(envNoHost).requireHost = true;
    expect(await autoJoined(envNoHost, started(300000004, 'occ-r4'))).toBe('claim_opened');
  });
});
