import { beforeAll, beforeEach, expect, it } from 'vitest';
import { CARD_IDS_MAX } from '../../../src/http.ts';
import { ADDS_PER_MEMBER_PER_MIN, goals } from '../../../src/plugins/goals/index.ts';
import { switchOn } from '../../app.ts';
import { asSuperuser, describeDb } from '../../db/harness.ts';
import { ADMIN, ADMIN_ID, MEMBER, useRoles } from '../../people.ts';

// QOR-4921: the goals plugin's API (phase 1), what the board and other products read and write.
describeDb('the goals plugin (QOR-4921)', () => {
  // Wednesday 21 Oct 2026, noon in New York (the list's default timezone); each test a minute on,
  // so each starts a fresh rate-limit window.
  const NOON = Date.UTC(2026, 9, 21, 16, 0);
  let tick = 0;
  let clock = NOON;
  const t = useRoles({ plugins: [goals], clock: () => clock });
  beforeAll(() => switchOn(t.pool, 'goals'));
  const url = (path: string) => `/plugins/goals${path}`;
  const get = (path: string, headers = MEMBER) => t.app.inject({ method: 'GET', url: url(path), headers });
  const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, payload?: unknown, headers = MEMBER) =>
    t.app.inject({ method, url: url(path), headers, ...(payload !== undefined && { payload: payload as object }) });
  const su = (sql: string, params: unknown[] = []) => asSuperuser((c) => c.query(sql, params), t.db.name);

  let meetingId: string;
  const newCard = async () =>
    (
      await su(
        `INSERT INTO cards.cards (meeting_id, kind, display_number, title) VALUES ($1, 'todo', nextval('cards.todo_numbers'), 'A card') RETURNING id`,
        [meetingId],
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    meetingId = (await su(`INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES ('occ-goals', '444444444') RETURNING id`)).rows[0].id;
  });

  beforeEach(async () => {
    clock = NOON + ++tick * 61_000;
    await su(`TRUNCATE goals.card_links, goals.goals`);
    await su(`UPDATE goals.lists SET cadence = 'week', timezone = 'America/New_York', anchor = '2024-01-01', revision = 1`);
  });

  /** A goal of this period, promoted by the admin. */
  const goal = async (title: string, date?: string) => {
    const draft = (await send('POST', '/goals', { title, ...(date && { date }) })).json();
    return (await send('POST', `/goals/${draft.id}/promote`, { revision: draft.revision }, ADMIN)).json();
  };

  it('reads this week and next, labelled in board order; drafts carry no label', async () => {
    const g1 = await goal('Ship the plugin');
    const g2 = await goal('Wire the board');
    await send('POST', '/goals', { title: 'Maybe later' });
    await goal('Next week', '2026-10-28');
    const res = await get('/current');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.list).toMatchObject({ name: 'Company goals', cadence: 'week', timezone: 'America/New_York' });
    expect(body.period).toEqual({ start: '2026-10-19', end: '2026-10-26' });
    expect(body.goals.map((g: { title: string; label: string | null }) => [g.title, g.label])).toEqual([
      ['Ship the plugin', 'G1'],
      ['Wire the board', 'G2'],
      ['Maybe later', null],
    ]);
    expect(body.next.period.start).toBe('2026-10-26');
    expect(body.next.goals.map((g: { label: string }) => g.label)).toEqual(['G1']);
    // a goal alone carries its label too
    expect((await get(`/goals/${g2.id}`)).json().label).toBe('G2');
    expect((await get(`/goals/${g1.id}`)).json().updated_by_name).toBeNull();
  });

  it('refuses a draft for a past period, and needs a signed-in person', async () => {
    expect((await send('POST', '/goals', { title: 'Too late', date: '2026-10-12' })).json()).toEqual({ error: 'past_period' });
    expect((await send('POST', '/goals', { title: '   ' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: url('/current') })).statusCode).toBe(401);
  });

  it('edits at a revision: a stale one is refused with the goal as it is now', async () => {
    const g = await goal('Ship');
    const edited = await send('PATCH', `/goals/${g.id}`, { revision: g.revision, summary: 'By Friday' });
    expect(edited.json()).toMatchObject({ summary: 'By Friday', revision: g.revision + 1 });
    const stale = await send('PATCH', `/goals/${g.id}`, { revision: g.revision, title: 'Other' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale_revision', goal: { title: 'Ship', revision: g.revision + 1 } });
    expect((await send('PATCH', `/goals/${g.id}`, { revision: 1 })).statusCode).toBe(400);
    expect((await send('PATCH', '/goals/not-a-uuid', { revision: 1, title: 'x' })).statusCode).toBe(404);
  });

  it('promote, dismiss and outcome are an admin\'s, audited', async () => {
    const draft = (await send('POST', '/goals', { title: 'Draft' })).json();
    expect((await send('POST', `/goals/${draft.id}/promote`, { revision: draft.revision })).statusCode).toBe(403);
    const dismissed = (await send('POST', `/goals/${draft.id}/dismiss`, { revision: draft.revision }, ADMIN)).json();
    expect(dismissed.state).toBe('dismissed');
    expect((await get('/current')).json().goals).toEqual([]);
    expect((await get('/goals?include=dismissed')).json().goals.map((g: { id: string }) => g.id)).toEqual([draft.id]);
    const audit = await t.pool.query(`SELECT actor_id FROM audit WHERE action = 'goal.dismissed' AND target_id = $1`, [draft.id]);
    expect(audit.rows).toEqual([{ actor_id: ADMIN_ID }]);
  });

  it('carried makes one copy in the next period; un-carrying dismisses it unless a person touched it', async () => {
    const g = await goal('Carry me');
    const carried = (await send('POST', `/goals/${g.id}/outcome`, { revision: g.revision, outcome: 'carried' }, ADMIN)).json();
    expect(carried.outcome).toBe('carried');
    const next = (await get('/current')).json().next.goals;
    expect(next).toMatchObject([{ title: 'Carry me', state: 'goal', carried_from: g.id, label: 'G1' }]);
    const met = (await send('POST', `/goals/${g.id}/outcome`, { revision: carried.revision, outcome: 'met' }, ADMIN)).json();
    expect(met.outcome).toBe('met');
    expect((await get('/current')).json().next.goals).toEqual([]);
    // carried again: the same copy comes back; edited, un-carrying is refused
    const again = (await send('POST', `/goals/${g.id}/outcome`, { revision: met.revision, outcome: 'carried' }, ADMIN)).json();
    const copy = (await get('/current')).json().next.goals[0];
    expect(copy.id).toBe(next[0].id);
    await send('PATCH', `/goals/${copy.id}`, { revision: copy.revision, summary: 'Edited' });
    const refused = await send('POST', `/goals/${g.id}/outcome`, { revision: again.revision, outcome: null }, ADMIN);
    expect(refused.json()).toEqual({ error: 'carried_copy_edited' });
  });

  it('links a card to a goal; links?cards= answers the label; unknown card or goal is 404', async () => {
    await goal('First');
    const g2 = await goal('Second');
    const card = await newCard();
    const other = await newCard();
    const linked = await send('PUT', `/cards/${card}/goal`, { goal_id: g2.id });
    expect(linked.statusCode).toBe(200);
    const links = (await get(`/links?cards=${card},${other}`)).json();
    expect(links).toEqual({ links: [{ card_id: card, goal: { id: g2.id, label: 'G2', title: 'Second', state: 'goal' } }] });
    expect((await send('PUT', `/cards/00000000-0000-4000-8000-000000000000/goal`, { goal_id: g2.id })).statusCode).toBe(404);
    expect((await send('PUT', `/cards/${card}/goal`, { goal_id: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    expect((await send('DELETE', `/cards/${card}/goal`)).statusCode).toBe(204);
    expect((await get(`/links?cards=${card}`)).json()).toEqual({ links: [] });
    // a deleted card takes its link with it
    await send('PUT', `/cards/${other}/goal`, { goal_id: g2.id });
    await su(`DELETE FROM cards.cards WHERE id = $1`, [other]);
    expect((await su(`SELECT count(*)::int AS n FROM goals.card_links`)).rows[0].n).toBe(0);
  });

  it("a goal's cards, for the board narrowed to it; an unknown goal is 404", async () => {
    const g1 = await goal('First');
    const g2 = await goal('Second');
    const [a, b, c] = [await newCard(), await newCard(), await newCard()];
    await send('PUT', `/cards/${a}/goal`, { goal_id: g2.id });
    await send('PUT', `/cards/${b}/goal`, { goal_id: g2.id });
    await send('PUT', `/cards/${c}/goal`, { goal_id: g1.id });
    const res = (await get(`/goals/${g2.id}/cards`)).json();
    expect(res.goal).toEqual({ id: g2.id, label: 'G2', title: 'Second' });
    expect(res.card_ids.sort()).toEqual([a, b].sort());
    expect((await get('/goals/00000000-0000-4000-8000-000000000000/cards')).statusCode).toBe(404);
    expect((await get('/goals/not-a-uuid/cards')).statusCode).toBe(404);
  });

  it('says whether the reader may promote, dismiss and decide outcomes', async () => {
    expect((await get('/current')).json().can_decide).toBe(false);
    expect((await get('/current', ADMIN)).json().can_decide).toBe(true);
  });

  it('refuses a link to a dismissed goal, and a links read without cards or with too many', async () => {
    const draft = (await send('POST', '/goals', { title: 'Gone' })).json();
    await send('POST', `/goals/${draft.id}/dismiss`, { revision: draft.revision }, ADMIN);
    expect((await send('PUT', `/cards/${await newCard()}/goal`, { goal_id: draft.id })).json()).toEqual({ error: 'dismissed' });
    expect((await get('/links')).statusCode).toBe(400);
    const many = Array.from({ length: CARD_IDS_MAX + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await get(`/links?cards=${many.join(',')}`)).statusCode).toBe(400);
  });

  it('the rhythm is an admin\'s: a switch to monthly keeps the week\'s goals in view, labelled within the month', async () => {
    await goal('Week 1 goal');
    await goal('Week 2 goal', '2026-10-28');
    const list = (await get('/settings')).json();
    expect((await send('PUT', '/settings', { revision: list.revision, cadence: 'month' })).statusCode).toBe(403);
    const set = await send('PUT', '/settings', { revision: list.revision, cadence: 'month' }, ADMIN);
    expect(set.json()).toMatchObject({ cadence: 'month', revision: list.revision + 1 });
    const current = (await get('/current')).json();
    expect(current.period).toEqual({ start: '2026-10-01', end: '2026-11-01' });
    expect(current.goals.map((g: { title: string; label: string }) => [g.title, g.label])).toEqual([
      ['Week 1 goal', 'G1'],
      ['Week 2 goal', 'G2'],
    ]);
    expect((await send('PUT', '/settings', { revision: list.revision, cadence: 'week' }, ADMIN)).json()).toEqual({ error: 'stale_revision' });
    expect((await send('PUT', '/settings', { revision: list.revision + 1, timezone: 'Mars/Olympus' }, ADMIN)).statusCode).toBe(400);
    expect((await send('PUT', '/settings', { revision: list.revision + 1, anchor: '2026-10-21' }, ADMIN)).statusCode).toBe(400);
  });

  it("today is the list's: Sunday night in New York is still last week", async () => {
    clock = Date.UTC(2026, 9, 26, 3, 0); // Monday 03:00 UTC = Sunday 23:00 in New York
    expect((await get('/current')).json().period.start).toBe('2026-10-19');
  });
  it('brings a dismissed carry copy back in the next period as the rhythm now has it, with the text as it is now', async () => {
    const g = await goal('Carry me');
    const carried = (await send('POST', `/goals/${g.id}/outcome`, { revision: g.revision, outcome: 'carried' }, ADMIN)).json();
    const undone = (await send('POST', `/goals/${g.id}/outcome`, { revision: carried.revision, outcome: null }, ADMIN)).json();
    const edited = (await send('PATCH', `/goals/${g.id}`, { revision: undone.revision, title: 'Carry me, renamed' })).json();
    const list = (await get('/settings')).json();
    await send('PUT', '/settings', { revision: list.revision, cadence: 'month' }, ADMIN);
    await send('POST', `/goals/${g.id}/outcome`, { revision: edited.revision, outcome: 'carried' }, ADMIN);
    const current = (await get('/current')).json();
    expect(current.goals.map((x: { id: string }) => x.id)).toEqual([g.id]);
    expect(current.next.period.start).toBe('2026-11-01');
    expect(current.next.goals).toMatchObject([{ title: 'Carry me, renamed', carried_from: g.id, period_start: '2026-11-01' }]);
  });

  it('labels links whose goals sit in different periods, each within its own', async () => {
    await goal('This week A');
    const b = await goal('This week B');
    const n = await goal('Next week', '2026-10-28');
    const [c1, c2] = [await newCard(), await newCard()];
    await send('PUT', `/cards/${c1}/goal`, { goal_id: b.id });
    await send('PUT', `/cards/${c2}/goal`, { goal_id: n.id });
    const labels = async () =>
      Object.fromEntries((await get(`/links?cards=${c1},${c2}`)).json().links.map((l: { card_id: string; goal: { label: string } }) => [l.card_id, l.goal.label]));
    expect(await labels()).toEqual({ [c1]: 'G2', [c2]: 'G1' });
    expect((await get(`/goals/${n.id}`)).json().label).toBe('G1');
    // monthly: all three are October's goals now
    const list = (await get('/settings')).json();
    await send('PUT', '/settings', { revision: list.revision, cadence: 'month' }, ADMIN);
    expect(await labels()).toEqual({ [c1]: 'G2', [c2]: 'G3' });
    expect((await get(`/goals/${n.id}`)).json().label).toBe('G3');
  });

  it('takes dates in years 2000-2999 only, outcomes from admins only, and limits adds per member', async () => {
    expect((await send('POST', '/goals', { title: 'Far', date: '9999-12-31' })).statusCode).toBe(400);
    expect((await get('/goals?date=9999-12-31')).statusCode).toBe(400);
    const g = await goal('Mine');
    expect((await send('POST', `/goals/${g.id}/outcome`, { revision: g.revision, outcome: 'met' })).statusCode).toBe(403);
    // goal() added one already
    for (let i = 1; i < ADDS_PER_MEMBER_PER_MIN; i++) expect((await send('POST', '/goals', { title: `Draft ${i}` })).statusCode).toBe(201);
    expect((await send('POST', '/goals', { title: 'One too many' })).statusCode).toBe(429);
    expect((await send('POST', '/goals', { title: 'Another person' }, ADMIN)).statusCode).toBe(201);
  });
});
