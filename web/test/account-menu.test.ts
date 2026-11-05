import { afterEach, describe, expect, it } from 'vitest';
import { fakeServer, loadPage, until, type Call } from './board-harness.ts';

let close: (() => void) | undefined;
afterEach(() => close?.());

const open = async (server = fakeServer(), query = '') => {
  const loaded = await loadPage('board.html', server, query);
  close = () => loaded.window.close();
  await until(() => loaded.document.querySelector('#viewer-name')?.textContent?.includes('Ada') ?? false);
  return loaded;
};
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const nameButton = (document: Document) => document.querySelector('#viewer-name') as HTMLButtonElement;
const menu = (document: Document) => document.querySelector('#account-menu');
const TWO = [{ id: 'sess-1', name: 'bwat repo' }, { id: 'sess-2', name: 'school work', ageS: 7200 }];

// QOR-4959: your name opens a menu of what is yours, not the board's: the default Claude session and Sign out.
describe('the account menu on your name (QOR-4959)', () => {
  it('is a button on your name that opens and closes the menu, saying so', async () => {
    const { document } = await open();
    const btn = nameButton(document);
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click();
    expect(menu(document)!.getAttribute('role')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    btn.click();
    expect(menu(document)).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('holds who you are, the default session and Sign out, and no settings', async () => {
    const { document } = await open();
    nameButton(document).click();
    const m = menu(document)!;
    expect(m.querySelector('.account-who')!.textContent).toContain('Ada');
    expect(m.querySelector('.account-who')!.textContent).toContain('ada@example.com');
    expect([...m.querySelectorAll('[role=menuitem]')].map((i) => i.textContent!.trim().replace(/\s+/g, ' '))).toEqual([
      'Default Claude session None ▾', 'Sign out',
    ]);
    expect(m.textContent).not.toMatch(/settings/i);
    expect(document.activeElement).toBe(m.querySelector('[role=menuitem]'));
  });

  it('signs out at /auth/logout', async () => {
    const { document } = await open();
    nameButton(document).click();
    expect(menu(document)!.querySelector('#account-signout')!.getAttribute('href')).toBe('/auth/logout');
  });

  it('closes on Esc and on a click outside, focus back on your name after Esc', async () => {
    const { document, window } = await open();
    nameButton(document).click();
    menu(document)!.querySelector<HTMLElement>('[role=menuitem]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu(document)).toBeNull();
    expect(document.activeElement).toBe(nameButton(document));
    nameButton(document).click();
    document.querySelector<HTMLElement>('#main')!.click();
    expect(menu(document)).toBeNull();
  });

  it('moves between items with the arrow keys', async () => {
    const { document, window } = await open();
    nameButton(document).click();
    const items = [...menu(document)!.querySelectorAll<HTMLElement>('[role=menuitem]')];
    items[0]!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    items[1]!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });

  it('names the default and lists your sessions under it, the default first, in the picker’s rows', async () => {
    const server = fakeServer({ sessions: TWO, defaultSession: { session_id: 'sess-2', name: 'school work', live: true } });
    const { document } = await open(server);
    nameButton(document).click();
    const row = document.querySelector('#account-default') as HTMLButtonElement;
    await until(() => row.textContent!.includes('school work'));
    expect(row.getAttribute('aria-expanded')).toBe('false');
    row.click();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    await until(() => document.querySelectorAll('#account-sessions [data-session]').length === 2);
    const list = document.querySelector('#account-sessions')!;
    expect([...list.querySelectorAll('.send-heading')].map((h) => h.textContent)).toEqual(['Default', 'Other sessions']);
    expect([...list.querySelectorAll<HTMLElement>('[data-session]')].map((b) => b.dataset.session)).toEqual(['sess-2', 'sess-1']);
    const pin = list.querySelector('[data-pin="sess-2"]')!;
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(pin.getAttribute('aria-label')).toBe('Default session: school work');
    // No note button: the menu only picks a default, it never sends.
    expect(list.querySelector('[data-note-for]')).toBeNull();
    expect(list.querySelector('[data-session="sess-1"] .send-dot.old')).toBeNull();
    expect(list.querySelector('[data-session="sess-2"] .send-session-meta.old')!.textContent).toBe('2h ago');
  });

  it('makes a session the default from its row, and keeps the menu open with focus on it', async () => {
    const server = fakeServer({ sessions: TWO });
    const { document } = await open(server);
    nameButton(document).click();
    (document.querySelector('#account-default') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#account-sessions [data-session="sess-2"]'));
    const b = document.querySelector('#account-sessions [data-session="sess-2"]') as HTMLButtonElement;
    b.focus();
    b.click();
    await until(() => writes(server.calls).some((c) => c.path === '/v1/sessions/sess-2/default'));
    expect(writes(server.calls).find((c) => c.path === '/v1/sessions/sess-2/default')!.method).toBe('PUT');
    expect(writes(server.calls).some((c) => c.path === '/v1/handoffs')).toBe(false);
    await until(() => (document.activeElement as HTMLElement | null)?.dataset?.session === 'sess-2');
    expect(menu(document)).not.toBeNull();
  });

  it('clears the default with its filled pin', async () => {
    const server = fakeServer({ sessions: TWO, defaultSession: { session_id: 'sess-2', name: 'school work', live: true } });
    const { document } = await open(server);
    nameButton(document).click();
    (document.querySelector('#account-default') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#account-sessions [data-clear-default="sess-2"]'));
    (document.querySelector('#account-sessions [data-clear-default="sess-2"]') as HTMLButtonElement).click();
    await until(() => writes(server.calls).some((c) => c.path === '/v1/sessions/sess-2/default'));
    expect(writes(server.calls).find((c) => c.path === '/v1/sessions/sess-2/default')!.method).toBe('DELETE');
    expect(menu(document)).not.toBeNull();
  });

  it('in Zoom, your avatar opens the same menu as a sheet', async () => {
    const { document } = await open(fakeServer({ occurrence: 'zoom-occurrence==' }));
    await until(() => document.body.classList.contains('surface-zoom'));
    nameButton(document).click();
    const m = menu(document)!;
    expect(m.classList.contains('sheet')).toBe(true);
    expect(m.querySelector('#account-default')).not.toBeNull();
  });
});
