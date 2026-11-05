import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrate.ts';
import { describeDb, useTestDb } from './harness.ts';

// Migration 0029 meets cards made before drafts: they count as live from the migration (a
// fresh 10 days), and an owned one as accepted, so no existing to-do says "not yet
// accepted" on deploy. Neither changes a card's version, so no open board goes stale.
describeDb('cards from before drafts (migration 0029)', () => {
  const db = useTestDb({ migrate: false });
  let owner: pg.Client;
  let earlier: string;

  beforeAll(async () => {
    owner = await db.connect('owner');
    earlier = mkdtempSync(join(tmpdir(), 'bwat-before-0029-'));
    for (const name of readdirSync(MIGRATIONS_DIR).filter((n) => n < '0029')) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(earlier, name));
    }
    await migrate(owner, earlier);
  });

  afterAll(async () => {
    await owner?.end();
    rmSync(earlier, { recursive: true, force: true });
  });

  it('counts existing cards as live and owned ones as accepted, without a new version', async () => {
    const { rows: meetings } = await owner.query(
      `INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES ('occ-before-drafts', '444444444') RETURNING id`,
    );
    const { rows: members } = await owner.query(`INSERT INTO bwat.members (email) VALUES ('marco-0029@example.com') RETURNING id`);
    const { rows: made } = await owner.query(
      `INSERT INTO cards.cards (meeting_id, kind, display_number, title, owner_member_id)
       VALUES ($1, 'todo', nextval('cards.todo_numbers'), 'Owned', $2), ($1, 'todo', nextval('cards.todo_numbers'), 'Unowned', NULL)
       RETURNING id, title`,
      [meetings[0].id, members[0].id],
    );
    await migrate(owner);
    const { rows } = await owner.query(
      `SELECT title, version, live_at IS NOT NULL AS live, accepted_at IS NOT NULL AS accepted
         FROM cards.cards WHERE id = ANY($1::uuid[]) ORDER BY title`,
      [made.map((r) => r.id)],
    );
    expect(rows).toEqual([
      { title: 'Owned', version: 1, live: true, accepted: true },
      { title: 'Unowned', version: 1, live: true, accepted: false },
    ]);
  });
});
