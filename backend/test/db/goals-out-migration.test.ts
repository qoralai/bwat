import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrate.ts';
import { CHECK_VIOLATION, describeDb, sqlstate, useTestDb } from './harness.ts';

// Migration 0040 meets an install that kept goals (0037, 0038): the goals, the cards' links to
// them and the two goals settings go; the card itself stays, and a dotted settings key is
// refused again.
describeDb('weekly goals out of core (migration 0040)', () => {
  const db = useTestDb({ migrate: false });
  let owner: pg.Client;
  let earlier: string;

  beforeAll(async () => {
    owner = await db.connect('owner');
    earlier = mkdtempSync(join(tmpdir(), 'bwat-before-0040-'));
    for (const name of readdirSync(MIGRATIONS_DIR).filter((n) => n < '0040')) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(earlier, name));
    }
    await migrate(owner, earlier);
  });

  afterAll(async () => {
    await owner?.end();
    rmSync(earlier, { recursive: true, force: true });
  });

  it('drops the goals, the card links and the goals settings, and keeps the card', async () => {
    const { rows: meetings } = await owner.query(
      `INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES ('occ-goals-out', '555555555') RETURNING id`,
    );
    const { rows: goals } = await owner.query(
      `INSERT INTO bwat.goals (week_of, title, state, drafted_by) VALUES ('2026-10-19', 'Ship it', 'goal', 'member') RETURNING id`,
    );
    const { rows: cards } = await owner.query(
      `INSERT INTO cards.cards (meeting_id, kind, display_number, title, goal_id, goal_set_by)
       VALUES ($1, 'todo', nextval('cards.todo_numbers'), 'Serves a goal', $2, 'member') RETURNING id`,
      [meetings[0].id, goals[0].id],
    );
    await owner.query(
      `INSERT INTO bwat.settings (key, value, revision) VALUES ('goals.timezone', '"America/Chicago"', 1),
              ('goals.review_meeting_patterns', '[]', 1)`,
    );
    const before = (await owner.query(`SELECT version FROM bwat.settings_version`)).rows[0].version;

    await migrate(owner);

    expect((await owner.query(`SELECT to_regclass('bwat.goals') AS t`)).rows[0].t).toBeNull();
    const { rows: columns } = await owner.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'cards' AND table_name = 'cards' AND column_name LIKE 'goal%'`,
    );
    expect(columns).toEqual([]);
    expect((await owner.query(`SELECT title FROM cards.cards WHERE id = $1`, [cards[0].id])).rows).toEqual([
      { title: 'Serves a goal' },
    ]);
    expect((await owner.query(`SELECT key FROM bwat.settings WHERE key LIKE 'goals.%'`)).rows).toEqual([]);
    expect((await owner.query(`SELECT version FROM bwat.settings_version`)).rows[0].version).toBe(before + 1);
    expect(await sqlstate(owner, `INSERT INTO bwat.settings (key, value, revision) VALUES ('a.b', '1', 1)`)).toBe(
      CHECK_VIOLATION,
    );
  });
});
