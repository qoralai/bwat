import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeDb, INSUFFICIENT_PRIVILEGE, sqlstate, useTestDb } from './harness.ts';

// QOR-4601: the card service reads the backend's members and meetings through two views
// (migration 0010), never the tables. Which occurrence_state a meeting reads is checked
// against the transcript read in test/occurrence-state.test.ts.
describeDb('card service read views (QOR-4601)', () => {
  const db = useTestDb();
  let cards: pg.Client;
  let runtime: pg.Client;

  beforeAll(async () => {
    cards = await db.connect('cards');
    runtime = await db.connect('runtime');
  });

  afterAll(async () => {
    await cards?.end();
    await runtime?.end();
  });

  const columns = async (view: string) =>
    (
      await cards.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'bwat' AND table_name = $1 ORDER BY ordinal_position`,
        [view],
      )
    ).rows.map((r) => r.column_name);

  it('shows the card service only the columns it needs', async () => {
    expect(await columns('v_cards_members')).toEqual(['member_id', 'display_name', 'email', 'zoom_user_id', 'active']);
    expect(await columns('v_cards_occurrences')).toEqual([
      'meeting_id',
      'occurrence_uuid',
      'meeting_number',
      'started_at',
      'ended_at',
      'occurrence_state',
      'title',
    ]);
  });

  it('reads a member as active only once activated, and never their role or Google account', async () => {
    const { rows } = await runtime.query(
      `INSERT INTO bwat.members (email, display_name, zoom_user_id, google_sub, role, activated_at)
       VALUES ('ada@example.com', 'Ada', 'zoom-ada', 'g-ada', 'owner', now()),
              ('marco@example.com', 'Marco', NULL, NULL, 'member', NULL)
       RETURNING id`,
    );
    const [ada, marco] = rows.map((r) => r.id);
    const read = await cards.query(`SELECT * FROM bwat.v_cards_members WHERE member_id = ANY($1) ORDER BY email`, [[ada, marco]]);
    expect(read.rows).toEqual([
      { member_id: ada, display_name: 'Ada', email: 'ada@example.com', zoom_user_id: 'zoom-ada', active: true },
      { member_id: marco, display_name: 'Marco', email: 'marco@example.com', zoom_user_id: null, active: false },
    ]);
    // Not activated (activated_at cleared): the card service reads it at once.
    await runtime.query(`UPDATE bwat.members SET activated_at = NULL WHERE id = $1`, [ada]);
    const after = await cards.query(`SELECT active FROM bwat.v_cards_members WHERE member_id = $1`, [ada]);
    expect(after.rows).toEqual([{ active: false }]);
  });

  it("reads a meeting's identity, times and title", async () => {
    const { rows } = await runtime.query(
      `INSERT INTO bwat.meetings (occurrence_uuid, meeting_number, ended_at, title) VALUES ('occ-views-1', '333333333', now(), 'Standup')
       RETURNING *`,
    );
    const m = rows[0];
    const read = await cards.query(
      `SELECT meeting_id, occurrence_uuid, meeting_number, started_at, ended_at, title FROM bwat.v_cards_occurrences WHERE meeting_id = $1`,
      [m.id],
    );
    expect(read.rows).toEqual([
      {
        meeting_id: m.id, occurrence_uuid: 'occ-views-1', meeting_number: '333333333', started_at: m.started_at, ended_at: m.ended_at,
        title: 'Standup',
      },
    ]);
  });

  it("gives the card login no table of the backend's, only the read views", async () => {
    const tables = (await cards.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'bwat' ORDER BY 1`)).rows.map(
      (r) => r.tablename as string,
    );
    expect(tables).toEqual(expect.arrayContaining(['members', 'meetings', 'transcript_segments', 'claims']));
    for (const table of tables) {
      expect([table, await sqlstate(cards, `SELECT 1 FROM bwat.${table} LIMIT 1`)]).toEqual([table, INSUFFICIENT_PRIVILEGE]);
    }
    for (const view of ['v_cards_members', 'v_cards_occurrences', 'v_transcript_speakers']) {
      expect(await sqlstate(cards, `SELECT * FROM bwat.${view} LIMIT 1`)).toBe('ok');
      expect((await cards.query(`SELECT has_table_privilege(current_user, $1, 'DELETE') AS allowed`, [`bwat.${view}`])).rows[0].allowed).toBe(false);
    }
  });

  it("leaves the backend's runtime login unchanged: nothing on cards.*, and not the card views", async () => {
    for (const table of ['cards', 'evidence', 'card_events', 'card_links', 'capture_positions']) {
      expect(await sqlstate(runtime, `SELECT 1 FROM cards.${table} LIMIT 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    }
    for (const view of ['v_cards_members', 'v_cards_occurrences']) {
      expect(await sqlstate(runtime, `SELECT 1 FROM bwat.${view} LIMIT 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('opens no function the owner adds later to either login: a migration grants each by name', async () => {
    const owner = await db.connect('owner');
    try {
      await owner.query(`CREATE FUNCTION bwat.later_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
      await owner.query(`CREATE FUNCTION cards.later_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
      expect(await sqlstate(cards, `SELECT bwat.later_function()`)).toBe(INSUFFICIENT_PRIVILEGE);
      const { rows } = await owner.query(
        `SELECT has_function_privilege(r, f::regprocedure, 'EXECUTE') AS can
           FROM unnest(ARRAY['bwat_runtime', 'bwat_cards']) r, unnest(ARRAY['bwat.later_function()', 'cards.later_function()']) f`,
      );
      expect(rows.map((r) => r.can)).toEqual([false, false, false, false]);
    } finally {
      await owner.query(`DROP FUNCTION IF EXISTS bwat.later_function()`);
      await owner.query(`DROP FUNCTION IF EXISTS cards.later_function()`);
      await owner.end();
    }
  });
});
