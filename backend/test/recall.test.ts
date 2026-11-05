import { expect, it, vi } from 'vitest';
import { lockMeeting, MEETING_LOCK, recallClaim } from '../src/claims.ts';
import { botPost, claimRow, PERSON, postAllocation, registerBot, resetAllocationsBeforeEach } from './app.ts';
import { useAdminApp } from './people.ts';
import { describeDb } from './db/harness.ts';

describeDb('PATCH /allocations/{id} (QOR-4571)', () => {
  const t = useAdminApp();
  resetAllocationsBeforeEach(t);

  const patch = (id: string, payload: object, headers: Record<string, string> = PERSON) =>
    t.app.inject({ method: 'PATCH', url: `/allocations/${id}`, headers, payload });

  it('recalls a pending claim: it is cancelled and never allocated', async () => {
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/240000001' })).json();
    const res = await patch(sent.id, { recall: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: sent.id, claim_state: 'refused', refused_reason: 'recalled' });
    await registerBot(t); // ready: would take it if it were still pending
    expect(await claimRow(t, sent.id)).toMatchObject({ state: 'abandoned', bot_id: null, refused_reason: 'recalled' });
  });

  const beat = (token: string, payload: object) => botPost(t, '/assignment/heartbeat', token, payload);

  it('serializes recall with an invitation holding the meeting lock', async () => {
    const number = '240000009';
    const sent = (await postAllocation(t, { zoom_url: `https://zoom.us/j/${number}` })).json();
    const client = await t.pool.connect();
    let completed = false;
    let recalled: ReturnType<typeof recallClaim> | undefined;
    try {
      await client.query('BEGIN');
      await lockMeeting(client, number);
      recalled = recallClaim(t.pool, sent.id).then(result => { completed = true; return result; });
      await vi.waitFor(async () => {
        const waiting = await t.pool.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
          AND NOT granted AND classid = $1::oid AND objid = hashtext($2)::oid`, [MEETING_LOCK, number]);
        expect(completed || waiting.rowCount !== 0).toBe(true);
      });
      expect(completed).toBe(false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      if (recalled) await recalled;
    }
    expect((await claimRow(t, sent.id)).refused_reason).toBe('recalled');
  });

  it("recalls a held claim: its bot learns on its next heartbeat (409 stale_claim); other claims are untouched", async () => {
    const bot = await registerBot(t);
    const other = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/240000002' })).json();
    const kept = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/240000003' })).json();
    const holder = (await claimRow(t, sent.id)).bot_id === bot.bot_id ? bot : other;

    expect((await patch(sent.id, { recall: true })).json()).toMatchObject({ claim_state: 'refused', refused_reason: 'recalled' });
    const res = await beat(holder.bot_token, { claim_id: sent.id, generation: 1, joined: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_claim' });
    expect(await claimRow(t, kept.id)).toMatchObject({ state: 'claimed', refused_reason: null });
  });

  it('frees the recalled bot at once: it may be given the next meeting, and leaves the old one on its 409', async () => {
    const bot = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/240000004' })).json();
    await patch(sent.id, { recall: true });
    const next = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/240000005' })).json();
    expect(await claimRow(t, next.id)).toMatchObject({ state: 'claimed', bot_id: bot.bot_id });
  });

  it('answers 409 not_live to a recall of a claim that already ended, and changes nothing', async () => {
    await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/240000006' })).json();
    await t.pool.query(`UPDATE claims SET state = 'done', refused_reason = 'could_not_join' WHERE id = $1`, [sent.id]);
    const res = await patch(sent.id, { recall: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not_live' });
    expect(await claimRow(t, sent.id)).toMatchObject({ state: 'done', refused_reason: 'could_not_join' });
  });

  it('answers 400 to a body that is not a recall alone (QOR-4894: settings are gone); 404 to an unknown id; 401 to nobody', async () => {
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/240000008' })).json();
    for (const body of [{}, { recall: false }, { recall: true, settings: { voice: 'cedar' } }, { settings: { voice: 'cedar' } }]) {
      expect((await patch(sent.id, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await patch('00000000-0000-4000-8000-000000000000', { recall: true })).statusCode).toBe(404);
    expect((await patch('not-a-uuid', { recall: true })).statusCode).toBe(404);
    expect((await patch(sent.id, { recall: true }, {})).statusCode).toBe(401);
    expect((await claimRow(t, sent.id)).state).toBe('pending');
  });
});
