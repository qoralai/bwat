// How hard one open board reads the server: every open board re-read every shown
// meeting's cards several times a minute, and a hosted database ran out of connections.
// The page's timers run on the test's clock; one feed read is one GET /v1/members.
import type { DOMWindow } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { CARD, CARD_OWNED, MEETING, OLDER_MEETING, QUESTION_NOW, control, fakeServer, feedOf, loadPage, pastId, type Call } from './board-harness.ts';

let close: (() => void) | undefined;
afterEach(() => { close?.(); close = undefined; vi.useRealTimers(); });

// `at`: the test's clock starts there (the page's own clock until it loads keeps the real time).
async function open(page: string, query = '', server = fakeServer(), at?: number) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  if (at !== undefined) vi.setSystemTime(at);
  const loading = loadPage(page, server, query);
  await vi.advanceTimersByTimeAsync(100);
  const loaded = await loading;
  close = () => loaded.window.close();
  // jsdom's window keeps its own Date; the page's clocks run on the test's.
  (loaded.window as unknown as { Date: DateConstructor }).Date = Date;
  await vi.advanceTimersByTimeAsync(1000);
  return loaded;
}
const feeds = (calls: Call[]) => calls.filter((c) => c.path === '/v1/members').length;
// The meetings whose cards were read, one entry a read.
const readOf = (calls: Call[]) => calls.flatMap((c) => /^\/v1\/occurrences\/([^/]+)\/cards$/.exec(c.path)?.[1] ?? []);
const cardReads = (calls: Call[]) => readOf(calls).length;
/** What the server is asked in the next `ms`. */
async function during(server: { calls: Call[] }, ms: number) {
  const from = server.calls.length;
  await vi.advanceTimersByTimeAsync(ms);
  return server.calls.slice(from);
}
function setHidden(window: DOMWindow, hidden: boolean) {
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
}

it('the board reads its cards every 15 s', async () => {
  const server = fakeServer();
  await open('board.html', '', server);
  expect(feeds(await during(server, 60_000))).toBeLessThanOrEqual(4);
});

it('the board asks nothing while its tab is hidden, and reads once when it is shown again', async () => {
  const server = fakeServer();
  const { window } = await open('board.html', '', server);
  setHidden(window, true);
  expect(await during(server, 60_000)).toEqual([]);
  setHidden(window, false);
  expect(feeds(await during(server, 1000))).toBe(1);
});

it('"All weeks" reads every week at most once a minute', async () => {
  const server = fakeServer({ pastWeeks: 8 });
  const { document } = await open('board.html', '?week=all', server);
  expect(document.querySelector(`#card-list [data-card="${CARD}"]`)).not.toBeNull();
  const minute = await during(server, 60_000);
  expect(feeds(minute)).toBe(1);
  // This week's two meetings and one in each of the eight weeks before: one read each.
  expect(cardReads(minute)).toBeLessThanOrEqual(10);
});

it('the board reads again at once when a close is refused because someone changed the card first', async () => {
  const server = fakeServer({ archiveStaleOnce: true });
  const { document } = await open('board.html', '', server);
  (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
  await vi.advanceTimersByTimeAsync(100);
  (document.querySelector('#do-done') as HTMLButtonElement).click();
  const after = await during(server, 1000);
  expect(after.some((c) => c.path.endsWith('/archive'))).toBe(true);
  expect(feeds(after)).toBe(1);
});

// An edit holds its card with a heartbeat every 8 s; a hidden tab must keep it, or the hold
// lapses and someone else can save over the edit.
it('an open edit keeps its hold on the card while the tab is hidden', async () => {
  const server = fakeServer();
  const { document, window } = await open('board.html', '', server);
  (document.querySelector(`[data-more="${CARD}"]`) as HTMLButtonElement).click();
  (document.querySelector('#more-edit') as HTMLButtonElement).click();
  await vi.advanceTimersByTimeAsync(100);
  setHidden(window, true);
  const beats = (await during(server, 60_000)).filter((c) => c.method === 'POST' && c.path === '/v1/editing');
  expect(beats.length).toBeGreaterThanOrEqual(7);
});

// The week picker's numbers come from the card service's counts, so opening a board
// reads the cards of the weeks it shows, not of every meeting ever held.

// The desk shows this week and last.
it('opens reading only the cards of the weeks it shows, and counts each week from the card service', async () => {
  const server = fakeServer({ pastWeeks: 8 });
  const { window } = await open('board.html', '', server);
  expect(new Set(readOf(server.calls))).toEqual(new Set([MEETING, OLDER_MEETING, pastId(0)]));
  // One count a feed (a feed still in flight has read its members but not yet counted).
  const counted = server.calls.filter((c) => c.path === '/v1/cards/counts').length;
  expect(counted).toBeGreaterThanOrEqual(1);
  expect(counted).toBeLessThanOrEqual(feeds(server.calls));
  const feed = await feedOf(window);
  // Four in this week (the closed one not counted), and each earlier week's one card, none of them read.
  expect(feed.weeks.map((w) => w.n)).toEqual([4, 1, 1, 1, 1, 1, 1, 1, 1]);
});

it.each([500, 'dropped'] as const)('keeps the last counts when the card service cannot count (%s)', async (down) => {
  const server = fakeServer({ pastWeeks: 2 });
  const { window } = await open('board.html', '', server);
  const weeks = async () => (await feedOf(window)).weeks.map((w) => w.n);
  expect(await weeks()).toEqual([4, 1, 1]);
  control.countsDown = down;
  try {
    expect(await weeks()).toEqual([4, 1, 1]);
  } finally {
    control.countsDown = false;
  }
});

// A week's cards are read again when one of its meetings' cards changed, and at least every
// three minutes for what never changes a card (Jev's hints, "expires in", owner names).
const WINDOW_MS = 180_000;
// One second into the current three-minute window: the next 179 s are in it.
const windowStart = () => Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + 1000;

it("reads no week's cards again while nothing in it changed", async () => {
  const server = fakeServer({ pastWeeks: 2 });
  await open('board.html', '', server, windowStart());
  expect(cardReads(await during(server, 60_000))).toBe(0);
});

// The desk shows this week and last: only this week, where the card changed, is read again.
it("reads again only the week whose meeting's cards changed", async () => {
  const server = fakeServer({ pastWeeks: 2 });
  await open('board.html', '', server, windowStart());
  // Save on T-2: a new revision, the meeting's count unchanged.
  await server.fetch(`/v1/cards/${CARD_OWNED}/keep`, { method: 'POST', body: '{}' });
  // The card service counts again COUNTS_TTL_S after, and a poll follows within 15 s.
  expect(new Set(readOf(await during(server, 30_000)))).toEqual(new Set([MEETING, OLDER_MEETING]));
});

it('reads every shown week on each feed while the counts cannot be read', async () => {
  const server = fakeServer({ pastWeeks: 2 });
  await open('board.html', '', server, windowStart());
  control.countsDown = 500;
  try {
    expect(readOf(await during(server, 15_000))).toContain(pastId(0));
  } finally {
    control.countsDown = false;
  }
});

it('reads every shown week again once its three minutes are up', async () => {
  const server = fakeServer({ pastWeeks: 2 });
  await open('board.html', '', server, windowStart());
  expect(cardReads(await during(server, WINDOW_MS - 15_000))).toBe(0);
  expect(readOf(await during(server, 30_000))).toContain(pastId(0));
});

// The meetings whose cards a page reads at once: a tab shown again reads straight away.
async function readNow(server: { calls: Call[] }, window: DOMWindow) {
  setHidden(window, true);
  setHidden(window, false);
  return readOf(await during(server, 1000));
}
// The fake's answers passed through `around`, which may hold or drop one on its way back.
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
function wrapFetch(server: { fetch: Fetch }, around: (answer: Promise<Response>, input: string | URL, init?: RequestInit) => Promise<Response>) {
  const inner = server.fetch;
  server.fetch = (input, init) => around(inner(input, init), input, init);
}

// The board's own write, then a read straight after it (a tab shown again reads at once), well
// inside the ten seconds the counts are kept (countsTtl): only the board can know it changed.
// `dropped`: the write's answer is lost after the card service saved it.
async function readsAfterOwnWrite(page: string, path: string, body: unknown, dropped = false) {
  const server = fakeServer({ pastWeeks: 2, countsTtl: 10_000 });
  const { window } = await open(page, '', server, windowStart());
  if (dropped) {
    wrapFetch(server, async (answer, input, init) => {
      const r = await answer;
      if ((init?.method ?? 'GET') !== 'GET' && String(input).startsWith('/v1/cards/')) throw new TypeError('Failed to fetch');
      return r;
    });
  }
  await window.fetch(path, { method: 'POST', body: JSON.stringify(body) });
  return { read: await readNow(server, window), window };
}

it("reads a card's week straight after the board changed the card, before the counts show it", async () => {
  expect((await readsAfterOwnWrite('board.html', '/assign', { id: CARD, owner: 'Bob', version: 3 })).read).toContain(MEETING);
});

it.each([
  // A question's answer names the question as question_id.
  ['an answer', '/clarify', { question_id: QUESTION_NOW, version: 2, answer: 'Friday noon', request_id: 'r-1' }, MEETING],
  // An undo of a merge whose duplicate is in a week not loaded: only the survivor (via) is known.
  ['an undone merge', '/unmerge', { id: 'dddddddd-0000-4000-8000-000000000001', via: CARD, version: 1 }, MEETING],
  // A hint dismissed on T-1 that named last week's card: that card's week too.
  ['a dismissed hint', '/hint-dismiss', { id: CARD, kind: 'duplicate', target_card_id: 'bbbbbbbb-0000-4000-8000-000000000000' }, pastId(0)],
])('reads the week straight after %s, by whichever card the write names', async (_what, path, body, meeting = MEETING) => {
  expect((await readsAfterOwnWrite('board.html', path, body)).read).toContain(meeting);
});

it("reads a card's week straight after a write whose answer was lost", async () => {
  expect((await readsAfterOwnWrite('board.html', '/assign', { id: CARD, owner: 'Bob', version: 3 }, true)).read).toContain(MEETING);
});

it('shows its own edit straight after it, though the counts do not show it yet', async () => {
  const { window } = await readsAfterOwnWrite('board.html', '/edit', { id: CARD, version: 3, title: 'Ship it Monday' });
  expect(window.document.querySelector(`[data-card="${CARD}"]`)!.textContent).toContain('Ship it Monday');
});

it('reads a meeting again on the next feed when its cards could not be read', async () => {
  const server = fakeServer({ pastWeeks: 2, olderCardsDown: true });
  await open('board.html', '', server, windowStart());
  expect(readOf(await during(server, 15_000))).toContain(OLDER_MEETING);
});

it("keeps a write's mark when a read that began before the write ends after it", async () => {
  const server = fakeServer({ pastWeeks: 2, countsTtl: 10_000 });
  // Once armed, the next read of this meeting's cards is held until `release`, then answers as it began.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let hold = false;
  wrapFetch(server, async (answer, input) => {
    if (hold && String(input).endsWith(`/v1/occurrences/${MEETING}/cards`)) { hold = false; await held; }
    return answer;
  });
  const { window } = await open('board.html', '', server, windowStart());
  // The window rolls: the poll after it reads this week again, and that read is held.
  hold = true;
  await vi.advanceTimersByTimeAsync(WINDOW_MS);
  expect(hold).toBe(false);
  await window.fetch('/assign', { method: 'POST', body: JSON.stringify({ id: CARD, owner: 'Bob', version: 3 }) });
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await readNow(server, window)).toContain(MEETING);
});

it("lets a mark on a week not shown lapse after a window, so that week's rev settles", async () => {
  const server = fakeServer({ pastWeeks: 3, countsTtl: 10_000 });
  // "All weeks" reads every week, so the board knows the card two weeks back; then the desk
  // goes back to this week and last.
  const { window } = await open('board.html', '?week=all', server, windowStart());
  window.history.replaceState(null, '', '/board.html');
  await window.fetch('/hint-dismiss', { method: 'POST', body: JSON.stringify({
    id: CARD, kind: 'duplicate', target_card_id: 'bbbbbbbb-0000-4000-8000-000000000001' }) });
  type Feed = { sources: Record<string, { week: string }>; weeks: { key: string; rev: string }[] };
  const rev = async () => {
    const feed = await feedOf<Feed>(window);
    return feed.weeks.find((w) => w.key === feed.sources[pastId(1)]!.week)!.rev;
  };
  await vi.advanceTimersByTimeAsync(WINDOW_MS);
  const settled = await rev();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await rev()).toBe(settled);
});
