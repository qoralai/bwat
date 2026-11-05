import { afterEach, describe, expect, it } from 'vitest';
import { CARD, CARD_OWNED, fakeServer, loadPage, until } from '../../board-harness.ts';

// A person shows or hides a plugin on their own board, in Settings (the goals plugin as the one on).
// Hidden, it is still on for everyone else; only what it draws on this board goes.
let close: (() => void) | undefined;
afterEach(() => close?.());

const GOAL = { id: 'aaaaaaaa-0000-4000-8000-000000000002', title: 'Board is easy to scan', label: 'G2', state: 'goal' };
const HIDDEN = { 'bwat.hidden-plugins': '["goals"]' };

const server = (on = true) => fakeServer({
  boardPlugins: { plugins: on ? [{ name: 'goals', token: null, scripts: ['/plugins/goals/board.js'] }] : [], reserved: [] },
  extra: {
    'GET /v1/plugins/goals/current': () => [200, { list: null, period: null, goals: [GOAL], next: null, can_decide: false }],
    'GET /v1/plugins/goals/links': () => [200, { links: [{ card_id: CARD, goal: GOAL }] }],
    [`GET /v1/plugins/goals/goals/${GOAL.id}/cards`]: () => [200, { goal: GOAL, card_ids: [CARD] }],
  },
});
const open = async (query = '', s = server(), storage: Record<string, string> = {}) => {
  const loaded = await loadPage('board.html', s, query, { storage });
  close = () => loaded.window.close();
  return loaded;
};
const tile = (document: Document, id: string) => document.querySelector(`#card-list [data-card="${id}"]`);
const settings = async (document: Document) => {
  (document.getElementById('settings-open') as HTMLButtonElement).click();
  await until(() => !!document.querySelector('#settings-dialog .settings-form'));
  return document.querySelector('#settings-dialog')!;
};
const groups = (dlg: Element) => [...dlg.querySelectorAll('.settings-group')].map((h) => h.textContent);

describe('showing and hiding a plugin on your own board', () => {
  it('lists the plugin in Settings, and turning it off takes its tag and page link away while every card stays', async () => {
    // Pinned, so the gear's click outside the column leaves it open.
    const { document, window } = await open('', server(), { 'bwat.study.v1.board.nav': '"open"' });
    await until(() => !!tile(document, CARD)?.querySelector('.plugin-tag') && !!document.querySelector('[data-plugin-page="goals"]'));
    const dlg = await settings(document);
    expect(groups(dlg)).toContain('Plugins');
    const sw = dlg.querySelector<HTMLInputElement>('[data-plugin-switch="goals"]')!;
    expect(sw.checked).toBe(true);
    sw.checked = false;
    sw.dispatchEvent(new window.Event('change', { bubbles: true }));
    await until(() => !tile(document, CARD)?.querySelector('.plugin-tag'));
    expect(document.querySelector('[data-plugin-page="goals"]')).toBeNull();
    expect(tile(document, CARD)).not.toBeNull();
    expect(tile(document, CARD_OWNED)).not.toBeNull();
    expect(window.localStorage.getItem('bwat.hidden-plugins')).toBe('["goals"]');
  });

  it('has no plugin switches inside Zoom: no Plugins group in Settings, no button for it in the column', async () => {
    const { document } = await open('?surface=zoom', server(), { 'bwat.study.v1.board.nav': '"open"' });
    await until(() => !!tile(document, CARD)?.querySelector('.plugin-tag'));
    document.querySelector<HTMLButtonElement>('#nav-configure')!.click();
    expect(document.querySelector('#filter-config [data-show="people"]')).not.toBeNull();
    expect(document.querySelector('#filter-config [data-open-plugins]')).toBeNull();
    const dlg = await settings(document);
    expect(groups(dlg)).not.toContain('Plugins');
    expect(dlg.querySelector('[data-plugin-switch]')).toBeNull();
  });

  it('has no Plugins group when no plugin is on', async () => {
    const { document } = await open('', server(false));
    await until(() => !!tile(document, CARD));
    expect(groups(await settings(document))).not.toContain('Plugins');
  });

  it('keeps it hidden on the next visit, as this browser remembers', async () => {
    const { document } = await open('', server(), HIDDEN);
    await until(() => !!tile(document, CARD));
    await until(() => document.querySelector('#plugin-pages') !== null);
    expect(tile(document, CARD)!.querySelector('.plugin-tag')).toBeNull();
    expect((await settings(document)).querySelector<HTMLInputElement>('[data-plugin-switch="goals"]')!.checked).toBe(false);
  });

  it('shows every card for a link that narrows by a hidden plugin, says why, and Show brings it back', async () => {
    const { document } = await open(`?source=all&narrow=goals:${GOAL.id}`, server(), HIDDEN);
    await until(() => !!document.querySelector('#plugin-narrow:not([hidden])'));
    const bar = document.querySelector('#plugin-narrow')!;
    expect(bar.textContent).toContain('Goals is hidden on your board, so this link’s goals filter is off.');
    expect(tile(document, CARD)).not.toBeNull();
    expect(tile(document, CARD_OWNED)).not.toBeNull();
    (bar.querySelector('button') as HTMLButtonElement).click();
    await until(() => !tile(document, CARD_OWNED) && !!tile(document, CARD)?.querySelector('.plugin-tag'));
    expect(document.querySelector('#plugin-narrow')!.textContent).toContain('Goal: ');
  });
});
