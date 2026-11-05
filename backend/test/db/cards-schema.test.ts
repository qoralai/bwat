import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from '../../src/db/migrate.ts';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { asSuperuser, CHECK_VIOLATION, describeDb, FOREIGN_KEY_VIOLATION, INSUFFICIENT_PRIVILEGE, ROLE_NAMES, sqlstate, UNIQUE_VIOLATION, useTestDb } from './harness.ts';

// QOR-4604: the card service owns card data in its own schema, written only through its
// own login (bwat_cards). The backend's runtime login gets nothing on cards.*. Cards quote
// meeting speech, so every card-side row dies with its meeting.
describeDb('cards schema (QOR-4604)', () => {
  const db = useTestDb();
  let cards: pg.Client;
  let runtime: pg.Client;
  let meetingId: string;
  let otherMeetingId: string;
  let marcoId: string;
  let adaId: string;

  beforeAll(async () => {
    cards = await db.connect('cards');
    runtime = await db.connect('runtime');
    const meetings = await runtime.query(
      `INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES ('occ-cards-1', '111111111'), ('occ-cards-2', '222222222') RETURNING id`,
    );
    [meetingId, otherMeetingId] = meetings.rows.map((r) => r.id);
    const members = await runtime.query(
      `INSERT INTO bwat.members (email, display_name) VALUES ('marco@example.com', 'Marco'), ('ada@example.com', 'Ada') RETURNING id`,
    );
    [marcoId, adaId] = members.rows.map((r) => r.id);
  });

  afterAll(async () => {
    await cards?.end();
    await runtime?.end();
  });

  async function newCard(meeting = meetingId, owner: string | null = marcoId): Promise<string> {
    const { rows } = await cards.query(
      `INSERT INTO cards.cards (meeting_id, kind, display_number, title, owner_member_id)
       VALUES ($1, 'todo', nextval('cards.todo_numbers'), 'Send the license draft', $2) RETURNING id`,
      [meeting, owner],
    );
    return rows[0].id;
  }

  it('lets the card service write a card with its evidence, events, links and writer position', async () => {
    const card = await newCard();
    const other = await newCard();
    await cards.query(
      `INSERT INTO cards.evidence (card_id, meeting_id, epoch, seq, speaker_member_id, speaker_label, text, source)
       VALUES ($1, $2, 1, 7, $3, 'Marco', 'I''ll send the license draft by Friday', 'asr')`,
      [card, meetingId, marcoId],
    );
    await cards.query(
      `INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind, actor_member_id, after)
       VALUES ($1, $2, 'owner.set', 'member', $3, '{"owner": "Marco"}')`,
      [card, meetingId, adaId],
    );
    await cards.query(
      `INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) VALUES ($1, $2, $3, 'supersedes')`,
      [meetingId, other, card],
    );
    await cards.query(`INSERT INTO cards.capture_positions (meeting_id, epoch, last_seq) VALUES ($1, 1, 7)`, [meetingId]);
    const { rows } = await cards.query(`SELECT display_id, status, version FROM cards.cards WHERE id = $1`, [card]);
    expect(rows[0].display_id).toMatch(/^A\d+$/);
    // Version 2: the link to it bumped it.
    expect(rows[0]).toMatchObject({ status: 'open', version: 2 });
  });

  it('labels cards by kind (D, A, Q, R), unique across meetings', async () => {
    const { rows } = await cards.query(
      `INSERT INTO cards.cards (meeting_id, kind, display_number, title) VALUES
         ($1, 'decision', nextval('cards.decision_numbers'), 'd'),
         ($1, 'question', nextval('cards.question_numbers'), 'q'),
         ($1, 'risk', nextval('cards.risk_numbers'), 'r')
       RETURNING display_id`,
      [otherMeetingId],
    );
    expect(rows.map((r) => r.display_id[0])).toEqual(['D', 'Q', 'R']);
    expect(
      await sqlstate(cards, `INSERT INTO cards.cards (meeting_id, kind, display_number, title) VALUES ($1, 'risk', 1, 'dup')`, [
        meetingId,
      ]),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await sqlstate(cards, `INSERT INTO cards.cards (meeting_id, kind, display_number, title) VALUES ($1, 'note', 99, 'x')`, [
        meetingId,
      ]),
    ).toBe(CHECK_VIOLATION);
  });

  it('keeps events append-only, and lets a link be revoked but not rewritten', async () => {
    expect(await sqlstate(cards, `UPDATE cards.card_events SET action = 'x.y'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(cards, `DELETE FROM cards.card_events`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(cards, `UPDATE cards.card_links SET revoked_at = now(), revoked_by = $1`, [adaId])).toBe('ok');
    expect(await sqlstate(cards, `UPDATE cards.card_links SET kind = 'answers'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(cards, `DELETE FROM cards.card_links`)).toBe(INSUFFICIENT_PRIVILEGE);
    // Quotes are written once and go only with their card or meeting, so an event that
    // cites one never points at nothing.
    for (const set of ['seq = 1', "text = 'other words'", 'speaker_member_id = NULL', "speaker_label = 'x'"]) {
      expect(await sqlstate(cards, `UPDATE cards.evidence SET ${set}`)).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await sqlstate(cards, `DELETE FROM cards.evidence`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("moves the writer's position only forward, and takes a quote as long as a transcript line", async () => {
    await cards.query(`INSERT INTO cards.capture_positions (meeting_id, epoch, last_seq) VALUES ($1, 5, 10)`, [meetingId]);
    const move = (set: string) => sqlstate(cards, `UPDATE cards.capture_positions SET ${set} WHERE meeting_id = $1 AND epoch = 5`, [meetingId]);
    expect(await move('last_seq = 12')).toBe('ok');
    expect(await move('last_seq = 3')).toBe(CHECK_VIOLATION);
    expect(await move('epoch = 6')).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await move('updated_at = now()')).toBe(INSUFFICIENT_PRIVILEGE);
    const card = await newCard();
    const quote = (length: number, seq: number) =>
      sqlstate(
        cards,
        `INSERT INTO cards.evidence (card_id, meeting_id, epoch, seq, speaker_label, text, source) VALUES ($1, $2, 20, $3, 'Marco', repeat('a', $4), 'asr')`,
        [card, meetingId, seq, length],
      );
    expect(await quote(20000, 1)).toBe('ok');
    expect(await quote(20001, 2)).toBe(CHECK_VIOLATION);
  });

  it("gives the backend's runtime login nothing on cards, and the card login nothing on the backend's tables", async () => {
    for (const table of ['cards', 'evidence', 'card_events', 'card_links', 'capture_positions', 'card_orders', 'card_checks', 'card_carries']) {
      expect(await sqlstate(runtime, `SELECT 1 FROM cards.${table} LIMIT 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await sqlstate(cards, `SELECT 1 FROM bwat.members LIMIT 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(cards, `SELECT 1 FROM bwat.transcript_segments LIMIT 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(cards, `CREATE TABLE cards.mine (x int)`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('lets the card login carry a card and revoke the carry, once per meeting, and nothing else (QOR-5000)', async () => {
    const card = await newCard(meetingId, null);
    const version = async () => (await cards.query(`SELECT version FROM cards.cards WHERE id = $1`, [card])).rows[0].version;
    const before = await version();
    expect(await sqlstate(cards, `INSERT INTO cards.card_carries (card_id, meeting_id) VALUES ($1, $2)`, [card, otherMeetingId])).toBe('ok');
    // A carry moves the card between two meetings' lists: its version moves with it.
    expect(await version()).toBe(before + 1);
    expect(await sqlstate(cards, `INSERT INTO cards.card_carries (card_id, meeting_id) VALUES ($1, $2)`, [card, otherMeetingId])).toBe(
      UNIQUE_VIOLATION,
    );
    expect(await sqlstate(cards, `UPDATE cards.card_carries SET revoked_at = now(), revoked_by = $2 WHERE card_id = $1`, [card, adaId])).toBe(
      'ok',
    );
    expect(await version()).toBe(before + 2);
    expect(await sqlstate(cards, `UPDATE cards.card_carries SET meeting_id = $2 WHERE card_id = $1`, [card, meetingId])).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlstate(cards, `DELETE FROM cards.card_carries WHERE card_id = $1`, [card])).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('clears a deleted member from owners, actors and speakers', async () => {
    const card = await newCard(meetingId, adaId);
    await cards.query(
      `INSERT INTO cards.evidence (card_id, meeting_id, epoch, seq, speaker_member_id, speaker_label, text, source)
       VALUES ($1, $2, 3, 1, $3, 'Ada', 'ada again', 'asr')`,
      [card, meetingId, adaId],
    );
    await cards.query(
      `INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind, actor_member_id) VALUES ($1, $2, 'card.close', 'member', $3)`,
      [card, meetingId, adaId],
    );
    await cards.query(
      `INSERT INTO cards.card_links (meeting_id, from_card_id, to_todo_id, kind, revoked_at, revoked_by) VALUES ($1, $2, 'T-3', 'todo_twin', now(), $3)`,
      [meetingId, card, adaId],
    );
    await runtime.query(`DELETE FROM bwat.members WHERE id = $1`, [adaId]);
    const { rows } = await cards.query(
      `SELECT (SELECT count(*) FROM cards.cards WHERE owner_member_id = $1) AS owners,
              (SELECT count(*) FROM cards.card_events WHERE actor_member_id = $1) AS actors,
              (SELECT count(*) FROM cards.evidence WHERE speaker_member_id = $1) AS speakers,
              (SELECT count(*) FROM cards.card_links WHERE revoked_by = $1) AS revokers`,
      [adaId],
    );
    expect(rows[0]).toEqual({ owners: '0', actors: '0', speakers: '0', revokers: '0' });
  });

  it("bumps a card's version on every change, its own or a cascade, and never lets the writer set it", async () => {
    const { rows: m } = await runtime.query(`INSERT INTO bwat.members (email, display_name) VALUES ('cy@example.com', 'Cy') RETURNING id`);
    const card = await newCard(meetingId, m[0].id);
    const state = async () =>
      (await cards.query(`SELECT version, updated_at FROM cards.cards WHERE id = $1`, [card])).rows[0] as { version: number; updated_at: Date };
    const first = await state();
    await cards.query(`UPDATE cards.cards SET status = 'done' WHERE id = $1`, [card]);
    const second = await state();
    expect(second.version).toBe(2);
    expect(second.updated_at.getTime()).toBeGreaterThanOrEqual(first.updated_at.getTime());
    // Deleting the owner changes the card under a person who has it open.
    await runtime.query(`DELETE FROM bwat.members WHERE id = $1`, [m[0].id]);
    expect((await state()).version).toBe(3);
    // Nor seed one: a new card starts at version 1 whatever the writer sends.
    const { rows: seeded } = await cards.query(
      `INSERT INTO cards.cards (meeting_id, kind, display_number, title, version) VALUES ($1, 'risk', nextval('cards.risk_numbers'), 'r', 2147483647) RETURNING version`,
      [meetingId],
    );
    expect(seeded[0].version).toBe(1);
    for (const set of ['version = 1', 'updated_at = now()']) {
      expect(await sqlstate(cards, `UPDATE cards.cards SET ${set} WHERE id = $1`, [card])).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("drops a link when the other card's meeting is deleted, and bumps the surviving card", async () => {
    const { rows: m } = await runtime.query(
      `INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES ('occ-cards-5', '555555555') RETURNING id`,
    );
    const later = await newCard(m[0].id);
    const earlier = await newCard();
    const version = async () => (await cards.query(`SELECT version FROM cards.cards WHERE id = $1`, [earlier])).rows[0].version;
    await cards.query(`INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) VALUES ($1, $2, $3, 'supersedes')`, [
      m[0].id,
      later,
      earlier,
    ]);
    const linked = await version();
    expect(linked).toBe(2);
    await runtime.query(`DELETE FROM bwat.meetings WHERE id = $1`, [m[0].id]);
    const links = await cards.query(`SELECT count(*) FROM cards.card_links WHERE to_card_id = $1`, [earlier]);
    expect(links.rows[0].count).toBe('0');
    expect(await version()).toBe(linked + 1);
  });

  it("ties every quote, event and link to its card's meeting", async () => {
    const card = await newCard();
    for (const sql of [
      `INSERT INTO cards.evidence (card_id, meeting_id, epoch, seq, speaker_label, text, source) VALUES ($1, $2, 12, 1, 'Marco', 'w', 'asr')`,
      `INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind) VALUES ($1, $2, 'card.create', 'writer')`,
      `INSERT INTO cards.card_links (meeting_id, from_card_id, to_todo_id, kind) VALUES ($2, $1, 'T-7', 'todo_twin')`,
    ]) {
      expect(await sqlstate(cards, sql, [card, otherMeetingId])).toBe(FOREIGN_KEY_VIOLATION);
    }
    await cards.query(
      `INSERT INTO cards.evidence (card_id, meeting_id, epoch, seq, speaker_label, text, source) VALUES ($1, $2, 12, 1, 'Marco', 'w', 'asr')`,
      [card, meetingId],
    );
    // A card never moves meeting, nor changes kind or number, even with no quotes yet.
    const bare = await newCard();
    for (const set of ['meeting_id = gen_random_uuid()', "kind = 'risk'", 'display_number = 999999']) {
      expect(await sqlstate(cards, `UPDATE cards.cards SET ${set} WHERE id = $1`, [bare])).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await sqlstate(cards, `UPDATE cards.cards SET title = 'Renamed' WHERE id = $1`, [bare])).toBe('ok');
  });

  it('keeps one active link per target, and never links a card to itself', async () => {
    const from = await newCard();
    const to = await newCard();
    const link = (target: string, kind = 'supersedes') =>
      sqlstate(cards, `INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) VALUES ($1, $2, $3, $4) RETURNING id`, [
        meetingId,
        from,
        target,
        kind,
      ]);
    const twin = () =>
      sqlstate(cards, `INSERT INTO cards.card_links (meeting_id, from_card_id, to_todo_id, kind) VALUES ($1, $2, 'T-42', 'todo_twin')`, [
        meetingId,
        from,
      ]);
    expect(await link(to)).toBe('ok');
    expect(await link(to)).toBe(UNIQUE_VIOLATION);
    expect(await link(to, 'answers')).toBe('ok');
    expect(await twin()).toBe('ok');
    expect(await twin()).toBe(UNIQUE_VIOLATION);
    // Undoing a link frees its place for a new one.
    await cards.query(`UPDATE cards.card_links SET revoked_at = now() WHERE from_card_id = $1 AND kind = 'supersedes'`, [from]);
    expect(await link(to)).toBe('ok');
    expect(await link(from)).toBe(CHECK_VIOLATION);
  });

  it('links a card to exactly one target: a to-do for todo_twin, a card otherwise', async () => {
    const from = await newCard();
    const to = await newCard();
    const results: string[] = [];
    for (const kind of ['todo_twin', 'answers']) {
      for (const todo of [null, 'T-9']) {
        for (const toCard of [null, to]) {
          const state = await sqlstate(
            cards,
            `INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, to_todo_id, kind) VALUES ($1, $2, $3, $4, $5)`,
            [meetingId, from, toCard, todo, kind],
          );
          if (state === 'ok') results.push(`${kind} todo=${todo !== null} card=${toCard !== null}`);
          else expect(state).toBe(CHECK_VIOLATION);
        }
      }
    }
    expect(results).toEqual(['todo_twin todo=true card=false', 'answers todo=false card=true']);
  });

  // QOR-4770: "Not a duplicate" and "Dismiss" name the other card of the pair, once per pair and kind.
  it('takes a hint dismissal only with the card it names, once per pair and kind', async () => {
    const card = await newCard();
    const other = await newCard();
    const third = await newCard();
    const dismiss = (kind: string, toCard: string | null) =>
      sqlstate(cards, `INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) VALUES ($1, $2, $3, $4)`, [
        meetingId,
        card,
        toCard,
        kind,
      ]);
    expect(await dismiss('not_duplicate', null)).toBe(CHECK_VIOLATION);
    expect(await dismiss('not_duplicate', other)).toBe('ok');
    expect(await dismiss('not_duplicate', other)).toBe(UNIQUE_VIOLATION);
    expect(await dismiss('not_duplicate', third)).toBe('ok');
    expect(await dismiss('not_related', other)).toBe('ok');
    expect(await dismiss('not_relevant', other)).toBe(CHECK_VIOLATION);
  });

  it("keeps one hint check per card, which the card service writes and the backend cannot read", async () => {
    const card = await newCard();
    const check = (state = 'pending') =>
      sqlstate(cards, `INSERT INTO cards.card_checks (card_id, meeting_id, event_id, event_at, state) VALUES ($1, $2, gen_random_uuid(), now(), $3)`, [
        card,
        meetingId,
        state,
      ]);
    expect(await check('waiting')).toBe(CHECK_VIOLATION);
    expect(await check()).toBe('ok');
    expect(await check()).toBe(UNIQUE_VIOLATION);
    const gone = await runtime.query(`INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES ('occ-cards-3', '333333333') RETURNING id`);
    const named = await newCard(gone.rows[0].id, null);
    const pick = (confidence: number) =>
      sqlstate(cards, `UPDATE cards.card_checks SET state = 'done', dup_card_id = $2, dup_confidence = $3, rel_card_id = $2, rel_confidence = 0.1 WHERE card_id = $1`, [
        card,
        named,
        confidence,
      ]);
    expect(await pick(0.7)).toBe('ok');
    expect(await pick(1.5)).toBe(CHECK_VIOLATION);
    expect(await sqlstate(cards, `UPDATE cards.card_checks SET dup_card_id = gen_random_uuid() WHERE card_id = $1`, [card])).toBe(FOREIGN_KEY_VIOLATION);
    expect(await sqlstate(cards, `DELETE FROM cards.card_checks`)).toBe(INSUFFICIENT_PRIVILEGE);
    // The named card going leaves the check, without a name.
    await runtime.query(`DELETE FROM bwat.meetings WHERE id = $1`, [gone.rows[0].id]);
    const { rows } = await cards.query(`SELECT dup_card_id, dup_confidence, rel_card_id FROM cards.card_checks WHERE card_id = $1`, [card]);
    expect(rows).toEqual([{ dup_card_id: null, dup_confidence: 0.7, rel_card_id: null }]);
  });

  // A draft until its meeting ends or a person acts; a live card nobody touches closes as no_response.
  it('takes draft and no_response, and lets the card service set when a card went live and was accepted', async () => {
    const card = await newCard();
    const set = (sql: string) => sqlstate(cards, `UPDATE cards.cards SET ${sql} WHERE id = $1`, [card]);
    for (const status of ['draft', 'open', 'no_response', 'done', 'wont_do']) expect(await set(`status = '${status}'`)).toBe('ok');
    expect(await set(`status = 'expired'`)).toBe(CHECK_VIOLATION);
    expect(await set('live_at = NULL, accepted_at = now()')).toBe('ok');
    // A card made without a status goes live as it is made.
    const { rows } = await cards.query(`SELECT status, live_at IS NOT NULL AS live, accepted_at FROM cards.cards WHERE id = $1`, [await newCard()]);
    expect(rows[0]).toEqual({ status: 'open', live: true, accepted_at: null });
  });

  it('deletes every card-side row with its meeting', async () => {
    const card = await newCard(otherMeetingId, null);
    await cards.query(
      `INSERT INTO cards.evidence (card_id, meeting_id, epoch, seq, speaker_label, text, source) VALUES ($1, $2, 1, 1, 'S', 't', 'asr')`,
      [card, otherMeetingId],
    );
    await cards.query(`INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind) VALUES ($1, $2, 'card.create', 'writer')`, [
      card,
      otherMeetingId,
    ]);
    await cards.query(`INSERT INTO cards.card_links (meeting_id, from_card_id, to_todo_id, kind) VALUES ($1, $2, 'T-1', 'todo_twin')`, [
      otherMeetingId,
      card,
    ]);
    // Both ends in the meeting being deleted.
    const answer = await newCard(otherMeetingId, null);
    await cards.query(`INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) VALUES ($1, $2, $3, 'answers')`, [
      otherMeetingId,
      answer,
      card,
    ]);
    await cards.query(`INSERT INTO cards.capture_positions (meeting_id, epoch, last_seq) VALUES ($1, 1, 1)`, [otherMeetingId]);
    await cards.query(`INSERT INTO cards.card_checks (card_id, meeting_id, event_id, event_at) VALUES ($1, $2, gen_random_uuid(), now())`, [
      card,
      otherMeetingId,
    ]);
    await cards.query(`INSERT INTO cards.card_carries (card_id, meeting_id) VALUES ($1, $2)`, [card, otherMeetingId]);
    await runtime.query(`DELETE FROM bwat.meetings WHERE id = $1`, [otherMeetingId]);
    for (const table of ['cards', 'evidence', 'card_events', 'card_links', 'capture_positions', 'card_orders', 'card_checks', 'card_carries']) {
      const { rows } = await cards.query(`SELECT count(*) FROM cards.${table} WHERE meeting_id = $1`, [otherMeetingId]);
      expect([table, rows[0].count]).toEqual([table, '0']);
    }
  });

  it('runs the card service as a login that owns nothing and cannot bypass anything', async () => {
    const { rows } = await asSuperuser(
      (su) =>
        su.query(
          `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
                  EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) AS owns_relations,
                  EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid) AS owns_schemas
             FROM pg_roles r WHERE r.rolname = $1`,
          [ROLE_NAMES.cards],
        ),
      db.name,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      owns_relations: false,
      owns_schemas: false,
    });
  });

  it('refuses to migrate without the card login, saying where to create it', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0009_cards_schema.sql'), 'utf8');
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'bwat_cards'\)/);
    expect(sql).toMatch(/RAISE EXCEPTION '[^']*bwat_cards[^']*10-roles\.sql/);
  });
});
