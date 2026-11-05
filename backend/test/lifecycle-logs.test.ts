import { expect, it } from 'vitest';
import { botPost, PERSON, postAllocation, registerBot, resetAllocations } from './app.ts';
import { useAdminApp } from './people.ts';
import { describeDb } from './db/harness.ts';

describeDb('claim lifecycle logs (QOR-4571)', () => {
  const lines: string[] = [];
  const t = useAdminApp({
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
  });

  it('records events and ids, never the meeting, the passcode, the occurrence or the status', async () => {
    const MEETING = '290909090';
    const PASSCODE = 'leakypass9';
    const OCCURRENCE = 'Zk9vY2N1cnJlbmNlMQ/+Q==';
    const SHA = 'c'.repeat(64);
    const bot = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: `https://acme.zoom.us/j/${MEETING}?pwd=${PASSCODE}` })).json();
    const call = (url: string, payload: object) => botPost(t, url, bot.bot_token, payload);

    await call('/assignment/heartbeat', {
      claim_id: sent.id, generation: 1, transcript_epoch: 7, state: 'in_meeting', joined: true,
      error: 'mic_lost_in_room', dictionary_sha256: SHA, version: '9.9.9',
    });
    await call('/assignment/occurrence', { claim_id: sent.id, generation: 1, occurrence_uuid: OCCURRENCE });
    const refused = { claim_id: sent.id, generation: 5, error: 'mic_lost_in_room', dictionary_sha256: SHA };
    expect((await call('/assignment/heartbeat', refused)).statusCode).toBe(409);
    await t.app.inject({ method: 'GET', url: '/allocations', headers: PERSON });
    await t.app.inject({ method: 'GET', url: '/fleet', headers: PERSON });
    await call('/assignment/release', { claim_id: sent.id, generation: 1, reason: 'host_ended_it', meeting_ended: true });
    const other = (await postAllocation(t, { zoom_url: `https://zoom.us/j/${MEETING}1` })).json();
    await t.app.inject({ method: 'PATCH', url: `/allocations/${other.id}`, headers: PERSON, payload: { recall: true } });
    // A held claim whose lease lapses is retired by the next allocation.
    const lapsing = (await postAllocation(t, { zoom_url: `https://zoom.us/j/${MEETING}2` })).json();
    await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE id = $1`, [lapsing.id]);
    await postAllocation(t, { zoom_url: `https://zoom.us/j/${MEETING}3` });

    const log = lines.join('');
    for (const event of ['claim.stale', 'claim.released', 'allocation.recalled', 'claim.retired']) {
      expect(log, event).toContain(`"event":"${event}"`);
    }
    for (const secret of [MEETING, PASSCODE, 'acme.zoom.us', OCCURRENCE, SHA, 'mic_lost_in_room', 'host_ended_it', bot.bot_token]) {
      expect(log, secret).not.toContain(secret);
    }
  });

  it("logs a failed placement out of attempts as retired with the backend's code, never the bot's reason", async () => {
    await resetAllocations(t);
    const bot = await registerBot(t);
    const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/291919191' })).json();
    await t.pool.query(`UPDATE claims SET allocation_count = 3 WHERE id = $1`, [sent.id]);
    lines.length = 0;
    await botPost(t, '/assignment/release', bot.bot_token, { claim_id: sent.id, generation: 1, reason: 'waiting_room_timeout' });
    const log = lines.join('');
    expect(log).toContain(`"event":"claim.retired","claim_id":"${sent.id}","reason":"allocations_exhausted"`);
    expect(log).toContain(`"event":"claim.released"`);
    expect(log).not.toContain('waiting_room_timeout');
  });
});
