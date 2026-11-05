import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { createPool } from '../src/db/pool.ts';
import { apiBase, bearer, heldClaim, postAllocation, registerBot, resetAllocationsBeforeEach, signedIn, useApp } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';

// QOR-4582: the backend derives each claim generation's feed token from
// BWAT_FEED_KEY, so nothing is stored, and the bot reports where it serves the feed.

const DEV_TOKEN = 'dev-person-token-for-the-feed-key-test';
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

/** The contract's derivation, computed here independently of the backend. */
const expected = (claimId: string, generation: number) =>
  `bwo_${createHmac('sha256', KEY).update(`${claimId}|${generation}`).digest('base64url')}`;

describeDb('the feed token in the claim view (QOR-4582)', () => {
  const t = useApp({ authenticatePerson: signedIn, feedKey: KEY });
  resetAllocationsBeforeEach(t);

  const beat = (token: string, payload: object) =>
    t.app.inject({ method: 'POST', url: '/assignment/heartbeat', headers: bearer(token), payload });

  it('is bwo_ + base64url(HMAC-SHA256(key, claim_id|generation)) on GET /assignment and the heartbeat, and changes with the generation', async () => {
    const { bot, claimId } = await heldClaim(t, '230000001');
    const polled = await t.app.inject({ method: 'GET', url: '/assignment', headers: bearer(bot.bot_token) });
    expect(polled.json()).toMatchObject({ claim_id: claimId, generation: 1, feed_token: expected(claimId, 1) });

    await t.pool.query(`UPDATE claims SET generation = 2 WHERE id = $1`, [claimId]);
    const beaten = await beat(bot.bot_token, { claim_id: claimId, generation: 2 });
    expect(beaten.json().feed_token).toBe(expected(claimId, 2));
    expect(expected(claimId, 2)).not.toBe(expected(claimId, 1));
  });

  it('takes the feed address as a private IP literal and port', async () => {
    const { bot, claimId } = await heldClaim(t, '230000002');
    const res = await beat(bot.bot_token, { claim_id: claimId, generation: 1, feed_host: '10.180.1.5', feed_port: 8771 });
    expect(res.statusCode).toBe(200);
    const { rows } = await t.pool.query(`SELECT status FROM bots WHERE id = $1`, [bot.bot_id]);
    expect(rows[0].status).toMatchObject({ feed_host: '10.180.1.5', feed_port: 8771 });
  });

  it('refuses (400 invalid_body) a feed host that is a name, link-local (also IPv4-mapped), the IPv6 metadata service, loopback or public', async () => {
    const { bot, claimId } = await heldClaim(t, '230000003');
    for (const host of ['bot.local', '169.254.169.254', '::ffff:169.254.169.254', 'fd00:ec2::254', '127.0.0.1', '8.8.8.8']) {
      const res = await beat(bot.bot_token, { claim_id: claimId, generation: 1, feed_host: host, feed_port: 8771 });
      expect(res.statusCode, host).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_body' });
    }
    expect((await beat(bot.bot_token, { claim_id: claimId, generation: 1, feed_host: '10.180.1.5', feed_port: 0 })).statusCode).toBe(400);
  });
});

describeDb('BWAT_FEED_KEY at startup (QOR-4582)', () => {
  const db = useTestDb();
  const production = () => ({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'production', BWAT_ALLOWED_DOMAINS: 'example.com', BWAT_GOOGLE_CLIENT_IDS: 'id' });

  it('is required in production, and must be 32 bytes', async () => {
    await expect(start(production())).rejects.toThrow('BWAT_FEED_KEY is required when NODE_ENV=production');
    await expect(start({ ...production(), BWAT_FEED_KEY: 'abcd' })).rejects.toThrow('BWAT_FEED_KEY must be 32 bytes, as 64 hex characters or base64');
  });

  it('gives the server started with it feed tokens from it', async () => {
    const app = apiBase(await start({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'development', BWAT_DEV_PERSON_TOKEN: DEV_TOKEN, BWAT_FEED_KEY: KEY.toString('hex') }));
    const pool = createPool(db.url('runtime'));
    try {
      const t = { app, pool, db };
      const bot = await registerBot(t);
      const sent = (await postAllocation(t, { zoom_url: 'https://zoom.us/j/230000004' }, bearer(DEV_TOKEN))).json();
      const polled = await app.inject({ method: 'GET', url: '/assignment', headers: bearer(bot.bot_token) });
      expect(polled.json().feed_token).toBe(expected(sent.id, 1));
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('reads the key as 64 hex characters or base64', async () => {
    const { feedKey } = await import('../src/feed.ts');
    expect(feedKey({ BWAT_FEED_KEY: KEY.toString('hex') })).toEqual(KEY);
    expect(feedKey({ BWAT_FEED_KEY: KEY.toString('base64') })).toEqual(KEY);
  });
});

describe('BWAT_FEED_KEY is a startup secret (QOR-4582)', () => {
  it('is resolved with the server startup secrets', async () => {
    const { STARTUP_NAMES } = await import('../src/config.ts');
    expect(STARTUP_NAMES.server).toContain('BWAT_FEED_KEY');
  });
});
