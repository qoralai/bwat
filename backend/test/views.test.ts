import { expect, it } from 'vitest';
import { bearer, botPost, PERSON, postAllocation, registerBot, resetAllocationsBeforeEach, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';

describeDb('GET /allocations (QOR-4571)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  const list = (headers: Record<string, string> = PERSON) => t.app.inject({ method: 'GET', url: '/allocations', headers });

  it("lists live and recent claims, newest first, each with its bot's last error", async () => {
    const bot = await registerBot(t);
    const held = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/250000001' })).json();
    const waiting = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/250000002' })).json();
    const old = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/250000003' })).json();
    await t.pool.query(`UPDATE claims SET state = 'abandoned', ended_at = now() - interval '25 hours' WHERE id = $1`, [old.id]);
    await botPost(t, '/assignment/heartbeat', bot.bot_token, {
      claim_id: held.id, generation: 1, joined: true, recording: true, hearing: true, muted: false, error: 'mic_lost',
    });

    const res = await list();
    expect(res.statusCode).toBe(200);
    const { allocations } = res.json();
    const ids = allocations.map((a: { id: string }) => a.id);
    expect(ids.indexOf(waiting.id)).toBeLessThan(ids.indexOf(held.id));
    expect(ids).not.toContain(old.id);
    expect(allocations.find((a: { id: string }) => a.id === held.id)).toEqual({
      id: held.id,
      meeting_number: '250000001',
      occurrence_id: null,
      claim_state: 'attending',
      refused_reason: null,
      last_placement_failure: null,
      meeting_title: null,
      error: 'mic_lost',
      created_at: expect.any(String),
      joined_at: expect.any(String),
      ended_at: null,
    });
    expect(allocations.find((a: { id: string }) => a.id === waiting.id)).toMatchObject({ claim_state: 'pending', error: null });
  });

  it('says why the last try at a send failed, as the admin words it', async () => {
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/250000004' })).json();
    await t.pool.query(
      `UPDATE claims SET state = 'abandoned', refused_reason = 'allocations_exhausted', last_placement_failure = 'waiting_room_timeout', ended_at = now() WHERE id = $1`,
      [sent.id],
    );
    const listed = (await list()).json().allocations.find((a: { id: string }) => a.id === sent.id);
    expect(listed).toMatchObject({
      claim_state: 'refused',
      refused_reason: 'allocations_exhausted',
      last_placement_failure: 'waiting_room_timeout',
      created_at: expect.any(String),
      joined_at: null,
      ended_at: expect.any(String),
    });
  });

  it("names a send's meeting once bwat has its title, and none before", async () => {
    const named = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/250000005' })).json();
    const unnamed = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/250000006' })).json();
    await t.pool.query(`INSERT INTO meetings (occurrence_uuid, meeting_number, title) VALUES ('alloc/occ+1==', '250000005', 'Design Review')`);
    await t.pool.query(`UPDATE claims SET occurrence_uuid = 'alloc/occ+1==' WHERE id = $1`, [named.id]);
    const { allocations } = (await list()).json();
    const of = (id: string) => allocations.find((a: { id: string }) => a.id === id);
    expect(of(named.id).meeting_title).toBe('Design Review');
    expect(of(unnamed.id).meeting_title).toBeNull();
  });

  it('refuses nobody signed in', async () => {
    expect((await list({})).statusCode).toBe(401);
  });
});

describeDb('GET /fleet (QOR-4571)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  const fleet = async (headers: Record<string, string> = PERSON) =>
    t.app.inject({ method: 'GET', url: '/fleet', headers });
  const rowOf = (rows: { bot_id: string }[], id: string) => rows.find((r) => r.bot_id === id);

  it('shows one row per live bot: its claim, its last report, and whether its heartbeat is stale', async () => {
    const busy = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/260000001' })).json();
    await botPost(t, '/assignment/heartbeat', busy.bot_token, {
      claim_id: sent.id, generation: 1, state: 'in_meeting', joined: true, recording: true, hearing: true, muted: true,
      error: null, dictionary_sha256: 'b'.repeat(64), version: '2.0.0',
    });
    const idle = await registerBot(t);
    const quiet = await registerBot(t);
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() - interval '46 seconds' WHERE id = $1`, [quiet.bot_id]);
    const gone = await registerBot(t);
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() - interval '1 hour' WHERE id = $1`, [gone.bot_id]);

    const res = await fleet();
    expect(res.statusCode).toBe(200);
    const rows = res.json().fleet;
    expect(rowOf(rows, busy.bot_id)).toEqual({
      bot_id: busy.bot_id,
      version: '2.0.0',
      ready: true,
      busy: true,
      stale: false,
      last_report_at: expect.any(String),
      state: 'in_meeting',
      joined: true,
      recording: true,
      hearing: true,
      muted: true,
      error: null,
      dictionary_sha256: 'b'.repeat(64),
      claim_id: sent.id,
      claim_state: 'attending',
      meeting_number: '260000001',
      occurrence_id: null,
      meeting_title: null,
      meeting_started_at: null,
    });
    expect(rowOf(rows, idle.bot_id)).toMatchObject({ stale: false, ready: true, claim_id: null, claim_state: null });
    expect(rowOf(rows, quiet.bot_id)).toMatchObject({ stale: true });
    expect(rowOf(rows, gone.bot_id)).toBeUndefined();
    expect(rows.filter((r: { bot_id: string }) => r.bot_id === busy.bot_id)).toHaveLength(1);
  });

  it("names the meeting a bot is in and when it started, from the meeting's own row", async () => {
    const bot = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/260000003' })).json();
    const { rows } = await t.pool.query(
      `INSERT INTO meetings (occurrence_uuid, meeting_number, title) VALUES ('fleet/occ+1==', '260000003', 'Weekly sync') RETURNING started_at`,
    );
    await t.pool.query(`UPDATE claims SET occurrence_uuid = 'fleet/occ+1==' WHERE id = $1`, [sent.id]);
    expect(rowOf((await fleet()).json().fleet, bot.bot_id)).toMatchObject({
      occurrence_id: 'fleet/occ+1==',
      meeting_title: 'Weekly sync',
      meeting_started_at: rows[0].started_at.toISOString(),
    });
  });

  it('keeps a bot that still holds a claim, however long it has been silent', async () => {
    const bot = await registerBot(t);
    await postAllocation(t, { zoom_url: 'https://zoom.us/j/260000002' });
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() - interval '1 hour' WHERE id = $1`, [bot.bot_id]);
    expect(rowOf((await fleet()).json().fleet, bot.bot_id)).toMatchObject({ stale: true, claim_state: 'claimed' });
  });

  it('refuses nobody signed in, and a bot token', async () => {
    expect((await fleet({})).statusCode).toBe(401);
    const bot = await registerBot(t);
    expect((await fleet(bearer(bot.bot_token))).statusCode).toBe(401);
  });
});
