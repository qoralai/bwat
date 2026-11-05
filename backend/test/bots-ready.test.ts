import { beforeAll, expect, it } from 'vitest';
import { issueFleetCredential } from '../src/credentials.ts';
import { bearer, registerBot, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';

describeDb('POST /bots/ready (QOR-4571)', () => {
  const t = useApp();
  let fleetToken: string;
  let bot: { bot_id: string; bot_token: string };

  beforeAll(async () => {
    fleetToken = await issueFleetCredential(t.pool);
    bot = await registerBot(t, { ready: false });
  });

  const ready = (headers: Record<string, string>, payload: object = {}) =>
    t.app.inject({ method: 'POST', url: '/bots/ready', headers, payload });
  const readyAt = async () => (await t.pool.query(`SELECT ready_at FROM bots WHERE id = $1`, [bot.bot_id])).rows[0].ready_at;

  it('refuses a caller with no credential or an unknown one', async () => {
    expect((await ready({})).statusCode).toBe(401);
    expect((await ready(bearer(`bwb_${'A'.repeat(43)}`))).statusCode).toBe(401);
  });

  it('answers 409 unregistered_bot to a fleet credential: a bot registers first', async () => {
    const res = await ready(bearer(fleetToken));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'unregistered_bot' });
  });

  it('marks the bot named by its token ready', async () => {
    expect(await readyAt()).toBeNull();
    const res = await ready(bearer(bot.bot_token));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bot_id: bot.bot_id, ready: true });
    expect(await readyAt()).toBeInstanceOf(Date);
  });

  it('withdraws the bot with ready: false', async () => {
    const res = await ready(bearer(bot.bot_token), { ready: false });
    expect(res.json()).toEqual({ bot_id: bot.bot_id, ready: false });
    expect(await readyAt()).toBeNull();
  });

  it('rejects a ready flag that is not a boolean', async () => {
    expect((await ready(bearer(bot.bot_token), { ready: 'yes' })).statusCode).toBe(400);
  });
});
