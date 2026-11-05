import { beforeEach, expect, it } from 'vitest';
import { allocate as placeClaims, ALLOCATOR_LOCK } from '../src/claims.ts';
import { bearer, postAllocation, registerBot, resetAllocationsBeforeEach, signedIn, until, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { ZOOM_S2S } from './fake-zoom.ts';
import { autoJoined, storedSwitch, useAutoJoinApp, zoomEvent } from './zoom.ts';


describeDb('POST /allocations (QOR-4571)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  const claimsFor = async (meeting: string) =>
    (await t.pool.query(`SELECT * FROM claims WHERE meeting_number = $1 ORDER BY created_at`, [meeting])).rows;

  it('refuses a request from nobody signed in', async () => {
    const res = await postAllocation(t, { zoom_url: 'https://zoom.us/j/111111111' }, {});
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    expect(await claimsFor('111111111')).toEqual([]);
  });

  it('answers 422 for anything that is not a Zoom meeting link, and opens nothing', async () => {
    for (const zoom_url of ['https://zoom.us.evil.com/j/111111112', 'https://zoom.us/j/1234', 'hello']) {
      const res = await postAllocation(t, { zoom_url });
      expect(res.statusCode, zoom_url).toBe(422);
      expect(res.json()).toEqual({ error: 'not_a_zoom_meeting_link' });
    }
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM claims WHERE state = 'pending'`)).rows[0].n).toBe(0);
  });

  it('answers 400 for a body without a link', async () => {
    expect((await postAllocation(t, {})).statusCode).toBe(400);
  });

  it('opens a pending claim (202) when no bot is ready, with the passcode in the briefing', async () => {
    await registerBot(t, { ready: false });
    const res = await postAllocation(t, { zoom_url: 'https://zoom.us/j/222222222?pwd=s3cret' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      meeting_number: '222222222',
      occurrence_id: null,
      claim_state: 'pending',
      refused_reason: null,
      error: null,
    });
    const [claim] = await claimsFor('222222222');
    expect(claim).toMatchObject({ id: body.id, state: 'pending', bot_id: null, briefing: { passcode: 's3cret' } });
  });

  it('allocates the claim to a ready free bot', async () => {
    const bot = await registerBot(t);
    const res = await postAllocation(t, { zoom_url: 'https://zoom.us/j/333333333' });
    expect(res.statusCode).toBe(202);
    expect(res.json().claim_state).toBe('claimed');
    const [claim] = await claimsFor('333333333');
    expect(claim).toMatchObject({ state: 'claimed', bot_id: bot.bot_id, generation: 1, allocation_count: 1 });
    expect(claim.lease_until.getTime()).toBeGreaterThan(Date.now());
  });

  it('gives a bot one meeting at a time', async () => {
    const bot = await registerBot(t);
    await postAllocation(t, { zoom_url: 'https://zoom.us/j/444444441' });
    const second = await postAllocation(t, { zoom_url: 'https://zoom.us/j/444444442' });
    expect(second.json().claim_state).toBe('pending');
    expect((await claimsFor('444444441'))[0].bot_id).toBe(bot.bot_id);
    expect((await claimsFor('444444442'))[0].bot_id).toBeNull();
  });

  it('never gives a meeting to a bot the fleet is draining: ECS is about to stop it (QOR-4888)', async () => {
    const draining = await registerBot(t);
    await t.pool.query(`UPDATE bots SET draining_at = now() WHERE id = $1`, [draining.bot_id]);
    expect((await postAllocation(t, { zoom_url: 'https://zoom.us/j/444444443' })).json().claim_state).toBe('pending');
    const other = await registerBot(t);
    expect((await claimsFor('444444443'))[0].bot_id).toBe(other.bot_id);
  });

  it('places a pending claim when a bot declares itself ready', async () => {
    const bot = await registerBot(t, { ready: false });
    await postAllocation(t, { zoom_url: 'https://zoom.us/j/555555555' });
    expect((await claimsFor('555555555'))[0].state).toBe('pending');
    await t.app.inject({ method: 'POST', url: '/bots/ready', headers: bearer(bot.bot_token) });
    expect((await claimsFor('555555555'))[0]).toMatchObject({ state: 'claimed', bot_id: bot.bot_id });
  });

  it('answers a repeat for an open meeting 200 already_claimed and opens no second claim', async () => {
    await registerBot(t);
    const first = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/666666666' })).json();
    const again = await postAllocation(t, { zoom_url: 'https://us02web.zoom.us/j/666666666?pwd=x' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.id, claim_state: 'claimed', status: 'already_claimed' });
    expect(await claimsFor('666666666')).toHaveLength(1);
  });

  it('re-runs allocation on a repeat while the claim is still pending', async () => {
    const first = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/777777777' })).json();
    expect(first.claim_state).toBe('pending');
    // A bot that became ready without anything being allocated (it raced the request).
    const bot = await registerBot(t, { ready: false });
    await t.pool.query(`UPDATE bots SET ready_at = now() WHERE id = $1`, [bot.bot_id]);
    const again = await postAllocation(t, { zoom_url: 'https://zoom.us/j/777777777' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.id, claim_state: 'claimed', status: 'already_claimed' });
  });

  it('does not answer already_claimed for a claim past its pending bound: that one is abandoned', async () => {
    const first = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/888888888' })).json();
    await t.pool.query(`UPDATE claims SET pending_until = now() - interval '1 second' WHERE id = $1`, [first.id]);
    const again = await postAllocation(t, { zoom_url: 'https://zoom.us/j/888888888' });
    expect(again.statusCode).toBe(202);
    const [old, fresh] = await claimsFor('888888888');
    expect(old).toMatchObject({ id: first.id, state: 'abandoned', refused_reason: 'no_bot_available' });
    expect(fresh).toMatchObject({ id: again.json().id, state: 'pending' });
  });

  it('never allocates a claim out of allocation attempts: the next allocation abandons it', async () => {
    const first = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/999999990' })).json();
    await t.pool.query(`UPDATE claims SET allocation_count = 3 WHERE id = $1`, [first.id]);
    await registerBot(t); // ready: would take it if it were placeable
    expect((await claimsFor('999999990'))[0]).toMatchObject({
      state: 'abandoned',
      bot_id: null,
      refused_reason: 'allocations_exhausted',
    });
    const again = await postAllocation(t, { zoom_url: 'https://zoom.us/j/999999990' });
    expect(again.statusCode).toBe(202);
    expect(await claimsFor('999999990')).toHaveLength(2);
  });

  it('abandons a held claim whose lease lapsed, and opens a fresh one', async () => {
    await registerBot(t);
    const first = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/999999991' })).json();
    await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE id = $1`, [first.id]);
    const again = await postAllocation(t, { zoom_url: 'https://zoom.us/j/999999991' });
    expect(again.statusCode).toBe(202);
    expect((await claimsFor('999999991'))[0]).toMatchObject({ state: 'abandoned', refused_reason: 'lease_expired' });
  });

  it('retires lapsed claims of every meeting when allocating, freeing their bots', async () => {
    const bot = await registerBot(t);
    const held = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/131313131' })).json();
    const stale = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/141414141' })).json();
    expect(stale.claim_state).toBe('pending');
    await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE id = $1`, [held.id]);
    await t.pool.query(`UPDATE claims SET pending_until = now() - interval '1 second' WHERE id = $1`, [stale.id]);
    // A request for a third meeting, not a re-send of either.
    const other = await postAllocation(t, { zoom_url: 'https://zoom.us/j/151515151' });
    expect(other.json().claim_state).toBe('claimed');
    expect((await claimsFor('151515151'))[0].bot_id).toBe(bot.bot_id);
    expect((await claimsFor('131313131'))[0]).toMatchObject({ state: 'abandoned', refused_reason: 'lease_expired' });
    expect((await claimsFor('141414141'))[0]).toMatchObject({ state: 'abandoned', refused_reason: 'no_bot_available' });
  });

  it('allocation returns the claims it placed, as rows, oldest first', async () => {
    const [a, b] = [await registerBot(t, { ready: false }), await registerBot(t, { ready: false })];
    const first = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/161616161' })).json();
    const second = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/161616162' })).json();
    await t.pool.query(`UPDATE bots SET ready_at = now() - interval '1 minute' WHERE id = $1`, [a.bot_id]);
    await t.pool.query(`UPDATE bots SET ready_at = now() WHERE id = $1`, [b.bot_id]);
    const { placed } = await placeClaims(t.pool);
    expect(placed).toEqual([
      expect.objectContaining({ id: first.id, state: 'claimed', bot_id: a.bot_id, generation: 1 }),
      expect.objectContaining({ id: second.id, state: 'claimed', bot_id: b.bot_id, generation: 1 }),
    ]);
  });
});

describeDb('allocation progress under overlapping requests (QOR-4571 review)', () => {
  const t = useApp();

  const claimsFor = async (meeting: string) =>
    (await t.pool.query(`SELECT * FROM claims WHERE meeting_number = $1`, [meeting])).rows;

  it('places a claim committed while another allocation held the free bot, with no further request', async () => {
    const bot = await registerBot(t); // ready and free; nothing pending yet
    // Allocator A, held mid-transaction: it holds the allocator lock and has locked the
    // free bot, and has already looked for pending claims (there were none).
    const a = await t.pool.connect();
    let b: ReturnType<typeof postAllocation> | undefined;
    try {
      await a.query('BEGIN');
      await a.query(`SELECT pg_advisory_xact_lock(${ALLOCATOR_LOCK})`);
      await a.query(`SELECT id FROM bots WHERE id = $1 FOR UPDATE`, [bot.bot_id]);
      // Request B commits a pending claim while A is held.
      b = postAllocation(t, { zoom_url: 'https://zoom.us/j/121212121' });
      await until(async () => (await claimsFor('121212121')).length === 1, { tries: 250, ms: 20 });
    } finally {
      await a.query('COMMIT'); // A finishes having placed nothing
      a.release();
    }
    const res = await b!;
    expect(res.json().claim_state).toBe('claimed');
    expect((await claimsFor('121212121'))[0]).toMatchObject({ state: 'claimed', bot_id: bot.bot_id });
  });
});

describeDb('POST /allocations logs (QOR-4571)', () => {
  const lines: string[] = [];
  const t = useApp({
    authenticatePerson: async () => ({ id: 'p' }),
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
  });

  it('records events, never the link, the meeting number or the passcode', async () => {
    await registerBot(t);
    const res = await postAllocation(t, { zoom_url: 'https://acme.zoom.us/j/123123123?pwd=leakypass' });
    expect(res.statusCode).toBe(202);
    const log = lines.join('');
    expect(log).toContain('"event":"allocation.requested"');
    expect(log).toContain('"event":"claim.allocated"');
    for (const secret of ['leakypass', '123123123', 'acme.zoom.us']) expect(log).not.toContain(secret);
  });
});

describeDb("a person's send is the explicit invite: it goes ahead whatever the meeting's recording setting (QOR-4608, D71)", () => {
  const t = useAutoJoinApp({ authenticatePerson: signedIn, zoom: { autoJoin: true, requireHost: false }, autoJoinCacheMs: 0 });
  const { zoom, secrets } = t;
  resetAllocationsBeforeEach(t);
  beforeEach(() => {
    storedSwitch(t).value = true;
    secrets.values = { ...ZOOM_S2S };
    zoom.calls.length = 0;
    zoom.answer = undefined;
    zoom.recording = 'none';
    t.lines.length = 0;
  });

  const claimsFor = async (meeting: string) =>
    (await t.pool.query(`SELECT * FROM claims WHERE meeting_number = $1`, [meeting])).rows;
  const started = (id: string, uuid: string) => zoomEvent('meeting.started', { id, uuid, host_id: 'host-1', start_time: new Date().toISOString() });

  it('auto-join waits for a ready bot, while a person can explicitly queue the meeting, asking Zoom only for its schedule', async () => {
    expect(await autoJoined(t, started('131313131', 'occ-P1=='))).toBe('not_ready');
    expect(await claimsFor('131313131')).toEqual([]);

    zoom.calls.length = 0;
    const res = await postAllocation(t, { zoom_url: 'https://zoom.us/j/131313131?pwd=leakypass' });
    expect(res.statusCode).toBe(202);
    expect(await claimsFor('131313131')).toEqual([expect.objectContaining({ id: res.json().id, briefing: { passcode: 'leakypass' } })]);
    expect(zoom.apiCalls().map((c) => c.url)).toEqual(['https://api.zoom.us/v2/meetings/131313131']);
  });
});
