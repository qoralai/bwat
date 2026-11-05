import { afterEach, describe, expect, it } from 'vitest';
import { CARD, CARD_OWNED, fakeServer, loadPage, OLD_CARD, QUESTION, until } from '../../board-harness.ts';

// The goals plugin on the board (web/plugins/goals/board/board.js), as the board pages load it
// from /board-plugins: on the plain board too, which asks for no plugin's sign-in.
let close: (() => void) | undefined;
afterEach(() => close?.());

const goal = (n: number, title: string, more: Record<string, unknown> = {}) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${n}`, title, summary: '', details: '', state: 'goal', label: `G${n}`,
  outcome: null, carried_from: null, revision: 1, period_start: '2026-10-19', ...more,
});
const SHIP = goal(1, 'Ship the plugin');
const BOARD = goal(2, 'Board is easy to scan');
const MAYBE = goal(3, 'Maybe later', { state: 'draft', label: null });
const NEXT = goal(4, 'Next one', { period_start: '2026-10-26', label: 'G1' });
const LIST = { id: 'bbbbbbbb-0000-4000-8000-000000000001', name: 'Company goals', cadence: 'week', timezone: 'America/New_York', anchor: '2024-01-01', revision: 1 };

/** The board with the plugin on: CARD serves BOARD, CARD_OWNED serves none. */
function server(more: Record<string, (url: URL, body: unknown) => [number, unknown]> = {}, { canDecide = false } = {}) {
  const links: Record<string, string> = { [CARD]: BOARD.id };
  const current = [SHIP, BOARD, MAYBE];
  return fakeServer({
    boardPlugins: { plugins: [{ name: 'goals', token: null, scripts: ['/plugins/goals/board.js'] }], reserved: [] },
    extra: {
      'GET /v1/plugins/goals/current': () => [200, {
        list: LIST, period: { start: '2026-10-19', end: '2026-10-26' }, goals: current,
        next: { period: { start: '2026-10-26', end: '2026-11-02' }, goals: [NEXT] }, can_decide: canDecide,
      }],
      'GET /v1/plugins/goals/links': (url) => [200, {
        links: url.searchParams.get('cards')!.split(',').filter((id) => links[id]).map((id) => {
          const g = [...current, NEXT].find((x) => x.id === links[id])!;
          return { card_id: id, goal: { id: g.id, label: g.label, title: g.title, state: g.state } };
        }),
      }],
      ...Object.fromEntries([CARD, CARD_OWNED].flatMap((id) => [
        [`PUT /v1/plugins/goals/cards/${id}/goal`, (_url: URL, body: unknown) => { links[id] = (body as { goal_id: string }).goal_id; return [200, { card_id: id }]; }],
        [`DELETE /v1/plugins/goals/cards/${id}/goal`, () => { delete links[id]; return [204, null]; }],
      ])),
      ...more,
    },
  });
}

const open = async (query = '', s = server()) => {
  const loaded = await loadPage('board.html', s, query);
  close = () => loaded.window.close();
  return loaded;
};
const tile = (document: Document, id: string) => document.querySelector(`#card-list [data-card="${id}"]`);
const change = (el: HTMLSelectElement, value: string) => { el.value = value; el.dispatchEvent(new el.ownerDocument.defaultView!.Event('change')); };

describe('the goals plugin on the board', () => {
  it("shows the goal a card serves on its tile, and nothing on a card serving none", async () => {
    const { document } = await open();
    await until(() => !!tile(document, CARD)?.querySelector('.plugin-tag'));
    expect(tile(document, CARD)!.querySelector('.plugin-tag')!.textContent).toBe('G2 Board is easy to scan');
    expect(tile(document, CARD_OWNED)!.querySelector('.plugin-tag')).toBeNull();
  });

  it("picks a card's goal in its detail panel, from this period's goals, and None unlinks it", async () => {
    const { document, server: s } = await open(`?card=${CARD_OWNED}`);
    await until(() => !!document.querySelector(`#reader select[name="goals"] option[value="${SHIP.id}"]`));
    const pick = document.querySelector<HTMLSelectElement>('#reader select[name="goals"]')!;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['None', 'G1 Ship the plugin', 'G2 Board is easy to scan']);
    change(pick, SHIP.id);
    await until(() => tile(document, CARD_OWNED)?.querySelector('.plugin-tag')?.textContent === 'G1 Ship the plugin');
    expect(s.calls.find((c) => c.method === 'PUT')!.body).toEqual({ goal_id: SHIP.id });
    change(document.querySelector<HTMLSelectElement>('#reader select[name="goals"]')!, '');
    await until(() => s.calls.some((c) => c.method === 'DELETE'));
    await until(() => !tile(document, CARD_OWNED)?.querySelector('.plugin-tag'));
  });

  it('puts the menu back and says so when a link is refused', async () => {
    const s = server({ [`PUT /v1/plugins/goals/cards/${CARD}/goal`]: () => [409, { error: 'dismissed' }] });
    const { document } = await open(`?card=${CARD}`, s);
    await until(() => !!document.querySelector(`#reader select[name="goals"] option[value="${SHIP.id}"]`));
    const pick = document.querySelector<HTMLSelectElement>('#reader select[name="goals"]')!;
    change(pick, SHIP.id);
    await until(() => !!document.querySelector('#reader .plugin-row[data-plugin="goals"] [role="status"]')?.textContent);
    expect(pick.value).toBe(BOARD.id);
  });

  it('says so when a new goal is not added', async () => {
    const s = server({ 'POST /v1/plugins/goals/goals': () => [429, { error: 'rate_limited' }] });
    const { document } = await open('?page=goals', s);
    await until(() => !!document.querySelector('#plugin-page form.goal-add'));
    const add = document.querySelector<HTMLFormElement>('#plugin-page form.goal-add')!;
    (add.querySelector('[name="title"]') as HTMLInputElement).value = 'Board filters';
    add.requestSubmit();
    await until(() => !!document.querySelector('#goals-status')?.textContent);
    expect(document.querySelector('#goals-status')!.textContent).toBe('Not added. Try again.');
    expect((add.querySelector('[name="title"]') as HTMLInputElement).value).toBe('Board filters');
  });

  it("keeps a goal from another period as the chosen one in a linked card's menu", async () => {
    const s = server({ 'GET /v1/plugins/goals/links': () => [200, { links: [{ card_id: CARD, goal: { id: 'aaaaaaaa-0000-4000-8000-00000000000a', label: 'G1', title: 'Last week', state: 'goal' } }] }] });
    const { document } = await open(`?card=${CARD}`, s);
    await until(() => !!document.querySelector(`#reader select[name="goals"] option[value="${SHIP.id}"]`));
    expect(document.querySelector<HTMLSelectElement>('#reader select[name="goals"]')!.selectedOptions[0]!.textContent).toBe('G1 Last week');
  });

  it("narrows the board to a goal's cards, with a bar to clear it", async () => {
    const s = server({
      [`GET /v1/plugins/goals/goals/${BOARD.id}/cards`]: () => [200, { goal: { id: BOARD.id, label: 'G2', title: BOARD.title }, card_ids: [OLD_CARD, QUESTION] }],
    });
    const { document } = await open(`?source=open&narrow=goals:${BOARD.id}`, s);
    const shown = () => [...document.querySelectorAll('#card-list [data-card]')].map((a) => a.getAttribute('data-card')).sort();
    await until(() => shown().length === 2);
    expect(shown()).toEqual([OLD_CARD, QUESTION].sort());
    expect(document.querySelector('#plugin-narrow')!.textContent).toContain('Goal: G2 Board is easy to scan');
  });

  it("has a Goals page with this week's and next week's goals, each linking to its cards", async () => {
    const { document } = await open();
    document.querySelector<HTMLButtonElement>('#nav-toggle')!.click();
    await until(() => !!document.querySelector('#filter-groups a[data-plugin-page="goals"]'));
    document.querySelector<HTMLAnchorElement>('#filter-groups a[data-plugin-page="goals"]')!.click();
    await until(() => document.querySelectorAll('#plugin-page .goal-row').length === 4);
    expect(document.querySelector('#workspace')!.hasAttribute('hidden')).toBe(true);
    const headings = [...document.querySelectorAll('#plugin-page h2')].map((h) => h.textContent);
    expect(headings).toEqual(['This week', 'Next week']);
    const rows = [...document.querySelectorAll('#plugin-page .goal-row')];
    expect(rows[0]!.textContent).toContain('G1');
    expect(rows[0]!.textContent).toContain('Ship the plugin');
    expect(rows[2]!.textContent).toContain('Draft');
    expect(rows[0]!.querySelector('a.goal-cards')!.getAttribute('href')).toContain(`narrow=goals%3A${SHIP.id}`);
    // a member is not offered what only an owner or admin may do
    expect(document.querySelector('#plugin-page .goal-promote, #plugin-page select[name="outcome"]')).toBeNull();
  });

  it('names the periods by the list\'s rhythm', async () => {
    const s = server({
      'GET /v1/plugins/goals/current': () => [200, { list: { ...LIST, cadence: 'quarter' }, period: { start: '2026-10-01', end: '2027-01-01' }, goals: [], next: { period: { start: '2027-01-01', end: '2027-04-01' }, goals: [] }, can_decide: false }],
    });
    const { document } = await open('?page=goals', s);
    await until(() => document.querySelectorAll('#plugin-page h2').length === 2);
    expect([...document.querySelectorAll('#plugin-page h2')].map((h) => h.textContent)).toEqual(['This quarter', 'Next quarter']);
  });

  it('adds a draft goal and edits a goal at its revision', async () => {
    const s = server({
      'POST /v1/plugins/goals/goals': (_url, body) => [201, goal(5, (body as { title: string }).title, { state: 'draft', label: null })],
      [`PATCH /v1/plugins/goals/goals/${SHIP.id}`]: (_url, body) => [200, { ...SHIP, ...(body as object), revision: 2 }],
    });
    const { document } = await open('?page=goals', s);
    await until(() => document.querySelectorAll('#plugin-page .goal-row').length === 4);
    const add = document.querySelector<HTMLFormElement>('#plugin-page form.goal-add')!;
    expect(document.querySelector('#plugin-page .goal-tip')!.textContent).toContain('SMART');
    (add.querySelector('[name="title"]') as HTMLInputElement).value = 'Board filters';
    (add.querySelector('[name="summary"]') as HTMLTextAreaElement).value = 'Filter by goal in the left column, live in dev by Friday';
    add.requestSubmit();
    await until(() => s.calls.some((c) => c.method === 'POST'));
    expect(s.calls.find((c) => c.method === 'POST')!.body).toEqual({ title: 'Board filters', summary: 'Filter by goal in the left column, live in dev by Friday' });
    await until(() => !!document.querySelector(`#plugin-page button.goal-edit[data-goal="${SHIP.id}"]`));
    document.querySelector<HTMLButtonElement>(`#plugin-page button.goal-edit[data-goal="${SHIP.id}"]`)!.click();
    const form = document.querySelector<HTMLFormElement>('#plugin-page form.goal-change')!;
    const summary = form.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')!;
    summary.value = 'By Friday';
    form.requestSubmit();
    await until(() => s.calls.some((c) => c.method === 'PATCH'));
    // only what changed, at the revision it was read at
    expect(s.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ revision: 1, summary: 'By Friday' });
  });

  it('keeps the line breaks in a description on the Goals page', async () => {
    const s = server({
      'GET /v1/plugins/goals/current': () => [200, {
        list: LIST, period: { start: '2026-10-19', end: '2026-10-26' }, goals: [{ ...SHIP, summary: 'Specific: X\nMeasurable: Y' }],
        next: { period: { start: '2026-10-26', end: '2026-11-02' }, goals: [] }, can_decide: false,
      }],
    });
    const { document, window } = await open('?page=goals', s);
    await until(() => !!document.querySelector('#plugin-page .goal-name small'));
    const summary = document.querySelector('#plugin-page .goal-name small')!;
    expect(summary.textContent).toBe('Specific: X\nMeasurable: Y');
    expect(window.getComputedStyle(summary).whiteSpace).toBe('pre-line');
  });

  it('closes an edit that changed nothing without sending it', async () => {
    const { document, server: s } = await open('?page=goals');
    await until(() => !!document.querySelector(`#plugin-page button.goal-edit[data-goal="${SHIP.id}"]`));
    document.querySelector<HTMLButtonElement>(`#plugin-page button.goal-edit[data-goal="${SHIP.id}"]`)!.click();
    document.querySelector<HTMLFormElement>('#plugin-page form.goal-change')!.requestSubmit();
    await until(() => !document.querySelector('#plugin-page form.goal-change'));
    expect(s.calls.some((c) => c.method === 'PATCH')).toBe(false);
    await until(() => document.activeElement?.getAttribute('data-goal') === SHIP.id);
  });

  it('keeps what was typed when someone else changed the goal first, and saves it at the new revision', async () => {
    let saves = 0;
    const s = server({
      [`PATCH /v1/plugins/goals/goals/${SHIP.id}`]: (_url, body) => (++saves === 1
        ? [409, { error: 'stale_revision', goal: { ...SHIP, title: 'Ship it', revision: 2 } }]
        : [200, { ...SHIP, ...(body as object), revision: 3 }]),
    });
    const { document } = await open('?page=goals', s);
    await until(() => !!document.querySelector(`#plugin-page button.goal-edit[data-goal="${SHIP.id}"]`));
    document.querySelector<HTMLButtonElement>(`#plugin-page button.goal-edit[data-goal="${SHIP.id}"]`)!.click();
    const form = document.querySelector<HTMLFormElement>('#plugin-page form.goal-change')!;
    (form.querySelector('[name="summary"]') as HTMLTextAreaElement).value = 'By Friday';
    form.requestSubmit();
    await until(() => !!form.querySelector('[role="status"]')?.textContent);
    expect(form.isConnected).toBe(true);
    expect((form.querySelector('[name="summary"]') as HTMLTextAreaElement).value).toBe('By Friday');
    expect(form.querySelector('[role="status"]')!.textContent).toContain('Someone changed this goal');
    form.requestSubmit();
    await until(() => saves === 2);
    expect(s.calls.filter((c) => c.method === 'PATCH')[1]!.body).toEqual({ revision: 2, summary: 'By Friday' });
  });

  it("says why an outcome was refused and shows the goal's outcome as it is", async () => {
    const s = server({
      [`POST /v1/plugins/goals/goals/${SHIP.id}/outcome`]: () => [409, { error: 'carried_copy_edited' }],
    }, { canDecide: true });
    const { document } = await open('?page=goals', s);
    await until(() => !!document.querySelector(`#plugin-page select[name="outcome"][data-goal="${SHIP.id}"]`));
    change(document.querySelector<HTMLSelectElement>(`#plugin-page select[name="outcome"][data-goal="${SHIP.id}"]`)!, 'met');
    await until(() => !!document.querySelector('#goals-status')?.textContent);
    expect(document.querySelector('#goals-status')!.textContent).toContain('carried copy');
    const pick = document.querySelector<HTMLSelectElement>(`#plugin-page select[name="outcome"][data-goal="${SHIP.id}"]`)!;
    expect(pick.value).toBe('');
    expect(document.activeElement).toBe(pick);
  });

  it('offers an owner or admin promote, dismiss and the outcome', async () => {
    const s = server({
      [`POST /v1/plugins/goals/goals/${MAYBE.id}/promote`]: () => [200, { ...MAYBE, state: 'goal', label: 'G3', revision: 2 }],
      [`POST /v1/plugins/goals/goals/${SHIP.id}/outcome`]: (_url, body) => [200, { ...SHIP, ...(body as object), revision: 2 }],
    }, { canDecide: true });
    const { document } = await open('?page=goals', s);
    await until(() => !!document.querySelector(`#plugin-page button.goal-promote[data-goal="${MAYBE.id}"]`));
    expect(document.querySelector(`#plugin-page button.goal-dismiss[data-goal="${MAYBE.id}"]`)).not.toBeNull();
    document.querySelector<HTMLButtonElement>(`#plugin-page button.goal-promote[data-goal="${MAYBE.id}"]`)!.click();
    await until(() => s.calls.some((c) => c.path.endsWith('/promote')));
    expect(s.calls.find((c) => c.path.endsWith('/promote'))!.body).toEqual({ revision: 1 });
    await until(() => !!document.querySelector(`#plugin-page select[name="outcome"][data-goal="${SHIP.id}"]`));
    change(document.querySelector<HTMLSelectElement>(`#plugin-page select[name="outcome"][data-goal="${SHIP.id}"]`)!, 'met');
    await until(() => s.calls.some((c) => c.path.endsWith('/outcome')));
    expect(s.calls.find((c) => c.path.endsWith('/outcome'))!.body).toEqual({ revision: 1, outcome: 'met' });
    // redrawn, the focus stays on the goal's outcome
    await until(() => document.activeElement === document.querySelector(`#plugin-page select[name="outcome"][data-goal="${SHIP.id}"]`));
  });

  // The filters column (ui/sidebar.js): this period's goals as a group; one picked narrows the
  // board, picked again clears; Configure links to its switch in Settings.
  it("lists this period's goals in the filters column and narrows the board to one", async () => {
    const s = server({ [`GET /v1/plugins/goals/goals/${BOARD.id}/cards`]: () => [200, { goal: BOARD, card_ids: [OLD_CARD, QUESTION] }] });
    const { document, window } = await open('', s);
    document.querySelector<HTMLButtonElement>('#nav-toggle')!.click();
    const links = () => [...document.querySelectorAll<HTMLAnchorElement>('#filter-groups [data-group="goals"] a[data-filter]')];
    await until(() => links().length > 0);
    expect(links().map((a) => a.querySelector('.fi-text')!.textContent).sort()).toEqual(['G1 Ship the plugin', 'G2 Board is easy to scan']);
    const board = () => links().find((a) => a.dataset.value === BOARD.id)!;
    board().click();
    expect(new URLSearchParams(window.location.search).get('narrow')).toBe('goals:' + BOARD.id);
    const shown = () => [...document.querySelectorAll('#card-list [data-card]')].map((a) => a.getAttribute('data-card')).sort();
    await until(() => shown().join() === [OLD_CARD, QUESTION].sort().join());
    expect(board().getAttribute('aria-current')).toBe('true');
    board().click();
    expect(new URLSearchParams(window.location.search).has('narrow')).toBe(false);
  });

  it("lists a tagged card's goal from another week in the filters column, busiest first, with counts and numbers", async () => {
    const LAST = goal(9, 'Last week: tidy the settings drawer', { period_start: '2026-10-12', label: 'G9' });
    const s = server({ 'GET /v1/plugins/goals/links': () => [200, { links: [CARD, CARD_OWNED].map((id) => ({ card_id: id, goal: { id: LAST.id, label: LAST.label, title: LAST.title, state: 'goal' } })) }] });
    const loaded = await loadPage('board.html', s, '', { storage: { 'bwat.study.v1.board.nav': '"open"' } });
    close = () => loaded.window.close();
    const { document } = loaded;
    const rows = () => [...document.querySelectorAll<HTMLAnchorElement>('#filter-groups [data-group="goals"] a[data-filter]')];
    await until(() => rows().length === 3);
    expect(rows().map((a) => a.querySelector('.fi-text')!.textContent)).toEqual(['G9 Last week: tidy the settings drawer', 'G1 Ship the plugin', 'G2 Board is easy to scan']);
    expect(rows().map((a) => a.querySelector('b')!.textContent)).toEqual(['2', '0', '0']);
    expect(rows().map((a) => a.querySelector('.fi-mark')!.textContent)).toEqual(['9', '1', '2']);
    expect(rows()[1]!.classList.contains('zero')).toBe(true);
  });

  it('shows eight goals in the filters column and More goals the rest, and its heading opens the Goals page', async () => {
    const many = Array.from({ length: 10 }, (_, i) => goal(i + 1, 'Goal ' + (i + 1), { id: `aaaaaaaa-0000-4000-8000-0000000001${String(i).padStart(2, '0')}` }));
    const s = server({ 'GET /v1/plugins/goals/current': () => [200, { list: LIST, period: { start: '2026-10-19', end: '2026-10-26' }, goals: many, next: { period: { start: '2026-10-26', end: '2026-11-02' }, goals: [] }, can_decide: false }] });
    const loaded = await loadPage('board.html', s, '', { storage: { 'bwat.study.v1.board.nav': '"open"' } });
    close = () => loaded.window.close();
    const { document } = loaded;
    const rows = () => document.querySelectorAll('#filter-groups [data-group="goals"] a[data-filter]');
    await until(() => rows().length > 0);
    expect(rows().length).toBe(8);
    document.querySelector<HTMLButtonElement>('#filter-groups [data-group="goals"] [data-more]')!.click();
    // The ten, and the goal a card on the board is tagged with.
    expect(rows().length).toBe(11);
    document.querySelector<HTMLAnchorElement>('#filter-groups [data-group="goals"] a[data-plugin-page="goals"]')!.click();
    await until(() => !!document.querySelector('#plugin-page h1'));
    expect(document.querySelector('#plugin-page h1')!.textContent).toBe('Goals');
  });

  it('lists a goal added on the Goals page in a pinned filters column once the page is left', async () => {
    const goals = [SHIP];
    const s = server({ 'GET /v1/plugins/goals/current': () => [200, { list: LIST, period: { start: '2026-10-19', end: '2026-10-26' }, goals, next: { period: { start: '2026-10-26', end: '2026-11-02' }, goals: [] }, can_decide: false }] });
    const loaded = await loadPage('board.html', s, '?page=goals', { storage: { 'bwat.study.v1.board.nav': '"open"' } });
    close = () => loaded.window.close();
    const { document } = loaded;
    const links = () => [...document.querySelectorAll('#filter-groups [data-group="goals"] a[data-filter]')];
    // SHIP, and BOARD, which a card on the board is tagged with.
    await until(() => links().length === 2);
    goals.push(goal(5, 'Added on the page'));
    document.querySelector<HTMLAnchorElement>('#meeting-links a[data-meeting="all"]')!.click();
    await until(() => links().length === 3);
  });

  it("opens Settings at its switch from the filters column's Configure; off, its group and tags go", async () => {
    const loaded = await loadPage('board.html', server(), '', { storage: { 'bwat.study.v1.board.nav': '"open"' } });
    close = () => loaded.window.close();
    const { document, window } = loaded;
    (window as unknown as { Element: typeof Element }).Element.prototype.scrollIntoView = () => {};
    await until(() => !!tile(document, CARD)?.querySelector('.plugin-tag') && !!document.querySelector('#filter-groups [data-group="goals"]'));
    document.querySelector<HTMLButtonElement>('#nav-configure')!.click();
    expect(document.querySelector('#filter-config input[data-show="goals"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('#filter-config [data-open-plugins]')!.click();
    const sw = document.querySelector<HTMLInputElement>('#settings-dialog [data-plugin-switch="goals"]')!;
    expect(document.activeElement).toBe(sw);
    sw.click();
    await until(() => !tile(document, CARD)?.querySelector('.plugin-tag'));
    document.querySelector<HTMLButtonElement>('#nav-configure')!.click();
    expect(document.querySelector('#filter-groups [data-group="goals"]')).toBeNull();
    expect(window.localStorage.getItem('bwat.hidden-plugins')).toBe('["goals"]');
  });
});
