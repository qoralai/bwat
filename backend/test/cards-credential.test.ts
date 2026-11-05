import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digest, issueCardsCredential } from '../src/credentials.ts';
import { bearer, botPost, PERSON, resetAllocationsBeforeEach, signedIn, useApp } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { botInMeeting, meetingIdOf, pushTranscript, segment } from './meetings.ts';
import { envWithoutDb, runNpmScript } from './npm-script.ts';

// QOR-4662 (QOR-4582 part 2, D152): the card service's credential reads
// /fleet with each bot's feed fields and reads meeting transcripts; nothing else.

const KEY = Buffer.alloc(32, 7);

describeDb('the card-service credential (QOR-4662)', () => {
  const t = useApp({ authenticatePerson: signedIn, feedKey: KEY });
  resetAllocationsBeforeEach(t);

  /** The bot reports where it serves its claim's feed, as its heartbeat does. */
  const reportFeed = (bot: { bot_token: string; claim_id: string }) =>
    botPost(t, '/assignment/heartbeat', bot.bot_token, { claim_id: bot.claim_id, generation: 1, feed_host: '10.180.1.5', feed_port: 8771 });
  /** The bot's /fleet row as the card service reads it. */
  const fleetRow = async (cards: string, botId: string) =>
    (await t.app.inject({ method: 'GET', url: '/fleet', headers: bearer(cards) })).json().fleet.find((r: { bot_id: string }) => r.bot_id === botId);

  /** Runs `fn` on an install with no activated owner yet, where people's routes answer 403 not_onboarded. */
  async function beforeOnboarding<T>(fn: () => Promise<T>): Promise<T> {
    await t.pool.query(`UPDATE members SET activated_at = NULL WHERE role = 'owner'`);
    try {
      return await fn();
    } finally {
      await t.pool.query(`UPDATE members SET activated_at = now() WHERE role = 'owner'`);
    }
  }

  it('reads /fleet with the feed fields of a bot that reported them, even before onboarding; people see rows without them', async () => {
    const cards = await issueCardsCredential(t.pool);
    const bot = await botInMeeting(t, 'feed/occ+1==', '240000001', 2);
    await reportFeed(bot);

    const res = await beforeOnboarding(() => t.app.inject({ method: 'GET', url: '/fleet', headers: bearer(cards) }));
    expect(res.statusCode).toBe(200);
    const row = res.json().fleet.find((r: { bot_id: string }) => r.bot_id === bot.bot_id);
    expect(row).toMatchObject({
      claim_id: bot.claim_id,
      generation: 1,
      occurrence_id: 'feed/occ+1==',
      transcript_epoch: 2,
      feed_host: '10.180.1.5',
      feed_port: 8771,
      feed_token: `bwo_${createHmac('sha256', KEY).update(`${bot.claim_id}|1`).digest('base64url')}`,
    });

    const seen = (await t.app.inject({ method: 'GET', url: '/fleet', headers: PERSON })).json();
    const person = seen.fleet.find((r: { bot_id: string }) => r.bot_id === bot.bot_id);
    for (const field of ['feed_token', 'feed_host', 'feed_port']) expect(person).not.toHaveProperty(field);
  });

  // QOR-5113: capture dials every row with a feed address; a bot that is gone must not keep one.
  it.each([
    ['stale', `UPDATE bots SET last_heartbeat = now() - interval '1 minute' WHERE id = $1`],
    ['past its lease', `UPDATE claims SET lease_until = now() - interval '1 second' WHERE bot_id = $1`],
    ['past its drain after Zoom ended the meeting', `UPDATE claims SET drain_until = now() - interval '1 second' WHERE bot_id = $1`],
  ])('gives no feed address for a bot %s, though its claim is still live', async (_, gone) => {
    const cards = await issueCardsCredential(t.pool);
    const bot = await botInMeeting(t, 'feed/occ+gone==', '240000004', 1);
    await reportFeed(bot);
    expect(await fleetRow(cards, bot.bot_id)).toMatchObject({ feed_host: '10.180.1.5', feed_port: 8771 });

    await t.pool.query(gone, [bot.bot_id]);
    expect(await fleetRow(cards, bot.bot_id)).toMatchObject({ claim_id: bot.claim_id, feed_host: null, feed_port: null });
  });

  it('keeps the feed address of a bot that holds a live claim while not ready', async () => {
    const cards = await issueCardsCredential(t.pool);
    const bot = await botInMeeting(t, 'feed/occ+unready==', '240000005', 1);
    await reportFeed(bot);
    await t.pool.query(`UPDATE bots SET ready_at = NULL WHERE id = $1`, [bot.bot_id]);
    expect(await fleetRow(cards, bot.bot_id)).toMatchObject({ ready: false, claim_id: bot.claim_id, feed_host: '10.180.1.5', feed_port: 8771 });
  });

  it('reads a meeting transcript by its id, even before onboarding', async () => {
    const cards = await issueCardsCredential(t.pool);
    const bot = await botInMeeting(t, 'feed/occ+2==', '240000002', 1);
    await pushTranscript(t, 'feed/occ+2==', bot.bot_token, { epoch: 1, segments: [segment(0), segment(1)] });
    const meetingId = await meetingIdOf(t, 'feed/occ+2==');

    const res = await beforeOnboarding(() => t.app.inject({ method: 'GET', url: `/meetings/${meetingId}/transcript`, headers: bearer(cards) }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ meeting_id: meetingId, complete: false, occurrence_state: 'live', next_cursor: null });
    expect(res.json().segments.map((s: { seq: number }) => s.seq)).toEqual([0, 1]);
  });

  it('is refused (401) everywhere else', async () => {
    const cards = await issueCardsCredential(t.pool);
    const res = await t.app.inject({ method: 'POST', url: '/allocations', headers: bearer(cards), payload: { zoom_url: 'https://zoom.us/j/240000003' } });
    expect(res.statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/assignment', headers: bearer(cards) })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/meetings', headers: bearer(cards) })).statusCode).toBe(401);
  });

  it('is refused (401) on its own routes when unknown', async () => {
    const unknown = `bwc_${'A'.repeat(43)}`;
    expect((await t.app.inject({ method: 'GET', url: '/fleet', headers: bearer(unknown) })).statusCode).toBe(401);
    const meeting = '00000000-0000-4000-8000-000000000000';
    expect((await t.app.inject({ method: 'GET', url: `/meetings/${meeting}/transcript`, headers: bearer(unknown) })).statusCode).toBe(401);
  });
});

describeDb('the card-service credential and transcripts (QOR-4662)', () => {
  const t = useApp({ authenticatePerson: signedIn });

  it("reads a meeting's transcript", async () => {
    const cards = await issueCardsCredential(t.pool);
    const bot = await botInMeeting(t, 'feed/occ+4==', '240000004', 1);
    await pushTranscript(t, 'feed/occ+4==', bot.bot_token, { epoch: 1, segments: [segment(0)] });
    const meetingId = await meetingIdOf(t, 'feed/occ+4==');
    expect((await t.app.inject({ method: 'GET', url: `/meetings/${meetingId}/transcript`, headers: bearer(cards) })).statusCode).toBe(200);
  });
});

describeDb('npm run cards-credential (QOR-4662)', () => {
  const db = useTestDb();

  it('issues a card-service credential as the runtime role, prints it once, and stores only its digest', async () => {
    const run = await runNpmScript('cards-credential', { ...envWithoutDb(), BWAT_DB_URL: db.url('runtime') }, ['--label', 'cards-a']);
    expect(run.code).toBe(0);
    const tokens = run.stdout.match(/bwc_[A-Za-z0-9_-]{43}/g) ?? [];
    expect(tokens).toHaveLength(1);
    const owner = await db.connect('owner');
    try {
      const { rows } = await owner.query(`SELECT label, token_sha256 FROM bwat.cards_credentials`);
      expect(rows).toEqual([{ label: 'cards-a', token_sha256: digest(tokens[0]!) }]);
    } finally {
      await owner.end();
    }
  }, 30_000);
});

describe('npm run cards-credential without a database (QOR-4662)', () => {
  it('fails, naming the missing variable', async () => {
    const run = await runNpmScript('cards-credential', envWithoutDb());
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('cards-credential failed: BWAT_DB_URL is not set');
  }, 30_000);
});
