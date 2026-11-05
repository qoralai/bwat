import { expect, it } from 'vitest';
import {
  botPost,
  claimRow,
  expectNotRenewed,
  heldClaim,
  lapsingLease,
  occurrenceUuid,
  PERSON,
  postAllocation,
  raceBehindLock,
  registerBot,
  resetAllocationsBeforeEach,
  shortLease,
  untilLapsed,
  useApp,
} from './app.ts';
import { describeDb } from './db/harness.ts';

describeDb('POST /assignment/heartbeat (QOR-4571)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  const beat = (token: string, payload: object) => botPost(t, '/assignment/heartbeat', token, payload);

  it('renews the lease of the bot own claim and answers the claim', async () => {
    const bot = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/210000001' })).json();
    await shortLease(t, sent.id);

    const res = await beat(bot.bot_token, { claim_id: sent.id, generation: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ claim_id: sent.id, generation: 1 });
    const lease = (await claimRow(t, sent.id)).lease_until.getTime();
    expect(lease).toBeGreaterThan(Date.now() + 60_000);
  });

  it('answers 409 stale_claim, and renews nothing, for a generation that is not the claim one', async () => {
    const { bot, claimId } = await heldClaim(t, '210000002');
    await t.pool.query(`UPDATE claims SET generation = 2, lease_until = now() + interval '5 seconds' WHERE id = $1`, [claimId]);
    for (const generation of [1, 3]) {
      const res = await beat(bot.bot_token, { claim_id: claimId, generation });
      expect(res.statusCode, `generation ${generation}`).toBe(409);
      expect(res.json()).toEqual({ error: 'stale_claim' });
    }
    await expectNotRenewed(t, claimId);
  });

  it('answers 409 stale_claim for a claim that is no longer live (recalled, abandoned, released)', async () => {
    for (const [meeting, state] of [['210000003', 'abandoned'], ['210000004', 'done']] as const) {
      const { bot, claimId } = await heldClaim(t, meeting);
      await t.pool.query(`UPDATE claims SET state = $2 WHERE id = $1`, [claimId, state]);
      const res = await beat(bot.bot_token, { claim_id: claimId, generation: 1 });
      expect(res.statusCode, state).toBe(409);
      expect((await claimRow(t, claimId)).state).toBe(state);
    }
  });

  it('answers 409 stale_claim for a lease that already lapsed: it cannot be renewed back to life', async () => {
    const { bot, claimId } = await heldClaim(t, '210000005');
    await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE id = $1`, [claimId]);
    expect((await beat(bot.bot_token, { claim_id: claimId, generation: 1 })).statusCode).toBe(409);
    expect((await claimRow(t, claimId)).lease_until.getTime()).toBeLessThan(Date.now());
  });

  it("answers 409 stale_claim to a bot naming another bot's claim, and leaves that claim alone", async () => {
    const { claimId } = await heldClaim(t, '210000006');
    const other = await registerBot(t, { ready: false });
    await shortLease(t, claimId);
    expect((await beat(other.bot_token, { claim_id: claimId, generation: 1 })).statusCode).toBe(409);
    await expectNotRenewed(t, claimId);
  });

  const STATUS = {
    state: 'in_meeting',
    joined: true,
    recording: true,
    hearing: true,
    muted: false,
    error: null,
    dictionary_sha256: 'a'.repeat(64),
    version: '1.2.3',
  };
  const botRow = async (id: string) => (await t.pool.query(`SELECT * FROM bots WHERE id = $1`, [id])).rows[0];

  it("stores the bot's status as a snapshot, and its version and heartbeat time", async () => {
    const { bot, claimId } = await heldClaim(t, '210000007');
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() - interval '1 minute' WHERE id = $1`, [bot.bot_id]);
    await beat(bot.bot_token, { claim_id: claimId, generation: 1, ...STATUS, error: 'mic_lost', unknown_field: 'x' });
    expect((await botRow(bot.bot_id)).status).toEqual({ ...STATUS, error: 'mic_lost' });
    // A snapshot, not a merge: a recovered bot stops showing the error it no longer has.
    await beat(bot.bot_token, { claim_id: claimId, generation: 1, joined: true });
    const row = await botRow(bot.bot_id);
    expect(row.status).toEqual({ joined: true });
    expect(row.version).toBe('1.2.3');
    expect(row.last_heartbeat.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it('moves a claimed claim to attending once the bot reports it joined, and stores the transcript epoch', async () => {
    const { bot, claimId } = await heldClaim(t, '210000008');
    await beat(bot.bot_token, { claim_id: claimId, generation: 1, joined: false, transcript_epoch: 2 });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'claimed', transcript_epoch: 2 });
    await beat(bot.bot_token, { claim_id: claimId, generation: 1, joined: true });
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'attending', transcript_epoch: 2 });
  });

  it('records when the bot joined on its first joined report, keeps it after, shows it on GET /allocations, and clears it on a requeue', async () => {
    const { bot, claimId } = await heldClaim(t, '210000012');
    await beat(bot.bot_token, { claim_id: claimId, generation: 1, joined: false });
    expect((await claimRow(t, claimId)).joined_at).toBeNull();
    await beat(bot.bot_token, { claim_id: claimId, generation: 1, joined: true });
    const joined = (await claimRow(t, claimId)).joined_at as Date;
    expect(joined.getTime()).toBeGreaterThan(Date.now() - 5_000);
    await t.pool.query(`UPDATE claims SET joined_at = joined_at - interval '1 minute' WHERE id = $1`, [claimId]);
    await beat(bot.bot_token, { claim_id: claimId, generation: 1, joined: true });
    const kept = (await claimRow(t, claimId)).joined_at as Date;
    expect(kept.getTime()).toBe(joined.getTime() - 60_000);
    const listed = (await t.app.inject({ method: 'GET', url: '/allocations', headers: PERSON })).json().allocations;
    expect(listed.find((a: { id: string }) => a.id === claimId).joined_at).toBe(kept.toISOString());
    await botPost(t, '/assignment/release', bot.bot_token, { claim_id: claimId, generation: 1, requeue: true });
    expect((await claimRow(t, claimId)).joined_at).toBeNull();
  });

  it('answers 400 for a fence it cannot use: no claim, a generation or epoch that is not a 32-bit count', async () => {
    const { bot, claimId } = await heldClaim(t, '210000009');
    for (const bad of [
      { generation: 1 },
      { claim_id: claimId, generation: 'one' },
      { claim_id: claimId, generation: -1 },
      { claim_id: claimId, generation: 2147483648 },
      { claim_id: claimId, generation: 1, transcript_epoch: -1 },
      { claim_id: claimId, generation: 1, transcript_epoch: 2147483648 },
    ]) {
      expect((await beat(bot.bot_token, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('renews the lease even when the report is unusable: what it cannot store is dropped, never refused', async () => {
    const { bot, claimId } = await heldClaim(t, '210000011');
    await shortLease(t, claimId);
    const res = await beat(bot.bot_token, {
      claim_id: claimId,
      generation: 1,
      joined: true,
      state: 'In the Acme standup',
      error: 'Mic lost in Acme standup',
      dictionary_sha256: 'xyz',
      recording: 'yes',
    });
    expect(res.statusCode).toBe(200);
    expect((await claimRow(t, claimId)).lease_until.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect((await botRow(bot.bot_id)).status).toEqual({ joined: true });
  });

  it('refuses a caller with no bot token (401), and a fleet credential (409 unregistered_bot)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/assignment/heartbeat', payload: {} });
    expect(res.statusCode).toBe(401);
    const { issueFleetCredential } = await import('../src/credentials.ts');
    const fleet = await beat(await issueFleetCredential(t.pool), {});
    expect(fleet.statusCode).toBe(409);
    expect(fleet.json()).toEqual({ error: 'unregistered_bot' });
  });

  it('takes a heartbeat with no claim from an idle bot: stores its status, answers null', async () => {
    const bot = await registerBot(t, { ready: false });
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() - interval '1 minute' WHERE id = $1`, [bot.bot_id]);
    const res = await beat(bot.bot_token, { state: 'idle' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    const row = await botRow(bot.bot_id);
    expect(row.status).toEqual({ state: 'idle' });
    expect(row.last_heartbeat.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it('never allocates a ready bot unheard from for over 45 s; its next heartbeat makes it a candidate again', async () => {
    const bot = await registerBot(t);
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() - interval '46 seconds' WHERE id = $1`, [bot.bot_id]);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/210000010' })).json();
    expect(sent.claim_state).toBe('pending');
    // An idle ready bot that beats pulls the waiting claim; it reads it from GET /assignment.
    expect((await beat(bot.bot_token, { state: 'ready' })).json()).toBeNull();
    expect(await claimRow(t, sent.id)).toMatchObject({ state: 'claimed', bot_id: bot.bot_id });
  });
  it('stores the status and heartbeat time of a bot whose beat answers stale_claim', async () => {
    const { bot, claimId } = await heldClaim(t, '210000012');
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() - interval '1 minute' WHERE id = $1`, [bot.bot_id]);
    const res = await beat(bot.bot_token, { claim_id: claimId, generation: 2, state: 'leaving' });
    expect(res.json()).toEqual({ error: 'stale_claim' });
    const row = await botRow(bot.bot_id);
    expect(row.status).toEqual({ state: 'leaving' });
    expect(row.last_heartbeat.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("takes the claim's lock before the bot's, as a release does, so a heartbeat racing a requeue never deadlocks", async () => {
    const { bot, claimId } = await heldClaim(t, '210000011');
    // The holder locks as releaseClaim's requeue and retry do: the claim, then (once the
    // heartbeat waits on it, so the race is fixed) the bot.
    const res = await raceBehindLock(
      t,
      { sql: `SELECT 1 FROM claims WHERE id = $1 FOR UPDATE`, params: [claimId] },
      () => beat(bot.bot_token, { claim_id: claimId, generation: 1 }),
      (holder) => holder.query(`UPDATE bots SET ready_at = NULL WHERE id = $1`, [bot.bot_id]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ claim_id: claimId, generation: 1 });
  });
  it('judges the lease after it holds the claim: one that lapsed while a lock that changed nothing held it is refused', async () => {
    const { bot, claimId } = await heldClaim(t, '210000014');
    // A plain row lock updates nothing, so PostgreSQL never re-reads the heartbeat's
    // predicate once it gets the row: a clock in that predicate was read before the wait.
    await lapsingLease(t, claimId, 1500);
    const res = await raceBehindLock(
      t,
      { sql: `SELECT 1 FROM claims WHERE id = $1 FOR UPDATE`, params: [claimId] },
      () => beat(bot.bot_token, { claim_id: claimId, generation: 1 }),
      () => untilLapsed(t, claimId),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_claim' });
    expect((await claimRow(t, claimId)).lease_until.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('answers what it commits when the lease lapses between the fence and the write: renewed, and the epoch it raised is the claim one', async () => {
    const { bot, claimId } = await heldClaim(t, '210000013');
    const uuid = occurrenceUuid();
    expect((await botPost(t, '/assignment/occurrence', bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid })).statusCode).toBe(200);
    // The bot's lock is the one a heartbeat takes after passing the fence on the claim's.
    const res = await raceBehindLock(
      t,
      { sql: `SELECT 1 FROM bots WHERE id = $1 FOR UPDATE`, params: [bot.bot_id] },
      // The lease is set as the call starts, so it is live when the fence is read.
      async () => (await lapsingLease(t, claimId, 1500), beat(bot.bot_token, { claim_id: claimId, generation: 1, transcript_epoch: 5 })),
      () => untilLapsed(t, claimId),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ claim_id: claimId, transcript_epoch: 5 });
    const row = await claimRow(t, claimId);
    expect(row).toMatchObject({ state: 'claimed', transcript_epoch: 5 });
    expect(row.lease_until.getTime()).toBeGreaterThan(Date.now() + 60_000);
    const highest = (await t.pool.query(`SELECT highest_epoch FROM occurrence_epochs WHERE occurrence_uuid = $1`, [uuid])).rows[0];
    expect(highest).toEqual({ highest_epoch: 5 });
  });
});
