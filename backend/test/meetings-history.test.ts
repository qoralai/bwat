import { beforeEach, describe, expect, it } from 'vitest';
import { PERSON, useApp } from './app.ts';
import { meetingBotStatus } from '../src/claims.ts';
import { describeDb } from './db/harness.ts';

describeDb('GET /meetings (QOR-4577)', () => {
  const t = useApp();

  beforeEach(async () => {
    await t.pool.query(`DELETE FROM meetings`);
  });

  const history = (query = '', headers: Record<string, string> = PERSON) =>
    t.app.inject({ method: 'GET', url: `/meetings${query}`, headers });

  const meeting = async (occurrence: string, startedAt: string, over: Record<string, unknown> = {}) =>
    (
      await t.pool.query<{ id: string }>(
        `INSERT INTO meetings (occurrence_uuid, meeting_number, started_at, ended_at, title, host_email, attendee_count, finalization)
         VALUES ($1, '123456789', $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          occurrence,
          startedAt,
          over.ended_at ?? null,
          over.title ?? null,
          over.host_email ?? null,
          over.attendee_count ?? null,
          over.finalization ?? 'open',
        ],
      )
    ).rows[0]!.id;

  it('needs a signed-in person', async () => {
    const res = await history('', {});
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('answers 403 not_onboarded on every people meeting route until the install has an activated owner (D149), 401 first', async () => {
    const id = await meeting('not-onboarded', '2026-09-01T10:00:00Z');
    await t.pool.query(`UPDATE members SET activated_at = NULL WHERE role = 'owner'`);
    try {
      for (const [method, url] of [
        ['GET', '/meetings'],
        ['GET', `/meetings/${id}/transcript`],
        ['DELETE', `/meetings/${id}`],
      ] as const) {
        expect((await t.app.inject({ method, url })).statusCode, url).toBe(401);
        const res = await t.app.inject({ method, url, headers: PERSON });
        expect(res.statusCode, url).toBe(403);
        expect(res.json()).toEqual({ error: 'not_onboarded' });
      }
    } finally {
      await t.pool.query(`UPDATE members SET activated_at = now() WHERE role = 'owner'`);
    }
  });

  it('lists meetings newest first, with their history fields and whether a transcript exists', async () => {
    const older = await meeting('occ-1', '2026-09-01T10:00:00.000Z', {
      ended_at: '2026-09-01T10:30:00.000Z',
      title: 'Weekly sync',
      host_email: 'grace@example.com',
      attendee_count: 4,
      finalization: 'transcript_complete',
    });
    const newer = await meeting('occ-2', '2026-09-02T10:00:00.000Z');
    await t.pool.query(
      `INSERT INTO transcript_segments (meeting_id, epoch, seq, speaker_label, text, start_ms, end_ms)
       VALUES ($1, 1, 0, 'A', 'hi', 0, 1)`,
      [older],
    );

    const res = await history();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      meetings: [
        {
          id: newer,
          occurrence_id: 'occ-2',
          title: null,
          host_email: null,
          started_at: '2026-09-02T10:00:00.000Z',
          ended_at: null,
          duration_seconds: null,
          attendee_count: null,
          transcript_available: false,
          finalization: 'open',
          // No claim open and no end recorded: the bot left without its final push.
          occurrence_state: 'abandoned',
          bot_ids: [],
          bot_error: null,
          bot_present: false,
          transcript_expired: false,
          transcript_expired_at: null,
        },
        {
          id: older,
          occurrence_id: 'occ-1',
          title: 'Weekly sync',
          host_email: 'grace@example.com',
          started_at: '2026-09-01T10:00:00.000Z',
          ended_at: '2026-09-01T10:30:00.000Z',
          duration_seconds: 1800,
          attendee_count: 4,
          transcript_available: true,
          finalization: 'transcript_complete',
          occurrence_state: 'ended',
          bot_ids: [],
          bot_error: null,
          bot_present: false,
          transcript_expired: false,
          transcript_expired_at: null,
        },
      ],
      next_cursor: null,
    });
  });

  it('says a meeting is live only while a claim is open for it, as the board shows Live (QOR-4722)', async () => {
    await meeting('occ-live', '2026-09-02T10:00:00.000Z');
    const claim = await t.pool.query<{ id: string }>(
      `INSERT INTO claims (meeting_number, occurrence_uuid) VALUES ('123456789', 'occ-live') RETURNING id`,
    );
    expect((await history()).json().meetings[0]).toMatchObject({ occurrence_id: 'occ-live', ended_at: null, occurrence_state: 'live' });
    // The bot's lease lapsed with no final push: ended_at stays null, and it is no longer live.
    await t.pool.query(`UPDATE claims SET state = 'abandoned', ended_at = now() WHERE id = $1`, [claim.rows[0]!.id]);
    expect((await history()).json().meetings[0]).toMatchObject({ ended_at: null, occurrence_state: 'abandoned' });
  });

  it('names the bots that were in each meeting, so the admin History tab can link to them (QOR-4722)', async () => {
    await meeting('occ-bot', '2026-09-02T10:00:00.000Z');
    const cred = await t.pool.query<{ id: string }>(
      `INSERT INTO fleet_credentials (token_sha256) VALUES (sha256('fleet-history')) RETURNING id`,
    );
    const bot = await t.pool.query<{ id: string }>(
      `INSERT INTO bots (fleet_credential_id, token_sha256) VALUES ($1, sha256('bot-history')) RETURNING id`,
      [cred.rows[0]!.id],
    );
    await t.pool.query(
      `INSERT INTO claims (meeting_number, occurrence_uuid, bot_id, state, ended_at)
       VALUES ('123456789', 'occ-bot', $1, 'done', now())`,
      [bot.rows[0]!.id],
    );
    expect((await history()).json().meetings[0]).toMatchObject({ occurrence_id: 'occ-bot', bot_ids: [bot.rows[0]!.id] });
  });

  it("carries the error the bot in a live meeting reports, so the board can say the model key is out of credit (QOR-4738)", async () => {
    await meeting('occ-credit', '2026-09-02T10:00:00.000Z');
    const cred = await t.pool.query<{ id: string }>(
      `INSERT INTO fleet_credentials (token_sha256) VALUES (sha256('fleet-credit')) RETURNING id`,
    );
    const bot = await t.pool.query<{ id: string }>(
      `INSERT INTO bots (fleet_credential_id, token_sha256, status) VALUES ($1, sha256('bot-credit'), '{"error": "model_out_of_credit"}') RETURNING id`,
      [cred.rows[0]!.id],
    );
    const claim = await t.pool.query<{ id: string }>(
      `INSERT INTO claims (meeting_number, occurrence_uuid, bot_id, state, lease_until)
       VALUES ('123456789', 'occ-credit', $1, 'attending', now() + interval '90 seconds') RETURNING id`,
      [bot.rows[0]!.id],
    );
    expect((await history()).json().meetings[0]).toMatchObject({ occurrence_state: 'live', bot_error: 'model_out_of_credit' });
    // The next heartbeat without it: the bot's calls succeed again.
    await t.pool.query(`UPDATE bots SET status = '{"joined": true}' WHERE id = $1`, [bot.rows[0]!.id]);
    expect((await history()).json().meetings[0]).toMatchObject({ bot_error: null });
    // A bot that has left the meeting reports nothing for it.
    await t.pool.query(`UPDATE bots SET status = '{"error": "model_out_of_credit"}' WHERE id = $1`, [bot.rows[0]!.id]);
    await t.pool.query(`UPDATE claims SET state = 'done', ended_at = now(), lease_until = NULL WHERE id = $1`, [claim.rows[0]!.id]);
    expect((await history()).json().meetings[0]).toMatchObject({ bot_error: null });
  });

  // The board's Live pill means bwat is in the meeting: a claim open only waits for a bot, and a
  // bot in its claim has joined only once it says so.
  it('says whether a bot is in the meeting now: in its claim, joined, and heard from lately', async () => {
    await meeting('occ-present', '2026-09-02T10:00:00.000Z');
    const cred = await t.pool.query<{ id: string }>(
      `INSERT INTO fleet_credentials (token_sha256) VALUES (sha256('fleet-present')) RETURNING id`,
    );
    const bot = await t.pool.query<{ id: string }>(
      `INSERT INTO bots (fleet_credential_id, token_sha256, status) VALUES ($1, sha256('bot-present'), '{"joined": true}') RETURNING id`,
      [cred.rows[0]!.id],
    );
    const claim = await t.pool.query<{ id: string }>(
      `INSERT INTO claims (meeting_number, occurrence_uuid, bot_id, state, lease_until, allocated_at)
       VALUES ('123456789', 'occ-present', $1, 'claimed', now() + interval '90 seconds', now() - interval '10 minutes') RETURNING id`,
      [bot.rows[0]!.id],
    );
    const present = async () => (await history()).json().meetings[0];
    // Claimed, not yet attending: on its way, whatever the bot last said.
    expect(await present()).toMatchObject({ occurrence_state: 'live', bot_present: false });
    await t.pool.query(`UPDATE claims SET state = 'attending' WHERE id = $1`, [claim.rows[0]!.id]);
    await t.pool.query(`UPDATE bots SET status = '{"state": "waiting_room"}' WHERE id = $1`, [bot.rows[0]!.id]);
    expect(await present()).toMatchObject({ occurrence_state: 'live', bot_present: false });
    await t.pool.query(`UPDATE bots SET status = '{"joined": true}', last_heartbeat = now() WHERE id = $1`, [bot.rows[0]!.id]);
    expect(await present()).toMatchObject({ occurrence_state: 'live', bot_present: true });
    // Silent: not confidently in (claims.ts STALE_SECONDS).
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() - interval '1 minute' WHERE id = $1`, [bot.rows[0]!.id]);
    expect(await present()).toMatchObject({ bot_present: false });
    // A report from before this claim was allocated is another meeting's.
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() WHERE id = $1`, [bot.rows[0]!.id]);
    await t.pool.query(`UPDATE claims SET allocated_at = now() + interval '1 second' WHERE id = $1`, [claim.rows[0]!.id]);
    expect(await present()).toMatchObject({ bot_present: false });
  });

  // The list and the Zoom panel's own check (meetingBotStatus) answer one question: they agree
  // where they once could not.
  describe('agrees with the Zoom panel\'s check of the meeting', () => {
    let occ = '';
    const present = async () => (await history()).json().meetings[0].bot_present as boolean;
    const checked = async () => (await meetingBotStatus(t.pool, occ)).state;
    // A bot in the meeting, joined and heard from now, on an attending claim.
    async function inMeeting() {
      // One open claim a meeting number: the earlier tests' claims end first.
      await t.pool.query(`UPDATE claims SET state = 'done', ended_at = now() WHERE state IN ('pending', 'claimed', 'attending')`);
      occ = `occ-agree-${Math.random()}`;
      await meeting(occ, '2026-09-02T10:00:00.000Z');
      const cred = await t.pool.query<{ id: string }>(`INSERT INTO fleet_credentials (token_sha256) VALUES (sha256(convert_to(gen_random_uuid()::text, 'UTF8'))) RETURNING id`);
      const bot = await t.pool.query<{ id: string }>(
        `INSERT INTO bots (fleet_credential_id, token_sha256, status) VALUES ($1, sha256(convert_to(gen_random_uuid()::text, 'UTF8')), '{"joined": true}') RETURNING id`,
        [cred.rows[0]!.id],
      );
      const claim = await t.pool.query<{ id: string }>(
        `INSERT INTO claims (meeting_number, occurrence_uuid, bot_id, state, lease_until, allocated_at)
         VALUES ('123456789', $2, $1, 'attending', now() + interval '90 seconds', now() - interval '10 minutes') RETURNING id`,
        [bot.rows[0]!.id, occ],
      );
      expect([await present(), await checked()]).toEqual([true, 'present']);
      return { bot: bot.rows[0]!.id, claim: claim.rows[0]!.id };
    }

    it('a bot recalled is leaving, not in', async () => {
      const { claim } = await inMeeting();
      await t.pool.query(`UPDATE claims SET state = 'abandoned', refused_reason = 'recalled', ended_at = now() WHERE id = $1`, [claim]);
      expect([await present(), await checked()]).toEqual([false, 'leaving']);
    });

    it('a lease that ran out before the bot went quiet is not in', async () => {
      const { claim } = await inMeeting();
      await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE id = $1`, [claim]);
      expect([await present(), await checked()]).toEqual([false, 'failed']);
    });

    // Zoom's end is recorded while the claim drains: still live, but the meeting is over.
    it('a meeting whose end is recorded is not one bwat is in, though its claim is still open', async () => {
      const { claim } = await inMeeting();
      await t.pool.query(`UPDATE claims SET meeting_ended_at = now() WHERE id = $1`, [claim]);
      expect((await history()).json().meetings[0].occurrence_state).toBe('live');
      expect([await present(), await checked()]).toEqual([false, 'ended']);
    });

    it('reads only the latest claim: an older one attending does not count once a newer one ended', async () => {
      const { bot } = await inMeeting();
      await t.pool.query(
        `INSERT INTO claims (meeting_number, occurrence_uuid, bot_id, state, ended_at, created_at)
         VALUES ('123456789', $2, $1, 'done', now(), now() + interval '1 second')`,
        [bot, occ],
      );
      expect([await present(), await checked()]).toEqual([false, 'absent']);
    });
  });

  it('pages by (started_at desc, id desc): every meeting exactly once, ties included', async () => {
    const tie = '2026-09-03T09:00:00.123Z';
    const ids = [
      await meeting('p-1', tie),
      await meeting('p-2', tie),
      await meeting('p-3', '2026-09-03T08:00:00.000Z'),
      await meeting('p-4', '2026-09-03T10:00:00.000Z'),
    ];
    const tied = ids.slice(0, 2).sort().reverse();
    const expected = [ids[3], ...tied, ids[2]];

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await history(`?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      seen.push(...body.meetings.map((m: { id: string }) => m.id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(expected);
  });

  it('defaults to 25 a page and refuses a bad limit or cursor', async () => {
    for (let i = 0; i < 26; i++) await meeting(`d-${i}`, `2026-08-01T00:00:${String(i).padStart(2, '0')}.000Z`);
    const first = (await history()).json();
    expect(first.meetings).toHaveLength(25);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect((await history(`?cursor=${encodeURIComponent(first.next_cursor)}`)).json().meetings).toHaveLength(1);
    for (const q of ['?limit=0', '?limit=101', '?limit=abc', '?cursor=nope', '?cursor=bm9wZQ']) {
      expect((await history(q)).statusCode, q).toBe(400);
    }
  });
});
