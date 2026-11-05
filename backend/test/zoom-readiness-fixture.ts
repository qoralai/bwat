import { registerBot, type TestApp } from './app.ts';

/** A healthy but occupied bot proves readiness without changing available capacity. */
export async function readyBusyBot(t: Pick<TestApp, 'app' | 'pool'>) {
  const bot = await registerBot(t as TestApp);
  await t.pool.query(`INSERT INTO claims (meeting_number, state, bot_id, lease_until)
    VALUES ('99999999999', 'claimed', $1, now() + interval '1 hour')`, [bot.bot_id]);
}
