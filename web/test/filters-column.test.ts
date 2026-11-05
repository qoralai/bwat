import { afterEach, describe, expect, it } from 'vitest';
import { fakeServer, loadPage, until } from './board-harness.ts';

// The filters column (ui/sidebar.js): the ☰ column of meetings, with a group for each plugin's
// items (its `facets`; tested in each plugin's own tests) and one for people. Pinned, it stays
// open; Configure ticks which groups it shows; its edge drags it wider.
let close: (() => void) | undefined;
afterEach(() => close?.());

const open = async (query = '', storage: Record<string, string> = {}) => {
  const loaded = await loadPage('board.html', fakeServer(), query, { storage });
  close = () => loaded.window.close();
  return loaded;
};
const groups = (d: Document) => [...d.querySelectorAll('#filter-groups [data-group]')].map((g) => g.getAttribute('data-group'));
const people = (d: Document) => [...d.querySelectorAll<HTMLAnchorElement>('#filter-groups [data-group="people"] a')];

describe('the filters column', () => {
  it('lists the newest meetings with their card counts, and More meetings shows them all', async () => {
    const { document } = await open('', { 'bwat.study.v1.board.nav': '"open"' });
    const rows = () => [...document.querySelectorAll<HTMLAnchorElement>('#filter-meetings a[data-filter="meetings"]')];
    await until(() => rows().length > 0);
    expect(rows().map((a) => a.querySelector('.fi-text')!.textContent)).toEqual(['Standup', 'Planning']);
    expect(rows().every((a) => /^\d+$/.test(a.querySelector('b')!.textContent!))).toBe(true);
    const more = document.querySelector<HTMLButtonElement>('#filter-meetings [data-more]')!;
    expect(more.textContent).toBe('More meetings…');
    expect(document.querySelector('#meeting-nav')!.classList.contains('all-meetings')).toBe(false);
    more.click();
    expect(document.querySelector('#meeting-nav')!.classList.contains('all-meetings')).toBe(true);
    expect(document.querySelector('#filter-meetings [data-more]')!.textContent).toBe('Fewer meetings');
  });

  // The cap (ten people) is the same groupHTML as a plugin group's eight, tested in that plugin's tests.
  it("lists only today's meetings in the Today view, as the full list does", async () => {
    // Standup and Planning are today's; Weekly was a week ago.
    const loaded = await loadPage('board.html', fakeServer({ pastWeeks: 1 }), '?when=today&days=today', { storage: { 'bwat.study.v1.board.nav': '"open"' } });
    close = () => loaded.window.close();
    const { document } = loaded;
    const rows = () => [...document.querySelectorAll('#filter-meetings a[data-filter="meetings"] .fi-text')].map((t) => t.textContent);
    await until(() => rows().length > 0 && !!document.querySelector('#meeting-links a[data-meeting]'));
    expect(rows().sort()).toEqual(['Planning', 'Standup']);
  });

  it('shows the people busiest first, with their counts, initials and (you), and dims one with none', async () => {
    const { document } = await open('', { 'bwat.study.v1.board.nav': '"open"' });
    await until(() => people(document).length > 0);
    const ada = people(document)[0]!;
    expect(ada.querySelector('.fi-text')!.textContent).toBe('Ada (you)');
    expect(ada.querySelector('.fi-mark')!.textContent).toBe('A');
    expect(Number(ada.querySelector('b')!.textContent)).toBeGreaterThan(0);
    expect(people(document)[1]!.classList.contains('zero')).toBe(true);
    expect(document.querySelector('#filter-groups [data-group="people"] [data-more]')).toBeNull();
  });

  it("lists the people, and shows one person's cards; a second click shows everyone's", async () => {
    const { document, window } = await open();
    document.querySelector<HTMLButtonElement>('#nav-toggle')!.click();
    await until(() => people(document).length > 0);
    expect(groups(document)).toEqual(['people']);
    const name = people(document)[0]!.dataset.value;
    people(document)[0]!.click();
    expect(new URLSearchParams(window.location.search).get('person')).toBe(name);
    await until(() => people(document)[0]!.getAttribute('aria-current') === 'true');
    people(document)[0]!.click();
    expect(new URLSearchParams(window.location.search).has('person')).toBe(false);
  });

  it('keeps the focus on a person picked from the keyboard', async () => {
    const { document } = await open('', { 'bwat.study.v1.board.nav': '"open"' });
    await until(() => people(document).length > 0);
    const name = people(document)[0]!.dataset.value;
    people(document)[0]!.focus();
    people(document)[0]!.click();
    await until(() => people(document)[0]!.getAttribute('aria-current') === 'true');
    await until(() => document.activeElement === people(document)[0]);
    expect((document.activeElement as HTMLElement).dataset.value).toBe(name);
  });

  it('keeps the focus on a person when a refresh changes the counts', async () => {
    const { document, window } = await open('', { 'bwat.study.v1.board.nav': '"open"' });
    await until(() => people(document).length > 1);
    const bob = () => people(document).find((a) => a.dataset.value === 'Bob')!;
    bob().focus();
    // Every card now Bob's: the counts and the order change, and the group is drawn again.
    (window as unknown as { eval: (code: string) => void }).eval("for (const c of cards) c.owner = 'Bob'; render();");
    expect(people(document)[0]!.dataset.value).toBe('Bob');
    expect(document.activeElement).toBe(bob());
  });

  it("counts a person's cards as picking them shows them: owned, and the questions they raised", async () => {
    const { document, window } = await open('', { 'bwat.study.v1.board.nav': '"open"' });
    await until(() => people(document).length > 1);
    // Bob owns nothing; one question is his, as the room heard it.
    (window as unknown as { eval: (code: string) => void }).eval(
      "for (const c of cards) if (c.owner === 'Bob') c.owner = ''; const q = cards.find((c) => c.bucket === 'ask'); q.owner = ''; q.raisedBy = 'Bob'; render();");
    const bob = people(document).find((a) => a.dataset.value === 'Bob')!;
    expect(bob.querySelector('b')!.textContent).toBe('1');
    expect(bob.classList.contains('zero')).toBe(false);
  });

  it("keeps a name with an apostrophe's link in place when the board redraws", async () => {
    const loaded = await loadPage('board.html', fakeServer({ bobName: "Dana O'Brien" }), '', { storage: { 'bwat.study.v1.board.nav': '"open"' } });
    close = () => loaded.window.close();
    const { document, window } = loaded;
    const dana = () => people(document).find((a) => a.dataset.value === "Dana O'Brien");
    await until(() => !!dana());
    const before = dana()!;
    (window as unknown as { render: () => void }).render();
    expect(dana()).toBe(before);
  });

  it('closes on a click outside it unless pinned, and a pinned column opens with the page', async () => {
    const { document, window } = await open();
    const toggle = document.querySelector<HTMLButtonElement>('#nav-toggle')!;
    toggle.click();
    expect(document.body.classList.contains('nav-open')).toBe(true);
    document.querySelector<HTMLElement>('#main')!.click();
    expect(document.body.classList.contains('nav-open')).toBe(false);
    toggle.click();
    document.querySelector<HTMLButtonElement>('#nav-pin')!.click();
    expect(document.querySelector('#nav-pin')!.getAttribute('aria-pressed')).toBe('true');
    document.querySelector<HTMLElement>('#main')!.click();
    expect(document.body.classList.contains('nav-open')).toBe(true);
    expect(window.localStorage.getItem('bwat.study.v1.board.nav')).toBe('"open"');
  });

  it('hides the meetings and the people from Configure, and remembers it', async () => {
    const { document, window } = await open('', { 'bwat.study.v1.board.nav': '"open"' });
    await until(() => people(document).length > 0);
    document.querySelector<HTMLButtonElement>('#nav-configure')!.click();
    const box = (g: string) => document.querySelector<HTMLInputElement>(`#filter-config input[data-show="${g}"]`)!;
    expect([...document.querySelectorAll('#filter-config input')].map((i) => i.getAttribute('data-show'))).toEqual(['meetings', 'people']);
    box('people').click();
    box('meetings').click();
    document.querySelector<HTMLButtonElement>('#nav-configure')!.click();
    expect(groups(document)).toEqual([]);
    expect(document.querySelector('#meeting-nav')!.classList.contains('no-meetings')).toBe(true);
    expect(window.localStorage.getItem('bwat.study.v1.board.nav.hide')).toBe('["people","meetings"]');
  });

  it('keeps a ticked box and its focus in Configure when the board redraws', async () => {
    const { document, window } = await open('', { 'bwat.study.v1.board.nav': '"open"' });
    document.querySelector<HTMLButtonElement>('#nav-configure')!.click();
    const people = document.querySelector<HTMLInputElement>('#filter-config input[data-show="people"]')!;
    people.focus();
    people.click();
    (window as unknown as { render: () => void }).render();
    expect(document.querySelector('#filter-config input[data-show="people"]')).toBe(people);
    expect(document.activeElement).toBe(people);
  });

  it('widens from its edge with the arrow keys, within 180 to 560px, and remembers the width', async () => {
    const { document, window } = await open('', { 'bwat.study.v1.board.nav': '"open"', 'bwat.study.v1.board.nav.width': '550' });
    const grip = document.querySelector<HTMLElement>('#nav-grip')!;
    const shell = document.querySelector<HTMLElement>('.app-shell')!;
    expect(shell.style.getPropertyValue('--nav-w')).toBe('550px');
    grip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(shell.style.getPropertyValue('--nav-w')).toBe('560px');
    expect(grip.getAttribute('aria-valuenow')).toBe('560');
    grip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(window.localStorage.getItem('bwat.study.v1.board.nav.width')).toBe('544');
  });

  it('marks the ☰ while a filter is on and the column is closed', async () => {
    const { document } = await open('?person=Ada');
    await until(() => !!document.querySelector('#nav-toggle.filtered'));
    document.querySelector<HTMLButtonElement>('#nav-toggle')!.click();
    expect(document.querySelector('#nav-toggle')!.classList.contains('filtered')).toBe(false);
  });
});
