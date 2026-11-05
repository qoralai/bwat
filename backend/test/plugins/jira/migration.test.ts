import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate, migrateAll } from '../../../src/db/migrate.ts';
import { describeDb, useTestDb } from '../../db/harness.ts';

// QOR-4976: an install that sent cards to Jira while core kept the issue on the card (migration
// 0019) upgrades: the jira plugin's 0001 copies each issue, with who sent it and when, into
// jira.card_issues, and 0002 drops the core columns. A plugin's migrations run after core's,
// whether or not it is switched on, so the copy is never lost to the drop.
describeDb("the Jira issues on cards, moved into the jira plugin's table", () => {
  const db = useTestDb({ migrate: false });
  let owner: pg.Client;
  let sent: string;
  let unsent: string;
  const MEMBER = '00000000-0000-4000-8000-0000000000c1';
  const AT = '2026-10-20T10:00:00.000Z';

  beforeAll(async () => {
    owner = await db.connect('owner');
    // Core only, as an install before the plugin: the cards still carry their issues.
    await migrate(owner);
    const { rows: meetings } = await owner.query(
      `INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES ('occ-jira-move', '444444444') RETURNING id`,
    );
    await owner.query(`INSERT INTO bwat.members (id, email, role, activated_at) VALUES ($1, 'ada@example.com', 'member', now())`, [MEMBER]);
    const card = async (title: string, key: string | null) =>
      (
        await owner.query(
          `INSERT INTO cards.cards (meeting_id, kind, display_number, title, jira_key, jira_url)
           VALUES ($1, 'todo', nextval('cards.todo_numbers'), $2, $3::text, CASE WHEN $3::text IS NULL THEN NULL ELSE 'https://acme.atlassian.net/browse/' || $3::text END) RETURNING id`,
          [meetings[0].id, title, key],
        )
      ).rows[0].id as string;
    sent = await card('Sent to Jira', 'ABC-7');
    unsent = await card('Never sent', null);
    await owner.query(
      `INSERT INTO cards.card_events (card_id, meeting_id, at, action, actor_kind, actor_member_id, after)
       VALUES ($1, $2, $3, 'card.jira', 'member', $4, '{"jira_key": "ABC-7"}')`,
      [sent, meetings[0].id, AT, MEMBER],
    );
    await migrateAll(owner);
  });

  afterAll(async () => {
    await owner?.end();
  });

  it('copies each issue with who sent it and when, its line counted as written', async () => {
    const { rows } = await owner.query(`SELECT card_id, key, url, sent_by, sent_at, noted_at FROM jira.card_issues`);
    expect(rows).toEqual([
      { card_id: sent, key: 'ABC-7', url: 'https://acme.atlassian.net/browse/ABC-7', sent_by: MEMBER, sent_at: new Date(AT), noted_at: new Date(AT) },
    ]);
    expect(rows.some((r) => r.card_id === unsent)).toBe(false);
  });

  it("drops the issue from core's card, and keeps the card", async () => {
    const { rows: columns } = await owner.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'cards' AND table_name = 'cards' AND column_name LIKE 'jira%'`,
    );
    expect(columns).toEqual([]);
    expect((await owner.query(`SELECT title FROM cards.cards WHERE id = $1`, [sent])).rows).toEqual([{ title: 'Sent to Jira' }]);
  });

  it("deletes a card's issue with the card", async () => {
    await owner.query(`DELETE FROM cards.cards WHERE id = $1`, [sent]);
    expect((await owner.query(`SELECT 1 FROM jira.card_issues WHERE card_id = $1`, [sent])).rowCount).toBe(0);
  });
});
