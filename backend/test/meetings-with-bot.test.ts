import { expect, it } from 'vitest';
import { PERSON, resetAllocationsBeforeEach, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting } from './meetings.ts';

describeDb('GET /meetings?with_bot=1: only meetings a bot was in (QOR-5088)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  const list = async (query = '') => (await t.app.inject({ method: 'GET', url: `/meetings${query}`, headers: PERSON })).json();
  const titles = (page: { meetings: { title: string }[] }) => page.meetings.map((m) => m.title);

  it('pages only meetings a bot joined, so every page is full and its cursor is right; the default lists every meeting', async () => {
    await t.pool.query(`DELETE FROM meetings`);
    await botInMeeting(t, 'with-bot-old', '955666781');
    await t.pool.query(`INSERT INTO meetings (occurrence_uuid, meeting_number, title, started_at) VALUES ('with-bot-old', '955666781', 'Bot old', now() - interval '3 hours')`);
    await t.pool.query(`INSERT INTO meetings (occurrence_uuid, meeting_number, title, started_at) VALUES ('no-bot', '955666782', 'No bot', now() - interval '2 hours')`);
    await botInMeeting(t, 'with-bot-new', '955666783');
    await t.pool.query(`INSERT INTO meetings (occurrence_uuid, meeting_number, title, started_at) VALUES ('with-bot-new', '955666783', 'Bot new', now() - interval '1 hour')`);

    expect(titles(await list())).toEqual(['Bot new', 'No bot', 'Bot old']);
    const first = await list('?with_bot=1&limit=1');
    expect(titles(first)).toEqual(['Bot new']);
    const second = await list(`?with_bot=1&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`);
    expect(titles(second)).toEqual(['Bot old']);
    expect(second.next_cursor).toBeNull();
  });

  it('refuses any other with_bot value', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/meetings?with_bot=yes', headers: PERSON })).statusCode).toBe(400);
  });
});
