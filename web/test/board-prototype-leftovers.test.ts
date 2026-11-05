import { afterEach, expect, it } from 'vitest';
import { CARD, control, fakeServer, loadPage, until } from './board-harness.ts';

// QOR-5015: the desk keeps none of the prototype's paths that bwat's own feed never fills,
// and says out loud when it cannot reach the server.
let close: (() => void) | undefined;
afterEach(() => { close?.(); close = undefined; });

// `ready`: what the page shows once loaded (Mine shows no card of Bob's).
async function open(query = '', ready = `[data-open="${CARD}"]`) {
  const loaded = await loadPage('board.html', fakeServer(), query);
  close = () => loaded.window.close();
  await until(() => !!loaded.document.querySelector(ready));
  return loaded;
}
const refresh = (window: object, force = false) => (window as unknown as { refresh: (force: boolean) => Promise<void> }).refresh(force);

it('says a failed refresh once, in the Live pill, not in the alert bar too, and clears it once one works', async () => {
  const { document, window } = await open();
  const alert = document.getElementById('feed-alert')!;
  control.feedDown = true;
  try {
    await refresh(window);
    expect(alert.hidden).toBe(true);
    expect(document.getElementById('live-pill')!.textContent).toBe('Reconnecting…');
  } finally {
    control.feedDown = false;
  }
  await refresh(window);
  expect(alert.hidden).toBe(true);
  expect(!!document.getElementById('stamp-text')).toBe(false);
});

it('shows the signed-in name, with no name picker', async () => {
  const { document } = await open();
  expect(!!document.querySelector('select#viewer')).toBe(false);
  await until(() => document.querySelector('#viewer-name .viewer-name-text')?.textContent === 'Ada');
});

it('is always the desk: no lane view and no type tabs', async () => {
  const { document } = await open('?view=lane', '.desk-column');
  expect(!!document.getElementById('type-nav')).toBe(false);
  expect(document.body.dataset.view).toBe('desk');
  expect(!!document.querySelector('.desk-columns')).toBe(true);
  // An old lane link still opens Mine, as it did on the desk.
  expect(document.getElementById('scope-mine')!.getAttribute('aria-pressed')).toBe('true');
});

it('reads Mine for an old lane link to the open list', async () => {
  const { window } = await open('?source=open&view=lane', '.desk-column');
  const asked: string[] = [];
  const fetch = window.fetch;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.href);
    asked.push(url.pathname + '?mine=' + url.searchParams.get('mine'));
    return fetch(input, init);
  };
  await refresh(window, true);
  expect(asked).toContain('/open-todos?mine=1');
});

it('asks for no to-dos: every card is a card', async () => {
  const { window } = await open();
  const asked: string[] = [];
  const fetch = window.fetch;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(new URL(String(input), window.location.href).pathname);
    return fetch(input, init);
  };
  await refresh(window, true);
  expect(asked).toContain('/board_feed.json');
  expect(asked).not.toContain('/todos');
});

it('has no dropped-frames line in the footer', async () => {
  const { document } = await open();
  await until(() => !!document.getElementById('foot-tail'));
  expect(!!document.getElementById('foot-capture')).toBe(false);
});
