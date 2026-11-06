import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADA, alerted, BOB, BOT_CLAIM, SENT_CLAIM, control, fakeServer, CARD, CARD_OWNED, loadPage, MEETING, ms, OLD_CARD, OLDER_MEETING, QUESTION, QUESTION_NOW, said, SPOKEN, TOKEN, until, type Call,
  feedOf as sharedFeedOf,
} from './board-harness.ts';

let close: (() => void) | undefined;
afterEach(() => close?.());

const open = async (page: string, server = fakeServer(), query = '', framed = false, storage: Record<string, string> = {}) => {
  const loaded = await loadPage(page, server, query, { framed, storage });
  close = () => loaded.window.close();
  return loaded;
};
/** The hand-off id the fake backend answers every send with. */
const HANDOFF = '55555555-5555-4555-8555-555555555555';
/** A poll, as the page's own timer runs it (not a forced refresh). */
const poll = (window: object) => (window as unknown as { refresh: (force: boolean) => Promise<void> }).refresh(false);
/** The card's node in the live list. */
const cardEl = (document: Document, id: string) => document.querySelector(`#card-list [data-card="${id}"]`);
/** Sends Ada's own to-do, T-2, to her one session, from its card. */
async function sendOwned(document: Document) {
  await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
  (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
  await until(() => !!document.querySelector('#send-dialog [data-session="sess-1"]'));
  (document.querySelector('#send-dialog [data-session="sess-1"]') as HTMLButtonElement).click();
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

/** Turns on the Zoom panel's Risks and Decisions tabs in Settings, as a person would. */
function showRisksAndDecisions(document: Document) {
  (document.querySelector('#settings-open') as HTMLButtonElement).click();
  for (const k of ['risk', 'decided']) (document.querySelector(`#setting-${k}`) as HTMLInputElement).click();
  (document.querySelector('#settings-dialog') as HTMLDialogElement).close();
}

/** Opens the meeting's ⋯ beside the title and returns the item `sel` in its menu. */
async function meetingMenu(document: Document, sel: string) {
  await until(() => !document.querySelector<HTMLElement>('#meeting-more')?.hidden);
  document.querySelector<HTMLButtonElement>('#meeting-more')!.click();
  await until(() => !!document.querySelector(`#more-menu ${sel}`));
  return document.querySelector(`#more-menu ${sel}`) as HTMLElement;
}

/** What a person can read: the page's text without its scripts and styles. */
function visibleText(document: Document): string {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll('script, style').forEach((n) => n.remove());
  return body.textContent!.replace(/\s+/g, ' ');
}

describe('the desk, from the card service (board.html)', () => {
  const openCard = async (document: Document, id: string) => {
    await until(() => !!document.querySelector(`[data-open="${id}"]`));
    (document.querySelector(`[data-open="${id}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#reader #do-done'));
  };
  const ownerPicker = async (document: Document) => {
    (document.querySelector('#change-owner') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#owner-dialog [data-person]'));
    return [...document.querySelectorAll('#owner-dialog [data-person]')] as HTMLButtonElement[];
  };

  it("shows the card's quote and none of the model HTML that could run, read with the bearer", async () => {
    const { document, server } = await open('board.html');
    await openCard(document, CARD);
    const reader = document.querySelector('#reader')!;
    expect(reader.textContent).toContain('ship it on friday');
    expect(reader.innerHTML).not.toMatch(/<script|<img|<svg|onerror|pwned/);
    const cards = server.calls.find((c) => c.path === `/v1/occurrences/${MEETING}/cards`)!;
    expect(cards.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('shows a member name in the owner list as text, never as HTML', async () => {
    const evil = '<img src=x onerror="window.injected=1">';
    const { document } = await open('board.html', fakeServer({ bobName: evil }));
    await openCard(document, CARD);
    expect((await ownerPicker(document)).map((b) => b.textContent).join('|')).toContain(evil);
    expect(document.querySelector('#owner-dialog img')).toBeNull();
  });

  it('tells two members with the same name apart, and assigns the one picked', async () => {
    const { document, server } = await open('board.html', fakeServer({ adaName: 'Alex', bobName: 'Alex' }));
    await openCard(document, CARD);
    (await ownerPicker(document)).find((b) => b.textContent!.includes('bob@example.com'))!.click();
    await until(() => writes(server.calls).length > 0);
    expect(writes(server.calls)).toEqual([{
      method: 'PUT', path: `/v1/cards/${CARD}/owner`, authorization: `Bearer ${TOKEN}`,
      body: { owner_member_id: BOB, revision: 3 },
    }]);
  });

  it('still offers Send to Claude on your own card when your name is shared', async () => {
    const { document } = await open('board.html', fakeServer({ adaName: 'Alex', bobName: 'Alex' }));
    await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
  });

  it('reads every page of the meeting history', async () => {
    const { document, server } = await open('board.html');
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    // The older meeting is only on the second page of GET /v1/meetings.
    expect(server.calls.some((c) => c.path === `/v1/occurrences/${OLDER_MEETING}/cards`)).toBe(true);
  });

  it('sends a hand-off with only the card, the meeting, the session and a request key: the backend writes the brief', async () => {
    // A first owner has no display name until they set one: the email stands in.
    const { document, server } = await open('board.html', fakeServer({ adaName: null }));
    await sendOwned(document);
    await until(() => writes(server.calls).length > 0);
    const body = writes(server.calls)[0]!.body as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['occurrence_id', 'request_key', 'source_id', 'source_kind', 'target_session_id']);
    expect(body.request_key).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('meeting dates', () => {
  it('use the local date and week of the viewer, matching the local start time', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Chicago';
    try {
      // Thursday 1 Oct, 22:30 in Chicago; already Friday 2 Oct in UTC.
      const { window } = await open('board.html', fakeServer({ startedAt: '2026-10-02T03:30:00Z' }));
      const feed = await (await window.fetch('board_feed.json')).json();
      // As the prototype wrote them: "10/1", the week "Sep 28", and the start with its zone.
      expect(feed.sources[MEETING]).toMatchObject({ date: '10/1', start: '2026-10-02T03:30:00Z', week: '2026-09-28' });
      expect(feed.weeks.find((w: { key: string }) => w.key === '2026-09-28')).toMatchObject({ label: 'Sep 28' });
    } finally {
      process.env.TZ = tz;
    }
  });
});

describe('as the prototype board had it', () => {
  type Feed = { [k: string]: unknown; weeks: { key: string; n: number }[]; people: [string, string][] };
  type Item = { id: string; detail: string; src: string; owner: string | null; ownerBy: string | null; ownerColor: string | null; answers: string[] };
  const feedOf = (window: { fetch: typeof fetch }) => sharedFeedOf<Feed>(window);
  const itemsOf = async (window: { fetch: typeof fetch }) => {
    const feed = await feedOf(window);
    const weeks = await Promise.all(feed.weeks.map(async (w) => (await (await window.fetch(`board_week_${w.key}.json`)).json()).items as Item[]));
    return weeks.flat();
  };
  // chips.py's owner_color: the name's SHA-1, its first 8 hex digits, over the eight hues.
  const HUES = ['#2f6690', '#7a4e8c', '#1f7a5a', '#b0562a', '#8c3b52', '#2a6f7a', '#6b6a2c', '#4a6e8a'];
  const chip = (name: string) => HUES[parseInt(createHash('sha1').update(name.trim().toLowerCase()).digest('hex').slice(0, 8), 16) % HUES.length];

  it('puts each quote first, with who said it, once, and cites the transcript range', async () => {
    const { window } = await open('board.html');
    const card = (await itemsOf(window)).find((c) => c.id === CARD)!;
    expect(card.detail).toBe('<p><b>Ada Lovelace</b> “ship it on friday”</p><p><b>Bob</b> “friday works”</p><p>Agreed in standup.</p>');
    expect(card.src).toBe('e0 seq 78-80');
  });

  it('keeps cross-meeting evidence in separate labeled transcript ranges', async () => {
    const { window } = await open('board.html', fakeServer({ crossMeetingEvidence: true }));
    const card = (await itemsOf(window)).find((c) => c.id === CARD)!;
    expect(card.src).toContain('e0 seq 78-80');
    expect(card.src).toContain('e0 seq 4-4');
    expect(card.src).not.toContain('seq 4-80');
    expect(card.detail.match(/Source:/g)).toHaveLength(2);
    expect(card.detail).toContain('Include the screenshots');
  });

  it('says who set the owner, and colours every name by a hash of it, people sorted by name', async () => {
    const { window } = await open('board.html', fakeServer({ adaName: 'Zoe' }));
    const items = await itemsOf(window);
    expect(items.find((c) => c.id === CARD_OWNED)).toMatchObject({ owner: 'Zoe', ownerBy: 'Bob', ownerColor: chip('Zoe') });
    expect(items.find((c) => c.id === CARD)!.ownerBy).toBeNull();
    expect((await feedOf(window)).people).toEqual([['Bob', chip('Bob')], ['Zoe', chip('Zoe')]]);
  });

  it('names a meeting Zoom has not named, gives its length, and counts each week\'s cards', async () => {
    const startedAt = new Date().toISOString();
    const { window } = await open('board.html', fakeServer({ title: null, startedAt }));
    const feed = await feedOf(window);
    const sources = feed.sources as Record<string, Record<string, unknown>>;
    expect(sources[MEETING]!.label).toBe('Meeting ' + new Date(startedAt).toTimeString().slice(0, 5));
    expect(sources[OLDER_MEETING]).toMatchObject({ label: 'Planning', duration_min: 30 });
    // Three open cards in this meeting and one in the older: the closed one is not counted.
    expect(feed.weeks.reduce((n, w) => n + w.n, 0)).toBe(4);
  });

  it("carries the live meeting's last transcript lines and which meeting is captured", async () => {
    const { window } = await open('board.html');
    const feed = await feedOf(window);
    expect(feed.tail).toEqual([{ seq: 79, speaker: 'Ada Lovelace', text: 'ship it on friday' }, { seq: 80, speaker: 'Bob', text: 'friday works' }]);
    expect(feed.capture).toEqual({ source: MEETING, status: 'LIVE' });
  });

  it("carries no other meeting's transcript lines inside a Zoom meeting bwat has not listed yet", async () => {
    // The same meeting number every day: today's occurrence is new, and the live one is yesterday's.
    const { window, server } = await open('board.html', fakeServer({ occurrence: 'today==' }));
    const feed = await feedOf(window);
    expect(feed.tail).toEqual([]);
    expect(feed.capture).toEqual({ source: null, status: 'WAITING' });
    expect(server.calls.some((c) => c.path.endsWith('/transcript'))).toBe(false);
  });

  it('carries the transcript of the Zoom meeting the board was opened from, in either spelling, not the live one', async () => {
    // Zoom writes "/" and "+" as "_" and "-" in some places: the store's "old/er+==" is this meeting.
    const { window, server } = await open('board.html', fakeServer({ occurrence: 'old_er-==' }));
    await feedOf(window);
    const tails = () => server.calls.filter((c) => c.path.endsWith('/transcript')).map((c) => c.path);
    expect(tails()).toContain(`/v1/meetings/${OLDER_MEETING}/transcript`);
    expect(tails()).not.toContain(`/v1/meetings/${MEETING}/transcript`);
  });

  it('shows a meeting as Live only while the backend says it is, not while its end is unrecorded', async () => {
    const { window } = await open('board.html', fakeServer({ state: 'abandoned' }));
    const feed = await feedOf(window);
    expect((feed.sources as Record<string, Record<string, unknown>>)[MEETING]!.live).toBe(false);
    expect(feed.capture).toMatchObject({ status: 'ENDED' });
  });

  it('colours an owner the room named who is not a member, on the desk', async () => {
    const { document } = await open('board.html', fakeServer({ spokenOwner: 'Jonah' }));
    await until(() => !!document.querySelector(`[data-card="${CARD}"]`)?.getAttribute('style')?.includes('--owner'));
    expect(document.querySelector(`[data-card="${CARD}"]`)!.getAttribute('style')).toContain(`--owner:${chip('Jonah')}`);
  });

  it('links an answered question to the card that answered it by its label, and keeps it on the board', async () => {
    const { document, window } = await open('board.html');
    expect((await itemsOf(window)).find((c) => c.id === QUESTION_NOW)!.answers).toEqual([CARD]);
    await until(() => !!document.querySelector(`[data-open="${QUESTION_NOW}"]`));
    const card = document.querySelector(`[data-card="${QUESTION_NOW}"]`)!;
    expect(card.textContent).toContain('Answered by T-1');
  });

  it('tells the board inside Zoom which meeting it was opened from', async () => {
    const { window } = await open('board.html', fakeServer({ occurrence: 'zoom-occurrence==' }));
    expect(await (await window.fetch('/whoami')).json()).toMatchObject({ meeting: 'zoom-occurrence==' });
  });

  it('loads the board when one meeting\'s cards cannot be read', async () => {
    const { document, window } = await open('board.html', fakeServer({ olderCardsDown: true }));
    const feed = await feedOf(window);
    // The card service still counts the older meeting's card; only its list cannot be read.
    expect(feed.weeks.reduce((n, w) => n + w.n, 0)).toBe(4);
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
  });

  it('says why a change was refused in words', async () => {
    const { window } = await open('board.html');
    const r = await window.fetch('/archive', { method: 'POST', body: JSON.stringify({ id: QUESTION, version: 1, outcome: 'done' }) });
    expect(await r.json()).toEqual({ ok: false, error: 'that card is no longer on the board' });
  });

  it('says when a column is empty and what Mine shows, with no counts (design sync 9/30: a quieter board)', async () => {
    const loaded = await loadPage('board.html', fakeServer(), '?scope=mine');
    close = () => loaded.window.close();
    const { document } = loaded;
    const column = (k: string) => document.querySelector(`#heading-${k}`)?.closest('section');
    // Mine: Ada's one to-do.
    await until(() => column('do')?.querySelectorAll('.card').length === 1);
    expect(document.querySelector('#heading-do')!.textContent).toBe('To-dos');
    expect(document.querySelector('#heading-ask')!.textContent).toBe('Questions');
    // Each column's show/hide toggle: the × on a shown column, a spine for a hidden one.
    const toggles = ['do', 'ask', 'risk', 'decided'].map((k) => document.querySelector(`#column-${k}`)!);
    // A constant name, with aria-pressed saying whether the column is shown.
    expect(toggles.map((b) => b.getAttribute('aria-label'))).toEqual(['To-dos', 'Questions', 'Risks', 'Decisions']);
    expect(toggles.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'false', 'false']);
    // No question is anyone's: that column is empty under Mine.
    expect(document.querySelector('#heading-ask')!.closest('section')!.textContent).toMatch(/No .+ in this scope\./);
    // Mine says itself in its pressed button: no line under the toolbar repeats it.
    expect(document.querySelector('#personal-context')).toBeNull();
    expect(visibleText(document)).not.toContain('To-dos assigned to you.');
  });

  it('marks each card with its type icon on its title line, hidden from screen readers', async () => {
    const { document } = await open('board.html');
    await until(() => document.querySelectorAll('.desk-column .card').length >= 3);
    for (const [k, title] of [['do', 'Write the release notes'], ['do', 'Ship the release on Friday'], ['ask', 'When is the code freeze?']] as const) {
      const cards = document.querySelector(`#heading-${k}`)!.closest('section')!.querySelectorAll('.card');
      const card = [...cards].find((c) => c.querySelector('h3')!.textContent === title)!;
      // The title stays plain text; the mark sits just before it on the title line (make room).
      expect(card.querySelector('h3 svg')).toBeNull();
      const icon = card.querySelector('.card-title h3')!.previousElementSibling!;
      expect(icon.tagName.toLowerCase()).toBe('svg');
      expect(icon.getAttribute('data-type')).toBe(k);
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it("names the Zoom panel's four icon tabs without a count", async () => {
    const loaded = await loadPage('board.html', fakeServer(), '?surface=zoom');
    close = () => loaded.window.close();
    const { document } = loaded;
    await until(() => !!document.querySelector('#tab-ask'));
    showRisksAndDecisions(document);
    const tabs = [...document.querySelectorAll('#zoom-tabs [role=tab]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['To-dos', 'Questions', 'Risks', 'Decisions']);
    // Each is its type's mark, hidden from screen readers; the name is the tab's text.
    expect(tabs.map((t) => t.querySelector('.type-icon')?.getAttribute('aria-hidden'))).toEqual(['true', 'true', 'true', 'true']);
  });

  // The Zoom panel has no Unassigned (nobody's to-dos sort first there instead).
  it('hides Questions under Unassigned and restores the selected column afterwards', async () => {
    const loaded = await loadPage('board.html', fakeServer(), '?surface=web&scope=team&cols=ask');
    close = () => loaded.window.close();
    const { document } = loaded;
    await until(() => !!document.querySelector('#heading-ask'));
    document.querySelector<HTMLButtonElement>('#scope-unassigned')!.click();
    expect(document.querySelector('#column-ask')).toBeNull();
    expect(document.querySelector('#tab-ask')).toBeNull();
    expect(document.querySelector('#heading-ask')).toBeNull();
    expect(document.querySelector(`[data-card="${QUESTION_NOW}"]`)).toBeNull();
    expect(document.querySelector(`#heading-do`)!.closest('section')!.querySelector(`[data-card="${CARD}"]`)).not.toBeNull();
    document.querySelector<HTMLButtonElement>('#scope-team')!.click();
    expect(document.querySelector('#heading-ask')).not.toBeNull();
    expect(document.querySelector('#heading-do')).toBeNull();
  });

  it('opens an Unassigned Questions link on To-dos', async () => {
    const loaded = await loadPage('board.html', fakeServer(), '?surface=web&scope=unassigned&cols=ask');
    close = () => loaded.window.close();
    const { document } = loaded;
    await until(() => !!document.querySelector(`[data-card="${CARD}"]`));
    expect(document.querySelector('#column-ask')).toBeNull();
    expect(document.querySelector('#tab-ask')).toBeNull();
    expect(document.querySelector('#heading-ask')).toBeNull();
    expect(document.querySelector('#heading-do')).not.toBeNull();
  });

  it('keeps the default columns when opening Unassigned without a column selection', async () => {
    const loaded = await loadPage('board.html', fakeServer(), '?scope=unassigned');
    close = () => loaded.window.close();
    const { document } = loaded;
    await until(() => !!document.querySelector(`[data-card="${CARD}"]`));
    expect(document.querySelector('#heading-ask')).toBeNull();
    document.querySelector<HTMLButtonElement>('#scope-team')!.click();
    expect(document.querySelector('#heading-do')).not.toBeNull();
    expect(document.querySelector('#heading-ask')).not.toBeNull();
  });

  it.each(['do,ask', 'ask'])('keeps Questions saved while enabling Risks under Unassigned from %s', async (cols) => {
    const loaded = await loadPage('board.html', fakeServer(), `?scope=unassigned&cols=${cols}`);
    close = () => loaded.window.close();
    const { document } = loaded;
    await until(() => !!document.querySelector('#heading-do'));
    document.querySelector<HTMLButtonElement>('#column-risk')!.click();
    expect(document.querySelector('#heading-do')).not.toBeNull();
    expect(document.querySelector('#heading-risk')).not.toBeNull();
    expect(document.querySelector('#heading-ask')).toBeNull();
    document.querySelector<HTMLButtonElement>('#scope-team')!.click();
    expect(document.querySelector('#heading-ask')).not.toBeNull();
    expect(document.querySelector('#heading-do')).not.toBeNull();
    expect(document.querySelector('#heading-risk')).not.toBeNull();
  });

  // B5: the last column on stays on. Its chip, in today's style, only says so.
  it.each(['do,ask', 'ask'])('keeps the last column, To-dos under Unassigned from %s, on without forgetting Questions', async (cols) => {
    const loaded = await loadPage('board.html', fakeServer(), `?scope=unassigned&cols=${cols}`);
    close = () => loaded.window.close();
    const { document, window } = loaded;
    await until(() => !!document.querySelector('#heading-do'));
    expect(document.querySelector<HTMLElement>('#column-do')!.title).toBe('The last column stays on');
    const url = window.location.search;
    document.querySelector<HTMLButtonElement>('#column-do')!.click();
    expect(window.location.search).toBe(url);
    expect(document.querySelector('#column-do')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('#column-do')!.getAttribute('data-tip')).toBe('The last column stays on');
    expect(document.querySelector('#heading-do')).not.toBeNull();
    expect(document.querySelector('#card-list')!.textContent).not.toContain('No columns selected.');
    document.querySelector<HTMLButtonElement>('#scope-team')!.click();
    expect(document.querySelector('#heading-ask')).not.toBeNull();
    if (cols !== 'do,ask') return;
    expect(document.querySelector('#heading-do')).not.toBeNull();
    // With two on, either turns off as before.
    expect(document.querySelector<HTMLElement>('#column-do')!.title).toMatch(/^Hide To-dos \(\d+\)$/);
    document.querySelector<HTMLButtonElement>('#column-do')!.click();
    expect(document.querySelector('#heading-do')).toBeNull();
    expect(document.querySelector('#column-do')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps a fault of its own in its own words, not as a board it could not reach', async () => {
    const server = fakeServer(), answer = server.fetch;
    // An answer with no body to read: the page's own code throws a TypeError that no network raised.
    server.fetch = (input, init) => (String(input).endsWith('/archive') ? Promise.resolve(new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })) : answer(input, init));
    const { document } = await open('board.html', server);
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    (document.querySelector(`[data-open="${CARD}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#do-done'));
    (document.querySelector('#do-done') as HTMLButtonElement).click();
    await until(() => !!alerted(document));
    expect(alerted(document)).not.toContain('Couldn’t reach the board.');
  });

  it('keeps the to-do owner picked when the question changed underneath the answer', async () => {
    const { document, server } = await open('board.html', fakeServer({ clarifyStaleOnce: true, askedOpen: true }));
    await until(() => !!document.querySelector(`[data-open="${QUESTION_NOW}"]`));
    (document.querySelector(`[data-open="${QUESTION_NOW}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#clarify-form'));
    (document.querySelector('#clarify-answer') as HTMLTextAreaElement).value = 'Friday noon';
    const todo = document.querySelector('#clarify-title') as HTMLInputElement;
    todo.value = 'Lin tells the team';
    todo.dispatchEvent(new todo.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    (document.querySelector('#clarify-owner-pick') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#owner-dialog [data-person="Bob"]'));
    (document.querySelector('#owner-dialog [data-person="Bob"]') as HTMLButtonElement).click();
    (document.querySelector('#clarify-form') as HTMLFormElement).requestSubmit();
    await until(() => writes(server.calls).some((c) => c.path.endsWith('/clarify')) && !/Saving/.test(document.querySelector('#clarify-status')!.textContent!));
    expect(document.querySelector('#clarify-owner')!.textContent).toBe('Bob');
    (document.querySelector('#clarify-form') as HTMLFormElement).requestSubmit();
    await until(() => writes(server.calls).filter((c) => c.path.endsWith('/clarify')).length === 2);
    expect(writes(server.calls).filter((c) => c.path.endsWith('/clarify'))[1]).toMatchObject({ body: { todo: 'Lin tells the team', todo_owner_member_id: BOB, revision: 2 } });
  });
});

// One loader for Zoom's SDK script (ui/link.js), shared by every link out and Zoom's meeting lookup.
describe('Zoom’s SDK script', () => {
  type Linker = { bwatLink: { openInBrowser(url: string): void } };
  const linkOut = (window: unknown) => (window as Linker).bwatLink.openInBrowser('https://bwat.test/admin/');
  const tags = (document: Document) => document.querySelectorAll<HTMLScriptElement>('script[src="https://appssdk.zoom.us/sdk.min.js"]');

  it('is added once however many links out are opened before it lands', async () => {
    const { window, document } = await open('board.html', fakeServer());
    linkOut(window);
    linkOut(window);
    expect(tags(document)).toHaveLength(1);
  });

  it('is tried again on the next link out when it failed to load', async () => {
    const { window, document } = await open('board.html', fakeServer());
    const opened: string[] = [];
    (window as unknown as { open: (u: string) => null }).open = (u) => { opened.push(u); return null; };
    linkOut(window);
    const first = tags(document)[0]!;
    first.dispatchEvent(new window.Event('error'));
    // The failed load falls back to a new tab, and its script tag goes.
    await until(() => opened.length === 1);
    linkOut(window);
    expect(tags(document)).toHaveLength(1);
    expect(tags(document)[0] === first).toBe(false);
  });
});

describe('a link the person has not connected', () => {
  const banner = (document: Document) => document.getElementById('bwat-not-connected');
  const feed = async (window: { fetch: typeof fetch }) => (await window.fetch('board_feed.json')).json();
  const ZOOM = 'Your Zoom login is not linked: open bwat inside Zoom and link your account.';
  const lines = (document: Document) => [...banner(document)!.querySelectorAll('p')].map((p) => p.textContent);

  it('names the Zoom login and the step that fixes it, on the desk', async () => {
    const { window, document } = await open('board.html', fakeServer({ sessions: [], zoomLinked: { on: false } }));
    await feed(window);
    expect(banner(document)!.getAttribute('role')).toBe('status');
    expect(lines(document)).toEqual([ZOOM]);
  });

  // The board works without a Claude session: no banner says so; Send to Claude does, when it is used.
  it('shows no banner for a missing Claude session, and nothing sticks above the board', async () => {
    const { window, document } = await open('board.html', fakeServer({ sessions: [] }));
    await feed(window);
    expect(banner(document)).toBeNull();
    expect(document.body.textContent).not.toContain('Claude session is not connected');
    expect(document.documentElement.style.getPropertyValue('--bwat-banners')).toBe('0px');
  });

  it('keeps the same banner while the same links are missing, so it is announced once', async () => {
    const { window, document } = await open('board.html', fakeServer({ zoomLinked: { on: false } }));
    await feed(window);
    const first = banner(document);
    await feed(window);
    expect(banner(document)).toBe(first);
  });

  it('keeps what it shows through a failed read, and shows nothing until a read succeeds', async () => {
    const connectionsDown = { on: true };
    const { window, document } = await open('board.html', fakeServer({ zoomLinked: { on: false }, connectionsDown }));
    await feed(window);
    expect(banner(document)).toBeNull();
    connectionsDown.on = false;
    await feed(window);
    const shown = banner(document);
    expect(lines(document)).toEqual([ZOOM]);
    connectionsDown.on = true;
    await feed(window);
    expect(banner(document)).toBe(shown);
  });

  it('shows no banner once every link is connected', async () => {
    const zoomLinked = { on: false };
    const { window, document } = await open('board.html', fakeServer({ zoomLinked }));
    await feed(window);
    expect(lines(document)).toEqual([ZOOM]);
    zoomLinked.on = true;
    await feed(window);
    expect(banner(document)).toBeNull();
  });
});

describe('Send to Claude with no session yet', () => {
  const openSend = async (document: Document) => {
    await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
    (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#send-dialog .send-empty'));
    return document.querySelector('#send-dialog .send-empty')!;
  };

  it('says "No session yet · How to install", the link to the admin panel’s Connect Claude Code commands', async () => {
    const { document } = await open('board.html', fakeServer({ sessions: [] }));
    const empty = await openSend(document);
    expect(empty.textContent).toBe('No session yet · How to install');
    const how = empty.querySelector('a')!;
    expect([how.textContent, how.getAttribute('href'), how.getAttribute('target')]).toEqual(['How to install', '/admin/#/members?claude', '_blank']);
  });

  // Zoom's own browser may not follow a new-tab link, so the click goes through Zoom's openUrl.
  it('opens the install commands through Zoom when Zoom is there', async () => {
    const { window, document } = await open('board.html', fakeServer({ sessions: [] }));
    const empty = await openSend(document);
    const opened: string[] = [];
    (window as unknown as { zoomSdk: object }).zoomSdk = { config: async () => ({}), openUrl: async ({ url }: { url: string }) => { opened.push(url); } };
    empty.querySelector('a')!.click();
    await until(() => opened.length > 0);
    expect(opened).toEqual(['http://bwat.test/admin/#/members?claude']);
  });
});

describe('the writer status beside the Live pill', () => {
  // One dropped read is not offline; three in a row are.
  it('says Offline only after three failed reads in a row', async () => {
    const activityDown = { on: false };
    const server = fakeServer({ activityDown });
    const { document } = await open('board.html', server);
    const strip = () => document.querySelector('.extraction-activity')!;
    const reads = () => server.calls.filter((c) => c.path === `/v1/occurrences/${MEETING}/activity`).length;
    // Waits out n more reads, and the page's handling of the last.
    const polls = async (n: number) => {
      const from = reads();
      await until(() => reads() >= from + n);
      await new Promise((r) => setTimeout(r, 100));
    };
    await until(() => strip().textContent === 'Saved');
    activityDown.on = true;
    await polls(2);
    expect(strip().textContent).toBe('Saved');
    // A good read starts the count again.
    activityDown.on = false;
    await polls(1);
    activityDown.on = true;
    await polls(2);
    expect(strip().textContent).toBe('Saved');
    await until(() => strip().textContent === 'Offline');
  }, 30_000); // seven reads on the page's own 2s timer
});

describe('a card writer model that is gone', () => {
  it('says Paused: model unavailable beside the Live pill, with why in its title, and no out-of-credit banner', async () => {
    const { document } = await open('board.html', fakeServer({ modelError: { bot: null, cards: 'model_unavailable' } }));
    const strip = () => document.querySelector('.extraction-activity')!;
    await until(() => strip().textContent === 'Paused: model unavailable');
    expect(strip().getAttribute('title')).toBe(
      "Standup: The card writer's model is no longer available, so no new cards are written. An admin picks another in Settings.",
    );
    expect(document.getElementById('bwat-out-of-credit')).toBeNull();
  });
});

describe('a model key out of credit', () => {
  const banner = (document: Document) => document.getElementById('bwat-out-of-credit');
  const feed = async (window: { fetch: typeof fetch }) => (await window.fetch('board_feed.json')).json();

  it('says so on the desk while the bot in the live meeting reports it, and stops once it clears', async () => {
    const modelError = { bot: 'model_out_of_credit' as string | null, cards: null };
    const { window, document } = await open('board.html', fakeServer({ modelError }));
    await feed(window);
    expect(banner(document)!.getAttribute('role')).toBe('alert');
    expect(banner(document)!.textContent).toBe(
      "bwat's AI model key is out of credit, so transcription and cards have stopped. Ask your bwat owner to add credit at https://openrouter.ai/settings/credits.",
    );
    expect(banner(document)!.querySelector('a')!.getAttribute('href')).toBe('https://openrouter.ai/settings/credits');
    modelError.bot = null;
    await feed(window);
    expect(banner(document)).toBeNull();
  });

  it('says so on the desk while the card writer reports it', async () => {
    const { window, document } = await open('board.html', fakeServer({ modelError: { bot: null, cards: 'model_out_of_credit' } }));
    await feed(window);
    expect(banner(document)).not.toBeNull();
  });

  it('says nothing while no part reports it, or once the meeting is no longer live', async () => {
    const { window, document } = await open('board.html');
    await feed(window);
    expect(banner(document)).toBeNull();
    close?.();
    const ended = await open('board.html', fakeServer({ state: 'ended', modelError: { bot: 'model_out_of_credit', cards: 'model_out_of_credit' } }));
    await feed(ended.window);
    expect(banner(ended.document)).toBeNull();
  });
});

describe('Open to-dos: every meeting\'s open to-dos', () => {
  const titles = (document: Document) => [...document.querySelectorAll('.desk-column .card')].map((c) => c.getAttribute('data-card'));

  it('lists every page of the card service\'s open list, from every meeting, with the bearer', async () => {
    const { document, server } = await open('board.html', fakeServer(), '?source=open');
    await until(() => titles(document).length === 4);
    expect(new Set(titles(document))).toEqual(new Set([CARD, CARD_OWNED, SPOKEN, OLD_CARD]));
    const asked = server.openReads;
    expect(asked.slice(0, 2).map((q) => [q.get('status'), q.get('owner'), q.get('cursor')])).toEqual([['open', null, null], ['open', null, 'open-2']]);
    expect(server.calls.find((c) => c.path === '/v1/cards')!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(document.querySelector('#page-title')!.textContent).toBe('Open to-dos');
    // A meeting weeks before the feed's: named as the card service names it.
    const old = document.querySelector(`.card[data-card="${OLD_CARD}"]`)!;
    expect(old.querySelector('.card-source')!.textContent).toContain('Kickoff');
    expect(document.querySelector('#zoom-scope-open')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('reads at most 5 pages a refresh (the newest 1,000) and says when more are open', async () => {
    const { document, server, window } = await open('board.html', fakeServer({ endlessOpen: true }), '?source=open');
    await until(() => titles(document).length === 4);
    const live = (window as unknown as { LIVE: { api: { warnings?: string[] } } }).LIVE;
    await until(() => live.api.warnings?.some((w) => w.startsWith('Open to-dos: showing the newest')) ?? false);
    expect(server.openReads.slice(0, 5).map((q) => q.get('cursor'))).toEqual([null, 'open-2', 'open-3', 'open-4', 'open-5']);
    expect(server.openReads.some((q) => q.get('cursor') === 'open-6')).toBe(false);
  });

  it('shows to-dos only, and no closed or archived card, whatever the meeting views hold', async () => {
    const { document } = await open('board.html', fakeServer(), '?source=open');
    await until(() => titles(document).length === 4);
    expect(titles(document)).not.toContain(QUESTION);
    expect(titles(document)).not.toContain(QUESTION_NOW);
    expect(titles(document)).not.toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(visibleText(document)).not.toContain('Closed earlier');
  });

  it('Mine reads owner=me: the viewer\'s cards by member, never a card the room said was "Ada"', async () => {
    const { document, server } = await open('board.html', fakeServer(), '?source=open&scope=mine');
    await until(() => titles(document).length === 2);
    expect(new Set(titles(document))).toEqual(new Set([CARD_OWNED, OLD_CARD]));
    expect(titles(document)).not.toContain(SPOKEN);
    expect(server.openReads.every((q) => q.get('owner') === 'me')).toBe(true);
  });

  it('switching Everything to Mine reads the list again with owner=me', async () => {
    const { document, server } = await open('board.html', fakeServer(), '?source=open');
    await until(() => titles(document).length === 4);
    (document.querySelector('#scope-mine') as HTMLButtonElement).click();
    await until(() => titles(document).length === 2);
    expect(server.openReads.at(-1)!.get('owner')).toBe('me');
    (document.querySelector('#scope-team') as HTMLButtonElement).click();
    await until(() => titles(document).length === 4);
    expect(server.openReads.at(-1)!.get('owner')).toBeNull();
  });

  it('opens from the header beside the meeting views, which never read the open list', async () => {
    const { document, server, window } = await open('board.html');
    await until(() => document.querySelectorAll('.desk-column .card').length >= 3);
    expect(server.openReads).toEqual([]);
    expect([...document.querySelectorAll('#zoom-scope button')].map((b) => b.textContent))
      .toEqual(['Current meeting', 'Today', 'This week', 'All meetings', 'Open to-dos']);
    (document.querySelector('#zoom-scope-open') as HTMLButtonElement).click();
    await until(() => titles(document).length === 4);
    expect(new URLSearchParams(window.location.search).get('source')).toBe('open');
    expect(document.querySelector(`.card[data-card="${OLD_CARD}"]`)).not.toBeNull();
  });
});

// QOR-5039 (10/28): the header's first button names the meeting it opens. Current
// meeting while one on the board is live, else Last meeting, the newest. A meeting that starts
// does not take the viewer off the one they are reading: the button relabels, and a click moves.
describe('Current meeting / Last meeting', () => {
  const first = (document: Document) => document.querySelector('#zoom-scope-this')!.textContent;
  const source = (window: { location: Location }) => new URLSearchParams(window.location.search).get('source');

  it('says Current meeting while a meeting is live', async () => {
    const { document } = await open('board.html');
    await until(() => !!cardEl(document, CARD));
    expect(first(document)).toBe('Current meeting');
  });

  it('says Last meeting when none is live, and shows the newest', async () => {
    const { document } = await open('board.html', fakeServer({ state: 'ended' }));
    await until(() => !!cardEl(document, CARD));
    expect(first(document)).toBe('Last meeting');
    expect(cardEl(document, QUESTION)).toBeNull();
  });

  it('stays on the last meeting when one starts, until Current meeting is clicked', async () => {
    const server = fakeServer({ late: true });
    const { document, window } = await open('board.html', server);
    await until(() => !!cardEl(document, QUESTION));
    expect(first(document)).toBe('Last meeting');
    server.start();
    await poll(window);
    expect(first(document)).toBe('Current meeting');
    expect(cardEl(document, QUESTION)).not.toBeNull();
    expect(cardEl(document, CARD)).toBeNull();
    expect(source(window)).toBe(OLDER_MEETING);
    // Not pressed: the meeting on screen is not the one the button opens.
    expect(document.querySelector('#zoom-scope-this')!.getAttribute('aria-pressed')).toBe('false');
    (document.querySelector('#zoom-scope-this') as HTMLButtonElement).click();
    await until(() => !!cardEl(document, CARD));
    expect(cardEl(document, QUESTION)).toBeNull();
    expect(source(window)).toBeNull();
    expect(document.querySelector('#zoom-scope-this')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('says Last meeting on the same meeting when the live one ends', async () => {
    const server = fakeServer();
    const { document, window } = await open('board.html', server);
    await until(() => !!cardEl(document, CARD));
    server.end();
    await poll(window);
    expect(first(document)).toBe('Last meeting');
    expect(cardEl(document, CARD)).not.toBeNull();
  });

  it('keeps following the newest meeting while none is live', async () => {
    const server = fakeServer({ late: true, state: 'ended' });
    const { document, window } = await open('board.html', server);
    await until(() => !!cardEl(document, QUESTION));
    server.start();
    await poll(window);
    await until(() => !!cardEl(document, CARD));
    expect(first(document)).toBe('Last meeting');
    expect(source(window)).toBeNull();
  });

  // 10/28: the button opens the live meeting or else the newest, whatever Opens on says.
  it.each([['live', 'Current meeting'], ['ended', 'Last meeting']] as const)(
    'opens one meeting from %s even when the board opens on All', async (state, label) => {
      const { document, window } = await open('board.html', fakeServer({ state }), '', false, { 'bwat.study.v1.settings.open': '"all"' });
      await until(() => !!cardEl(document, QUESTION));
      expect(first(document)).toBe(label);
      (document.querySelector('#zoom-scope-this') as HTMLButtonElement).click();
      await until(() => !cardEl(document, QUESTION));
      expect(cardEl(document, CARD)).not.toBeNull();
      expect(source(window)).toBe(MEETING);
      expect(document.querySelector('#zoom-scope-this')!.getAttribute('aria-pressed')).toBe('true');
    });

  it('inside Zoom still follows the meeting the panel was opened from once it starts', async () => {
    const server = fakeServer({ late: true, occurrence: 'zoom-occurrence==' });
    const { document, window } = await open('board.html', server, '?surface=zoom');
    // Until then the panel shows the newest meeting listed, Planning, whose one card is a question.
    await sharedFeedOf(window);
    await until(() => !!document.querySelector('#card-list'));
    expect(cardEl(document, CARD)).toBeNull();
    server.start();
    await poll(window);
    await until(() => !!cardEl(document, CARD));
    expect(source(window)).toBeNull();
  });
});

describe('a hint that a card may duplicate or relate to another', () => {
  const DUP = { card_id: CARD_OWNED, display_id: 'T-2', title: 'Write the release notes' };
  const REL = { card_id: QUESTION_NOW, display_id: 'Q-2', title: 'When is the code freeze?' };
  const BOTH = { duplicate: DUP, related: REL };
  /** The hint lines on a card, as a person reads them. */
  const hints = (document: Document, id = CARD) =>
    [...document.querySelectorAll(`[data-card="${id}"] .hint`)].map((h) => h.textContent!.replace(/\s+/g, ' ').trim());
  const button = (document: Document, label: string) =>
    [...document.querySelectorAll(`[data-card="${CARD}"] .hint button`)].find((b) => b.textContent === label) as HTMLButtonElement;
  /** The line on the hint's card, and the words before its Try again. */
  const line = (document: Document) => document.querySelector(`[data-card="${CARD}"] .card-line`) as HTMLElement | null;
  const words = (el: HTMLElement) => el.firstChild!.textContent;
  const hintWrites = (calls: Call[]) => writes(calls).filter((c) => c.path.includes('/hint/'));
  /** The page's own fetch, wrapped: `onAct` sees each /hint-act request's wait, and may answer it. */
  const watchAct = (window: object, onAct: (ms: number | undefined) => Promise<Response> | undefined) => {
    const w = window as unknown as { fetch: typeof fetch; AbortSignal: typeof AbortSignal };
    const waits = new WeakMap<AbortSignal, number>();
    const timeout = w.AbortSignal.timeout.bind(w.AbortSignal);
    w.AbortSignal.timeout = (ms: number) => { const s = timeout(ms); waits.set(s, ms); return s; };
    const page = w.fetch;
    w.fetch = (input, init) => (String(input).endsWith('/hint-act') && onAct(init?.signal ? waits.get(init.signal) : undefined))
      || page(input, init);
  };

  it('names the card on each side, with its two buttons, and nothing on a card without one', async () => {
    const { document } = await open('board.html', fakeServer({ hint: BOTH }));
    await until(() => hints(document).length > 0);
    expect(hints(document)).toEqual([
      'May duplicate T-2 — Write the release notes Not a duplicate Merge now',
      'May relate to Q-2 — When is the code freeze? Dismiss Link now',
    ]);
    expect(hints(document, CARD_OWNED)).toEqual([]);
  });

  it('shows only the side Jev named a card for', async () => {
    const { document } = await open('board.html', fakeServer({ hint: { duplicate: null, related: REL } }));
    await until(() => hints(document).length > 0);
    expect(hints(document)).toEqual(['May relate to Q-2 — When is the code freeze? Dismiss Link now']);
  });

  it('Not a duplicate dismisses the pair the board showed with POST /v1/cards/{id}/hint/dismiss, and the line goes', async () => {
    const { document, server } = await open('board.html', fakeServer({ hint: BOTH }));
    await until(() => !!button(document, 'Not a duplicate'));
    button(document, 'Not a duplicate').click();
    await until(() => hints(document).length === 1);
    expect(hintWrites(server.calls)).toEqual([{
      method: 'POST', path: `/v1/cards/${CARD}/hint/dismiss`, authorization: `Bearer ${TOKEN}`, body: { kind: 'duplicate', target_card_id: CARD_OWNED },
    }]);
    expect(hints(document)).toEqual(['May relate to Q-2 — When is the code freeze? Dismiss Link now']);
  });

  it('Dismiss dismisses the related pair', async () => {
    const { document, server } = await open('board.html', fakeServer({ hint: { duplicate: null, related: REL } }));
    await until(() => !!button(document, 'Dismiss'));
    button(document, 'Dismiss').click();
    await until(() => hints(document).length === 0);
    expect(hintWrites(server.calls).map((c) => [c.path, c.body])).toEqual([[`/v1/cards/${CARD}/hint/dismiss`, { kind: 'related', target_card_id: QUESTION_NOW }]]);
  });

  it('Merge now posts to /hint/act, holds both buttons while it runs, then says what happened', async () => {
    let release!: () => void;
    const actGate = new Promise<void>((r) => { release = r; });
    const { document, server } = await open('board.html', fakeServer({ hint: BOTH, actGate }));
    await until(() => !!button(document, 'Merge now'));
    button(document, 'Merge now').click();
    await until(() => hintWrites(server.calls).length === 1);
    expect(hintWrites(server.calls)[0]).toEqual({
      method: 'POST', path: `/v1/cards/${CARD}/hint/act`, authorization: `Bearer ${TOKEN}`, body: { kind: 'duplicate', target_card_id: CARD_OWNED },
    });
    // Another action redraws the board while the merge runs: its buttons stay held.
    button(document, 'Dismiss').click();
    await until(() => hints(document).length === 1);
    expect(button(document, 'Merge now').disabled).toBe(true);
    expect(button(document, 'Not a duplicate').disabled).toBe(true);
    release();
    await until(() => hints(document).length === 0);
    // The hint going is the answer on the card; a screen reader hears the card service's words.
    expect(said(document)).toBe('Merged');
    expect(line(document)).toBeNull();
  });

  it('waits as long as the card service and the edge may take for Merge now: 300 s', async () => {
    const { window, document } = await open('board.html', fakeServer({ hint: BOTH }));
    const waits: (number | undefined)[] = [];
    watchAct(window, (ms) => { waits.push(ms); return undefined; });
    await until(() => !!button(document, 'Merge now'));
    button(document, 'Merge now').click();
    await until(() => said(document) === 'Merged');
    expect(waits).toEqual([300_000]);
  });

  // A drop and the 300 s wait running out end the same way: the request rejects.
  it('a request that never answers says so on the card, once, and Try again asks again', async () => {
    const { window, document, server } = await open('board.html', fakeServer({ hint: BOTH }));
    let drop = true;
    watchAct(window, () => (drop ? Promise.reject(new TypeError('Failed to fetch')) : undefined));
    await until(() => !!button(document, 'Merge now'));
    button(document, 'Merge now').click();
    await until(() => !!line(document));
    expect(line(document)!.classList.contains('err')).toBe(true);
    expect(words(line(document)!)).toBe('Couldn’t reach the board.');
    expect(document.querySelector('#alert')!.textContent).toBe('Couldn’t reach the board.');
    await until(() => !button(document, 'Merge now').disabled);
    expect(hints(document)).toHaveLength(2);
    // The board itself is reachable: not the offline state.
    expect(document.body.classList.contains('offline')).toBe(false);
    drop = false;
    (line(document)!.querySelector('[data-note-retry]') as HTMLButtonElement).click();
    await until(() => said(document) === 'Merged');
    expect(hintWrites(server.calls).filter((c) => c.path.endsWith('/hint/act'))).toHaveLength(1);
    await until(() => !line(document));
  });

  it('keeps the red line when its Try again finds the same request still in flight', async () => {
    const { window, document } = await open('board.html', fakeServer({ hint: BOTH }));
    let mode: 'drop' | 'hang' = 'drop';
    watchAct(window, () => (mode === 'drop' ? Promise.reject(new TypeError('Failed to fetch')) : new Promise<Response>(() => {})));
    await until(() => !!button(document, 'Merge now'));
    button(document, 'Merge now').click();
    await until(() => !!line(document));
    await until(() => !button(document, 'Merge now').disabled);
    mode = 'hang';
    button(document, 'Merge now').click();
    await until(() => button(document, 'Merge now').disabled);
    (line(document)!.querySelector('[data-note-retry]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(line(document)?.classList.contains('err')).toBe(true);
  });

  it('a dropped connection is a state: the lens greys, the Live pill says Reconnecting… and the cards dim, until a read works', async () => {
    const { window, document } = await open('board.html', fakeServer({ hint: BOTH }));
    watchAct(window, () => Promise.reject(new TypeError('Failed to fetch')));
    await until(() => !!button(document, 'Merge now'));
    const lens = document.querySelector('.brand .brand-lens')!;
    await poll(window);
    // The read after it fails too, so the board stays down.
    control.feedDown = true;
    try {
      button(document, 'Merge now').click();
      await until(() => document.body.classList.contains('offline'));
      expect(lens.classList.contains('offline')).toBe(true);
      // Said once, by the Live pill (a status), its dot grey: not in the header's message line,
      // not by the feed's band, not again through #announcement or #alert.
      const pill = document.querySelector('#live-pill') as HTMLElement;
      expect(pill.hidden).toBe(false);
      expect(pill.textContent).toBe('Reconnecting…');
      expect(pill.classList.contains('fading')).toBe(true);
      expect(pill.getAttribute('role')).toBe('status');
      expect(document.querySelector('#whisper')!.textContent).toBe('');
      expect((document.querySelector('#feed-alert') as HTMLElement).hidden).toBe(true);
      expect(said(document)).not.toContain('Connection dropped');
      expect(alerted(document)).not.toMatch(/Reconnect|unreachable/i);
    } finally {
      control.feedDown = false;
    }
    await poll(window);
    expect(document.body.classList.contains('offline')).toBe(false);
    expect(lens.classList.contains('offline')).toBe(false);
    expect(lens.classList.contains('ring')).toBe(true);
    const pill = document.querySelector('#live-pill') as HTMLElement;
    expect(pill.textContent).toBe('Live');
    expect(pill.classList.contains('fading')).toBe(false);
    expect(pill.hidden).toBe(false);
    // A poll, not a forced read, draws the board again: the held buttons come back.
    expect(button(document, 'Merge now').disabled).toBe(false);
  });

  it('Link now says on the card when the named card has gone, a while, and the hint clears', async () => {
    const { window, document, server } = await open('board.html', fakeServer({
      hint: { duplicate: null, related: REL }, act: [200, { outcome: 'gone', message: 'That card is no longer on the board' }],
    }));
    await until(() => !!button(document, 'Link now'));
    ms(window).who = 50;
    button(document, 'Link now').click();
    await until(() => !!line(document));
    // It fades in once, on the card drawn with the refresh after the answer.
    expect(line(document)!.classList.contains('once-in')).toBe(true);
    expect(line(document)!.classList.contains('note')).toBe(true);
    expect(line(document)!.textContent).toBe('That card is no longer on the board');
    expect(line(document)!.querySelector('button')).toBeNull();
    expect(hintWrites(server.calls)[0]!.body).toEqual({ kind: 'related', target_card_id: QUESTION_NOW });
    await until(() => hints(document).length === 0);
    await until(() => !line(document));
  });

  it('says the card service\'s words on the card when it refuses, offers the buttons again, and Try again asks again', async () => {
    const { window, document, server } = await open('board.html', fakeServer({
      hint: BOTH, act: [409, { error: 'cleanup_running', message: 'Clean-up running, try again shortly' }],
    }));
    await until(() => !!button(document, 'Merge now'));
    button(document, 'Merge now').click();
    await until(() => !!line(document));
    expect(line(document)!.classList.contains('err')).toBe(true);
    expect(alerted(document)).toBe('Clean-up running, try again shortly');
    expect(words(line(document)!)).toBe('Clean-up running, try again shortly');
    await until(() => !button(document, 'Merge now').disabled);
    expect(hints(document)).toHaveLength(2);
    // It stays across a poll, until it is fixed.
    await poll(window);
    expect(line(document)).not.toBeNull();
    (line(document)!.querySelector('[data-note-retry]') as HTMLButtonElement).click();
    await until(() => hintWrites(server.calls).length === 2);
    expect(hintWrites(server.calls)[1]!.body).toEqual(hintWrites(server.calls)[0]!.body);
    // Refused again in the same words, it is read out again.
    await until(() => document.querySelector('#alert')!.textContent === 'Clean-up running, try again shortly ');
  });

  it('a merge that outlives the connection sends the person to the board, not to an error code', async () => {
    const { document } = await open('board.html', fakeServer({ hint: BOTH, act: [504, {}] }));
    await until(() => !!button(document, 'Merge now'));
    button(document, 'Merge now').click();
    await until(() => !!line(document));
    expect(words(line(document)!)).toBe('No answer in time. The board shows what happened.');
    // The board shows what happened: there is nothing to try again.
    expect(line(document)!.querySelector('button')).toBeNull();
  });
});

// The desk's expiring-card line (mock-ups E3 and E6): "Closes in 3 days · Keep" under
// the source line, grey until 2 days are left, then amber, then red "Closes today"; Keep's answer
// is said on the card, and the board refreshes once that line has folded away.
describe('the expiring-card line on the desk (board.html)', () => {
  const face = (document: Document, id: string) => document.querySelector(`#card-list [data-card="${id}"]`) as HTMLElement;
  const line = (document: Document) => face(document, CARD_OWNED).querySelector('.keep-line') as HTMLElement | null;
  const kept = (document: Document) => face(document, CARD_OWNED)?.querySelector('.card-line.ok') as HTMLElement | null;
  const shown = async (days: number) => {
    const loaded = await open('board.html', fakeServer({ lifecycle: { expires_in_days: null }, ownedLifecycle: { expires_in_days: days } }));
    await until(() => !!face(loaded.document, CARD_OWNED));
    return loaded;
  };

  it('says the days left on that line, not as an expiry chip', async () => {
    const { document } = await shown(4);
    expect(face(document, CARD_OWNED).textContent).not.toContain('Expires');
    // Under the source line, outside the card's open button: a button cannot hold a button.
    expect(line(document)!.closest('.card-open')).toBeNull();
  });

  it.each([[3, []], [2, ['r2']], [1, ['r1']]])('colours the line by the days left: %i is %j', async (days, r) => {
    const { document } = await shown(days as number);
    expect([...line(document)!.classList].filter((x) => /^r\d$/.test(x))).toEqual(r);
  });

  it('names the card and what Keep does in its label', async () => {
    const { document } = await shown(3);
    expect(line(document)!.querySelector('[data-keep]')!.getAttribute('aria-label')).toBe('Keep T-2 on the board until someone closes it');
  });

  it('says it was kept on the card itself, through a poll, then folds it away and refreshes', async () => {
    const { window, document } = await shown(3);
    (line(document)!.querySelector('[data-keep]') as HTMLButtonElement).click();
    await until(() => !!kept(document));
    expect(kept(document)!.textContent!.trim()).toBe('Kept until you close it');
    expect(kept(document)!.closest('.card-open')).toBeNull();
    expect(kept(document)!.querySelector('svg')).not.toBeNull();
    expect(line(document)).toBeNull();
    expect(document.querySelector('#announcement')!.textContent).toBe('Kept until you close it.');
    // A poll meanwhile (the card no longer expires) keeps the confirmation.
    await poll(window);
    expect(kept(document)!.textContent!.trim()).toBe('Kept until you close it');
    await until(() => !kept(document), 5000);
    expect(face(document, CARD_OWNED).textContent).not.toContain('Closes');
  });

  it('says on the card when Keep never reaches the board, once, with Try again', async () => {
    const { window, document } = await shown(3);
    const w = window as unknown as { fetch: typeof fetch };
    const page = w.fetch;
    w.fetch = (input, init) => (String(input).endsWith('/keep') ? Promise.reject(new TypeError('Failed to fetch')) : page(input, init));
    (line(document)!.querySelector('[data-keep]') as HTMLButtonElement).click();
    const err = () => face(document, CARD_OWNED)?.querySelector('.card-line.err') as HTMLElement | null;
    await until(() => !!err());
    expect(err()!.firstChild!.textContent).toBe('Couldn’t reach the board.');
    expect(err()!.querySelector('[data-note-retry]')!.textContent).toBe('Try again');
    expect(document.querySelector('#alert')!.textContent).toBe('Couldn’t reach the board.');
    await until(() => !(line(document)!.querySelector('[data-keep]') as HTMLButtonElement).disabled);
  });

  it('lets go of the confirmation even when its fold fails', async () => {
    const { window, document } = await shown(3);
    (window as unknown as { DELIGHT: { fold: () => Promise<void> } }).DELIGHT.fold = () => Promise.reject(new Error('fold'));
    (line(document)!.querySelector('[data-keep]') as HTMLButtonElement).click();
    await until(() => !!kept(document));
    await until(() => !kept(document), 5000);
  });
});

// Each change says itself on the card it changed, never in a notice at the foot of the page
// (mock-ups T1, T2 and T5): the owner circle stamps, Saved shows under the source line, and a
// change someone made first is named on the card or the column it reloaded.
describe('a change shows on the card it changed (board.html)', () => {
  const lineOn = (document: Document, id: string) => cardEl(document, id)?.querySelector('.card-line') as HTMLElement | null;
  const openIt = async (document: Document, id: string) => {
    await until(() => !!document.querySelector(`[data-open="${id}"]`));
    (document.querySelector(`[data-open="${id}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#do-done'));
  };

  it('stamps the new initial into the owner circle and washes the card, after Change owner', async () => {
    const { window, document } = await open('board.html');
    await openIt(document, CARD);
    (document.querySelector('#change-owner') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#owner-dialog [data-person="Bob"]'));
    (document.querySelector('#owner-dialog [data-person="Bob"]') as HTMLButtonElement).click();
    await until(() => !!cardEl(document, CARD)?.querySelector('.card-owner.once-stamp'));
    expect(cardEl(document, CARD)!.querySelector('.card-owner')!.textContent).toBe('B');
    await until(() => cardEl(document, CARD)!.classList.contains('is-changed'));
    expect(said(document)).toBe('Owner: Bob.');
    expect(lineOn(document, CARD)).toBeNull();
    // A poll redraws the card but keeps its node: the stamp is not played again.
    const node = cardEl(document, CARD);
    await poll(window);
    expect(cardEl(document, CARD)).toBe(node);
  });

  it('stamps your own initial in after Take it', async () => {
    const { document } = await open('board.html');
    await until(() => !!document.querySelector(`[data-take="${CARD}"]`));
    (document.querySelector(`[data-take="${CARD}"]`) as HTMLButtonElement).click();
    await until(() => !!cardEl(document, CARD)?.querySelector('.card-owner.once-stamp'));
    expect(cardEl(document, CARD)!.querySelector('.card-owner')!.textContent).toBe('A');
    expect(said(document)).toBe('Owner: Ada.');
    // Only the owner just set stamps: a card that already had one does not.
    expect(cardEl(document, CARD_OWNED)!.querySelector('.once-stamp')).toBeNull();
  });

  it('says Saved under the source line of the card it saved, then lets it go', async () => {
    const { window, document } = await open('board.html');
    await until(() => !!document.querySelector(`[data-more="${CARD}"]`));
    ms(window).saved = 50;
    (document.querySelector(`[data-more="${CARD}"]`) as HTMLButtonElement).click();
    (document.querySelector('#more-edit') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#edit-form'));
    (document.querySelector('#edit-title') as HTMLInputElement).value = 'Ship it Monday';
    (document.querySelector('#edit-form') as HTMLFormElement).requestSubmit();
    await until(() => !!lineOn(document, CARD));
    const line = lineOn(document, CARD)!;
    expect(line.classList.contains('ok')).toBe(true);
    expect(line.textContent).toBe('Saved');
    expect(line.querySelector('svg')).not.toBeNull();
    expect(line.closest('.card-open')).toBeNull();
    expect(said(document)).toBe('Saved: Ship it Monday.');
    await until(() => !lineOn(document, CARD));
  });

  it('names who changed a card first, on that card, when a close is refused as stale', async () => {
    const { window, document } = await open('board.html', fakeServer({ archiveStaleOnce: true }));
    ms(window).who = 50;
    await openIt(document, CARD_OWNED);
    (document.querySelector('#do-done') as HTMLButtonElement).click();
    await until(() => !!lineOn(document, CARD_OWNED));
    const line = lineOn(document, CARD_OWNED)!;
    expect(line.classList.contains('who')).toBe(true);
    expect(line.textContent).toBe('Someone changed this just now');
    expect(line.querySelector('.card-line-av')).toBeNull();
    expect(said(document)).toBe('Someone changed this just now.');
    // The card reloads with their change, and washes once.
    await until(() => cardEl(document, CARD_OWNED)!.classList.contains('is-changed'));
    await until(() => !lineOn(document, CARD_OWNED));
  });

  it('names them, with their initial, when the refusal says who', async () => {
    const { document } = await open('board.html', fakeServer({ archiveStaleOnce: true, staleBy: 'Bob' }));
    await openIt(document, CARD_OWNED);
    (document.querySelector('#do-done') as HTMLButtonElement).click();
    await until(() => !!lineOn(document, CARD_OWNED));
    expect(lineOn(document, CARD_OWNED)!.textContent).toBe('BBob changed this just now');
    expect(lineOn(document, CARD_OWNED)!.querySelector('.card-line-av')!.textContent).toBe('B');
  });

  it('says so in red by Done and Won’t do when a close never reaches the board, read once, and Try again closes it', async () => {
    // The connection drops under the page's own fetch (bwat-api.js), as in a browser.
    const server = fakeServer(), answer = server.fetch;
    let drop = true;
    server.fetch = (input, init) => (drop && String(input).endsWith('/archive') ? Promise.reject(new TypeError('Failed to fetch')) : answer(input, init));
    const { document } = await open('board.html', server);
    await openIt(document, CARD_OWNED);
    const done = document.querySelector('#do-done') as HTMLButtonElement;
    done.click();
    const line = () => document.querySelector(`#reader [data-line="reader:${CARD_OWNED}"]`) as HTMLElement | null;
    await until(() => !!line());
    expect(line()!.classList.contains('err')).toBe(true);
    expect(line()!.firstChild!.textContent).toBe('Couldn’t reach the board.');
    expect(alerted(document)).toBe('Couldn’t reach the board.');
    expect(document.querySelector('#action-status')!.textContent).toBe('');
    expect(done.hasAttribute('aria-disabled')).toBe(false);
    expect((document.querySelector('#do-wont') as HTMLButtonElement).hasAttribute('aria-disabled')).toBe(false);
    drop = false;
    (line()!.querySelector('[data-note-retry]') as HTMLButtonElement).click();
    await until(() => !!cardEl(document, CARD_OWNED)?.classList.contains('slim-row'));
    expect(cardEl(document, CARD_OWNED)!.querySelector('.slim-label')!.textContent).toBe('Done');
    expect(line()).toBeNull();
  });

  it('says a refused Change owner in red by the buttons, read once, and Try again changes it', async () => {
    const { document, server } = await open('board.html', fakeServer({ ownerFailsOnce: true }));
    await openIt(document, CARD);
    (document.querySelector('#change-owner') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#owner-dialog [data-person="Bob"]'));
    (document.querySelector('#owner-dialog [data-person="Bob"]') as HTMLButtonElement).click();
    const line = () => document.querySelector(`#reader [data-line="reader:${CARD}"]`) as HTMLElement | null;
    await until(() => !!line());
    expect(line()!.classList.contains('err')).toBe(true);
    expect(line()!.previousElementSibling!.id).toBe('action-status');
    expect(line()!.firstChild!.textContent).toBe('internal');
    expect(alerted(document)).toBe('internal');
    expect(document.querySelector('#action-status')!.textContent).toBe('');
    expect((document.querySelector('#change-owner') as HTMLButtonElement).hasAttribute('aria-disabled')).toBe(false);
    (line()!.querySelector('[data-note-retry]') as HTMLButtonElement).click();
    await until(() => !!cardEl(document, CARD)?.querySelector('.card-owner.once-stamp'));
    expect(writes(server.calls).filter((c) => c.path === `/v1/cards/${CARD}/owner`)).toHaveLength(2);
    expect(cardEl(document, CARD)!.querySelector('.card-owner')!.textContent).toBe('B');
    await until(() => !line());
  });

  const changeOwnerToBob = async (document: Document) => {
    await openIt(document, CARD);
    (document.querySelector('#change-owner') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#owner-dialog [data-person="Bob"]'));
    (document.querySelector('#owner-dialog [data-person="Bob"]') as HTMLButtonElement).click();
  };
  const ownerWrites = (server: ReturnType<typeof fakeServer>) => writes(server.calls).filter((c) => c.path === `/v1/cards/${CARD}/owner`);

  it('changes the owner anyway when the card writer revised the card first, at its new revision', async () => {
    const { document, server } = await open('board.html', fakeServer({ ownerStaleOnce: 'text' }));
    await changeOwnerToBob(document);
    await until(() => !!cardEl(document, CARD)?.querySelector('.card-owner.once-stamp'));
    expect(ownerWrites(server)).toHaveLength(2);
    expect(ownerWrites(server)[1]!.body).toMatchObject({ revision: 4 });
    expect(cardEl(document, CARD)!.querySelector('.card-owner')!.textContent).toBe('B');
  });

  it('does not change the owner of a card someone closed first', async () => {
    const { document, server } = await open('board.html', fakeServer({ ownerStaleOnce: 'closed' }));
    await changeOwnerToBob(document);
    await until(() => !!lineOn(document, CARD) || !cardEl(document, CARD) || !!cardEl(document, CARD)!.classList.contains('slim-row'));
    await new Promise((r) => setTimeout(r, 200));
    expect(ownerWrites(server)).toHaveLength(1);
  });

  it('keeps an owner someone else set first, and says so on the card', async () => {
    const { document, server } = await open('board.html', fakeServer({ ownerStaleOnce: 'owner' }));
    await changeOwnerToBob(document);
    await until(() => !!lineOn(document, CARD));
    expect(lineOn(document, CARD)!.classList.contains('who')).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(ownerWrites(server)).toHaveLength(1);
  });

  it('says on the To-dos column head that someone reordered it first', async () => {
    const { window, document } = await open('board.html', fakeServer({ orderStaleOnce: true }), `?source=${MEETING}`);
    await until(() => !!cardEl(document, CARD));
    ms(window).who = 50;
    void (window as unknown as { applyShared: (m: string, o: string[], v: number) => Promise<void> }).applyShared(MEETING, [CARD, CARD_OWNED], 2);
    const head = () => document.querySelector('section.desk-column[aria-labelledby="heading-do"] > .card-line') as HTMLElement | null;
    await until(() => !!head());
    expect(head()!.classList.contains('who')).toBe(true);
    expect(head()!.textContent).toBe('Someone changed this just now');
    await until(() => !head());
  });
});

// A failure says itself in red on the card or control that failed, with Try again where there is
// one, and stays until it is fixed or the person moves on (mock-up T6). Undo merge from a card not
// loaded opens the card it is on, at its Undo merge (T11).
describe('an error shows on what failed (board.html)', () => {
  const errOn = (document: Document, id: string) => cardEl(document, id)?.querySelector('.card-line.err') as HTMLElement | null;
  const words = (el: HTMLElement) => el.firstChild!.textContent;
  const retry = (el: HTMLElement) => el.querySelector('[data-note-retry]') as HTMLButtonElement | null;
  const pageEval = (window: object, code: string) => (window as unknown as { eval: (c: string) => unknown }).eval(code);
  const take = async (document: Document) => {
    await until(() => !!document.querySelector(`[data-take="${CARD}"]`));
    (document.querySelector(`[data-take="${CARD}"]`) as HTMLButtonElement).click();
    await until(() => !!errOn(document, CARD));
    return errOn(document, CARD)!;
  };

  it('says a refused Take it on the card, and Try again takes it', async () => {
    const { document, server } = await open('board.html', fakeServer({ ownerFailsOnce: true }));
    const err = await take(document);
    expect(alerted(document)).toBe('internal');
    expect(words(err)).toBe('internal');
    expect(retry(err)!.textContent).toBe('Try again');
    retry(err)!.click();
    await until(() => !!cardEl(document, CARD)?.querySelector('.card-owner.once-stamp'));
    expect(writes(server.calls).filter((c) => c.path === `/v1/cards/${CARD}/owner`)).toHaveLength(2);
    await until(() => !errOn(document, CARD));
  });

  it('keeps keyboard focus on what failed, and its alert is read once', async () => {
    const { window, document } = await open('board.html', fakeServer({ ownerFailsOnce: true }));
    await until(() => !!document.querySelector(`[data-take="${CARD}"]`));
    (document.querySelector(`[data-take="${CARD}"]`) as HTMLButtonElement).focus();
    const err = await take(document);
    expect(document.activeElement!.id).toBe(`take-${CARD}`);
    expect(alerted(document)).toBe('internal');
    // A redraw while the retry runs: Try again holds focus, and the error is not read again.
    retry(err)!.focus();
    pageEval(window, `NOTES.get('${CARD}').busy=true;redraw()`);
    expect(document.querySelector('#alert')!.textContent).toBe('internal');
    expect(retry(errOn(document, CARD)!)!.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement!.id).toBe(`retry-${CARD}`);
  });

  it('says on the card when Take it could not reach the board', async () => {
    const { window, document } = await open('board.html');
    // The page's own request fails, as when the connection drops.
    const w = window as unknown as { fetch: typeof fetch };
    const page = w.fetch;
    w.fetch = (input, init) => (String(input).endsWith('/assign') ? Promise.reject(new TypeError('Failed to fetch')) : page(input, init));
    const err = await take(document);
    expect(words(err)).toBe('Couldn’t reach the board.');
    expect(retry(err)).not.toBeNull();
  });

  it('lets an error go once the person moves to a view without its card', async () => {
    const { window, document } = await open('board.html', fakeServer({ ownerFailsOnce: true }));
    await take(document);
    pageEval(window, "navigate({q:'nothing matches this'})");
    await until(() => !cardEl(document, CARD));
    pageEval(window, 'navigate({q:null})');
    await until(() => !!cardEl(document, CARD));
    expect(errOn(document, CARD)).toBeNull();
  });

  it('says on the To-dos column head when an order was not saved, and Try again saves it', async () => {
    const { window, document, server } = await open('board.html', fakeServer({ orderFailsOnce: true }), `?source=${MEETING}`);
    await until(() => !!cardEl(document, CARD));
    void (window as unknown as { applyShared: (m: string, o: string[], v: number) => Promise<void> }).applyShared(MEETING, [CARD, CARD_OWNED], 2);
    const head = () => document.querySelector('section.desk-column[aria-labelledby="heading-do"] > .card-line.err') as HTMLElement | null;
    await until(() => !!head());
    expect(words(head()!)).toBe('Order not saved: internal');
    expect(alerted(document)).toBe('Order not saved: internal');
    expect(document.querySelector('#announcement')!.textContent).not.toBe('Order not saved.');
    retry(head()!)!.click();
    await until(() => writes(server.calls).filter((c) => c.path === '/v1/orders').length === 2);
    await until(() => !head());
  });

  it('keeps the order line when its Try again finds another save still in flight', async () => {
    const { window, document } = await open('board.html', fakeServer({ orderFailsOnce: true }), `?source=${MEETING}`);
    await until(() => !!cardEl(document, CARD));
    void (window as unknown as { applyShared: (m: string, o: string[], v: number) => Promise<void> }).applyShared(MEETING, [CARD, CARD_OWNED], 2);
    const head = () => document.querySelector('section.desk-column[aria-labelledby="heading-do"] > .card-line.err') as HTMLElement | null;
    await until(() => !!head());
    pageEval(window, 'dndBusy=true');
    retry(head()!)!.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(head()).not.toBeNull();
  });

  it('says a refused Undo merge on the card it was pressed on, and Try again undoes it', async () => {
    const { document, server } = await open('board.html', fakeServer({ merged: true, unmergeFailsOnce: true }));
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    (document.querySelector(`[data-open="${CARD}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector(`#reader [data-unmerge="${CARD_OWNED}"]`));
    (document.querySelector(`#reader [data-unmerge="${CARD_OWNED}"]`) as HTMLButtonElement).click();
    await until(() => !!errOn(document, CARD));
    expect(words(errOn(document, CARD)!)).toBe('internal');
    retry(errOn(document, CARD)!)!.click();
    await until(() => writes(server.calls).filter((c) => c.path.endsWith('/unmerge')).length === 2);
    await until(() => !errOn(document, CARD));
  });

  // The duplicate's own card is hidden from the list: its refusal is said beside the button pressed.
  it("says a refused Undo merge in the duplicate's reader, and pressing it again undoes it", async () => {
    const { window, document, server } = await open('board.html', fakeServer({ merged: true, unmergeFailsOnce: true }));
    await until(() => !!cardEl(document, CARD));
    pageEval(window, `navigate({card:'${CARD_OWNED}'})`);
    const b = () => document.querySelector(`#reader [data-unmerge="${CARD_OWNED}"][data-via="${CARD_OWNED}"]`) as HTMLButtonElement | null;
    await until(() => !!b());
    b()!.click();
    const err = () => document.querySelector('#reader .card-line.err') as HTMLElement | null;
    await until(() => !!err());
    expect(err()!.textContent).toBe('internal');
    expect(alerted(document)).toBe('internal');
    expect(b()!.disabled).toBe(false);
    b()!.click();
    await until(() => writes(server.calls).filter((c) => c.path.endsWith('/unmerge')).length === 2);
    await until(() => !err());
  });

  it('opens the card an Undo merge belongs to when that card is not loaded', async () => {
    const { window, document } = await open('board.html', fakeServer({ merged: true }));
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    (document.querySelector(`[data-open="${CARD}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector(`#reader [data-unmerge="${CARD_OWNED}"]`));
    const b = document.querySelector(`#reader [data-unmerge="${CARD_OWNED}"]`) as HTMLButtonElement;
    b.dataset.via = OLD_CARD + '-elsewhere';
    b.click();
    await until(() => new URL(window.location.href).searchParams.get('card') === OLD_CARD + '-elsewhere');
  });

  it('opens that card at its Undo merge, its line open, focused and washed once', async () => {
    const { window, document } = await open('board.html', fakeServer({ merged: true }));
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    // As the Undo merge above leaves it once the card is loaded.
    pageEval(window, `pendingUnmerge={id:'${CARD_OWNED}',via:'${CARD}'};navigate({card:'${CARD}'})`);
    const b = () => document.querySelector(`#reader [data-unmerge="${CARD_OWNED}"]`) as HTMLButtonElement | null;
    await until(() => !!b());
    // The opening's own focus and scroll (a frame later) leave it there.
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(b());
    expect(b()!.classList.contains('once-wash')).toBe(true);
    expect((b()!.closest('details') as HTMLDetailsElement).open).toBe(true);
    expect(document.querySelector('#announcement')!.textContent).toBe('Undo merge is ready.');
  });

  it('forgets an Undo merge asked for from a card that never loaded once another card is opened', async () => {
    const { window, document } = await open('board.html', fakeServer({ merged: true }));
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    pageEval(window, `pendingUnmerge={id:'${CARD_OWNED}',via:'${CARD}'};navigate({card:'${QUESTION_NOW}'})`);
    await until(() => new URL(window.location.href).searchParams.get('card') === QUESTION_NOW);
    await new Promise((r) => setTimeout(r, 50));
    pageEval(window, `navigate({card:'${CARD}'})`);
    const b = () => document.querySelector(`#reader [data-unmerge="${CARD_OWNED}"]`) as HTMLButtonElement | null;
    await until(() => !!b());
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).not.toBe(b());
    expect(b()!.classList.contains('once-wash')).toBe(false);
    expect(document.querySelector('#announcement')!.textContent).not.toBe('Undo merge is ready.');
  });

  it('says a refused leave beside the Live pill, and Try again asks again', async () => {
    const server = fakeServer({ botJoinedAt: '2026-10-21T17:02:00.000Z', recallFailsOnce: true });
    const { document } = await open('board.html', server, `?source=${MEETING}`);
    const pill = () => document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => !pill().hidden);
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const dlg = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
    await until(() => !!dlg.querySelector('[data-ask-leave]'));
    dlg.querySelector<HTMLButtonElement>('[data-ask-leave]')!.click();
    dlg.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
    await until(() => !!document.querySelector('[data-line="pill"]'));
    const err = document.querySelector<HTMLElement>('[data-line="pill"]')!;
    expect(alerted(document)).toBe('Could not ask bwat to leave.');
    expect(err.firstChild!.textContent).toBe('Could not ask bwat to leave.');
    expect(pill().textContent).toBe('Live');
    err.querySelector<HTMLButtonElement>('[data-note-retry]')!.click();
    await until(() => pill().textContent === 'Leaving…');
    expect(server.calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
    expect(document.querySelector('[data-line="pill"]')).toBeNull();
  });

  const refuseLeave = async (document: Document) => {
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const dlg = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
    await until(() => !!dlg.querySelector('[data-ask-leave]'));
    dlg.querySelector<HTMLButtonElement>('[data-ask-leave]')!.click();
    dlg.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
    await until(() => !!document.querySelector('[data-line="pill"]'));
    return document.querySelector<HTMLElement>('[data-line="pill"]')!;
  };

  it("keeps keyboard focus when a refused leave's Try again works: on Settings, where it was asked", async () => {
    const server = fakeServer({ botJoinedAt: '2026-10-21T17:02:00.000Z', recallFailsOnce: true });
    const { document } = await open('board.html', server, `?source=${MEETING}`);
    await until(() => !document.querySelector<HTMLElement>('#live-pill')!.hidden);
    const again = (await refuseLeave(document)).querySelector<HTMLButtonElement>('[data-note-retry]')!;
    again.focus();
    again.click();
    await until(() => !document.querySelector('[data-line="pill"]'));
    expect(document.activeElement!.id).toBe('settings-open');
  });

  it('takes a refused leave off the page when bwat leaves, even once its note is gone', async () => {
    const server = fakeServer({ botJoinedAt: '2026-10-21T17:02:00.000Z', recallFailsOnce: true });
    const { window, document } = await open('board.html', server, `?source=${MEETING}`);
    await until(() => !document.querySelector<HTMLElement>('#live-pill')!.hidden);
    await refuseLeave(document);
    // As the Zoom view's queued leave leaves it: the note cleared, the line still drawn.
    pageEval(window, `(()=>{const again=DELIGHT.notes.get('pill').retry;DELIGHT.notes.delete('pill');void again();})()`);
    await until(() => document.querySelector<HTMLElement>('#live-pill')!.textContent === 'Leaving…');
    expect(document.querySelector('[data-line="pill"]')).toBeNull();
  });

  it('lets a refused leave go when another meeting is shown', async () => {
    const server = fakeServer({ botJoinedAt: '2026-10-21T17:02:00.000Z', recallFailsOnce: true });
    const { window, document } = await open('board.html', server, `?source=${MEETING}`);
    await until(() => !document.querySelector<HTMLElement>('#live-pill')!.hidden);
    await refuseLeave(document);
    pageEval(window, `navigate({source:'${OLDER_MEETING}'})`);
    await until(() => !document.querySelector('[data-line="pill"]'));
  });
});

// A card you close leaves a slim row where it was, "Done · <title> · Undo", for 8 s (paused while
// the pointer or focus is on it), then the row folds away (mock-up T3). Undo there brings the card
// back in its old place, dropping in, never at the end of the list (T4).
describe('a closed card leaves a row (board.html)', () => {
  const col = 'section.desk-column[aria-labelledby="heading-do"] [data-card]';
  const row = (id: string) => `#card-list [data-card="${id}"]`, told = (t: string) => `Done for everyone: ${t}.`;
  const done = 'Done', undo = 'Undo', again = 'Try again', errSel = '.card-line.err', retrySel = '[data-note-retry]';
  const FIRST = 'cccccccc-0000-4000-8000-00000000000a', SECOND = 'cccccccc-0000-4000-8000-00000000000b';
  const el = (document: Document, id: string) => document.querySelector(row(id)) as HTMLElement | null;
  const slim = (document: Document, id: string) => (el(document, id)?.classList.contains('slim-row') ? el(document, id) : null);
  const order = (document: Document) => [...document.querySelectorAll<HTMLElement>(col)].map((x) => x.dataset.card);
  const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
  async function closeAsDone(document: Document, id: string) {
    await until(() => !!el(document, id));
    (document.querySelector(`[data-open="${id}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#do-done'));
    (document.querySelector('#do-done') as HTMLButtonElement).click();
    await until(() => !!slim(document, id));
    return slim(document, id)!;
  }

  it('leaves a row where the card was, and Undo there puts it back at the version the close wrote', async () => {
    const { document, server } = await open('board.html');
    const r = await closeAsDone(document, CARD);
    expect(r.querySelector('.slim-label')!.textContent).toBe(done);
    expect(r.querySelector('s')!.textContent).toBe('Ship the release on Friday');
    expect(said(document)).toBe(told('Ship the release on Friday'));
    expect(writes(server.calls).find((c) => c.path.endsWith('/archive'))!.body).toEqual({ revision: 3, outcome: 'done' });
    // No notice at the foot of the page: the row is the whole answer.
    expect(document.querySelector('#toast')).toBeNull();
    const u = r.querySelector('[data-slim-undo]') as HTMLButtonElement;
    expect(u.textContent).toBe(undo);
    u.click();
    await until(() => !!el(document, CARD) && !slim(document, CARD));
    expect(writes(server.calls).find((c) => c.path.endsWith('/unarchive'))!.body).toEqual({ revision: 4 });
    expect(el(document, CARD)!.classList.contains('is-new')).toBe(true);
    expect(document.querySelector('#announcement')!.textContent).toBe('Reopened: Ship the release on Friday.');
  });

  it('draws the board while an Undo that worked waits for its refresh', async () => {
    const { window, document, server } = await open('board.html');
    const r = await closeAsDone(document, CARD);
    const run = (window as unknown as { eval: (c: string) => unknown }).eval.bind(window);
    run(`window.__read=LIVE.fetchSnapshot;LIVE.fetchSnapshot=()=>new Promise(go=>{window.__go=()=>go(window.__read())})`);
    (r.querySelector('[data-slim-undo]') as HTMLButtonElement).click();
    await until(() => !!writes(server.calls).find((c) => c.path.endsWith('/unarchive')));
    await until(() => !!run('window.__go'));
    expect(() => run('redraw()')).not.toThrow();
    run('LIVE.fetchSnapshot=window.__read;window.__go()');
    await until(() => !!el(document, CARD) && !slim(document, CARD));
  });

  it('folds the row away after its time, held while the pointer is on it', async () => {
    const { window, document } = await open('board.html');
    await until(() => !!el(document, CARD));
    ms(window).slim = 150;
    const r = await closeAsDone(document, CARD);
    r.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
    // Past its time and its fold (0.4 s): still there.
    await sleep(900);
    expect(slim(document, CARD)).not.toBeNull();
    slim(document, CARD)!.dispatchEvent(new window.Event('pointerout', { bubbles: true }));
    await until(() => !el(document, CARD));
  });

  it('puts a reopened card back where it was, though the feed lists it again last', async () => {
    const server = fakeServer();
    server.arrive({ id: FIRST, display_id: 'T-11', kind: 'task', title: 'Book the venue' });
    server.arrive({ id: SECOND, display_id: 'T-12', kind: 'task', title: 'Send the invites' });
    const { window, document } = await open('board.html', server);
    await until(() => !!el(document, SECOND));
    const before = order(document);
    expect(before.indexOf(FIRST)).toBeLessThan(before.indexOf(SECOND));
    await closeAsDone(document, FIRST);
    await poll(window);
    expect(order(document)).toEqual(before);
    slim(document, FIRST)!.querySelector<HTMLButtonElement>('[data-slim-undo]')!.click();
    await until(() => !!el(document, FIRST) && !slim(document, FIRST));
    expect(order(document)).toEqual(before);
    await poll(window);
    expect(order(document)).toEqual(before);
  });

  // A list read just after a reopen may not list the card yet: it stays where it was until one does.
  it('keeps a reopened card in its place while the list has yet to show it again', async () => {
    const { window, document } = await open('board.html');
    await until(() => !!el(document, CARD));
    const before = order(document);
    expect(before).toContain(CARD);
    await closeAsDone(document, CARD);
    control.cardGone = true;
    try {
      slim(document, CARD)!.querySelector<HTMLButtonElement>('[data-slim-undo]')!.click();
      await until(() => !!el(document, CARD) && !slim(document, CARD));
      await poll(window);
      expect(order(document)).toEqual(before);
      control.cardGone = false;
      await poll(window);
      expect(order(document)).toEqual(before);
      // Listed again, it is held no longer: a list without it now treats it as any card gone
      // (it lingers a while, marked as someone else's change).
      control.cardGone = true;
      await poll(window);
      expect(el(document, CARD)!.classList.contains('lingering')).toBe(true);
    } finally {
      control.cardGone = false;
    }
  });

  it('keeps a reopened card through a change of its own made before the list shows it again', async () => {
    const { window, document } = await open('board.html');
    await until(() => !!el(document, CARD));
    const before = order(document);
    await closeAsDone(document, CARD);
    control.cardGone = true;
    try {
      slim(document, CARD)!.querySelector<HTMLButtonElement>('[data-slim-undo]')!.click();
      await until(() => !!el(document, CARD) && !slim(document, CARD));
      // A change made here (another row going, an owner held) redraws from the board's own list,
      // which already has the reopened card: that is not the server listing it.
      (window as unknown as { eval: (c: string) => unknown }).eval(`holdGone('${CARD_OWNED}-elsewhere')`);
      await poll(window);
      expect(order(document)).toEqual(before);
      expect(el(document, CARD)!.classList.contains('lingering')).toBe(false);
    } finally {
      control.cardGone = false;
    }
  });

  it('says a refused Undo on the row, and Try again reopens the card', async () => {
    const { document } = await open('board.html', fakeServer({ unarchiveFailsOnce: true }));
    const r = await closeAsDone(document, CARD);
    // The row comes in on its first paint only: redrawn with the refusal, it does not come in again.
    expect(r.classList.contains('once-in')).toBe(true);
    r.querySelector<HTMLButtonElement>('[data-slim-undo]')!.click();
    await until(() => !!slim(document, CARD)?.querySelector(errSel));
    expect(slim(document, CARD)!.classList.contains('once-in')).toBe(false);
    const err = slim(document, CARD)!.querySelector(errSel)!;
    expect(err.firstChild!.textContent).toBe('internal');
    expect(alerted(document)).toBe('internal');
    const retry = slim(document, CARD)!.querySelector<HTMLButtonElement>(retrySel)!;
    expect(retry.textContent).toBe(again);
    retry.click();
    await until(() => !!el(document, CARD) && !slim(document, CARD));
  });

  // An Undo in flight holds the row's clock: the pointer leaving does not fold it away mid-request.
  it('keeps the row while its Undo is in flight, and a refusal says itself there', async () => {
    let answer = () => {};
    const { window, document } = await open('board.html', fakeServer({ unarchiveFailsOnce: true, unarchiveGate: new Promise<void>((r) => { answer = r; }) }));
    await until(() => !!el(document, CARD));
    ms(window).slim = 150;
    const r = await closeAsDone(document, CARD);
    r.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
    r.querySelector<HTMLButtonElement>('[data-slim-undo]')!.click();
    slim(document, CARD)!.dispatchEvent(new window.Event('pointerout', { bubbles: true }));
    await sleep(700);
    expect(slim(document, CARD)).not.toBeNull();
    answer();
    await until(() => !!slim(document, CARD)?.querySelector(errSel));
    expect(slim(document, CARD)!.querySelector(errSel)!.firstChild!.textContent).toBe('internal');
  });

  // By keyboard, an Undo can come as the row folds: the row stays while it asks.
  it('keeps the row when its Undo is pressed as it folds away', async () => {
    let answer = () => {};
    const { window, document } = await open('board.html', fakeServer({ unarchiveGate: new Promise<void>((r) => { answer = r; }) }));
    await until(() => !!el(document, CARD));
    ms(window).slim = 150;
    await closeAsDone(document, CARD);
    await until(() => !!slim(document, CARD)?.classList.contains('folding'));
    slim(document, CARD)!.querySelector<HTMLButtonElement>('[data-slim-undo]')!.click();
    await sleep(700);
    expect(slim(document, CARD)).not.toBeNull();
    answer();
    await until(() => !!el(document, CARD) && !slim(document, CARD));
  });

  // Unfolded: jsdom has no layout, so drawn open is no fold class and no collapsed height.
  const open_ = (r: HTMLElement | null) => !!r && !r.classList.contains('folding') && r.style.maxHeight !== '0px';

  // An Undo pressed as the row folds and refused before the fold ends: the row comes back, open, with why.
  it('keeps the row open, with its error, when an Undo pressed as it folds is refused at once', async () => {
    const { window, document } = await open('board.html', fakeServer({ unarchiveFailsOnce: true }));
    await until(() => !!el(document, CARD));
    ms(window).slim = 150;
    await closeAsDone(document, CARD);
    await until(() => !!slim(document, CARD)?.classList.contains('folding'));
    slim(document, CARD)!.querySelector<HTMLButtonElement>('[data-slim-undo]')!.click();
    await sleep(900);
    expect(open_(slim(document, CARD))).toBe(true);
    expect(slim(document, CARD)!.querySelector(errSel)!.firstChild!.textContent).toBe('internal');
    expect(slim(document, CARD)!.querySelector(retrySel)!.textContent).toBe(again);
  });

  // The focus or the pointer coming to the row as it folds holds it, open again; let go, it folds after its time.
  it.each(['focus', 'pointer'])('keeps the row open when the %s comes to it as it folds', async (how) => {
    const { window, document } = await open('board.html');
    await until(() => !!el(document, CARD));
    ms(window).slim = 150;
    await closeAsDone(document, CARD);
    await until(() => !!slim(document, CARD)?.classList.contains('folding'));
    const u = slim(document, CARD)!.querySelector<HTMLButtonElement>('[data-slim-undo]')!;
    if (how === 'focus') u.focus(); else u.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
    await sleep(900);
    expect(open_(slim(document, CARD))).toBe(true);
    if (how === 'focus') u.blur(); else slim(document, CARD)!.dispatchEvent(new window.Event('pointerout', { bubbles: true }));
    await until(() => !el(document, CARD));
  });

  it('shows the reopened card once a slow Undo lands, the pointer gone meanwhile', async () => {
    let answer = () => {};
    const { window, document } = await open('board.html', fakeServer({ unarchiveGate: new Promise<void>((r) => { answer = r; }) }));
    await until(() => !!el(document, CARD));
    ms(window).slim = 150;
    const r = await closeAsDone(document, CARD);
    r.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
    r.querySelector<HTMLButtonElement>('[data-slim-undo]')!.click();
    slim(document, CARD)!.dispatchEvent(new window.Event('pointerout', { bubbles: true }));
    await sleep(700);
    answer();
    await until(() => !!el(document, CARD) && !slim(document, CARD));
    await poll(window);
    expect(el(document, CARD)).not.toBeNull();
  });

  it('keeps keyboard focus on the row when its Undo is refused', async () => {
    const { document } = await open('board.html', fakeServer({ unarchiveFailsOnce: true }));
    const r = await closeAsDone(document, CARD);
    const u = r.querySelector<HTMLButtonElement>('[data-slim-undo]')!;
    u.focus();
    u.click();
    await until(() => !!slim(document, CARD)?.querySelector(errSel));
    expect(document.activeElement).toBe(slim(document, CARD)!.querySelector(retrySel));
    expect(document.activeElement!.textContent).toBe(again);
  });

  // The desk's rule for an error that is not fixed: moving on lets it go, and the card stays closed.
  it('lets a refused Undo go once the person moves to a view without its row', async () => {
    const { window, document } = await open('board.html', fakeServer({ unarchiveFailsOnce: true }));
    const r = await closeAsDone(document, CARD);
    r.querySelector<HTMLButtonElement>('[data-slim-undo]')!.click();
    await until(() => !!slim(document, CARD)?.querySelector(errSel));
    const go = (code: string) => (window as unknown as { eval: (c: string) => void }).eval(code);
    go("navigate({q:'nothing matches this'})");
    await until(() => !slim(document, CARD));
    go('navigate({q:null})');
    await until(() => !!el(document, CARD_OWNED));
    expect(slim(document, CARD)).toBeNull();
    expect(el(document, CARD)).toBeNull();
  });
});

describe("a card's draft and expiry marks on its face (board.html)", () => {
  const card = (id: string) => `[data-card="${id}"]`;
  const text = (document: Document, id: string) => (document.querySelector(card(id))?.textContent ?? '').replace(/\s+/g, ' ');
  const shown = async (server: ReturnType<typeof fakeServer>) => {
    const { document } = await open('board.html', server);
    await until(() => !!document.querySelector(card(CARD_OWNED)));
    return document;
  };

  it('marks a draft "Draft" and a live card not', async () => {
    const document = await shown(fakeServer({ lifecycle: { status: 'draft' }, ownedLifecycle: { status: 'open' } }));
    expect(text(document, CARD)).toContain('Draft');
    expect(text(document, CARD_OWNED)).not.toContain('Draft');
  });

  // Acceptance still drives the card's lifecycle, but a person can do nothing with
  // "not yet accepted", so the board does not say it: not on the card, not in the opened card.
  it('never says a to-do is not yet accepted', async () => {
    const document = await shown(fakeServer({ ownedLifecycle: { status: 'open', accepted: false, owner_by: 'agent' } }));
    (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#reader .detail-meta'));
    expect(document.body.textContent).not.toMatch(/not yet accepted/i);
  });

  // One line with its answer (lifecycle.js).
  it('says how many days a live card nobody acts on has left', async () => {
    const [four, one, none] = ['Closes in 4 days · Keep', 'Closes today · Keep', 'Closes'];
    const document = await shown(fakeServer({ lifecycle: { expires_in_days: null }, ownedLifecycle: { expires_in_days: 4 } }));
    expect(text(document, CARD_OWNED)).toContain(four);
    expect(text(document, CARD)).not.toContain(none);
    close?.();
    const last = await shown(fakeServer({ ownedLifecycle: { expires_in_days: 1 } }));
    expect(text(last, CARD_OWNED)).toContain(one);
  });

  it('keeps an expiring card with one POST /keep at the revision it shows', async () => {
    const server = fakeServer({ lifecycle: { expires_in_days: null }, ownedLifecycle: { expires_in_days: 4 } });
    const document = await shown(server);
    expect(document.querySelector(`${card(CARD)} [data-keep]`)).toBeNull();
    const keep = document.querySelector(`${card(CARD_OWNED)} [data-keep]`) as HTMLButtonElement;
    expect(keep.textContent).toBe('Keep');
    keep.click();
    await until(() => writes(server.calls).length > 0);
    expect(writes(server.calls)).toEqual([{ method: 'POST', path: `/v1/cards/${CARD_OWNED}/keep`, authorization: `Bearer ${TOKEN}`, body: { revision: 7 } }]);
  });

  it('takes the Keep off a card once it is kept, an open one too', async () => {
    const document = await shown(fakeServer({ ownedLifecycle: { expires_in_days: 4 } }));
    (document.querySelector(`${card(CARD_OWNED)} [data-keep]`) as HTMLButtonElement).click();
    await until(() => !document.querySelector(`${card(CARD_OWNED)} [data-keep]`));
    expect(text(document, CARD_OWNED)).not.toContain('Closes');
  });

  it('says a refused Keep on its card and gives the Keep back', async () => {
    const document = await shown(fakeServer({ ownedLifecycle: { expires_in_days: 4 }, keep: [500, { error: 'internal' }] }));
    (document.querySelector(`${card(CARD_OWNED)} [data-keep]`) as HTMLButtonElement).click();
    const err = '.card-line.err';
    await until(() => !!document.querySelector(`${card(CARD_OWNED)} ${err}`));
    const shownErr = document.querySelector(`${card(CARD_OWNED)} ${err}`)!;
    expect(alerted(document)).toBe(shownErr.firstChild!.textContent);
    expect(shownErr.firstChild!.textContent).toBe('internal');
    // Try again keeps it again.
    expect(shownErr.querySelector('[data-note-retry]')!.textContent).toBe('Try again');
    expect(document.querySelector(`${card(CARD_OWNED)} .card-line.ok`)).toBeNull();
    await until(() => !(document.querySelector(`${card(CARD_OWNED)} [data-keep]`) as HTMLButtonElement).disabled);
  });

  // A to-do's auto-apply shows only inside the opened card.
  it("keeps a to-do's auto-apply off the card face", async () => {
    const document = await shown(fakeServer({ lifecycle: { auto_apply_confidence: 35, suggested_action: 'investigate' }, ownedLifecycle: { auto_apply_confidence: null, suggested_action: null } }));
    expect(text(document, CARD)).not.toContain('Auto-apply');
    expect(text(document, CARD_OWNED)).not.toContain('Auto-apply');
  });

  it('shows a card closed with no response as closed and "No response", never "Done"', async () => {
    const document = await shown(fakeServer({ ownedLifecycle: { status: 'no_response', done: false } }));
    expect(text(document, CARD_OWNED)).toContain('No response');
    expect(text(document, CARD_OWNED)).not.toContain('Done');
    expect(document.querySelector(card(CARD_OWNED))!.classList.contains('done')).toBe(true);
  });

  it('shows a draft bwat closed as closed and "Closed by bwat", never "Done"', async () => {
    const document = await shown(fakeServer({ ownedLifecycle: { status: 'wont_do', withdrawn: true, done: false } }));
    expect(text(document, CARD_OWNED)).toContain('Closed by bwat');
    expect(text(document, CARD_OWNED)).not.toContain('Done');
    expect(document.querySelector(card(CARD_OWNED))!.classList.contains('done')).toBe(true);
  });
});

describe('a card closed with no response', () => {
  it('is closed but never Done in what the pages read', async () => {
    const { window } = await open('board.html', fakeServer({ ownedLifecycle: { status: 'no_response', done: false } }));
    const feed = await (await window.fetch('board_feed.json')).json() as { weeks: { key: string }[] };
    const items = (await Promise.all(feed.weeks.map(async (w) => (await (await window.fetch(`board_week_${w.key}.json`)).json()).items as Record<string, unknown>[]))).flat();
    expect(items.find((c) => c.id === CARD_OWNED)).toMatchObject({ done: false, closed: true, noResponse: true });
  });

  it('gives reasons that say closed, never done, for what it cannot do', async () => {
    const { document } = await open('board.html', fakeServer({ lifecycle: { status: 'no_response', done: false } }));
    const reasons: string[] = [];
    for (const id of [CARD_OWNED, QUESTION_NOW]) {
      await until(() => !!document.querySelector(`[data-open="${id}"]`));
      (document.querySelector(`[data-open="${id}"]`) as HTMLElement).click();
      await until(() => !!document.querySelector('#reader .action-row'));
      reasons.push(...[...document.querySelectorAll('[aria-description]')].map((b) => b.getAttribute('aria-description')!));
    }
    expect(reasons.some((r) => r.includes('closed'))).toBe(true);
    expect(reasons.filter((r) => /done/i.test(r))).toEqual([]);
  });

  it("shows a to-do's auto-apply in the desk's card reader, and none for a card without it", async () => {
    const { document } = await open('board.html', fakeServer({ lifecycle: { auto_apply_confidence: 35, suggested_action: 'investigate' }, ownedLifecycle: { auto_apply_confidence: null, suggested_action: null } }));
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    (document.querySelector(`[data-open="${CARD}"]`) as HTMLElement).click();
    await until(() => document.querySelector('#reader .detail-meta')?.textContent?.includes('Auto-apply 35% · investigate') ?? false);
    (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
    await until(() => document.querySelector('#detail-title')?.textContent === document.querySelector(`[data-card="${CARD_OWNED}"] h3`)?.textContent);
    expect(document.querySelector('#reader .detail-meta')!.textContent).not.toContain('Auto-apply');
  });

  it("says No response in the desk's card reader", async () => {
    const { document } = await open('board.html', fakeServer({ ownedLifecycle: { status: 'no_response', done: false } }));
    await until(() => !!document.querySelector(`[data-open="${CARD_OWNED}"]`));
    (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
    await until(() => document.querySelector('#reader .detail-meta')?.textContent?.includes('No response') ?? false);
  });
});

describe('the drag order', () => {
  it('reads the order of each meeting and the viewer\'s own, keyed as the pages key them', async () => {
    const { window } = await open('board.html');
    expect(await (await window.fetch('/order?t=1')).json()).toEqual({ orders: {
      [MEETING]: { order: [CARD_OWNED, CARD], version: 2 },
      'mine:Ada': { order: [CARD_OWNED], version: 1 },
    } });
  });

  it('saves the order of a meeting against the version drawn', async () => {
    const { window, server } = await open('board.html');
    const save = await window.fetch('/order', { method: 'POST', body: JSON.stringify({ meeting: MEETING, order: [CARD, CARD_OWNED], version: 2, who: 'Ada' }) });
    expect(await save.json()).toEqual({ ok: true, meeting: MEETING, order: [CARD, CARD_OWNED], version: 3 });
    expect(writes(server.calls).at(-1)).toMatchObject({ method: 'PUT', path: '/v1/orders', body: { meeting_id: MEETING, order: [CARD, CARD_OWNED], version: 2 } });
  });
});

describe('meeting desk (board.html)', () => {
  it('a note that only names data-clarify= is not an answer', async () => {
    // A person's note is escaped by the card service; only its own <p data-clarify="…"> answers.
    const server = fakeServer(), fetch = server.fetch;
    server.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).includes(`/v1/occurrences/${MEETING}/cards`)) return response;
      const cards = await response.json() as { id: string; detail_html: string }[];
      return new Response(JSON.stringify(cards.map((card) => card.id === QUESTION_NOW
        ? { ...card, detail_html: '<p><b>Note</b> from Bob: data-clarify=&quot;r&quot; is the field</p>' } : card)), { status: response.status });
    };
    const { document } = await open('board.html', server);
    await until(() => !!cardEl(document, QUESTION_NOW));
    expect(cardEl(document, QUESTION_NOW)!.querySelector('.badge.ask')).toBeNull();
  });

  it("shows a card's hand-off as Read once its session marked it read, and Queued until then, from the card itself", async () => {
    const at = '2026-10-21T10:00:00+00:00', readAt = '2026-10-21T10:05:00+00:00';
    const { document } = await open('board.html', fakeServer({
      lifecycle: { routed: [{ handoff_id: 'h-1', by_member_id: ADA, at, read_at: null }] },
      ownedLifecycle: { routed: [{ handoff_id: 'h-1', by_member_id: ADA, at, read_at: null }, { handoff_id: 'h-2', by_member_id: ADA, at, read_at: readAt }] },
    }));
    await until(() => !!cardEl(document, CARD_OWNED)?.querySelector('.badge.queued'));
    expect(cardEl(document, CARD_OWNED)!.querySelector('.badge.queued')!.textContent).toBe('Read');
    expect(cardEl(document, CARD)!.querySelector('.badge.queued')!.textContent).toBe('Queued');
  });

  it('renders the meeting card, without the closed one', async () => {
    const { document } = await open('board.html');
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    expect(document.body.textContent).not.toContain('Closed earlier');
    expect(document.body.textContent).not.toMatch(/To-dos unavailable/);
  });

  it('shows card labels, the signed-in name, and only bwat words', async () => {
    const { document } = await open('board.html');
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    expect(visibleText(document)).not.toContain(CARD);
    expect(document.querySelector(`[data-open="${CARD}"]`)!.getAttribute('aria-label')).toContain('T-1');
    expect(document.querySelector(`[data-take="${CARD}"]`)!.getAttribute('aria-label')).toContain('T-1');
    expect(document.querySelector('#viewer-caption')!.textContent).toBe('Signed in as');
    expect(visibleText(document)).not.toMatch(/through Zoom/i);
  });

  it('finds a card by the label it shows', async () => {
    const loaded = await loadPage('board.html', fakeServer(), '?q=T-2');
    close = () => loaded.window.close();
    const { document } = loaded;
    await until(() => !!document.querySelector(`[data-open="${CARD_OWNED}"]`));
    expect(document.querySelector(`[data-open="${CARD}"]`)).toBeNull();
  });

  it("has no notice at the foot of the page; a plugin's message shows in the header line, then goes", async () => {
    const { window, document } = await open('board.html');
    await until(() => !!document.querySelector(`[data-card="${CARD}"]`));
    expect(document.querySelector('#toast')).toBeNull();
    const w = window as unknown as { DELIGHT: { ms: Record<string, number> }; whisper: (text: string) => void };
    w.DELIGHT.ms.whisper = 50;
    w.whisper('Filed as ABC-1.');
    const line = document.querySelector('#whisper')!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toBe('Filed as ABC-1.');
    expect(line.getAttribute('title')).toBe('Filed as ABC-1.');
    expect(line.closest('.on')).not.toBeNull();
    await until(() => !line.closest('.on'));
    await until(() => line.textContent === '');
  });

  it("shows a plugin's message near the top of the window when the header has scrolled out of view", async () => {
    const { window, document } = await open('board.html');
    await until(() => !!document.querySelector(`[data-card="${CARD}"]`));
    const w = window as unknown as { whisper: (text: string) => void };
    const line = document.querySelector('#whisper') as HTMLElement;
    let bottom = -40;
    (line.parentElement as HTMLElement).getBoundingClientRect = () => ({ bottom }) as DOMRect;
    w.whisper('Filed as ABC-1.');
    expect(line.classList.contains('pinned')).toBe(true);
    // Scrolled back up: under its header again.
    bottom = 60;
    window.dispatchEvent(new window.Event('scroll'));
    expect(line.classList.contains('pinned')).toBe(false);
    w.whisper('Filed as ABC-2.');
    expect(line.classList.contains('pinned')).toBe(false);
  });

  it("holds a plugin's message for the time to read it, and while the pointer is on it", async () => {
    const { window, document } = await open('board.html');
    await until(() => !!document.querySelector(`[data-card="${CARD}"]`));
    const w = window as unknown as { DELIGHT: { ms: Record<string, number> }; whisper: (text: string) => void };
    Object.assign(w.DELIGHT.ms, { whisper: 50, word: 40, whisperMax: 2000 });
    const line = document.querySelector('#whisper')!;
    const shownFor = async (text: string) => {
      const t = Date.now();
      w.whisper(text);
      await until(() => !line.closest('.on'));
      return Date.now() - t;
    };
    const short = await shownFor('Filed as ABC-1.');
    const long = await shownFor('No answer from the tracker yet. If it took the card, the card links its issue shortly.');
    expect(long - short).toBeGreaterThan(300);
    // The longest wait has a cap.
    w.DELIGHT.ms.whisperMax = 100;
    expect(await shownFor('No answer from the tracker yet. If it took the card, the card links its issue shortly.')).toBeLessThan(400);
    w.DELIGHT.ms.word = 0;
    w.whisper('Filed as ABC-1.');
    line.dispatchEvent(new window.Event('pointerenter'));
    await new Promise((r) => setTimeout(r, 200));
    expect(line.closest('.on')).not.toBeNull();
    line.dispatchEvent(new window.Event('pointerleave'));
    await until(() => !line.closest('.on'));
  });

  // Narrow, a plugin's message stands in for a line of the page's own (delight.css 14): the desk's
  // meeting line, in Zoom the meeting's name. That line keeps its own
  // words, under the message while it shows; it holds the message while the pointer is on it.
  it.each([
    ['board.html', '', '#page-title'],
    ['board.html', '?surface=zoom', '#brand-meeting'],
  ])('%s%s shows a plugin message in place of %s', async (page, query, slot) => {
    const { window, document } = await open(page, fakeServer({ occurrence: query ? 'zoom-occurrence==' : null }), query);
    await until(() => !!document.querySelector(slot)?.textContent);
    const w = window as unknown as { DELIGHT: { ms: Record<string, number> }; whisper: (text: string) => void };
    Object.assign(w.DELIGHT.ms, { whisper: 50, word: 0 });
    const line = document.querySelector(slot) as HTMLElement, own = line.textContent;
    // Drawn, in view (jsdom draws nothing).
    line.getBoundingClientRect = () => ({ top: 40, bottom: 58, left: 16, right: 200, width: 184, height: 18 }) as DOMRect;
    w.whisper('Filed as ABC-1.');
    expect(line.dataset.whisper).toBe('Filed as ABC-1.');
    expect(line.title).toBe('Filed as ABC-1.');
    expect(line.classList.contains('whisper-on')).toBe(true);
    expect(document.querySelector('#whisper')!.parentElement!.classList.contains('slotted')).toBe(true);
    expect(line.textContent).toBe(own);
    line.dispatchEvent(new window.Event('pointerenter'));
    await new Promise((r) => setTimeout(r, 200));
    expect(line.classList.contains('whisper-on')).toBe(true);
    line.dispatchEvent(new window.Event('pointerleave'));
    await until(() => !line.classList.contains('whisper-on'));
    await until(() => line.dataset.whisper === undefined);
    expect(line.hasAttribute('title')).toBe(false);
    expect(document.querySelector('#whisper')!.parentElement!.classList.contains('slotted')).toBe(false);
    // Scrolled out of view, that line is no place for it: the header line says it.
    line.getBoundingClientRect = () => ({ top: -60, bottom: -42, left: 16, right: 200, width: 184, height: 18 }) as DOMRect;
    w.whisper('Filed as ABC-2.');
    expect(line.dataset.whisper).toBeUndefined();
    expect(document.querySelector('#whisper')!.parentElement!.classList.contains('slotted')).toBe(false);
  });

  it('a read that answers but cannot be used is not offline: the feed says so', async () => {
    const { window, document } = await open('board.html');
    await until(() => !!cardEl(document, CARD));
    const page = (window as unknown as { eval: (c: string) => unknown }).eval.bind(window);
    page(`window.__read=LIVE.fetchSnapshot;LIVE.fetchSnapshot=()=>Promise.reject(new SyntaxError('Unexpected token <'))`);
    try {
      await poll(window);
      expect(document.body.classList.contains('offline')).toBe(false);
      expect((document.querySelector('#feed-alert') as HTMLElement).hidden).toBe(false);
    } finally {
      page('LIVE.fetchSnapshot=window.__read');
    }
  });

  it('a poll the backend answers with an error is not offline: it was reached, and the feed says so', async () => {
    const { window, document } = await open('board.html');
    await until(() => !!cardEl(document, CARD));
    control.feedDown = 500;
    try {
      await poll(window);
      expect(document.body.classList.contains('offline')).toBe(false);
      expect(document.querySelector('#live-pill')!.textContent).not.toBe('Reconnecting…');
      expect((document.querySelector('#feed-alert') as HTMLElement).hidden).toBe(false);
    } finally {
      control.feedDown = false;
    }
  });

  it('a poll that cannot reach the board is offline too, and a message meanwhile waits for it to be back', async () => {
    const { window, document } = await open('board.html');
    await until(() => !!cardEl(document, CARD));
    const w = window as unknown as { whisper: (text: string) => void };
    const line = document.querySelector('#whisper')!;
    control.feedDown = true;
    try {
      await poll(window);
      expect(document.body.classList.contains('offline')).toBe(true);
      w.whisper('Filed as ABC-1.');
      expect(line.textContent).toBe('');
      // The pill says it even with no live meeting on screen, and the feed's band does not say it twice.
      expect((document.querySelector('#live-pill') as HTMLElement).hidden).toBe(false);
      expect(document.querySelector('#live-pill')!.textContent).toBe('Reconnecting…');
      expect((document.querySelector('#feed-alert') as HTMLElement).hidden).toBe(true);
    } finally {
      control.feedDown = false;
    }
    await poll(window);
    expect(document.body.classList.contains('offline')).toBe(false);
    expect(line.textContent).toBe('Filed as ABC-1.');
    expect(document.querySelector('#live-pill')!.textContent).toBe('Live');
  });

  it('a poll whose drawing throws is not offline: the board was reached', async () => {
    const { window, document } = await open('board.html');
    await until(() => !!cardEl(document, CARD));
    const run = (code: string) => (window as unknown as { eval(c: string): unknown }).eval(code);
    run("HOOKS.afterPoll.push({name:'boom',order:99,fn(){throw new Error('boom');}})");
    try {
      await poll(window);
    } finally {
      run('HOOKS.afterPoll.pop()');
    }
    expect(document.body.classList.contains('offline')).toBe(false);
    expect(document.querySelector('.brand .brand-lens')!.classList.contains('offline')).toBe(false);
    expect(document.querySelector('#whisper')!.textContent).not.toBe('Reconnecting…');
  });

  // A1 + A4 (settings redesign mock-up): only this viewer's board, each row a switch or a two-way
  // choice. No settings about the board's own chatter: the writer's word always shows, and a new
  // card always gets its wash.
  it('opens the Settings drawer on your own board only: Your board and Show', async () => {
    const { document } = await open('board.html');
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const drawer = document.querySelector('#settings-dialog')!;
    expect(drawer.hasAttribute('open')).toBe(true);
    expect([...drawer.querySelectorAll('.settings-group')].map((g) => g.textContent)).toEqual(['Send bwat to a meeting', 'Your board', 'Show']);
    const text = drawer.textContent!.replace(/\s+/g, ' ');
    expect(text).toMatch(/Appearance.*Opens on.*Answered questions.*Replaced cards/);
    // QOR-5039: the stored value stays `live`; only what it says changed.
    expect(text).toContain('Current or last meetingThe meeting bwat is capturing now, or else the most recent one');
    expect((drawer.querySelector('#setting-open-live') as HTMLInputElement).value).toBe('live');
    expect(text).not.toMatch(/Moments|Card highlight|Writer status|When the board opens|Bottom/i);
    const switches = [...drawer.querySelectorAll('input[role=switch]')].map((s) => s.getAttribute('aria-label'));
    expect(switches).toEqual(['Answered questions', 'Replaced cards']);
    expect((drawer.querySelector('#setting-open-all') as HTMLInputElement).nextElementSibling!.textContent).toBe('All');
    // A2: this meeting is the Live pill's, not the drawer's.
    expect(drawer.querySelector('#settings-meeting-bot')).toBeNull();
  });

  it('shows the writer’s word and washes a new card, whatever an older build stored to turn them off', async () => {
    const loaded = await loadPage('board.html', fakeServer(), '', { storage: { 'bwat.study.v1.settings.activity': '"hidden"', 'bwat.study.v1.settings.pulse': '"off"' } });
    close = () => loaded.window.close();
    const { document, window } = loaded;
    const strip = () => document.querySelector<HTMLElement>('.extraction-activity');
    await until(() => strip()?.textContent === 'Saved');
    expect(strip()!.hidden).toBe(false);
    expect(document.documentElement.dataset.pulse).toBeUndefined();
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    (document.querySelector('#setting-superseded') as HTMLInputElement).click();
    expect(window.localStorage.getItem('bwat.study.v1.settings.superseded')).toBe('"show"');
  });

  it('has no Opens on inside Zoom, where the panel opens on its meeting', async () => {
    const { document } = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !!document.querySelector('#tab-ask'));
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const drawer = document.querySelector('#settings-dialog')!;
    expect(drawer.textContent).toContain('Appearance');
    expect(drawer.textContent).not.toMatch(/Opens on|Live meeting/);
    expect(drawer.querySelector('[name=open]')).toBeNull();
  });

  // The commands that connect Claude Code live on the admin panel only; Send to Claude links there.
  it('has no Claude Code commands', async () => {
    const { document } = await open('board.html');
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    expect(document.querySelector('#settings-dialog')!.textContent).not.toContain('claude plugin');
  });

  // A3: People leaves the drawer (inviting lives on the admin People page), and the Company
  // settings link shows to owners and admins only.
  it.each(['owner', 'admin'])('shows an %s the Company settings link, and no People', async (role) => {
    const whoami = [200, { member: { id: ADA, email: 'ada@example.com', display_name: 'Ada', role }, id_token: TOKEN, occurrence_id: null }] as [number, unknown];
    const { document } = await open('board.html', fakeServer({ whoami }));
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const link = document.querySelector('#settings-dialog a.settings-company')!;
    expect(link.getAttribute('href')).toBe('/admin/');
    expect([link.querySelector('.settings-label')!.firstChild!.textContent, link.querySelector('small')!.textContent]).toEqual(['Company settings', 'Meeting bot, cards, data and connections']);
    expect(document.querySelector('#settings-dialog')!.textContent).not.toMatch(/People|Invite|admin panel/);
    expect(document.querySelector('#invite-email')).toBeNull();
  });

  // Zoom's own browser does not follow a new-tab link, so inside Zoom the Company settings click
  // goes through Zoom's openUrl, with an absolute URL; on the web board it stays a plain link.
  it.each([
    ['inside Zoom', '?surface=zoom', ['http://bwat.test/admin/']],
    ['on the web board', '', []],
  ])('opens Company settings %s', async (_where, query, expected) => {
    const whoami = [200, { member: { id: ADA, email: 'ada@example.com', display_name: 'Ada', role: 'admin' }, id_token: TOKEN, occurrence_id: null }] as [number, unknown];
    const { window, document } = await open('board.html', fakeServer({ whoami }), query);
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    const opened: string[] = [];
    (window as unknown as { zoomSdk: object }).zoomSdk = { config: async () => ({}), openUrl: async ({ url }: { url: string }) => { opened.push(url); } };
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const link = document.querySelector('#settings-dialog a.settings-company') as HTMLAnchorElement;
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    if (expected.length) await until(() => opened.length > 0);
    expect(opened).toEqual(expected);
    expect(click.defaultPrevented).toBe(expected.length > 0);
  });

  // B7: a full-height panel sliding in from the right in 0.28 s, over no dimmed backdrop; in
  // place under Reduce Motion. Still a modal <dialog>, so focus and Escape are the browser's.
  it('opens Settings as a panel that slides in from the right, and in place under Reduce Motion', async () => {
    const { document, window } = await open('board.html', fakeServer());
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const dlg = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
    expect(dlg.tagName).toBe('DIALOG');
    expect(dlg.hasAttribute('open')).toBe(true);
    // In on the next frame, so the slide plays from off-screen.
    expect(dlg.classList.contains('in')).toBe(false);
    await until(() => dlg.classList.contains('in'));
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'settings.css'), 'utf8');
    expect(css).toContain('transform:translateX(100%);transition:transform .28s cubic-bezier(.2,.8,.2,1)');
    expect(css).toContain('.settings-dialog.in{transform:none}');
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^}]*\.settings-dialog\{transition:none\}/);
    const soft = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    expect(soft).toContain(':root[data-theme] .settings-dialog::backdrop{background:transparent}');
    // jsdom's close() fires no close event; a browser's does.
    dlg.close();
    dlg.dispatchEvent(new window.Event('close'));
    expect(dlg.classList.contains('in')).toBe(false);
  });

  // QOR-4957: 100vw counts a classic scrollbar (Zoom's Windows client has one), so a drawer
  // pinned to the right at 100vw ran off the left edge. 100% is the visible width.
  it('sizes the Settings drawer to the visible width, not 100vw', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'settings.css'), 'utf8');
    const rules = css.match(/[^{}]*\.settings-dialog\{[^}]*\}/g)!.join('\n');
    expect(rules).not.toContain('100vw');
    expect(css).toContain('.settings-dialog{position:fixed;inset:0 0 0 auto;margin:0;width:min(440px,100%);max-width:none;');
    expect(css).toContain('body.surface-zoom .settings-dialog{width:100%}');
  });

  // B3/B4: asking bwat to leave lives in Settings, not on the Live pill: a "This meeting" group
  // last in the drawer, for an owner or an admin, while bwat is in the meeting on screen.
  const JOINED = '2026-10-21T17:02:00.000Z';
  it('lets an owner on the full board ask bwat to leave the live meeting from Settings', async () => {
    const server = fakeServer({ botJoinedAt: JOINED });
    const { document, window } = await open('board.html', server, `?source=${MEETING}`);
    const pill = () => document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => !pill().hidden);
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const dlg = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
    await until(() => !!dlg.querySelector('[data-ask-leave]'));
    // Last, after the board's own groups.
    expect([...dlg.querySelectorAll('.settings-group')].at(-1)!.textContent).toBe('This meeting');
    const at = new window.Date(JOINED).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(dlg.querySelector('.settings-meeting-line')!.textContent).toBe(`bwat is listeningSince ${at}`);
    expect(dlg.querySelector('[data-ask-leave]')!.textContent).toBe('Remove bwat');
    const confirmation = dlg.querySelector<HTMLElement>('[data-leave-confirmation]')!;
    expect(confirmation.hidden).toBe(true);
    dlg.querySelector<HTMLButtonElement>('[data-ask-leave]')!.click();
    expect(confirmation.hidden).toBe(false);
    expect(confirmation.textContent).toContain('Transcription stops. Cards stay.');
    expect(document.activeElement).toBe(dlg.querySelector('[data-confirm-leave]'));
    expect(dlg.querySelector('[data-confirm-leave]')!.textContent).toBe('Remove bwat');
    dlg.querySelector<HTMLButtonElement>('[data-cancel-leave]')!.click();
    expect(confirmation.hidden).toBe(true);
    expect(dlg.hasAttribute('open')).toBe(true);
    expect(server.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    dlg.querySelector<HTMLButtonElement>('[data-ask-leave]')!.click();
    dlg.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
    expect(dlg.hasAttribute('open')).toBe(false);
    await until(() => pill().textContent === 'Leaving…');
    expect(server.calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: `/v1/allocations/${BOT_CLAIM}`, authorization: `Bearer ${TOKEN}`, body: { recall: true } });
    // The recall ended the claim: the next poll finds the meeting no longer live, and bwat Left.
    await poll(window);
    await until(() => pill().textContent === 'Left');
    expect(pill().classList.contains('fading')).toBe(true);
    expect(pill().hidden).toBe(false);
    expect(document.querySelector('.live-left-note')!.textContent).toMatch(/^bwat left at .+\. \d+ cards? and the transcript are kept\.$/);
    // Nothing more to offer.
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(dlg.textContent).not.toContain('This meeting');
  });

  it('says Live again, and offers leave again, once a recalled bwat is invited back in', async () => {
    const server = fakeServer({ botJoinedAt: JOINED });
    const { document, window } = await open('board.html', server, `?source=${MEETING}`);
    const pill = () => document.querySelector<HTMLElement>('#live-pill')!;
    const dlg = () => document.querySelector<HTMLDialogElement>('#settings-dialog')!;
    await until(() => !pill().hidden);
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    await until(() => !!dlg().querySelector('[data-ask-leave]'));
    dlg().querySelector<HTMLButtonElement>('[data-ask-leave]')!.click();
    dlg().querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
    await until(() => pill().textContent === 'Leaving…');
    await poll(window);
    await until(() => pill().textContent === 'Left');
    server.reinvite();
    await poll(window);
    await until(() => pill().textContent === 'Live');
    expect(pill().dataset.state).toBeUndefined();
    expect(pill().classList.contains('fading')).toBe(false);
    expect(document.querySelector('.live-left-note')).toBeNull();
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    await until(() => !!dlg().querySelector('[data-ask-leave]'));
  });

  const memberWho = [200, { member: { id: ADA, email: 'ada@example.com', display_name: 'Ada', role: 'member' }, id_token: TOKEN, occurrence_id: null }] as [number, unknown];
  it.each([
    ['a member', { whoami: memberWho, botJoinedAt: JOINED }, `?source=${MEETING}`],
    ['an owner while bwat is not in the meeting', {}, `?source=${MEETING}`],
    ['an owner looking at an ended meeting', { botJoinedAt: JOINED }, `?source=${OLDER_MEETING}`],
  ] as const)('offers no leave in Settings to %s', async (_who, options, query) => {
    const server = fakeServer(options);
    const { document } = await open('board.html', server, query);
    await until(() => document.querySelector('#page-title')!.textContent !== 'Meetings');
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector('#settings-dialog')!.textContent).not.toContain('This meeting');
    expect(document.querySelector('#settings-dialog [data-ask-leave]')).toBeNull();
  });

  it('lets a host inside Zoom ask bwat to leave from Settings, through the meeting bot route', async () => {
    const server = fakeServer({ occurrence: 'zoom-occurrence==', botJoinedAt: JOINED });
    const { document, window } = await open('board.html', server, '?surface=zoom');
    const w = window as unknown as { zoomSdk: object; MEETING_BOT: { current(): object | null } };
    w.zoomSdk = { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) };
    await until(() => w.MEETING_BOT.current() !== null, 9000);
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const dlg = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
    await until(() => !!dlg.querySelector('[data-ask-leave]'));
    expect([...dlg.querySelectorAll('.settings-group')].at(-1)!.textContent).toBe('This meeting');
    dlg.querySelector<HTMLButtonElement>('[data-ask-leave]')!.click();
    dlg.querySelector<HTMLButtonElement>('[data-confirm-leave]')!.click();
    expect(document.querySelector('#live-pill')!.textContent).toBe('Leaving…');
    await until(() => server.calls.some((c) => c.path === '/v1/zoom/meeting-bot' && (c.body as { leave?: boolean }).leave === true));
  }, 15_000);

  it.each([
    ['inside Zoom', '?surface=zoom'],
    ['on the full board', `?source=${MEETING}`],
  ])('offers leave without a join time it does not know yet, %s', async (_where, query) => {
    const server = fakeServer({ occurrence: 'zoom-occurrence==', botJoinedAt: JOINED, joinedAtKnown: false });
    const { document, window } = await open('board.html', server, query);
    const w = window as unknown as { zoomSdk: object; MEETING_BOT: { current(): object | null } };
    w.zoomSdk = { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) };
    await until(() => w.MEETING_BOT.current() !== null, 9000);
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const dlg = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
    await until(() => !!dlg.querySelector('[data-ask-leave]'));
    expect(dlg.querySelector('.settings-meeting-line')!.textContent).toBe('bwat is listening');
  }, 15_000);

  it('shows a member no Company settings link', async () => {
    const whoami = [200, { member: { id: ADA, email: 'ada@example.com', display_name: 'Ada', role: 'member' }, id_token: TOKEN, occurrence_id: null }] as [number, unknown];
    const { document } = await open('board.html', fakeServer({ whoami }));
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    expect(document.querySelector('#settings-dialog')!.hasAttribute('open')).toBe(true);
    expect(document.querySelector('#settings-dialog a[href="/admin/"]')).toBeNull();
    expect(document.querySelector('#settings-dialog')!.textContent).not.toContain('Company settings');
  });

  // Account mock-up M1: any signed-in person sends bwat to a meeting from the full board's
  // Settings, with the admin's form and its words (web/admin/src/Meetings.tsx SendForm).
  describe('Send bwat to a meeting, in Settings', () => {
    const LINK = 'https://zoom.us/j/1234567890?pwd=abc';
    async function openSend(server = fakeServer({ whoami: memberWho }), query = '') {
      const loaded = await open('board.html', server, query);
      const { document, window } = loaded;
      await until(() => document.body.textContent!.includes('Ship the release on Friday'));
      (document.querySelector('#settings-open') as HTMLButtonElement).click();
      const dlg = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
      const input = dlg.querySelector<HTMLInputElement>('#settings-send-link')!;
      const button = dlg.querySelector<HTMLButtonElement>('[data-send-bwat]')!;
      const type = (text: string) => { input.value = text; input.dispatchEvent(new window.Event('input', { bubbles: true })); };
      const status = () => dlg.querySelector('.settings-send-status')!.textContent;
      const error = () => dlg.querySelector<HTMLElement>('.settings-send-error')!;
      const reads = () => loaded.server.calls.filter((c) => c.method === 'GET' && c.path === '/v1/allocations').length;
      return { ...loaded, dlg, input, button, type, status, error, reads };
    }

    it('shows on the full board, above Your board, and not inside Zoom', async () => {
      const { dlg, input } = await openSend();
      const groups = [...dlg.querySelectorAll('.settings-group')].map((g) => g.textContent);
      expect(groups.slice(0, 2)).toEqual(['Send bwat to a meeting', 'Your board']);
      expect(dlg.querySelector('label[for="settings-send-link"]')!.textContent).toBe('Zoom meeting link');
      expect(input.placeholder).toBe('https://zoom.us/j/1234567890?pwd=…');
      close?.();
      const { document } = await open('board.html', fakeServer(), '?surface=zoom');
      await until(() => !!document.querySelector('#settings-open'));
      (document.querySelector('#settings-open') as HTMLButtonElement).click();
      expect(document.querySelector('#settings-dialog')!.hasAttribute('open')).toBe(true);
      expect(document.querySelector('#settings-dialog')!.textContent).not.toContain('Send bwat to a meeting');
      expect(document.querySelector('#settings-send-link')).toBeNull();
    });

    it('keeps Send bwat off while the link is empty', async () => {
      const { button, type } = await openSend();
      expect(button.textContent).toBe('Send bwat');
      expect(button.disabled).toBe(true);
      type('   ');
      expect(button.disabled).toBe(true);
      type(LINK);
      expect(button.disabled).toBe(false);
      type('');
      expect(button.disabled).toBe(true);
    });

    it('says a link that is not a Zoom meeting link is not one, from the server', async () => {
      const { window, server, button, type, error, input, dlg, status } = await openSend();
      type('https://example.com/meeting');
      button.click();
      await until(() => !error().hidden);
      expect(server.calls.find((c) => c.method === 'POST' && c.path === '/v1/allocations')).toBeTruthy();
      expect(error().getAttribute('role')).toBe('alert');
      expect(error().textContent).toBe("That doesn't look like a Zoom meeting link. Paste the full join URL (https://zoom.us/j/…).");
      expect(input.value).toBe('https://example.com/meeting');
      expect(status()).toBe('');
      // Leaving the field is not a setting saved: the drawer's change handler leaves it be.
      const errors: unknown[] = [];
      window.addEventListener('error', (e) => errors.push(e.error));
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      expect(errors).toEqual([]);
      expect(dlg.hasAttribute('open')).toBe(true);
    });

    it('lets a member send bwat with Enter: it posts the link and says Sending', async () => {
      const { window, server, input, type, status, error, dlg } = await openSend();
      type(LINK);
      const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      input.dispatchEvent(enter);
      // Enter sends, and does not submit (and so close) the drawer.
      expect(enter.defaultPrevented).toBe(true);
      await until(() => status() !== '');
      expect(status()).toBe('Sending bwat to meeting 1234567890');
      expect(server.calls.find((c) => c.method === 'POST' && c.path === '/v1/allocations')).toMatchObject({ authorization: `Bearer ${TOKEN}`, body: { zoom_url: LINK } });
      expect(input.value).toBe('');
      expect(error().hidden).toBe(true);
      expect(dlg.hasAttribute('open')).toBe(true);
    });

    it('says bwat is already on its way when the meeting has a claim', async () => {
      const server = fakeServer({ sendAnswer: [200, { id: SENT_CLAIM, meeting_number: '987654321', claim_state: 'claimed', refused_reason: null, status: 'already_claimed' }] });
      const { button, type, status, input } = await openSend(server);
      type('https://zoom.us/j/987654321');
      button.click();
      await until(() => status() !== '');
      expect(status()).toBe('bwat is already on its way to or in meeting 987654321');
      expect(input.value).toBe('');
    });

    it('follows the claim while Settings is open: joining, in the meeting, ended, then stops', async () => {
      const { server, button, type, status, dlg, reads } = await openSend();
      type(LINK);
      button.click();
      await until(() => status() === 'Sending bwat to meeting 1234567890');
      server.sent('claimed');
      await until(() => status() === 'bwat is joining meeting 1234567890…');
      server.sent('attending');
      await until(() => status() === 'bwat is in meeting 1234567890 and listening.');
      expect(dlg.querySelector('.settings-send-status')!.classList.contains('joined')).toBe(true);
      // Still read while bwat is in, so the line goes when bwat leaves.
      server.sent('released');
      await until(() => status() === 'Meeting 1234567890 ended');
      const after = reads();
      await new Promise((r) => setTimeout(r, 3500));
      expect(reads()).toBe(after);
    }, 20_000);

    it('reopened after bwat has left, says so at once', async () => {
      const { window, document, server, button, type, status, dlg } = await openSend();
      type(LINK);
      button.click();
      await until(() => status() !== '');
      server.sent('attending');
      await until(() => status() === 'bwat is in meeting 1234567890 and listening.');
      dlg.close();
      dlg.dispatchEvent(new window.Event('close'));
      server.sent('released');
      (document.querySelector('#settings-open') as HTMLButtonElement).click();
      // Read on opening, not a poll later.
      await until(() => status() === 'Meeting 1234567890 ended', 1500);
    }, 15_000);

    it('stops reading the claim once Settings closes', async () => {
      const { window, button, type, status, dlg, reads } = await openSend();
      type(LINK);
      button.click();
      await until(() => status() !== '');
      dlg.close();
      // jsdom's close() fires no close event; a browser's does.
      dlg.dispatchEvent(new window.Event('close'));
      const after = reads();
      await new Promise((r) => setTimeout(r, 3500));
      expect(reads()).toBe(after);
    }, 10_000);

    it('reads no claim when Settings closes before the send is answered', async () => {
      let answer!: () => void;
      const server = fakeServer({ whoami: memberWho, sendGate: new Promise<void>((r) => { answer = r; }) });
      const { window, button, type, dlg, reads } = await openSend(server);
      type(LINK);
      button.click();
      await until(() => server.calls.some((c) => c.method === 'POST' && c.path === '/v1/allocations'));
      dlg.close();
      dlg.dispatchEvent(new window.Event('close'));
      const before = reads();
      answer();
      await new Promise((r) => setTimeout(r, 3500));
      expect(reads()).toBe(before);
    }, 10_000);

    it("says Couldn't join when bwat's claim is refused", async () => {
      const { server, button, type, status } = await openSend();
      type(LINK);
      button.click();
      await until(() => status() !== '');
      server.sent('refused');
      await until(() => status() === "Couldn't join meeting 1234567890");
    }, 10_000);

    it('says bwat is not set up yet before onboarding', async () => {
      const { button, type, error, status } = await openSend(fakeServer({ sendAnswer: [403, { error: 'not_onboarded' }] }));
      type(LINK);
      button.click();
      await until(() => !error().hidden);
      expect(error().textContent).toBe('bwat is not set up yet: the owner finishes onboarding first.');
      expect(status()).toBe('');
    });

    it('pulses the dot once when bwat joins, and not under Reduce Motion', () => {
      const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'settings.css'), 'utf8');
      expect(css).toMatch(/\.settings-send-status\.joined \.settings-send-dot\{animation:[^;}]* 1[;}]/);
      expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^}]*\.settings-send-status\.joined \.settings-send-dot\{animation:none\}/);
    });
  });

  it('offers card edit, and the transcript of one meeting as a download from the web server, in the meeting’s ⋯', async () => {
    const loaded = await loadPage('board.html', fakeServer(), `?source=${MEETING}`);
    close = () => loaded.window.close();
    const { document } = loaded;
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    expect(document.querySelector(`[data-more="${CARD}"]`)).not.toBeNull();
    const download = await meetingMenu(document, '#download-transcript');
    expect([download.getAttribute('role'), download.getAttribute('href'), download.hasAttribute('download')]).toEqual(['menuitem', `transcript?source=${MEETING}`, true]);
    expect(document.activeElement).toBe(download);
  });

  // One title line: the meeting and when it started; nothing under it repeats either.
  it('names one meeting and its start on one line, with nothing under it', async () => {
    const startedAt = '2026-10-30T16:02:00Z';
    const { document } = await open('board.html', fakeServer({ startedAt }), `?source=${MEETING}`);
    const when = new Date(startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    await until(() => document.querySelector('#page-title')!.textContent === `Standup · ${when}`);
    expect(document.querySelector('#meeting-meta')!.textContent).toBe('');
    expect(document.querySelector<HTMLElement>('#meeting-more')!.hidden).toBe(false);
  });

  it('has no meeting ⋯ while several meetings are on screen', async () => {
    const { document } = await open('board.html', fakeServer(), '?source=all');
    await until(() => document.querySelector('#page-title')!.textContent === 'All meetings');
    expect(document.querySelector<HTMLElement>('#meeting-more')!.hidden).toBe(true);
    close?.();
    const two = await open('board.html', fakeServer(), `?source=${MEETING},${OLDER_MEETING}`);
    await until(() => two.document.querySelector('#page-title')!.textContent === '2 meetings');
    expect(two.document.querySelector<HTMLElement>('#meeting-more')!.hidden).toBe(true);
  });

  it("shows the switched-on plugins' links: on one meeting with its id, and in the header", async () => {
    const boardLinks = { links: [
      { slot: 'meeting', label: 'Probe report', href: '/probe-route?meeting={meeting_id}' },
      { slot: 'nav', label: 'Probe', href: '/probe-route' },
    ] };
    const loaded = await loadPage('board.html', fakeServer({ boardLinks }), `?source=${MEETING}`);
    close = () => loaded.window.close();
    const { document } = loaded;
    await until(() => !!document.querySelector('.app-header [data-plugin-link="nav"]'));
    const meeting = await meetingMenu(document, '[data-plugin-link="meeting"]');
    expect([meeting.textContent, meeting.getAttribute('href')]).toEqual(['Probe report', `/probe-route?meeting=${MEETING}`]);
    const nav = document.querySelector('.app-header [data-plugin-link="nav"]')!;
    expect([nav.textContent, nav.getAttribute('href')]).toEqual(['Probe', '/probe-route']);
  });

  it('draws no plugin links in the board inside Zoom: a link would replace the board in its panel', async () => {
    const boardLinks = { links: [{ slot: 'nav', label: 'Probe', href: '/probe-route' }] };
    const loaded = await loadPage('board.html', fakeServer({ boardLinks }), `?surface=zoom&source=${MEETING}`);
    close = () => loaded.window.close();
    const { document, server } = loaded;
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    expect(document.querySelector('[data-plugin-link]')).toBeNull();
    expect(server.calls.some((c) => c.path === '/board-links')).toBe(false);
  });

  it("draws no plugin links on a page signed in by a plugin: a link would leave that plugin's sign-in", async () => {
    const boardLinks = { links: [{ slot: 'meeting', label: 'Probe report', href: '/probe-route?meeting={meeting_id}' }] };
    const boardPlugins = { plugins: [{ name: 'probe', token: 'probe-sel', scripts: ['/plugins/probe/targets.js'] }], reserved: ['probe-sel'] };
    const loaded = await loadPage('board.html', fakeServer({ boardLinks, boardPlugins }), `?surface=probe-sel&source=${MEETING}`);
    close = () => loaded.window.close();
    const { document, server } = loaded;
    await meetingMenu(document, '#download-transcript');
    expect(document.querySelector('[data-plugin-link]')).toBeNull();
    expect(server.calls.some((c) => c.path === '/board-links')).toBe(false);
  });

  it('edits a card with PATCH /v1/cards/{id}: the new title and a note, at the card revision', async () => {
    const { document, server } = await open('board.html');
    await until(() => !!document.querySelector(`[data-more="${CARD}"]`));
    (document.querySelector(`[data-more="${CARD}"]`) as HTMLButtonElement).click();
    (document.querySelector('#more-edit') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#edit-form'));
    (document.querySelector('#edit-title') as HTMLInputElement).value = 'Ship it Monday';
    (document.querySelector('#edit-note') as HTMLTextAreaElement).value = 'after QA';
    (document.querySelector('#edit-form') as HTMLFormElement).requestSubmit();
    await until(() => server.calls.some((c) => c.method === 'PATCH'));
    expect(server.calls.find((c) => c.method === 'PATCH')).toMatchObject({
      path: `/v1/cards/${CARD}`, authorization: `Bearer ${TOKEN}`, body: { revision: 3, title: 'Ship it Monday', note: 'after QA' },
    });
    expect(server.calls.filter((c) => c.path === '/v1/editing' && c.method === 'POST')[0]!.body).toEqual({ card_id: CARD, on: true });
  });

  it('shows the meeting held today under Today, newest card first', async () => {
    const loaded = await loadPage('board.html', fakeServer(), '?when=today');
    close = () => loaded.window.close();
    const { document } = loaded;
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    const titles = [...document.querySelectorAll('.card h3')].map((h) => h.textContent);
    expect(titles.indexOf('Write the release notes')).toBeLessThan(titles.indexOf('Ship the release on Friday'));
  });

  it('opens a card without its UUID anywhere', async () => {
    const { document } = await open('board.html');
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    (document.querySelector(`[data-open="${CARD}"]`) as HTMLElement).click();
    await until(() => document.querySelector('#reader')!.textContent!.includes('Ship the release on Friday'));
    expect(visibleText(document)).not.toContain(CARD);
    expect(document.title).not.toContain(CARD);
  });

  it('moves the open raw transcript tail on a poll even when no card changed', async () => {
    const { document, window } = await open('board.html');
    await until(() => !!document.getElementById('foot-raw'));
    const raw = document.getElementById('foot-raw') as HTMLDetailsElement;
    raw.open = true;
    raw.dispatchEvent(new window.Event('toggle'));
    await until(() => document.getElementById('foot-tail')!.textContent!.includes('friday works'));
    const poll = () => (window as unknown as { refresh: (force: boolean) => Promise<void> }).refresh(false);
    await poll(); // the first poll after loading always repaints; the bug is in the ones after it
    control.newestLine = 'and the notes go out tonight';
    try {
      await poll();
      expect(document.getElementById('foot-tail')!.textContent).toContain('and the notes go out tonight');
    } finally {
      control.newestLine = null;
    }
  });

  it('keeps rendering when someone else archives a question on screen', async () => {
    const { document, window } = await open('board.html');
    await until(() => !!document.querySelector(`[data-open="${QUESTION_NOW}"]`));
    control.askedArchived = true;
    try {
      // A poll, not a forced refresh: only a poll marks cards that left as lingering.
      await (window as unknown as { refresh: (force: boolean) => Promise<void> }).refresh(false);
      expect(document.body.textContent).not.toContain('Board unreachable');
      expect(document.body.textContent).toContain('Ship the release on Friday');
    } finally {
      control.askedArchived = false;
    }
  });

  it('keeps the full desk in an ordinary browser: signing in is not being inside Zoom', async () => {
    const { document, window } = await open('board.html');
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    expect((window as unknown as { LIVE: { api: { zoom: boolean } } }).LIVE.api.zoom).toBe(false);
    // Inside Zoom the desk narrows to one column; here the questions column shows too.
    expect(document.querySelector('#heading-ask')).not.toBeNull();
  });

  it('shows a meeting title and a member name as text, never as HTML', async () => {
    const evil = '<img src=x onerror="window.injected=1">';
    const { document } = await open('board.html', fakeServer({ title: evil, bobName: evil }));
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    expect(document.body.textContent).toContain(evil);
    expect(document.querySelector('img:not([src^="ui/"])')).toBeNull();
  });

  it('answers a question with POST /v1/cards/{id}/clarify: the answer, the to-do to create and a request id', async () => {
    const { document, server } = await open('board.html', fakeServer({ askedOpen: true }));
    await until(() => !!document.querySelector(`[data-open="${QUESTION_NOW}"]`));
    (document.querySelector(`[data-open="${QUESTION_NOW}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#clarify-form'));
    expect(document.querySelector('label[for="clarify-title"]')!.textContent).toBe('Create to-do (optional)');
    expect(document.querySelector('#clarify-save')!.textContent).toBe('Save and close answer');
    (document.querySelector('#clarify-answer') as HTMLTextAreaElement).value = 'Friday noon';
    (document.querySelector('#clarify-title') as HTMLInputElement).value = 'Lin tells the team';
    (document.querySelector('#clarify-form') as HTMLFormElement).requestSubmit();
    await until(() => writes(server.calls).some((c) => c.path.endsWith('/clarify')));
    const sent = writes(server.calls).find((c) => c.path.endsWith('/clarify'))!;
    expect(sent).toMatchObject({ path: `/v1/cards/${QUESTION_NOW}/clarify`, body: { revision: 1, answer: 'Friday noon', todo: 'Lin tells the team' } });
    expect((sent.body as { request_id: string }).request_id).toBeTruthy();
    expect(sent.body).not.toHaveProperty('todo_owner_member_id');
    // Saved and closed: the reader closes, as it does after Done, and the card leaves a row, with no Undo.
    await until(() => !document.querySelector('#clarify-form'));
    expect(document.querySelector('#announcement')!.textContent).toBe('Answer saved and question closed.');
    await until(() => !!cardEl(document, QUESTION_NOW)?.classList.contains('slim-row'));
    expect(cardEl(document, QUESTION_NOW)!.querySelector('.slim-label')!.textContent).toBe('Answered');
    expect(cardEl(document, QUESTION_NOW)!.querySelector('s')!.textContent).toBe('When is the code freeze?');
    expect(cardEl(document, QUESTION_NOW)!.querySelector('[data-slim-undo]')).toBeNull();
  });

  it('takes a save again after a lost reply as saved: the reader closes, the card leaves a row and the kept answer is cleared', async () => {
    const { window, document, server } = await open('board.html', fakeServer({ clarifyLostOnce: true, askedOpen: true }));
    const draft = () => JSON.parse(window.localStorage.getItem(`bwat.study.v1.desk.clarify.${QUESTION_NOW}`) ?? 'null');
    await until(() => !!document.querySelector(`[data-open="${QUESTION_NOW}"]`));
    (document.querySelector(`[data-open="${QUESTION_NOW}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#clarify-form'));
    (document.querySelector('#clarify-answer') as HTMLTextAreaElement).value = 'Friday noon';
    (document.querySelector('#clarify-form') as HTMLFormElement).requestSubmit();
    await until(() => document.querySelector('#clarify-status')!.textContent === 'Couldn’t reach the board.');
    expect(draft()).toMatchObject({ answer: 'Friday noon' });
    (document.querySelector('#clarify-form') as HTMLFormElement).requestSubmit();
    await until(() => !document.querySelector('#clarify-form'));
    const [first, again] = writes(server.calls).filter((c) => c.path.endsWith('/clarify'));
    expect(again!.body).toEqual(first!.body);
    expect(draft()).toBeNull();
    expect(document.querySelector('#announcement')!.textContent).toBe('Already saved.');
    await until(() => !!cardEl(document, QUESTION_NOW)?.classList.contains('slim-row'));
  });

  it('picks the owner of the new to-do with the Change owner list, shown once there is a to-do, unassigned by default', async () => {
    const { document, server } = await open('board.html', fakeServer({ askedOpen: true }));
    await until(() => !!document.querySelector(`[data-open="${QUESTION_NOW}"]`));
    (document.querySelector(`[data-open="${QUESTION_NOW}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#clarify-form'));
    const row = document.querySelector('#clarify-owner-row') as HTMLElement;
    expect(row.hidden).toBe(true);
    (document.querySelector('#clarify-answer') as HTMLTextAreaElement).value = 'Friday noon';
    const todo = document.querySelector('#clarify-title') as HTMLInputElement;
    todo.value = 'Lin tells the team';
    todo.dispatchEvent(new todo.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    expect(row.hidden).toBe(false);
    expect(document.querySelector('#clarify-owner')!.textContent).toBe('Unassigned');
    (document.querySelector('#clarify-owner-pick') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#owner-dialog [data-person="Bob"]'));
    (document.querySelector('#owner-dialog [data-person="Bob"]') as HTMLButtonElement).click();
    expect(document.querySelector('#clarify-owner')!.textContent).toBe('Bob');
    (document.querySelector('#clarify-form') as HTMLFormElement).requestSubmit();
    await until(() => writes(server.calls).some((c) => c.path.endsWith('/clarify')));
    expect(writes(server.calls).find((c) => c.path.endsWith('/clarify'))).toMatchObject({ body: { todo: 'Lin tells the team', todo_owner_member_id: BOB } });
  });

  describe('the default session (QOR-4843)', () => {
    const TWO = [{ id: 'sess-1', name: 'bwat repo' }, { id: 'sess-2', name: 'school work' }];
    const openSend = async (server: ReturnType<typeof fakeServer>) => {
      const { document } = await open('board.html', server);
      await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
      (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
      await until(() => document.querySelectorAll('#send-dialog [data-session]').length > 1 || !!document.querySelector('#send-dialog .send-default-off'));
      return document;
    };
    const order = (document: Document) => [...document.querySelectorAll('#send-dialog [data-session]')].map((b) => (b as HTMLElement).dataset.session);

    it('lists the default first and focused, so one click or Enter sends there', async () => {
      const server = fakeServer({ sessions: TWO, defaultSession: { session_id: 'sess-2', name: 'school work', live: true } });
      const document = await openSend(server);
      await until(() => order(document)[0] === 'sess-2');
      expect(document.activeElement && (document.activeElement as HTMLElement).dataset.session).toBe('sess-2');
      expect(document.querySelector('#send-dialog .send-heading')!.textContent).toBe('Default');
      (document.querySelector('#send-dialog [data-session="sess-2"]') as HTMLButtonElement).click();
      await until(() => writes(server.calls).some((c) => c.path === '/v1/handoffs'));
      expect(writes(server.calls).find((c) => c.path === '/v1/handoffs')!.body).toMatchObject({ target_session_id: 'sess-2' });
    });

    it('makes a session the default without sending the card', async () => {
      const server = fakeServer({ sessions: TWO });
      const document = await openSend(server);
      (document.querySelector('#send-dialog [data-make-default="sess-2"]') as HTMLButtonElement).click();
      await until(() => writes(server.calls).some((c) => c.path === '/v1/sessions/sess-2/default'));
      expect(writes(server.calls).find((c) => c.path === '/v1/sessions/sess-2/default')!.method).toBe('PUT');
      expect(writes(server.calls).some((c) => c.path === '/v1/handoffs')).toBe(false);
    });

    it('keeps focus on the pin whose default was changed, so a second press is the pin again and never sends', async () => {
      const server = fakeServer({ sessions: TWO });
      const document = await openSend(server);
      const pin = () => document.querySelector('#send-dialog [data-pin="sess-2"]') as HTMLButtonElement;
      pin().focus();
      pin().click();
      await until(() => writes(server.calls).some((c) => c.path === '/v1/sessions/sess-2/default'));
      await new Promise((r) => setTimeout(r, 100));
      expect(document.activeElement).toBe(pin());
      (document.activeElement as HTMLButtonElement).click();
      // The fake keeps no default, so the second press asks again; what matters is where it lands.
      await until(() => writes(server.calls).filter((c) => c.path === '/v1/sessions/sess-2/default').length === 2);
      await new Promise((r) => setTimeout(r, 100));
      expect(document.activeElement).toBe(pin());
      expect(writes(server.calls).some((c) => c.path === '/v1/handoffs')).toBe(false);
    });

    it('says so when the default cannot be changed', async () => {
      const server = fakeServer({ sessions: TWO, defaultStatus: 500 });
      const document = await openSend(server);
      (document.querySelector('#send-dialog [data-make-default="sess-2"]') as HTMLButtonElement).click();
      await until(() => /could not change your default session/i.test(document.querySelector('#send-dialog')!.textContent || ''));
      expect(writes(server.calls).some((c) => c.path === '/v1/handoffs')).toBe(false);
    });

    it('shows a default that is not running as a row that cannot be picked, and focuses the first live one', async () => {
      const server = fakeServer({ sessions: TWO, defaultSession: { session_id: 'sess-9', name: 'old work', live: false } });
      const document = await openSend(server);
      await until(() => !!document.querySelector('#send-dialog .send-default-off'));
      expect(document.querySelector('#send-dialog .send-default-off')!.textContent).toContain('not running');
      expect(order(document)[0]).toBe('sess-1');
      expect((document.activeElement as HTMLElement).dataset.session).toBe('sess-1');
    });
  });

  describe('the Send to Claude picker', () => {
    const TWO = [{ id: 'sess-1', name: 'bwat repo' }, { id: 'sess-2', name: 'school work' }];
    const openPicker = async (server: ReturnType<typeof fakeServer>) => {
      const loaded = await open('board.html', server);
      const { document } = loaded;
      await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
      (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
      await until(() => !!document.querySelector('#send-dialog [data-session]') || !!document.querySelector('#send-dialog .send-empty'));
      // The second paint, after the dialog's own refresh of the sessions.
      await new Promise((r) => setTimeout(r, 60));
      return loaded;
    };
    const $$ = (document: Document, sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
    const row = (document: Document, id: string) => document.querySelector(`#send-dialog [data-session="${id}"]`)!.closest('.send-session-row') as HTMLElement;
    const headings = (document: Document) => $$(document, '#send-dialog .send-heading').map((h) => h.textContent);
    const handoff = (server: ReturnType<typeof fakeServer>) => writes(server.calls).find((c) => c.path === '/v1/handoffs');
    const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
      el.value = text;
      el.dispatchEvent(new el.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    };
    const key = (el: Element, k: string) => el.dispatchEvent(new el.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

    it('names each session once: no machine on one machine, and no "sessions" subtitle', async () => {
      const { document } = await openPicker(fakeServer({ sessions: TWO }));
      expect(document.querySelector('#send-dialog [data-session="sess-1"] .send-session-name')!.textContent).toBe('bwat repo');
      expect(document.querySelector('#send-dialog')!.textContent).not.toMatch(/ada-mac|@|’s sessions/);
      expect(document.querySelector('#send-dialog-who')!.textContent).toBe('');
    });

    it('with sessions on two machines, heads each machine and shows the default row’s machine', async () => {
      const server = fakeServer({
        sessions: [...TWO, { id: 'sess-3', name: 'bwat repo', machine: 'ada-pc' }, { id: 'sess-4', name: 'notes', machine: 'ada-pc' }],
        defaultSession: { session_id: 'sess-2', name: 'school work', live: true },
      });
      const { document } = await openPicker(server);
      await until(() => headings(document)[0] === 'Default');
      expect(headings(document)).toEqual(['Default', 'ada-mac', 'ada-pc']);
      expect(row(document, 'sess-2').querySelector('.send-machine')!.textContent).toBe('ada-mac');
      expect(row(document, 'sess-3').querySelector('.send-machine')).toBeNull();
      expect(row(document, 'sess-3').closest('[role=group]')!.getAttribute('aria-labelledby')).toBe($$(document, '#send-dialog .send-heading')[2]!.id);
    });

    it('shows a fresh session as a dot alone, and an older one with its short age', async () => {
      const { document } = await openPicker(fakeServer({ sessions: [{ id: 'sess-1', name: 'now' }, { id: 'sess-2', name: 'quiet', ageS: 840 }, { id: 'sess-3', name: 'gone', ageS: 7200 }] }));
      const meta = (id: string) => row(document, id).querySelector('.send-session-meta')!.textContent;
      expect(meta('sess-1')).toBe('');
      expect(row(document, 'sess-1').querySelector('.send-dot.old')).toBeNull();
      expect(row(document, 'sess-1').querySelector('.send-dot')).not.toBeNull();
      expect(meta('sess-2')).toBe('14m ago');
      expect(meta('sess-3')).toBe('2h ago');
      expect(row(document, 'sess-2').querySelector('.send-dot.old')).not.toBeNull();
      expect(document.querySelector('#send-dialog')!.textContent).not.toMatch(/last seen/);
    });

    it('puts a pin in each row, beside the session, never inside it', async () => {
      const server = fakeServer({ sessions: TWO, defaultSession: { session_id: 'sess-2', name: 'school work', live: true } });
      const { document } = await openPicker(server);
      await until(() => row(document, 'sess-2').querySelector('.send-pin')?.getAttribute('aria-pressed') === 'true');
      const pin = (id: string) => row(document, id).querySelector('.send-pin') as HTMLButtonElement;
      expect(pin('sess-2').getAttribute('aria-label')).toBe('Default session: school work');
      expect(pin('sess-1').getAttribute('aria-label')).toBe('Default session: bwat repo');
      expect(pin('sess-1').getAttribute('aria-pressed')).toBe('false');
      expect(document.querySelector('#send-dialog .send-session .send-pin')).toBeNull();
      expect($$(document, '#send-dialog .send-session-row .text-button')).toEqual([]);
      pin('sess-2').click();
      await until(() => writes(server.calls).some((c) => c.path === '/v1/sessions/sess-2/default'));
      expect(writes(server.calls).find((c) => c.path === '/v1/sessions/sess-2/default')!.method).toBe('DELETE');
      expect(handoff(server)).toBeUndefined();
    });

    it('heads the live default "Default" and the rest "Other sessions"; no headings without a default', async () => {
      const withDefault = await openPicker(fakeServer({ sessions: TWO, defaultSession: { session_id: 'sess-2', name: 'school work', live: true } }));
      await until(() => headings(withDefault.document).length === 2);
      expect(headings(withDefault.document)).toEqual(['Default', 'Other sessions']);
      expect((withDefault.document.activeElement as HTMLElement).dataset.session).toBe('sess-2');
      expect(withDefault.document.querySelector('#send-dialog')!.textContent).not.toMatch(/sends here/);
      withDefault.window.close();
      const none = await openPicker(fakeServer({ sessions: TWO }));
      expect(headings(none.document)).toEqual([]);
    });

    it('has no note box until a row’s note button opens one, and its Send carries the note', async () => {
      const server = fakeServer({ sessions: TWO });
      const { document } = await openPicker(server);
      expect(document.querySelector('#send-dialog textarea')).toBeNull();
      const bubble = row(document, 'sess-2').querySelector('[data-note-for="sess-2"]') as HTMLButtonElement;
      expect(bubble.getAttribute('aria-label')).toBe('Add a note and send to school work');
      expect(bubble.getAttribute('aria-expanded')).toBe('false');
      expect(bubble.closest('.send-session')).toBeNull();
      bubble.click();
      const note = document.querySelector('#send-dialog textarea') as HTMLTextAreaElement;
      expect(note).not.toBeNull();
      expect(row(document, 'sess-2').nextElementSibling!.contains(note)).toBe(true);
      expect(document.querySelector('[data-note-for="sess-2"]')!.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(note);
      type(note, 'check the logs first');
      (document.querySelector('#send-dialog [data-send-note="sess-2"]') as HTMLButtonElement).click();
      await until(() => !!handoff(server));
      expect(handoff(server)!.body).toMatchObject({ target_session_id: 'sess-2', note: 'check the logs first' });
    });

    it('sends at once, with no note, when the session’s name is clicked', async () => {
      const server = fakeServer({ sessions: TWO });
      const { document } = await openPicker(server);
      (row(document, 'sess-2').querySelector('[data-note-for]') as HTMLButtonElement).click();
      type(document.querySelector('#send-dialog textarea') as HTMLTextAreaElement, 'not this');
      (document.querySelector('#send-dialog [data-session="sess-1"]') as HTMLButtonElement).click();
      await until(() => !!handoff(server));
      expect(handoff(server)!.body).toMatchObject({ target_session_id: 'sess-1' });
      expect(handoff(server)!.body).not.toHaveProperty('note');
    });

    it('closes the note on Esc and keeps the dialog open', async () => {
      const { document } = await openPicker(fakeServer({ sessions: TWO }));
      (row(document, 'sess-2').querySelector('[data-note-for]') as HTMLButtonElement).click();
      const note = document.querySelector('#send-dialog textarea')!;
      expect(key(note, 'Escape')).toBe(false);
      expect(document.querySelector('#send-dialog textarea')).toBeNull();
      expect((document.querySelector('#send-dialog') as HTMLDialogElement).open).toBe(true);
      expect(document.activeElement).toBe(row(document, 'sess-2').querySelector('[data-note-for]'));
    });

    it('opens an unsent note again under the session it was typed for', async () => {
      const { document } = await openPicker(fakeServer({ sessions: TWO }));
      (row(document, 'sess-2').querySelector('[data-note-for]') as HTMLButtonElement).click();
      type(document.querySelector('#send-dialog textarea') as HTMLTextAreaElement, 'kept');
      (document.querySelector('#send-dialog-close') as HTMLButtonElement).click();
      (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
      await until(() => !!document.querySelector('#send-dialog textarea'));
      expect((document.querySelector('#send-dialog textarea') as HTMLTextAreaElement).value).toBe('kept');
      expect(row(document, 'sess-2').nextElementSibling!.querySelector('textarea')).not.toBeNull();
    });

    it('opens a kept note under the session it was last sent to, else the first row', async () => {
      const { window, document } = await openPicker(fakeServer({ sessions: TWO }));
      (document.querySelector('#send-dialog-close') as HTMLButtonElement).click();
      const reopen = async (d: object) => {
        const stored = Object.keys(window.localStorage).find((x) => x.endsWith('.' + CARD_OWNED) && x.includes('draft.'))!;
        window.localStorage.setItem(stored, JSON.stringify({ brief: '', status: 'draft', ...d }));
        (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
        await until(() => !!document.querySelector('#send-dialog textarea'));
        const at = document.querySelector('#send-dialog textarea')!.closest('.send-row-note')!.previousElementSibling!.querySelector('[data-session]') as HTMLElement;
        (document.querySelector('#send-dialog-close') as HTMLButtonElement).click();
        return at.dataset.session;
      };
      // A draft is written once the dialog is opened with a note typed; seed one first.
      (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
      await until(() => !!document.querySelector('#send-dialog [data-note-for="sess-1"]'));
      (document.querySelector('#send-dialog [data-note-for="sess-1"]') as HTMLButtonElement).click();
      type(document.querySelector('#send-dialog textarea') as HTMLTextAreaElement, 'x');
      (document.querySelector('#send-dialog-close') as HTMLButtonElement).click();
      expect(await reopen({ note: 'old', session: 'sess-2' })).toBe('sess-2');
      expect(await reopen({ note: 'old' })).toBe('sess-1');
    });

    it('keeps each row’s machine while filtering sessions on two machines', async () => {
      const nine = Array.from({ length: 9 }, (_, i) => ({ id: `sess-${i + 1}`, name: i === 8 ? 'work 1' : `work ${i + 1}`, machine: i === 8 ? 'ada-pc' : 'ada-mac' }));
      const { document } = await openPicker(fakeServer({ sessions: nine }));
      type(document.querySelector('#send-find') as HTMLInputElement, 'work 1');
      const machines = $$(document, '#send-dialog [data-session]').map((b) => [b.dataset.session, b.querySelector('.send-machine')?.textContent]);
      expect(machines).toEqual([['sess-1', 'ada-mac'], ['sess-9', 'ada-pc']]);
    });

    it('keeps focus on a row’s pin and on its note’s Send across a refresh', async () => {
      const { window, document } = await openPicker(fakeServer({ sessions: TWO }));
      const repaint = () => (window as unknown as { paintSendDialog: () => void }).paintSendDialog();
      (row(document, 'sess-2').querySelector('.send-pin') as HTMLButtonElement).focus();
      repaint();
      expect(document.activeElement).toBe(row(document, 'sess-2').querySelector('.send-pin'));
      (row(document, 'sess-2').querySelector('[data-note-for]') as HTMLButtonElement).click();
      (document.querySelector('#send-dialog [data-send-note="sess-2"]') as HTMLButtonElement).focus();
      repaint();
      expect(document.activeElement).toBe(document.querySelector('#send-dialog [data-send-note="sess-2"]'));
    });

    it('closes only the note on Esc from its Send button', async () => {
      const { document } = await openPicker(fakeServer({ sessions: TWO }));
      (row(document, 'sess-2').querySelector('[data-note-for]') as HTMLButtonElement).click();
      const go = document.querySelector('#send-dialog [data-send-note="sess-2"]')!;
      expect(key(go, 'Escape')).toBe(false);
      expect(document.querySelector('#send-dialog textarea')).toBeNull();
      expect((document.querySelector('#send-dialog') as HTMLDialogElement).open).toBe(true);
    });

    it('offers "Find a session" above more than 8 sessions: it has focus, filters, and Enter sends to the first match', async () => {
      const nine = Array.from({ length: 9 }, (_, i) => ({ id: `sess-${i + 1}`, name: `work ${i + 1}`, machine: i === 8 ? 'ada-pc' : 'ada-mac' }));
      const server = fakeServer({ sessions: nine });
      const { document } = await openPicker(server);
      const find = document.querySelector('#send-find') as HTMLInputElement;
      expect(find.getAttribute('aria-label')).toBe('Find a session');
      expect(document.activeElement).toBe(find);
      type(find, 'ada-pc');
      expect($$(document, '#send-dialog [data-session]').map((b) => b.dataset.session)).toEqual(['sess-9']);
      type(find, 'nothing like it');
      expect(document.querySelector('#send-dialog')!.textContent).toContain('No session matches “nothing like it”.');
      type(find, 'work 3');
      expect(document.activeElement).toBe(find);
      key(find, 'Enter');
      await until(() => !!handoff(server));
      expect(handoff(server)!.body).toMatchObject({ target_session_id: 'sess-3' });
      expect(handoff(server)!.body).not.toHaveProperty('note');
    });

    it('has no find field for 8 sessions or fewer', async () => {
      const eight = Array.from({ length: 8 }, (_, i) => ({ id: `sess-${i + 1}`, name: `work ${i + 1}` }));
      const { document } = await openPicker(fakeServer({ sessions: eight }));
      expect(document.querySelector('#send-find')).toBeNull();
      expect((document.activeElement as HTMLElement).dataset.session).toBe('sess-1');
    });

    it('closes with a grey ✕ named Close', async () => {
      const { document } = await openPicker(fakeServer({ sessions: TWO }));
      const x = document.querySelector('#send-dialog-close')!;
      expect(x.getAttribute('aria-label')).toBe('Close');
      expect(x.textContent).not.toBe('Close');
      expect(x.classList.contains('text-button')).toBe(false);
    });
  });

  it('sends a card to Claude with exactly one POST /v1/handoffs', async () => {
    const { document, server } = await open('board.html');
    // Only your own to-do can be sent; an unowned one offers Take it instead .
    await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
    expect(document.querySelector(`[data-send="${CARD}"]`)).toBeNull();
    (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#send-dialog [data-session="sess-1"]'));
    (document.querySelector('#send-dialog [data-session="sess-1"]') as HTMLButtonElement).click();
    await until(() => writes(server.calls).length > 0);
    await new Promise((r) => setTimeout(r, 200));
    const sent = writes(server.calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'POST', path: '/v1/handoffs', authorization: `Bearer ${TOKEN}`,
      body: { source_kind: 'card', source_id: CARD_OWNED, occurrence_id: MEETING, target_session_id: 'sess-1' },
    });
    expect((sent[0]!.body as { request_key: string }).request_key).toBeTruthy();
    // The card's receipt says where it went; no notice besides.
    await until(() => document.querySelector('#announcement')!.textContent === 'Queued.');
    expect(cardEl(document, CARD_OWNED)!.querySelector('.badge.queued')!.textContent).toBe('Queued for bwat repo @ ada-mac');
    expect(visibleText(document)).not.toMatch(/Sent to|delivered|when it.s read|with a note/i);
    // The open card's own receipt says the same.
    (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#route-receipt'));
    expect(document.querySelector('#route-receipt h3')!.textContent).toBe('Queued for bwat repo @ ada-mac');
  });

  it("says Read on the open card's receipt once its session read the hand-off, from the card itself", async () => {
    const { window, document } = await open('board.html');
    await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
    (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#send-dialog [data-session="sess-1"]'));
    (document.querySelector('#send-dialog [data-session="sess-1"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('#announcement')!.textContent === 'Queued.');
    (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#route-receipt'));
    expect(document.querySelector('#route-receipt .eyebrow')!.textContent).toBe('QUEUED');
    // The session reads it: the next poll brings the card's routed record with read_at.
    control.ownedRouted = [{ handoff_id: HANDOFF, by_member_id: ADA, at: '2026-10-21T10:00:00+00:00', read_at: '2026-10-21T10:05:00+00:00' }];
    try {
      await poll(window);
      await until(() => document.querySelector('#route-receipt .eyebrow')?.textContent === 'READ');
      expect(document.querySelector('#route-receipt h3')!.textContent).toBe('Read in bwat repo @ ada-mac');
      expect(cardEl(document, CARD_OWNED)!.querySelector('.badge.queued')!.textContent).toBe(`Read by bwat repo @ ada-mac · ${new Date('2026-10-21T10:05:00+00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}`);
    } finally { control.ownedRouted = null; }
  });

  it("keeps the open card's receipt at Queued while only an earlier hand-off was read", async () => {
    // An earlier send was read; this send's own hand-off is not in the card's record yet.
    control.ownedRouted = [{ handoff_id: 'h-earlier', by_member_id: ADA, at: '2026-10-21T09:00:00+00:00', read_at: '2026-10-21T09:05:00+00:00' }];
    try {
      const { document } = await open('board.html');
      await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
      (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
      await until(() => !!document.querySelector('#send-dialog [data-session="sess-1"]'));
      (document.querySelector('#send-dialog [data-session="sess-1"]') as HTMLButtonElement).click();
      await until(() => document.querySelector('#announcement')!.textContent === 'Queued.');
      (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
      await until(() => !!document.querySelector('#route-receipt'));
      expect(document.querySelector('#route-receipt .eyebrow')!.textContent).toBe('QUEUED');
      expect(document.querySelector('#route-receipt h3')!.textContent).toBe('Queued for bwat repo @ ada-mac');
      // The card in the list says the same, and offers no Done on the earlier send's Read.
      expect(cardEl(document, CARD_OWNED)!.querySelector('.badge.queued')!.textContent).toBe('Queued for bwat repo @ ada-mac');
      expect(cardEl(document, CARD_OWNED)!.querySelector('[data-done]')).toBeNull();
    } finally { control.ownedRouted = null; }
  });

  // A receipt kept in this browser from an earlier visit: one from before hand-off ids were kept
  // (no `handoff`), or a provider's send, which gets no id ('').
  const keptReceipt = async (handoff: string | undefined) => {
    control.ownedRouted = [{ handoff_id: 'h-earlier', by_member_id: ADA, at: '2026-10-21T09:00:00+00:00', read_at: '2026-10-21T09:05:00+00:00' }];
    const kept = { brief: '', session: 'sess-1', status: 'accepted', target: 'bwat repo @ ada-mac', request_id: 'req-1', ...(handoff !== undefined && { handoff }) };
    const { document } = await open('board.html', fakeServer(), '', false, { [`bwat.study.v1.draft.Ada.${CARD_OWNED}`]: JSON.stringify(kept) });
    (await until(() => !!document.querySelector(`[data-open="${CARD_OWNED}"]`)), document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#route-receipt'));
    return document.querySelector('#route-receipt .eyebrow')!.textContent;
  };

  it('says Read on a receipt kept from before hand-off ids were kept, from the newest hand-off', async () => {
    try { expect(await keptReceipt(undefined)).toBe('READ'); } finally { control.ownedRouted = null; }
  });

  it("keeps a provider send's receipt, which has no hand-off id, at Queued", async () => {
    try { expect(await keptReceipt('')).toBe('QUEUED'); } finally { control.ownedRouted = null; }
  });

  it('closes a card just sent to Claude at the revision the hand-off wrote', async () => {
    const { document, server } = await open('board.html');
    await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
    (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#send-dialog [data-session="sess-1"]'));
    (document.querySelector('#send-dialog [data-session="sess-1"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('#announcement')!.textContent === 'Queued.');
    (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#do-done'));
    (document.querySelector('#do-done') as HTMLButtonElement).click();
    await until(() => writes(server.calls).some((c) => c.path.endsWith('/archive')));
    // The hand-off moved the card from revision 7 to 8.
    expect(writes(server.calls).find((c) => c.path.endsWith('/archive'))!.body).toEqual({ revision: 8, outcome: 'done' });
  });
});

describe('inside Zoom, before the Zoom user is linked', () => {
  const LINK = 'https://bwat.example.test/auth/zoom-link';
  const linking = async () => {
    const loaded = await open('board.html', fakeServer({ whoami: [401, { error: 'link_needed', link_url: LINK }] }));
    await until(() => !!loaded.document.querySelector('#bwat-link'));
    return loaded;
  };
  const typeCode = (document: Document, code: string) => {
    const input = document.querySelector('#bwat-link input') as HTMLInputElement;
    input.value = code;
    (document.querySelector('#bwat-link form') as HTMLFormElement).requestSubmit();
  };

  it('asks the person to link once, and opens the Google sign-in in the browser through Zoom', async () => {
    const { document, window, server } = await linking();
    expect(visibleText(document)).toContain('Link your bwat account');
    expect(server.calls.some((c) => c.path.startsWith('/v1/'))).toBe(false);
    // A dialog over the board: focus is on its first button.
    expect(document.activeElement).toBe(document.querySelector('#bwat-link button'));

    // Zoom's openUrl, which opens the system browser.
    const asked: unknown[] = [];
    (window as unknown as { zoomSdk: unknown }).zoomSdk = {
      config: async (c: unknown) => { asked.push(c); },
      openUrl: async (o: unknown) => { asked.push(o); },
    };
    (document.querySelector('#bwat-link button') as HTMLButtonElement).click();
    await until(() => asked.length === 2);
    expect(asked).toEqual([{ capabilities: ['openUrl'] }, { url: LINK }]);
  });

  it('sends the code typed in', async () => {
    const { document, server } = await linking();
    typeCode(document, ' ABCD-EFGH ');
    await until(() => server.calls.some((c) => c.path === '/auth/zoom-pair'));
    expect(server.calls.filter((c) => c.path === '/auth/zoom-pair').map((c) => c.body)).toEqual([{ code: 'ABCD-EFGH' }]);
    // Then the page reloads (jsdom only logs that), and says nothing went wrong.
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector('#bwat-link [role=status]')!.textContent).toBe('Linking…');
  });

  it('says so when the code typed in is wrong', async () => {
    const { document } = await linking();
    control.pairCode = 'WRONG';
    try {
      typeCode(document, 'WRONG');
      await until(() => /didn.t work.*close bwat and open it again/.test(document.querySelector('#bwat-link [role=status]')!.textContent!));
    } finally {
      control.pairCode = 'ABCD-EFGH';
    }
  });
});

describe('the soft look (ui/soft.css)', () => {
  const ui = join(import.meta.dirname, '..', 'pages', 'board', 'ui');

  it('loads last on the desk, so it styles over every earlier layer', () => {
    const html = readFileSync(join(ui, '..', 'board.html'), 'utf8');
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    expect(sheets.at(-1)).toBe('ui/soft.css');
  });

  it('styles light and dark from one set of rules, each palette defining every colour they use', () => {
    const css = readFileSync(join(ui, 'soft.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // Every rule is scoped to a theme, so it outranks the earlier layers in both.
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1]!.split(/,(?![^(]*\))/)).map((s) => s.trim());
    expect(selectors.length).toBeGreaterThan(50);
    expect(selectors.filter((s) => !s.startsWith(':root[data-theme'))).toEqual([]);
    // A token used by a rule but missing from one palette would leave that theme unstyled.
    const used = new Set([...css.matchAll(/var\((--sf-[a-z0-9-]+)\)/g)].map((m) => m[1]));
    const palette = (theme: string) => {
      const block = css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\{([^}]*)\\}`))![1]!;
      return new Set([...block.matchAll(/(--sf-[a-z0-9-]+):/g)].map((m) => m[1]));
    };
    for (const theme of ['light', 'dark']) expect([...used].filter((t) => !palette(theme).has(t))).toEqual([]);
    expect([...palette('dark')].sort()).toEqual([...palette('light')].sort());
  });
});

// Small moments: each is decoration over a change that already happened.
// Mock-ups and spec: the planning record, specs/board-delight. Motion itself is CSS; these pin what
// plays, when, and that it stays out of the way of screen readers and of your own changes.
describe('small moments', () => {
  const SEAL = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  it('1 · turns the lens once when a pass saves cards, never for the pass already there on opening', async () => {
    const server = fakeServer();
    server.pass('p1', { created: 1, created_by: { do: 1 } });
    const { document } = await open('board.html', server);
    const lens = () => document.querySelector('.brand .brand-lens')!;
    await until(() => !!document.querySelector('#card-list .card'));
    expect(lens().getAttribute('aria-hidden')).toBe('true');
    await new Promise((r) => setTimeout(r, 2300)); // a poll of the pass that was already there
    expect(lens().classList.contains('ring')).toBe(false);
    server.pass('p2', { created: 1, created_by: { do: 1 } });
    await until(() => lens().classList.contains('ring'));
  });

  it('1 · turns the lens for a meeting’s first pass when the page opened before any pass had finished', async () => {
    const server = fakeServer();
    const { document } = await open('board.html', server);
    const lens = () => document.querySelector('.brand .brand-lens')!;
    await until(() => !!document.querySelector('#card-list .card'));
    await new Promise((r) => setTimeout(r, 2300)); // a poll with no pass finished yet
    expect(lens().classList.contains('ring')).toBe(false);
    server.pass('p1', { created: 1, created_by: { do: 1 } });
    await until(() => lens().classList.contains('ring'));
  });

  it('3 · highlights the sentence a card came from: a sweep the first time it opens, already there after', async () => {
    const { document } = await open('board.html');
    const openCard = async () => {
      await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
      (document.querySelector(`[data-open="${CARD}"]`) as HTMLElement).click();
      await until(() => !!document.querySelector('#reader .quote-hl'));
      return document.querySelector('#reader .quote-hl')!;
    };
    const first = await openCard();
    expect(first.classList.contains('sweep')).toBe(true);
    expect(first.textContent!.length).toBeGreaterThan(0);
    (document.querySelector('#close-reader') as HTMLElement).click();
    await until(() => !document.querySelector('#reader .quote-hl'));
    expect((await openCard()).classList.contains('sweep')).toBe(false);
  });

  it('4 · inks a card you close as done, then folds it into its row, without lingering as someone else’s change', async () => {
    const { document, window } = await open('board.html');
    await until(() => !!document.querySelector(`[data-open="${CARD_OWNED}"]`));
    (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#do-done'));
    (document.querySelector('#do-done') as HTMLButtonElement).click();
    await until(() => !!cardEl(document, CARD_OWNED)?.classList.contains('inking'));
    // A redraw mid-ink keeps the card inking, and out of reach of a second close.
    (window as unknown as { render: () => void }).render();
    expect(cardEl(document, CARD_OWNED)!.classList.contains('inking')).toBe(true);
    await until(() => !!cardEl(document, CARD_OWNED)?.classList.contains('folding'));
    // A poll that no longer lists the closed card keeps it, still inking, until it has folded away.
    control.ownedGone = true;
    try {
      await poll(window);
      if (!cardEl(document, CARD_OWNED)?.classList.contains('folding')) expect(cardEl(document, CARD_OWNED)!.classList.contains('inking')).toBe(true);
    } finally {
      control.ownedGone = false;
    }
    // A redraw mid-fold keeps it folded rather than bringing it back full height.
    (window as unknown as { render: () => void }).render();
    expect(cardEl(document, CARD_OWNED)!.classList.contains('folding')).toBe(true);
    await until(() => !!cardEl(document, CARD_OWNED)?.classList.contains('slim-row'));
    expect(document.querySelector('.card.lingering')).toBeNull();
  });

  it('strips the one-time animation classes from class names only, never from a card’s words', async () => {
    const { window } = await open('board.html');
    const strip = (h: string) => (window as unknown as { eval: (s: string) => (h: string) => string }).eval('stripMarks')(h);
    expect(strip('<article class="card is-new once-stamp" data-card="x"><h3>Draw up the contract, sealing it</h3></article>'))
      .toBe('<article class="card" data-card="x"><h3>Draw up the contract, sealing it</h3></article>');
    expect(strip('<p>Finish sealing the deal and draw the plan</p>')).toBe('<p>Finish sealing the deal and draw the plan</p>');
  });

  it('5 · sends a copy of the title across when a hand-off is queued, hidden from screen readers', async () => {
    const { document } = await open('board.html');
    await sendOwned(document);
    await until(() => !!cardEl(document, CARD_OWNED)?.querySelector('h3 .send-ghost'));
    const ghost = cardEl(document, CARD_OWNED)!.querySelector('h3 .send-ghost')!;
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.textContent).toBe('Write the release notes');
    expect(cardEl(document, CARD_OWNED)!.querySelector('.badge.queued')!.classList.contains('arrive')).toBe(true);
    // The ghost is decoration: it leaves once it has crossed.
    await until(() => !cardEl(document, CARD_OWNED)?.querySelector('.send-ghost'));
  });

  it('7 · stamps the seal on a decision that arrives while the board is open', async () => {
    const server = fakeServer();
    const { document, window } = await open('board.html', server, '?cols=do,ask,decided');
    await until(() => !!cardEl(document, CARD));
    await poll(window);
    server.arrive({ id: SEAL, display_id: 'D-1', kind: 'decision', title: 'Ship 0.5.0 on Thursday' });
    await poll(window);
    await until(() => !!cardEl(document, SEAL)?.querySelector('.type-icon.once-seal'));
  });

  it('8 · drains a hairline under a card someone else moved, for the time it lingers', async () => {
    const { document, window } = await open('board.html');
    await until(() => !!cardEl(document, QUESTION_NOW));
    control.askedArchived = true;
    try {
      await poll(window);
      const card = cardEl(document, QUESTION_NOW) as HTMLElement;
      expect(card.classList.contains('lingering')).toBe(true);
      expect(card.getAttribute('style')).toMatch(/--linger-left:\s*\d+ms/);
    } finally {
      control.askedArchived = false;
    }
  });

  it('9 · the Live pill\'s dot goes quiet when the meeting ends inside Zoom', async () => {
    const server = fakeServer({ occurrence: 'zoom-occurrence==' });
    const { document, window } = await open('board.html', server, '?surface=zoom');
    const pill = () => document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => !pill().hidden);
    expect(pill().classList.contains('quiet')).toBe(false);
    server.end();
    await poll(window);
    await until(() => pill().classList.contains('quiet'));
    // The pill stays while its dot fades, then goes; the class goes with it, so opening
    // another ended meeting cannot replay it.
    expect(pill().hidden).toBe(false);
    await until(() => pill().hidden && !pill().classList.contains('quiet'));
  });

  it('9 · does not hide a pill that says Left before its ended fade finishes', async () => {
    const server = fakeServer({ occurrence: 'zoom-occurrence==' });
    const { document, window } = await open('board.html', server, '?surface=zoom');
    const pill = () => document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => !pill().hidden);
    server.end();
    await poll(window);
    await until(() => pill().classList.contains('quiet'));
    // bwat confirms it has left while the dot is still fading (zoom-invite.js).
    pill().dataset.state = 'left';
    await new Promise((r) => setTimeout(r, 800));
    expect(pill().hidden).toBe(false);
  });

  it('10 · in Zoom, says an empty column of a live meeting has nothing yet, and of an ended one that nothing came up', async () => {
    const server = fakeServer();
    const loaded = await loadPage('board.html', server, `?surface=zoom&source=${MEETING}&scope=team&cols=risk`, { storage: { 'bwat.study.v1.settings.zoom.risk': '"on"' } });
    close = () => loaded.window.close();
    const { document, window } = loaded;
    const risks = () => document.querySelector('#heading-risk')?.closest('section');
    await until(() => !!risks()?.querySelector('.column-empty'));
    expect(risks()!.querySelector('.column-empty')!.textContent).toBe('Nothing yet.');
    expect(risks()!.querySelector('.column-empty svg')!.getAttribute('aria-hidden')).toBe('true');
    server.end();
    await poll(window);
    await until(() => risks()!.querySelector('.column-empty')!.textContent === 'Nothing came up.');
    expect(risks()!.querySelector('.column-empty svg')).toBeNull();
  });

  it('10 · on the web board, names the scope in an empty column of a live meeting, with no lens', async () => {
    const { document } = await open('board.html', fakeServer(), `?surface=web&source=${MEETING}&scope=team&cols=do,risk`);
    const risks = () => document.querySelector('#heading-risk')?.closest('section');
    await until(() => !!risks()?.querySelector('.column-empty'));
    expect(risks()!.querySelector('.column-empty')!.textContent).toBe('No risks in this scope.');
    expect(risks()!.querySelector('.column-empty svg')).toBeNull();
  });

  it('10 · keeps the plain empty text when a search filters a column empty', async () => {
    const { document } = await open('board.html', fakeServer(), `?source=${MEETING}&scope=team&cols=do,risk&q=release`);
    const risks = () => document.querySelector('#heading-risk')?.closest('section');
    await until(() => !!risks()?.querySelector('.column-empty'));
    expect(risks()!.querySelector('.column-empty')!.textContent).toBe('No risks in this scope.');
  });
});

// Make room: the Zoom panel's one-row header, the footer that opens when a card needs you,
// and the full board's column spines. Mock-ups: the planning record, specs/board-delight (four-views).
describe('make room', () => {

  // Settings redesign A2: the Live pill is back, carrying the dot and the word. Without the
  // right to ask bwat to leave (a member, or no Zoom here) it is plain status.
  // Zoom's panel opens before capture has made the meeting it is in, so the
  // board's first pick is the meeting before it. The header says Loading… until bwat knows.
  it('in Zoom, says Loading… in the header, never the last meeting’s name, while the meeting it is in is not on the board yet', async () => {
    const { document } = await open('board.html', fakeServer({ occurrence: 'next-meeting==' }), '?surface=zoom');
    await until(() => !document.getElementById('workspace')!.hidden);
    expect(document.querySelector('#brand-meeting')!.textContent).toBe('Loading…');
  });

  it('in Zoom, names a meeting picked in the link while the meeting the panel is in is not on the board yet', async () => {
    const { document } = await open('board.html', fakeServer({ occurrence: 'next-meeting==' }), `?surface=zoom&source=${MEETING}`);
    await until(() => document.querySelector('#brand-meeting')!.textContent === 'Standup');
  });

  it('in Zoom, names the meeting the board opens on once Zoom says the panel is in no meeting', async () => {
    const notInMeeting = async () => { throw new Error('not in a meeting'); };
    const zoomSdk = { config: async () => ({}), getMeetingUUID: notInMeeting, getAppContext: notInMeeting };
    const loaded = await loadPage('board.html', fakeServer(), '?surface=zoom', { globals: { zoomSdk } });
    close = () => loaded.window.close();
    await until(() => loaded.document.querySelector('#brand-meeting')!.textContent === 'Standup');
  });

  // Astra, 10/29: a lookup Zoom has not answered yet is not an answer; the header waits for Zoom.
  it('in Zoom, keeps Loading… in the header while Zoom is slow to say which meeting this is, then names it', async () => {
    const seen: string[] = [];
    const zoomSdk = {
      config: async () => ({}), getAppContext: async () => { throw new Error('not here'); },
      getMeetingUUID: () => new Promise((r) => setTimeout(() => r({ meetingUUID: 'old/er+==' }), 3500)),
    };
    const loaded = await loadPage('board.html', fakeServer(), '?surface=zoom', { globals: { zoomSdk } });
    close = () => loaded.window.close();
    const title = () => loaded.document.querySelector('#brand-meeting')!.textContent!;
    await until(() => { if (seen.at(-1) !== title()) seen.push(title()); return title() === 'Planning'; });
    expect(seen.filter(Boolean)).toEqual(['Loading…', 'Planning']);
  });

  // Review, 10/29: Zoom naming a meeting the board does not have (bwat never joined it) is an
  // answer too: the header goes blank, not Loading… for as long as the panel is open.
  it('in Zoom, leaves the header blank, not Loading…, when Zoom names a meeting the board does not have', async () => {
    const zoomSdk = {
      config: async () => ({}), getAppContext: async () => { throw new Error('not here'); },
      getMeetingUUID: async () => ({ meetingUUID: 'never/joined==' }),
    };
    const loaded = await loadPage('board.html', fakeServer(), '?surface=zoom', { globals: { zoomSdk } });
    close = () => loaded.window.close();
    const { window, document } = loaded;
    const answered = () => (window as unknown as { LIVE: { api: { zoomAnswered: boolean } } }).LIVE.api.zoomAnswered;
    await until(() => !document.getElementById('workspace')!.hidden && answered());
    await poll(window);
    expect(document.querySelector('#brand-meeting')!.textContent).toBe('');
  });

  // Astra, 10/29: a late answer does not take away a card the person has opened.
  it('in Zoom, keeps an open card when Zoom names another meeting late, and the header never names the wrong one', async () => {
    const seen: string[] = [];
    const zoomSdk = {
      config: async () => ({}), getAppContext: async () => { throw new Error('not here'); },
      // After the first render's wait for Zoom (study.js ZOOM_WAIT_MS).
      getMeetingUUID: () => new Promise((r) => setTimeout(() => r({ meetingUUID: 'old/er+==' }), 3500)),
    };
    const loaded = await loadPage('board.html', fakeServer(), `?surface=zoom&card=${CARD}`, { globals: { zoomSdk } });
    close = () => loaded.window.close();
    const { window, document } = loaded;
    const title = () => document.querySelector('#brand-meeting')!.textContent!;
    await until(() => !document.getElementById('workspace')!.hidden);
    // A poll before Zoom answers, so the one after it finds the feed unchanged.
    await poll(window);
    const answered = () => (window as unknown as { LIVE: { api: { zoomAnswered: boolean } } }).LIVE.api.zoomAnswered;
    await until(() => { if (seen.at(-1) !== title()) seen.push(title()); return answered(); });
    await new Promise((r) => setTimeout(r, 200));
    expect(new URLSearchParams(window.location.search).get('card')).toBe(CARD);
    expect(title()).toBe('Loading…');
    expect(seen.filter(Boolean)).toEqual(['Loading…']);
    // The next poll, with nothing new in the feed, moves the board to Zoom's meeting; the card stays.
    await poll(window);
    expect(title()).toBe('Planning');
    expect(new URLSearchParams(window.location.search).get('card')).toBe(CARD);
  });

  // Astra, 11/02: a failed SDK script is asked for again, so the panel still learns its meeting.
  // Review, 11/02: a lookup Zoom never answers is asked again, so the header is not stuck on Loading….
  it('in Zoom, asks Zoom again when its meeting lookup never answers, and names the meeting', async () => {
    let asks = 0;
    const zoomSdk = {
      config: async () => ({}), getAppContext: async () => { throw new Error('not here'); },
      getMeetingUUID: () => (++asks === 1 ? new Promise(() => {}) : Promise.resolve({ meetingUUID: 'old/er+==' })),
    };
    const loaded = await loadPage('board.html', fakeServer(), '?surface=zoom', { globals: { zoomSdk } });
    close = () => loaded.window.close();
    await until(() => loaded.document.querySelector('#brand-meeting')!.textContent === 'Planning', 18_000);
    expect(asks).toBe(2);
  }, 25_000);

  // Review, 11/02: the retry backs off, and a hidden panel asks for nothing until it is shown.
  it('in Zoom, asks for a failed SDK script again less and less often', async () => {
    const page = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !page.document.getElementById('workspace')!.hidden);
    const before = page.offsite.length;
    // At 3 s, then not again until 6 s after that.
    await new Promise((r) => setTimeout(r, 8000));
    expect(page.offsite.length).toBe(before + 1);
  }, 20_000);

  it('in Zoom, asks for a failed SDK script again only while the panel is shown', async () => {
    const page = await open('board.html', fakeServer(), '?surface=zoom');
    const { window, document } = page;
    await until(() => !document.getElementById('workspace')!.hidden);
    const before = page.offsite.length;
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new window.Event('visibilitychange'));
    };
    setHidden(true);
    await new Promise((r) => setTimeout(r, 4000));
    expect(page.offsite.length).toBe(before);
    setHidden(false);
    await until(() => page.offsite.length === before + 1);
  }, 20_000);

  it('in Zoom, asks Zoom again once its SDK is there after its script failed, and names the meeting', async () => {
    const { window, document } = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !document.getElementById('workspace')!.hidden);
    expect(document.querySelector('#brand-meeting')!.textContent).toBe('Loading…');
    Object.assign(window, { zoomSdk: {
      config: async () => ({}), getAppContext: async () => { throw new Error('not here'); },
      getMeetingUUID: async () => ({ meetingUUID: 'old/er+==' }),
    } });
    await until(() => document.querySelector('#brand-meeting')!.textContent === 'Planning');
  });

  // Zoom's SDK failing to load says nothing about the meeting.
  it('in Zoom, keeps Loading… in the header when Zoom’s SDK could not load', async () => {
    // The harness's Zoom SDK script fails at once (Pages).
    const { window, document } = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !document.getElementById('workspace')!.hidden);
    await poll(window);
    expect(document.querySelector('#brand-meeting')!.textContent).toBe('Loading…');
  });

  it('in Zoom, still asks Zoom which meeting this is when an old meeting link names one the board does not have', async () => {
    const notInMeeting = async () => { throw new Error('not in a meeting'); };
    const zoomSdk = { config: async () => ({}), getMeetingUUID: notInMeeting, getAppContext: notInMeeting };
    const loaded = await loadPage('board.html', fakeServer(), '?surface=zoom&meeting=gone%3D%3D', { globals: { zoomSdk } });
    close = () => loaded.window.close();
    await until(() => loaded.document.querySelector('#brand-meeting')!.textContent === 'Standup');
  });

  it('11 + 12 · in Zoom, the header names the meeting and a Live pill says it is live', async () => {
    const { document } = await open('board.html', fakeServer({ occurrence: 'zoom-occurrence==' }), '?surface=zoom');
    const pill = () => document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => !pill().hidden);
    expect(document.querySelector('#brand-meeting')!.textContent).toBe('Standup');
    expect(pill().textContent).toBe('Live');
    expect(pill().querySelector('.live-pill-dot')!.getAttribute('aria-hidden')).toBe('true');
    expect(pill().getAttribute('role')).toBe('status');
    // The pill says it in words, so the meeting line no longer repeats "Live".
    expect(document.querySelector('#meeting-meta')!.textContent).not.toContain('Live');
    // The word the card writer says stays on its own line under the lens.
    expect(document.querySelector('#meeting-meta #meta-status')).not.toBeNull();
    // Full board is an icon with its name kept, beside the signed-in name.
    expect(document.querySelector('#open-full')!.getAttribute('aria-label')).toBe('Full board');
    expect(document.querySelector('#viewer-name')).not.toBeNull();
  });

  it('12 · on the full board, the Live pill is plain status and goes when the meeting is not live', async () => {
    const server = fakeServer();
    const { document, window } = await open('board.html', server, `?source=${MEETING}`);
    const pill = () => document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => !pill().hidden);
    expect(pill().textContent).toBe('Live');
    expect(pill().getAttribute('role')).toBe('status');
    pill().click();
    expect(document.querySelector('#live-pop')).toBeNull();
    server.end();
    await poll(window);
    await until(() => pill().hidden);
  });

  // Asking bwat to leave ends the meeting's claim at once, so the feed stops calling it live
  // while bwat is still leaving: the pill keeps saying Leaving…, then Left, with no ended fade.
  it.each(['leaving', 'left'])('9 · keeps a pill that says %s after the meeting stops being live', async (state) => {
    const server = fakeServer({ occurrence: 'zoom-occurrence==' });
    const { document, window } = await open('board.html', server, '?surface=zoom');
    const pill = () => document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => !pill().hidden);
    // As zoom-invite.js marks it when the leave is confirmed, and once bwat confirms it has left.
    pill().dataset.state = state;
    // Its dot never starts the ended fade, not even for a moment.
    let faded = false;
    new window.MutationObserver(() => { faded ||= pill().classList.contains('quiet'); }).observe(pill(), { attributes: true });
    server.end();
    await poll(window);
    await new Promise((r) => setTimeout(r, 800));
    expect(faded).toBe(false);
    expect(pill().hidden).toBe(false);
    expect(pill().classList.contains('quiet')).toBe(false);
  });

  it('12 · shows no Live pill on a meeting that has ended', async () => {
    const { document } = await open('board.html', fakeServer(), `?source=${OLDER_MEETING}`);
    await until(() => document.querySelector('#page-title')!.textContent!.includes('Planning'));
    expect(document.querySelector<HTMLElement>('#live-pill')!.hidden).toBe(true);
  });

  it('17 · keeps the footer open on the cards that need you, and on no others', async () => {
    const { document } = await open('board.html', fakeServer({ askedOpen: true }));
    await until(() => !!cardEl(document, CARD_OWNED) && !!cardEl(document, QUESTION_NOW));
    // Your own unsent to-do, an unowned to-do and an unanswered question.
    expect(cardEl(document, CARD_OWNED)!.classList.contains('needs')).toBe(true);
    expect(cardEl(document, CARD)!.classList.contains('needs')).toBe(true);
    expect(cardEl(document, QUESTION_NOW)!.classList.contains('needs')).toBe(true);
    // The owner rides on the title line, hidden from screen readers (the footer and label name them).
    const owner = cardEl(document, CARD_OWNED)!.querySelector('.card-owner')!;
    expect(owner.textContent).toBe('A');
    expect(owner.getAttribute('aria-hidden')).toBe('true');
  });

  it('17 · lets the footer close once the card no longer needs you', async () => {
    const { document } = await open('board.html');
    await until(() => !!cardEl(document, QUESTION_NOW));
    // Answered before the page opened: nothing for you to do.
    expect(cardEl(document, QUESTION_NOW)!.classList.contains('needs')).toBe(false);
    await sendOwned(document);
    // Queued: sent, so the footer can close.
    await until(() => !!cardEl(document, CARD_OWNED)?.querySelector('.badge.queued'));
    expect(cardEl(document, CARD_OWNED)!.classList.contains('needs')).toBe(false);
  });

  it('17 · lets a card with only an auto-apply suggestion close its footer', async () => {
    // Nearly every to-do carries one ("leave", "investigate"): it is bwat's, not a thing for you to do.
    const { document } = await open('board.html', fakeServer({ ownedLifecycle: { auto_apply_confidence: 82, suggested_action: 'investigate' } }));
    await sendOwned(document);
    await until(() => !!cardEl(document, CARD_OWNED)?.querySelector('.badge.queued'));
    expect(cardEl(document, CARD_OWNED)!.classList.contains('needs')).toBe(false);
  });

  it('17 · lets a question another card answered close its footer', async () => {
    const { document } = await open('board.html', fakeServer({ askedByCard: true }));
    await until(() => !!cardEl(document, QUESTION_NOW));
    expect(cardEl(document, QUESTION_NOW)!.classList.contains('needs')).toBe(false);
  });

  it('the card ID line goes from every row in one meeting’s view', async () => {
    const { document } = await open('board.html', fakeServer(), `?source=${MEETING}&scope=team`);
    await until(() => !!cardEl(document, CARD_OWNED));
    // One meeting on screen: the line holds only the ID, so it is marked to go.
    expect(cardEl(document, CARD_OWNED)!.querySelector('.card-source')!.classList.contains('only-code')).toBe(true);
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    expect(css).toContain('body[data-view=desk] .card .card-source.only-code{display:none}');
  });

  it('drops the separator with the card ID when the meta line also names the meeting', async () => {
    const { document } = await open('board.html', fakeServer(), '?source=all&scope=team');
    await until(() => !!cardEl(document, CARD_OWNED));
    // Several meetings on screen: the line names the meeting, then the separator and the ID.
    const line = cardEl(document, CARD_OWNED)!.querySelector('.card-source')!;
    expect(line.classList.contains('only-code')).toBe(false);
    expect(line.querySelector('.card-sep')!.textContent).toBe(' · ');
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    expect(css).toContain('body[data-view=desk] .card .card-sep{display:none}');
  });

  it('11 · in Zoom, a signed-in name is the header’s initial only: the name’s button lies invisible over it', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    const rule = /body\.surface-zoom \.viewer-label\.locked \.viewer-name\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/position:absolute;inset:0/);
    expect(rule).toMatch(/opacity:0/);
  });

  it('20 · on the full board the columns narrow and then wrap to fit, rather than scroll sideways', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    expect(/body:not\(\.surface-zoom\)\[data-view=desk\] \.desk-columns\{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/flex-wrap:wrap/);
    expect(/body:not\(\.surface-zoom\)\[data-view=desk\] \.desk-column\{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/flex:1 1 \d+px/);
  });

  it('16 + 17 · keeps a row’s title clear of the owner’s initial and the menu: the row rule sets no right padding', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    const rule = /\.desk-column>\.card \.card-open\{([^}]*)\}/.exec(css)![1]!;
    expect(rule).not.toMatch(/padding(-right)?:/);
  });

  it('20 · turns a column off and back on from its chip, one control both ways', async () => {
    const { document } = await open('board.html');
    await until(() => !!document.querySelector('#heading-do'));
    const chip = () => document.querySelector('#type-chips #column-risk') as HTMLButtonElement;
    expect(chip().textContent).toBe('Risks');
    expect(chip().getAttribute('aria-pressed')).toBe('false');
    chip().click();
    expect(document.querySelector('#heading-risk')).not.toBeNull();
    expect(chip().getAttribute('aria-pressed')).toBe('true');
    chip().click();
    expect(document.querySelector('#heading-risk')).toBeNull();
    expect(chip().getAttribute('aria-pressed')).toBe('false');
  });
});

// The subtraction pass: each thing on a card or in the reader says itself once, and teaches nothing.
describe('saying it once', () => {
  const css = (file: string) => readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', file), 'utf8');
  /** Opens a card in the reader and returns the reader. */
  async function read(document: Document, id: string) {
    await until(() => !!document.querySelector(`[data-open="${id}"]`));
    (document.querySelector(`[data-open="${id}"]`) as HTMLElement).click();
    await until(() => document.querySelector('#reader #detail-title') !== null);
    return document.querySelector('#reader')!;
  }
  const actions = (reader: Element) => [...reader.querySelectorAll('.action-row button')].map((b) => b.textContent);

  it('shows an answered question as "Answered by T-1" alone, dimmed: no Answered chip, no Clarified badge, no tick', async () => {
    const { document } = await open('board.html', fakeServer(), '?scope=team&cols=do,ask');
    await until(() => !!cardEl(document, QUESTION_NOW));
    const face = cardEl(document, QUESTION_NOW)!;
    expect(face.querySelector('.card-rel')!.textContent).toBe('Answered by T-1');
    expect(face.querySelector('.state-chip, .badge')).toBeNull();
    expect(face.textContent).not.toMatch(/Clarified|Answered(?! by)/);
    expect(face.querySelector('.type-icon')!.getAttribute('data-answered')).toBeNull();
    expect(face.classList.contains('answered')).toBe(true);
    expect(css('t4/lifecycle.css')).toMatch(/\.card\.answered>:is\(\.card-open,\.card-rel\)\{opacity:\.55\}/);
  });

  it('dims a question answered in words alone, with no card to name', async () => {
    const { document } = await open('board.html', fakeServer({ askedClosedByBwat: 'answered' }), '?scope=team&cols=do,ask');
    await until(() => !!cardEl(document, QUESTION_NOW));
    expect(cardEl(document, QUESTION_NOW)!.classList.contains('answered')).toBe(true);
    expect(cardEl(document, QUESTION_NOW)!.textContent).not.toContain('Clarified');
  });

  it('keeps an open question undimmed', async () => {
    const { document } = await open('board.html', fakeServer({ askedOpen: true }), '?scope=team&cols=do,ask');
    await until(() => !!cardEl(document, QUESTION_NOW));
    expect(cardEl(document, QUESTION_NOW)!.classList.contains('answered')).toBe(false);
  });

  it('hides answered questions inside Zoom, where the ? tab says they are on the full board', async () => {
    const { document } = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !!document.querySelector('#tab-ask'));
    (document.querySelector('#tab-ask') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#heading-ask'));
    const column = document.querySelector('#heading-ask')!.closest('section')!;
    expect(cardEl(document, QUESTION_NOW)).toBeNull();
    expect(column.querySelector('.column-empty')!.textContent).toBe('All answered — they’re on the full board.');
    // Nothing to switch inside Zoom: the drawer has no Answered questions.
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    expect(document.querySelector('#setting-answered')).toBeNull();
  });

  it('shows an open question inside Zoom', async () => {
    const { document } = await open('board.html', fakeServer({ askedOpen: true }), '?surface=zoom');
    await until(() => !!document.querySelector('#tab-ask'));
    (document.querySelector('#tab-ask') as HTMLButtonElement).click();
    await until(() => !!cardEl(document, QUESTION_NOW));
  });

  it('puts an unowned to-do’s Take it on its title row inside Zoom', async () => {
    const { document } = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !!document.querySelector(`[data-take="${CARD}"]`));
    expect(cardEl(document, CARD)!.classList.contains('take-row')).toBe(true);
    expect(cardEl(document, CARD_OWNED)!.classList.contains('take-row')).toBe(false);
    expect(css('soft.css')).toMatch(/body\.surface-zoom \.card\.take-row>\.card-foot\{[^}]*position:absolute/);
  });

  // Answered is answered, however: by a card linked as its answer or in words. Its row has no Answer, and
  // its opened card no answer form; an open question keeps both.
  it.each([
    ['by a linked card', { askedByCard: true }],
    ['in words and by a card', {}],
  ])('offers no Answer on a question answered %s, and no answer form when it is opened', async (_how, opts) => {
    const { document } = await open('board.html', fakeServer(opts), '?scope=team&cols=do,ask');
    await until(() => !!cardEl(document, QUESTION_NOW));
    expect(cardEl(document, QUESTION_NOW)!.classList.contains('answered')).toBe(true);
    expect(cardEl(document, QUESTION_NOW)!.querySelector(`#route-${QUESTION_NOW}`)).toBeNull();
    const reader = await read(document, QUESTION_NOW);
    expect(reader.querySelector('.rel-line')!.textContent).toBe('Answered by T-1');
    expect(reader.querySelector('#clarify-form')).toBeNull();
  });

  it('keeps Answer, and the answer form, on an open question', async () => {
    const { document } = await open('board.html', fakeServer({ askedOpen: true }), '?scope=team&cols=do,ask');
    await until(() => !!cardEl(document, QUESTION_NOW));
    expect(cardEl(document, QUESTION_NOW)!.querySelector(`#route-${QUESTION_NOW}`)!.textContent).toBe('Answer');
    expect((await read(document, QUESTION_NOW)).querySelector('#clarify-form')).not.toBeNull();
  });

  it('opens an unowned to-do with Take it and a greyed Send that says why, and no teaching text', async () => {
    const { document, server } = await open('board.html');
    const reader = await read(document, CARD);
    expect(reader.querySelector('.detail-meta')!.textContent).toBe('No owner named');
    expect(actions(reader)).toEqual(['Take it', 'Send to Claude', 'Change owner', 'Done', 'Won’t do']);
    const send = reader.querySelector('#send-open')!;
    expect([send.getAttribute('aria-disabled'), send.getAttribute('title')]).toEqual(['true', 'Assign it to yourself to send it to Claude']);
    expect(visibleText(document)).not.toMatch(/Assign it to yourself|close this card for everyone|Undo stays|No owner required/);
    expect(reader.querySelector('#close-note, .detail-facts')).toBeNull();
    expect([...reader.querySelectorAll('summary')].map((x) => x.textContent)).not.toContain('Details');
    (reader.querySelector(`[data-take="${CARD}"]`) as HTMLButtonElement).click();
    await until(() => writes(server.calls).some((c) => c.path === `/v1/cards/${CARD}/owner`));
  });

  it('says no status for an open card and no owner for a question', async () => {
    const { document } = await open('board.html', fakeServer({ askedOpen: true }), '?scope=team&cols=do,ask');
    const reader = await read(document, QUESTION_NOW);
    expect(reader.querySelector('.detail-meta')).toBeNull();
    expect(reader.textContent).not.toMatch(/No owner required|•\s*Open/);
  });

  it('opens a card in Zoom under just ← Back and its ⋯', async () => {
    const { document } = await open('board.html', fakeServer(), '?surface=zoom');
    const reader = await read(document, CARD_OWNED);
    const top = reader.querySelector('.reader-top')!;
    expect(top.querySelector('#close-reader')!.textContent).toBe('← Back');
    expect(top.querySelector('.reader-meeting, .badge')).toBeNull();
    expect(top.querySelector('.more-button')).not.toBeNull();
  });

  it('says a single relation as a plain line, and keeps the list for two or more', async () => {
    const { document } = await open('board.html', fakeServer(), '?scope=team&cols=do,ask');
    const reader = await read(document, QUESTION_NOW);
    const line = reader.querySelector('.rel-line')!;
    expect(line.textContent).toBe('Answered by T-1');
    expect(line.closest('details')).toBeNull();
    expect(reader.textContent).not.toContain('Related');
    close?.();
    const merged = await open('board.html', fakeServer({ merged: true }));
    const both = await read(merged.document, CARD);
    expect(both.querySelector('details.detail-disclosure > summary')!.textContent).toBe('Related · 2');
  });

  // Evidence from more than one meeting opens with a "Source:" line; the quote is still the first one said.
  it('quotes the first thing said, by its speaker, when the evidence spans meetings', async () => {
    const { document } = await open('board.html', fakeServer({ crossMeetingEvidence: true }));
    const reader = await read(document, CARD);
    const quote = reader.querySelector('.quote-preview > p')!;
    expect([quote.querySelector('.quote-speaker')!.textContent, quote.querySelector('.quote-hl')!.textContent]).toEqual(['Ada Lovelace', '“ship it on friday”']);
  });

  it('quotes the evidence on a neutral highlight, its speaker outside it', async () => {
    const { document } = await open('board.html');
    const reader = await read(document, CARD);
    const quote = reader.querySelector('.quote-preview > p')!;
    expect(quote.querySelector('.quote-speaker')!.textContent).toBe('Ada Lovelace');
    expect(quote.querySelector('.quote-hl')!.textContent).toBe('“ship it on friday”');
    expect(css('delight.css')).toMatch(/\.quote-hl\{background-image:linear-gradient\(var\(--sf-fill\),var\(--sf-fill\)\)/);
  });
});

// The admin's Recent meetings link a meeting's board as ?meeting=<id>.
describe('a link to one meeting', () => {
  it('opens the board on the meeting it names, by its id', async () => {
    const { document, window } = await open('board.html', fakeServer(), `?meeting=${OLDER_MEETING}`);
    await until(() => document.querySelector('#page-title')!.textContent!.startsWith('Planning · '));
    const q = new URLSearchParams(window.location.search);
    expect([q.get('source'), q.get('meeting')]).toEqual([OLDER_MEETING, null]);
  });

  it('opens the normal view for an id it does not know', async () => {
    const { document, window } = await open('board.html', fakeServer(), '?meeting=00000000-0000-4000-8000-000000000000');
    await until(() => document.querySelector('#page-title')!.textContent!.startsWith('Standup · '));
    expect(new URLSearchParams(window.location.search).get('meeting')).toBeNull();
  });
});

// The Live pill means bwat is in the meeting: Live only while a bot is in the live meeting, a muted
// "bwat not in meeting" while the meeting is live without one, and no pill once it has ended.
describe('the Live pill', () => {
  const pill = (document: Document) => document.querySelector<HTMLElement>('#live-pill')!;
  const shown = (document: Document) => [pill(document).hidden, pill(document).textContent, pill(document).classList.contains('absent')];

  it('says Live on the full board while a bot is in the live meeting', async () => {
    const { document, window } = await open('board.html', fakeServer(), `?source=${MEETING}`);
    expect((await sharedFeedOf<{ sources: Record<string, unknown> }>(window)).sources[MEETING]).toMatchObject({ live: true, bot: true });
    await until(() => !pill(document).hidden);
    expect(shown(document)).toEqual([false, 'Live', false]);
  });

  it('says "bwat not in meeting", muted, on the full board while the meeting is live without one', async () => {
    const { document, window } = await open('board.html', fakeServer({ botPresent: false }), `?source=${MEETING}`);
    expect((await sharedFeedOf<{ sources: Record<string, unknown> }>(window)).sources[MEETING]).toMatchObject({ live: true, bot: false });
    await until(() => !pill(document).hidden);
    expect(shown(document)).toEqual([false, 'bwat not in meeting', true]);
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    expect(css).toMatch(/\.live-pill:is\(\.fading,\.absent\) \.live-pill-dot\{background:var\(--sf-faint\)\}/);
  });

  // Inside Zoom the panel's own check of the meeting answers first, before the board's next read.
  it.each([
    ['bwat not in meeting', { botJoinedAt: null, botPresent: true }, true],
    ['Live', { botJoinedAt: '2026-10-21T17:02:00.000Z', botPresent: false }, false],
  ] as const)('says %s inside Zoom as the meeting check finds bwat', async (words, options, absent) => {
    const { document, window } = await open('board.html', fakeServer({ occurrence: 'zoom-occurrence==', ...options }), '?surface=zoom');
    (window as unknown as { zoomSdk: object }).zoomSdk = { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) };
    await until(() => pill(document).textContent === words, 9000);
    expect(shown(document)).toEqual([false, words, absent]);
  }, 15_000);
});

describe('the Zoom panel, as the mock-up', () => {
  // One filter row: the type tabs, then Mine as a switch at the row's end; no Unassigned.
  it('puts the type tabs and a Mine switch on one row, in place of Mine / Everything / Unassigned', async () => {
    const { document, window } = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !!document.querySelector('#zoom-filter #zoom-mine'));
    const row = document.querySelector('#zoom-filter')!, mine = document.querySelector<HTMLInputElement>('#zoom-mine')!;
    expect(row.firstElementChild!.id).toBe('zoom-tabs');
    expect([mine.type, mine.getAttribute('role'), mine.checked, mine.closest('label')!.textContent]).toEqual(['checkbox', 'switch', false, 'Mine']);
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'live.css'), 'utf8');
    expect(css).toMatch(/body\.surface-zoom \.toolbar\{display:none\}/);
    mine.click();
    await until(() => new URLSearchParams(window.location.search).get('scope') === 'mine');
    expect(document.querySelector<HTMLInputElement>('#zoom-mine')!.checked).toBe(true);
    // Mine shows only Ada's own to-do.
    await until(() => !cardEl(document, CARD));
    expect(cardEl(document, CARD_OWNED)).not.toBeNull();
    document.querySelector<HTMLInputElement>('#zoom-mine')!.click();
    await until(() => new URLSearchParams(window.location.search).get('scope') === 'team');
    await until(() => !!cardEl(document, CARD));
  });

  it('moves between the tabs with the arrow keys', async () => {
    const { document, window } = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !!document.querySelector('#tab-ask'));
    document.querySelector('#zoom-tabs')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.querySelector('#tab-ask')!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement?.id).toBe('tab-ask');
    expect(document.querySelector('#heading-ask')).not.toBeNull();
  });

  // S15: never a blank page while the board loads: skeleton rows where the cards go, still under Reduce Motion.
  it('opens on skeleton rows, then the cards; a load that fails says so in their place', async () => {
    const page = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'board.html'), 'utf8');
    expect(page).toMatch(/<div id="loading" role="status" aria-busy="true"><h1 class="sr-only">Loading cards…<\/h1><div class="card-skeleton" aria-hidden="true">(<div class="card-skeleton-row"><i><\/i><i><\/i><\/div>){3}<\/div><\/div>/);
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{:root\[data-theme\] \.card-skeleton-row i\{animation:none\}\}/);
    const { document } = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !!cardEl(document, CARD));
    expect(document.querySelector<HTMLElement>('#loading')!.hidden).toBe(true);
    close?.();
    control.feedDown = 500;
    try {
      const failed = await open('board.html', fakeServer(), '?surface=zoom');
      await until(() => failed.document.querySelector('#loading h1')?.textContent === 'Couldn’t load the meeting record.');
      expect(failed.document.querySelector('#loading .card-skeleton')).toBeNull();
      expect(failed.document.querySelector('#loading')!.className).toBe('empty');
    } finally { control.feedDown = false; }
  });

  // A backend read that never answers ends at the page's own deadline in the load error, and the
  // board says it is done (LIVE.ready), so the panel's check is not held for ever.
  it.each(['GET /v1/members', 'GET /v1/meetings', 'GET /v1/cards/counts'])('ends in the load error when %s never answers', async (read) => {
    const { document, window } = await open('board.html', fakeServer({ occurrence: 'zoom-occurrence==', hung: [read] }), '?surface=zoom');
    let settled = false;
    void (window as unknown as { LIVE: { ready: Promise<void> } }).LIVE.ready.then(() => { settled = true; });
    await until(() => document.querySelector('#loading h1')?.textContent === 'Couldn’t load the meeting record.', 15_000);
    await until(() => settled);
  }, 25_000);

  // A read the board can do without (the shared order, the plugin list) ends at its deadline too: the
  // board loads without it, and LIVE.ready settles.
  it.each(['GET /v1/orders', 'GET /board-plugins'])('loads, and is ready by the deadline, when %s never answers', async (read) => {
    const { document, window } = await open('board.html', fakeServer({ occurrence: 'zoom-occurrence==', hung: [read] }), '?surface=zoom');
    let settled = false;
    void (window as unknown as { LIVE: { ready: Promise<void> } }).LIVE.ready.then(() => { settled = true; });
    await until(() => settled && !document.querySelector('.card-skeleton'), 15_000);
    expect(cardEl(document, CARD)).not.toBeNull();
  }, 25_000);

  // A plugin's sign-in waits for the plugin list however long it takes (it never runs as anyone else),
  // but no request waits past its own deadline: the load error, and the board is ready.
  it('ends a plugin sign-in’s page in the load error, as no one, when the plugin list never answers', async () => {
    const boardPlugins = { plugins: [{ name: 'probe', token: 'probe-sel', scripts: ['/plugins/probe/targets.js'] }], reserved: ['probe-sel'] };
    const { document, window, server } = await open('board.html', fakeServer({ boardPlugins, hung: ['GET /board-plugins'] }), '?surface=probe-sel');
    let settled = false;
    void (window as unknown as { LIVE: { ready: Promise<void> } }).LIVE.ready.then(() => { settled = true; });
    await until(() => settled && document.querySelector('#loading h1')?.textContent === 'Couldn’t load the meeting record.', 15_000);
    expect(server.calls.filter((c) => c.path.startsWith('/v1/') || c.path === '/whoami')).toEqual([]);
  }, 25_000);

  // S15: the meeting's shell as soon as the board knows its meetings, apart from its cards.
  it('shows the meeting’s name and the filter row, skeleton rows under them, while its cards are still being read', async () => {
    const { document, window } = await open('board.html', fakeServer({ occurrence: 'zoom-occurrence==', hung: [`GET /v1/occurrences/${MEETING}/cards`] }), '?surface=zoom');
    await until(() => document.querySelector('#brand-meeting')?.textContent === 'Standup');
    expect(document.querySelector('#zoom-filter #zoom-tabs [role=tab]')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('#workspace')!.hidden).toBe(false);
    expect(document.querySelector('.cards-pane > .card-skeleton')).not.toBeNull();
    expect(document.querySelector('#card-list article.card')).toBeNull();
    // The cards read that never answers ends at the page's deadline: the board is done, its rows gone.
    let settled = false;
    void (window as unknown as { LIVE: { ready: Promise<void> } }).LIVE.ready.then(() => { settled = true; });
    await until(() => settled && !document.querySelector('.card-skeleton'), 15_000);
  }, 25_000);

  // The panel's own answer is fresher than the board's read only while its checks work.
  it('follows the board’s read once the panel’s checks fail, not its last answer', async () => {
    const meetingBotDown = { on: false };
    const { document, window } = await open('board.html', fakeServer({ occurrence: 'zoom-occurrence==', botJoinedAt: '2026-10-21T17:02:00.000Z', botPresent: false, meetingBotDown }), '?surface=zoom');
    (window as unknown as { zoomSdk: object }).zoomSdk = { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) };
    const pill = () => document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => pill().textContent === 'Live', 9000);
    meetingBotDown.on = true;
    await until(() => pill().textContent === 'bwat not in meeting', 9000);
    expect(pill().classList.contains('absent')).toBe(true);
  }, 25_000);

  // A board that cannot read its meetings says so; the panel's check does not wait on it for ever.
  it('stops waiting for the meetings once the board says it could not load them', async () => {
    control.feedDown = 500;
    try {
      const { document, window, server } = await open('board.html', fakeServer({ occurrence: 'zoom-occurrence==' }), '?surface=zoom');
      (window as unknown as { zoomSdk: object }).zoomSdk = { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) };
      await until(() => document.querySelector('#loading')!.textContent!.includes('Couldn’t load the meeting record.'));
      const checks = () => server.calls.filter((c) => c.path === '/v1/zoom/meeting-bot').length;
      await until(() => checks() > 0, 9000);
      await new Promise((r) => setTimeout(r, 2000));
      expect(checks()).toBeLessThanOrEqual(2);
      expect(document.body.classList.contains('zoom-looking')).toBe(false);
    } finally { control.feedDown = false; }
  }, 20_000);

  it('shows Mine switched on for a link to Mine', async () => {
    const { document } = await open('board.html', fakeServer(), '?surface=zoom&scope=mine');
    await until(() => !!document.querySelector('#zoom-mine'));
    expect(document.querySelector<HTMLInputElement>('#zoom-mine')!.checked).toBe(true);
  });

  it('reads an Unassigned link as everyone’s cards inside Zoom', async () => {
    const { document, window } = await open('board.html', fakeServer(), '?surface=zoom&scope=unassigned');
    await until(() => !!cardEl(document, CARD_OWNED));
    expect(new URLSearchParams(window.location.search).get('scope')).toBeNull();
  });

  // Nobody's to-do comes first: it is the one that needs someone in the room. An order a person
  // dragged still wins, as it does over newest first.
  it('sorts an unowned to-do above an owned one inside Zoom, newest first on the full board, and a dragged order over both', async () => {
    const order = (document: Document) => [...document.querySelectorAll<HTMLElement>('#card-list article.card')].map((c) => c.dataset.card).filter((id) => id === CARD || id === CARD_OWNED);
    const shown = async (server: ReturnType<typeof fakeServer>, query: string) => {
      close?.();
      const { document } = await open('board.html', server, query);
      await until(() => !!cardEl(document, CARD) && !!cardEl(document, CARD_OWNED));
      return order(document);
    };
    expect(await shown(fakeServer({ handOrdered: false }), '?surface=zoom')).toEqual([CARD, CARD_OWNED]);
    expect(await shown(fakeServer({ handOrdered: false }), '?cols=do')).toEqual([CARD_OWNED, CARD]);
    expect(await shown(fakeServer(), '?surface=zoom')).toEqual([CARD_OWNED, CARD]);
  });

  it('names the meeting on the lens row, on one line cut short', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    const rule = /body\.surface-zoom \.brand-meeting\{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toMatch(/white-space:nowrap/);
    expect(rule).toMatch(/text-overflow:ellipsis/);
    expect(rule).not.toMatch(/flex:1 0 100%|line-clamp:2/);
  });

  it('offers Take it on an unowned to-do, sets the viewer as its owner, and shows no greyed Send', async () => {
    const { document, server } = await open('board.html');
    await until(() => !!document.querySelector(`[data-take="${CARD}"]`));
    const face = cardEl(document, CARD)!;
    expect(face.querySelector('select')).toBeNull();
    expect(face.querySelector(`[data-send="${CARD}"]`)).toBeNull();
    // Take it alone asks: no empty owner circle, no "No owner".
    expect(face.querySelector('.card-owner')).toBeNull();
    expect(face.querySelector('.card-foot .owner')!.textContent).toBe('');
    (face.querySelector(`[data-take="${CARD}"]`) as HTMLButtonElement).click();
    await until(() => writes(server.calls).some((c) => c.path === `/v1/cards/${CARD}/owner`));
  });

  it('leaves your own name off the footer of a card you own', async () => {
    const { document } = await open('board.html');
    await until(() => !!cardEl(document, CARD_OWNED));
    expect(cardEl(document, CARD_OWNED)!.querySelector('.card-foot .owner')!.innerHTML).toBe('');
  });

  it("names the owner, with their initial, in the footer of someone else's card", async () => {
    const bob = [200, { member: { id: BOB, email: 'bob@example.com', display_name: 'Bob', role: 'member' }, id_token: TOKEN, occurrence_id: null }] as [number, unknown];
    const { document } = await open('board.html', fakeServer({ whoami: bob }));
    await until(() => !!cardEl(document, CARD_OWNED)?.querySelector('.card-foot .avatar'));
    const owner = cardEl(document, CARD_OWNED)!.querySelector('.card-foot .owner')!;
    expect(owner.querySelector('.avatar')!.textContent).toBe('A');
    expect(owner.textContent).toBe('AAda');
  });

  it("writes an owner's initial as a capital letter, whatever case the name has", async () => {
    const { document } = await open('board.html', fakeServer({ adaName: 'ada' }));
    await until(() => !!cardEl(document, CARD_OWNED)?.querySelector('.card-owner'));
    expect(cardEl(document, CARD_OWNED)!.querySelector('.card-owner')!.textContent).toBe('A');
  });

  it("shows a card's label in the opened card", async () => {
    const { document } = await open('board.html');
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    (document.querySelector(`[data-open="${CARD}"]`) as HTMLElement).click();
    await until(() => document.querySelector('#reader .detail-source')?.textContent?.includes('T-1') ?? false);
  });

  it('marks a changed card with no "Updated" label', async () => {
    const server = fakeServer();
    const { document, window } = await open('board.html', server);
    await until(() => !!cardEl(document, CARD));
    server.edit({ title: 'Ship the release on Monday' });
    await poll(window);
    await until(() => cardEl(document, CARD)!.textContent!.includes('Ship the release on Monday'));
    expect(cardEl(document, CARD)!.classList.contains('is-changed')).toBe(true);
    expect(document.querySelector('.attention-pill')).toBeNull();
  });
});

describe('Settings: Answered questions', () => {
  it.each([
    ['typed on the board', {}],
    ['by another card', { askedByCard: true }],
    ['in the room, as bwat closed it', { askedClosedByBwat: 'answered' }],
  ] as const)('Hide takes an answered question off the full board (answered %s)', async (_how, opts) => {
    const { document } = await open('board.html', fakeServer(opts), '?scope=team&cols=do,ask');
    await until(() => !!cardEl(document, QUESTION_NOW));
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    (document.querySelector('#setting-answered') as HTMLInputElement).click();
    await until(() => !cardEl(document, QUESTION_NOW));
  });

  it('keeps a question bwat closed as dropped, not answered, under Hide', async () => {
    const { document } = await open('board.html', fakeServer({ askedClosedByBwat: 'dropped' }), '?scope=team&cols=do,ask');
    await until(() => !!cardEl(document, QUESTION_NOW));
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    (document.querySelector('#setting-answered') as HTMLInputElement).click();
    expect((document.querySelector('#setting-answered') as HTMLInputElement).checked).toBe(false);
    expect(cardEl(document, QUESTION_NOW)!.textContent).toContain('Closed by bwat');
  });
});

describe('the full board, as the mock-up', () => {
  it('puts a chip per type, its mark and its name, in the toolbar after Mine / Everything / Unassigned', async () => {
    const { document } = await open('board.html');
    await until(() => !!document.querySelector('#type-chips #column-do'));
    const bar = document.querySelector('#type-chips')!;
    expect(bar.previousElementSibling!.classList.contains('segmented')).toBe(true);
    const chips = [...bar.querySelectorAll('[data-col-toggle]')];
    expect(chips.map((b) => b.textContent)).toEqual(['To-dos', 'Questions', 'Risks', 'Decisions']);
    expect(chips.map((b) => b.querySelector('.type-icon')?.getAttribute('data-type'))).toEqual(['do', 'ask', 'risk', 'decided']);
    // The chips replace the sideways spines and the × in each column's heading.
    expect(document.querySelector('.desk-spines, .col-hide, .desk-column header [data-col-toggle]')).toBeNull();
  });

  // B6: each chip's tip counts its column's cards in this view; the chip itself shows no number.
  it('counts each column’s cards in its chip’s tip, never on the chip', async () => {
    const { document } = await open('board.html', fakeServer(), '?cols=do,ask,risk,decided');
    await until(() => !!document.querySelector('#heading-decided'));
    const counts = ['do', 'ask', 'risk', 'decided'].map((k) => document.querySelector(`#heading-${k}`)!.closest('.desk-column')!.querySelectorAll('article.card').length);
    expect(counts.some((n) => n > 0)).toBe(true);
    const chips = [...document.querySelectorAll<HTMLElement>('#type-chips [data-col-toggle]')];
    expect(chips.map((b) => b.title)).toEqual(['To-dos', 'Questions', 'Risks', 'Decisions'].map((name, i) => `Hide ${name} (${counts[i]})`));
    expect(chips.map((b) => b.textContent)).toEqual(['To-dos', 'Questions', 'Risks', 'Decisions']);
    // A column turned off is counted too, under Show.
    document.querySelector<HTMLButtonElement>('#column-risk')!.click();
    expect(document.querySelector<HTMLElement>('#column-risk')!.title).toBe(`Show Risks (${counts[2]})`);
  });

  it('draws the Zoom tabs and the web chips as one outlined set, the chosen one filled with its type tint', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    expect(css).toMatch(/button\.type-chip\{[^}]*border:1px solid var\(--sf-border\)/);
    expect(css).toMatch(/button\.type-chip:is\(\[aria-selected=true\],\[aria-pressed=true\]\)\{[^}]*background:var\(--arrive\)/);
    // Each unselected mark keeps its type colour on no tint, so the four read as one set of buttons.
    expect(css).toMatch(/\.type-chip \.type-icon \.ti-bg\{fill:transparent\}/);
  });

  it('dims the chosen chip\'s text a little in dark mode only, through one token', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    expect(css).toMatch(/button\.type-chip:is\(\[aria-selected=true\],\[aria-pressed=true\]\)\{[^}]*color:var\(--sf-chip-ink\)/);
    const light = css.slice(0, css.indexOf(':root[data-theme="dark"]{'));
    const dark = css.slice(css.indexOf(':root[data-theme="dark"]{'));
    expect(light).toMatch(/--sf-chip-ink:var\(--sf-ink\)/);
    expect(dark.slice(0, dark.indexOf('}'))).toMatch(/--sf-chip-ink:#d2d6dc/);
  });

  it('marks the chosen chip or tab with a Highlight border in high contrast, where tints are dropped', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    const forced = css.slice(css.lastIndexOf('@media(forced-colors:active)'));
    expect(forced).toMatch(/button\.type-chip:is\(\[aria-selected=true\],\[aria-pressed=true\]\)\{border-color:Highlight;border-width:2px\}/);
    expect(forced).toMatch(/\.type-chip \.type-icon \.ti-bg\{fill:Canvas\}/);
  });

  it('keeps the new-cards tint on a chip or tab under reduced motion, over the clear chip fill', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'pages', 'board', 'ui', 'soft.css'), 'utf8');
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion:reduce\)\{(.*)\}/g)].map((m) => m[1]).join('');
    expect(reduced).toMatch(/button\.type-chip\.has-news\{[^}]*background-color:var\(--arrive\)/);
  });

  it.each(['web', 'zoom'])('gives the %s filter buttons the one shared chip class', async (surface) => {
    const loaded = await loadPage('board.html', fakeServer(), `?surface=${surface}`);
    close = () => loaded.window.close();
    const { document } = loaded;
    const buttons = () => [...document.querySelectorAll(surface === 'zoom' ? '#zoom-tabs [role=tab]' : '#type-chips [data-col-toggle]')];
    await until(() => buttons().length > 0);
    expect(buttons().every((b) => b.classList.contains('type-chip'))).toBe(true);
  });

  it('tags an opened to-do "To-do", one card, not the column name "To-dos"', async () => {
    const { document } = await open('board.html');
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    (document.querySelector(`[data-open="${CARD}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#reader .reader-top .badge'));
    expect(document.querySelector('#reader .reader-top .badge')!.textContent).toBe('To-do');
  });

  it("shows no Send to Claude on a card someone else owns, rather than a greyed one", async () => {
    const { document } = await open('board.html', fakeServer({ lifecycle: { owner_member_id: BOB } }));
    await until(() => !!cardEl(document, CARD)?.querySelector('.card-owner'));
    expect(cardEl(document, CARD)!.querySelector(`[data-send="${CARD}"]`)).toBeNull();
    expect(cardEl(document, CARD_OWNED)!.querySelector(`[data-send="${CARD_OWNED}"]`)).not.toBeNull();
  });
});

describe('Risks and Decisions in the Zoom panel', () => {
  const tabNames = (document: Document) => [...document.querySelectorAll('#zoom-tabs [role=tab]')].map((t) => t.textContent);

  it('are off by default, and a Risks link opens on To-dos', async () => {
    const { document } = await open('board.html', fakeServer(), '?surface=zoom&cols=risk');
    await until(() => !!document.querySelector('#heading-do'));
    expect(tabNames(document)).toEqual(['To-dos', 'Questions']);
    expect(document.querySelector('#heading-risk')).toBeNull();
    expect(document.querySelector('#tab-do')!.getAttribute('aria-selected')).toBe('true');
  });

  it('are each turned on in Settings, and stay on for this person next time', async () => {
    const { document, window } = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !!document.querySelector('#tab-ask'));
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    const drawer = document.querySelector('#settings-dialog')!;
    expect(drawer.textContent).toMatch(/Risks tab[\s\S]*Decisions tab/);
    expect((drawer.querySelector('#setting-risk') as HTMLInputElement).checked).toBe(false);
    expect((drawer.querySelector('#setting-decided') as HTMLInputElement).checked).toBe(false);
    (drawer.querySelector('#setting-risk') as HTMLInputElement).click();
    expect(tabNames(document)).toEqual(['To-dos', 'Questions', 'Risks']);
    const kept = Object.fromEntries(Object.entries(window.localStorage));
    const again = await loadPage('board.html', fakeServer(), '?surface=zoom', { storage: kept });
    close = () => { window.close(); again.window.close(); };
    await until(() => !!again.document.querySelector('#tab-ask'));
    expect(tabNames(again.document)).toEqual(['To-dos', 'Questions', 'Risks']);
  });

  // Risks alone is covered above.
  it('adds only the Decisions tab when Decisions is turned on', async () => {
    const { document } = await open('board.html', fakeServer(), '?surface=zoom');
    await until(() => !!document.querySelector('#tab-ask'));
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    (document.querySelector('#setting-decided') as HTMLInputElement).click();
    expect(tabNames(document)).toEqual(['To-dos', 'Questions', 'Decisions']);
  });

  it('leave the full board as it was', async () => {
    const { document } = await open('board.html');
    await until(() => !!document.querySelector('#column-decided'));
    expect(document.querySelector('#column-risk')).not.toBeNull();
    (document.querySelector('#settings-open') as HTMLButtonElement).click();
    expect(document.querySelector('#settings-dialog')!.textContent).not.toMatch(/Risks tab|Decisions tab/);
  });
});

// B2: the full board says what narrows it, and an empty result names the cause.
describe('filters', () => {
  const chips = (document: Document) => [...document.querySelectorAll('#showing .showing-chip .showing-text')].map((c) => c.textContent);

  it('shows one line under the title, a chip per filter, and Clear filters resets them', async () => {
    const { document, window } = await open('board.html', fakeServer(), `?source=${MEETING}&scope=mine&q=ship`);
    const line = () => document.querySelector<HTMLElement>('#showing')!;
    await until(() => !line().hidden);
    expect(line().parentElement!.firstElementChild!.id).toBe('page-title');
    expect(line().firstChild!.textContent!.trim()).toBe('Showing:');
    // The meeting is the title's: no chip repeats it.
    expect(chips(document)).toEqual(['Mine', '“ship”']);
    line().querySelector<HTMLButtonElement>('.showing-clear')!.click();
    await until(() => line().hidden);
    const q = new URLSearchParams(window.location.search);
    expect([q.get('source'), q.get('scope'), q.get('q')]).toEqual(['all', 'team', null]);
  });

  it("removes one filter with its chip's ×, keeping the others", async () => {
    const { document, window } = await open('board.html', fakeServer(), `?source=${MEETING}&scope=mine&q=ship`);
    const line = () => document.querySelector<HTMLElement>('#showing')!;
    await until(() => !line().hidden);
    const x = line().querySelector<HTMLButtonElement>('[aria-label="Remove filter: Mine"]')!;
    x.click();
    await until(() => chips(document).join() === '“ship”');
    const q = new URLSearchParams(window.location.search);
    expect([q.get('source'), q.get('scope'), q.get('q')]).toEqual([MEETING, 'team', 'ship']);
    line().querySelector<HTMLButtonElement>('[aria-label="Remove filter: “ship”"]')!.click();
    await until(() => line().hidden);
    expect(new URLSearchParams(window.location.search).get('q')).toBeNull();
  });

  it("clears a plugin's narrowing with the view's ×, which it showed", async () => {
    const { document, window } = await open('board.html', fakeServer(), '?source=open&narrow=someplugin:1&scope=mine');
    const line = () => document.querySelector<HTMLElement>('#showing')!;
    await until(() => !line().hidden);
    line().querySelector<HTMLButtonElement>('[aria-label="Remove filter: Open to-dos"]')!.click();
    const q = new URLSearchParams(window.location.search);
    expect([q.get('source'), q.get('narrow'), q.get('scope')]).toEqual(['all', null, 'mine']);
  });

  // The Live pill says a meeting is being captured; the filters column does not say it again.
  it('says nothing about capture at the foot of the filters column', async () => {
    const { document } = await open('board.html');
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    expect(document.querySelector('#capture-status, #capture-dot')).toBeNull();
    expect(visibleText(document)).not.toMatch(/Capturing a meeting now|No meeting capturing|Checking capture/);
  });

  it('shows no line while nothing narrows the board', async () => {
    const { document } = await open('board.html', fakeServer(), '?source=all&scope=team');
    await until(() => document.body.textContent!.includes('Ship the release on Friday'));
    expect(document.querySelector<HTMLElement>('#showing')!.hidden).toBe(true);
  });

  // The meeting or view alone is what the title already says: no line for it.
  it.each([`?source=${MEETING}&scope=team`, '?when=week&scope=team'])('shows no line for a meeting or view alone (%s)', async (query) => {
    const { document } = await open('board.html', fakeServer(), query);
    await until(() => document.querySelector('#page-title')!.textContent !== 'Meetings');
    await until(() => !!document.querySelector('#card-list .desk-column, #card-list .empty'));
    expect(document.querySelector<HTMLElement>('#showing')!.hidden).toBe(true);
  });

  it('names Unassigned and a time window', async () => {
    const { document } = await open('board.html', fakeServer(), '?when=week&scope=unassigned');
    await until(() => !document.querySelector<HTMLElement>('#showing')!.hidden);
    expect(chips(document)).toEqual(['This week', 'Unassigned']);
  });

  it('names the cause when the filters leave nothing, with the buttons that fit', async () => {
    const { document, window } = await open('board.html', fakeServer(), `?source=${MEETING}&q=zzzz`);
    const empty = () => document.querySelector('#card-list .empty');
    const buttons = () => [...empty()!.querySelectorAll('button')].map((b) => b.textContent);
    await until(() => !!empty());
    expect(empty()!.querySelector('.eyebrow')).toBeNull();
    expect(empty()!.querySelector('h2')!.textContent).toBe('No cards match “zzzz” in Standup.');
    expect(buttons()).toEqual(['Search all meetings', 'Clear search']);
    empty()!.querySelector<HTMLButtonElement>('[data-empty="all"]')!.click();
    await until(() => empty()!.querySelector('h2')!.textContent === 'No cards match “zzzz”.');
    expect(new URLSearchParams(window.location.search).get('q')).toBe('zzzz');
    expect(buttons()).toEqual(['Clear search']);
    empty()!.querySelector<HTMLButtonElement>('[data-empty="search"]')!.click();
    await until(() => !empty());
    expect(new URLSearchParams(window.location.search).get('q')).toBeNull();
  });

  // A185 (20 Oct): filter cards by people, from the filters column's People group (the toolbar's
  // People list left on 27 Oct: the column filters people).
  describe('People', () => {
    // The column pinned open, as its People group is read.
    const openPinned = (server = fakeServer(), query = '') => open('board.html', server, query, false, { 'bwat.study.v1.board.nav': '"open"' });
    const person = (document: Document, name: string) =>
      document.querySelector<HTMLAnchorElement>(`#filter-groups [data-group="people"] a[data-value="${name}"]`);
    const shownCards = (document: Document) => [...document.querySelectorAll<HTMLElement>('#card-list [data-card]')].map((c) => c.dataset.card);

    it('has no People list in the toolbar', async () => {
      const { document } = await open('board.html');
      await until(() => document.body.textContent!.includes('Ship the release on Friday'));
      expect(document.querySelector('#person')).toBeNull();
    });

    it('shows only the cards of the person picked, through a refresh, and picking them again brings the rest back', async () => {
      const { document, window } = await openPinned(fakeServer(), '?scope=unassigned&type=do');
      await until(() => !!person(document, 'Ada'));
      person(document, 'Ada')!.click();
      // T-2 is hers, and Q-2 she said first.
      await until(() => shownCards(document).length === 2);
      expect(shownCards(document)).toEqual([CARD_OWNED, QUESTION_NOW]);
      const q = new URLSearchParams(window.location.search);
      // A person is everyone's cards narrowed to one: Unassigned gives way to Everything, all types.
      expect([q.get('person'), q.get('scope'), q.get('type')]).toEqual(['Ada', 'team', 'all']);
      expect(chips(document)).toContain('Ada');
      await poll(window);
      expect(shownCards(document)).toEqual([CARD_OWNED, QUESTION_NOW]);
      person(document, 'Ada')!.click();
      await until(() => shownCards(document).includes(CARD));
      expect(new URLSearchParams(window.location.search).get('person')).toBeNull();
      expect(document.querySelector<HTMLElement>('#showing')!.hidden).toBe(true);
    });

    // A185 (22 Oct): a question, risk or decision is also the person's who said it first (its
    // source quote's member, never the speaker's name); a to-do is only its owner's.
    it('adds what the person said first, never a to-do they do not own nor a quote no member said', async () => {
      const { document } = await openPinned(fakeServer({ askedEvidence: [
        { epoch: 0, seq: 70, speaker: 'Bob', speaker_member_id: null, quote: 'when do we freeze?' },
        { epoch: 0, seq: 71, speaker: 'Ada Lovelace', speaker_member_id: ADA, quote: 'good question' }] }));
      await until(() => !!person(document, 'Ada'));
      // T-1 is Ada's words first, but a to-do nobody owns; she speaks on Q-2 only second.
      person(document, 'Ada')!.click();
      await until(() => shownCards(document).length === 1);
      expect(shownCards(document)).toEqual([CARD_OWNED]);
      // Q-2's first speaker is named Bob, but no member: not Bob's.
      person(document, 'Bob')!.click();
      await until(() => !!document.querySelector('#card-list .empty'));
      expect(shownCards(document)).toEqual([]);
      expect(chips(document)).toContain('Bob');
    });
  });

  it('names Mine when your own cards are what is missing', async () => {
    const { document, window } = await open('board.html', fakeServer(), `?source=${OLDER_MEETING}&scope=mine`);
    const empty = () => document.querySelector('#card-list .empty');
    await until(() => !!empty());
    expect(empty()!.querySelector('h2')!.textContent).toBe('No to-dos of yours in Planning.');
    empty()!.querySelector<HTMLButtonElement>('button')!.click();
    await until(() => !empty());
    expect(new URLSearchParams(window.location.search).get('scope')).toBe('team');
  });
});

// A closed card's ⋯ menu offers Reopen, not a disabled Edit: T-1 closed with no response, as the
// card service lists a card nobody acted on, unless a test closes it another way.
describe('Reopen in a closed card’s ⋯ menu (board.html)', () => {
  const NO_RESPONSE = { status: 'no_response' };
  const closed = (more: Parameters<typeof fakeServer>[0] = {}) => fakeServer({ closed: NO_RESPONSE, ...more });
  const errSel = '.card-line.err', retrySel = '[data-note-retry]', back = 'Reopened: Ship the release on Friday.';
  async function menu(document: Document) {
    await until(() => !!document.querySelector(`#card-list [data-more="${CARD}"]`));
    document.querySelector<HTMLButtonElement>(`#card-list [data-more="${CARD}"]`)!.click();
    await until(() => !!document.querySelector('#more-menu'));
    return document.querySelector('#more-menu')!;
  }
  const reopened = (server: { calls: Call[] }) => writes(server.calls).filter((c) => c.path.endsWith('/unarchive'));
  const reads = (server: { calls: Call[] }) => server.calls.filter((c) => c.method === 'GET' && /^\/v1\/occurrences\/[^/]+\/cards$/.test(c.path)).length;

  it.each([
    ['Done', { status: 'done', done: true }],
    ['Won’t do, as bwat withdrew it', { status: 'wont_do', withdrawn: true }],
    ['with no response', NO_RESPONSE],
  ])('offers Reopen in place of Edit on a card closed as %s, and Reopen opens it again', async (_how, how) => {
    const { document, server } = await open('board.html', fakeServer({ closed: how }));
    const m = await menu(document);
    const item = m.querySelector<HTMLButtonElement>('#more-reopen')!;
    expect(item.textContent).toBe('Reopen');
    expect(item.getAttribute('role')).toBe('menuitem');
    expect(item.getAttribute('aria-disabled')).toBeNull();
    expect(m.querySelector('#more-edit')).toBeNull();
    expect(m.textContent).not.toContain('This card is closed');
    item.click();
    await until(() => said(document) === back);
    expect(document.querySelector('#more-menu')).toBeNull();
    expect(reopened(server).map((c) => c.body)).toEqual([{ revision: 3 }]);
    await until(() => !!cardEl(document, CARD)?.classList.contains('is-new'));
    expect(cardEl(document, CARD)!.classList.contains('done')).toBe(false);
  });

  it('sends one Reopen while the first is still on its way', async () => {
    let answer = () => {};
    const { document, server } = await open('board.html', closed({ unarchiveGate: new Promise<void>((r) => { answer = r; }) }));
    (await menu(document)).querySelector<HTMLButtonElement>('#more-reopen')!.click();
    await until(() => reopened(server).length === 1);
    (await menu(document)).querySelector<HTMLButtonElement>('#more-reopen')!.click();
    answer();
    await until(() => said(document) === back);
    expect(reopened(server)).toHaveLength(1);
    expect(cardEl(document, CARD)!.querySelector('.card-line')).toBeNull();
  });

  it('says a refused Reopen on the card, and Try again reopens it', async () => {
    const { document, server } = await open('board.html', closed({ unarchiveFailsOnce: true }));
    (await menu(document)).querySelector<HTMLButtonElement>('#more-reopen')!.click();
    await until(() => !!cardEl(document, CARD)?.querySelector(errSel));
    expect(cardEl(document, CARD)!.querySelector(errSel)!.firstChild!.textContent).toBe('internal');
    cardEl(document, CARD)!.querySelector<HTMLButtonElement>(retrySel)!.click();
    await until(() => said(document) === back);
    expect(reopened(server)).toHaveLength(2);
    await until(() => !cardEl(document, CARD)?.querySelector(errSel));
  });

  it('says a refused Reopen from the reader’s menu in the reader, and Try again reopens it', async () => {
    const { document } = await open('board.html', closed({ unarchiveFailsOnce: true }));
    await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
    document.querySelector<HTMLElement>(`[data-open="${CARD}"]`)!.click();
    await until(() => !!document.querySelector(`#reader [data-more="${CARD}"]`));
    document.querySelector<HTMLButtonElement>(`#reader [data-more="${CARD}"]`)!.click();
    await until(() => !!document.querySelector('#more-reopen'));
    document.querySelector<HTMLButtonElement>('#more-reopen')!.click();
    await until(() => !!document.querySelector(`#reader ${errSel}`));
    expect(document.querySelector(`#reader ${errSel}`)!.firstChild!.textContent).toBe('internal');
    document.querySelector<HTMLButtonElement>(`#reader ${retrySel}`)!.click();
    await until(() => said(document) === back);
  });

  it('names who changed the card first when a Reopen is stale, reloads it, and reopens at its new version', async () => {
    const { window, document, server } = await open('board.html', closed({ unarchiveStaleOnce: true, staleBy: 'Bob' }));
    ms(window).who = 50;
    const m = await menu(document), before = reads(server);
    m.querySelector<HTMLButtonElement>('#more-reopen')!.click();
    await until(() => reopened(server).length === 1);
    await until(() => !!cardEl(document, CARD)?.querySelector('.card-line.who'));
    expect(cardEl(document, CARD)!.querySelector('.card-line.who')!.textContent).toContain('Bob');
    await until(() => reads(server) > before);
    expect(said(document)).not.toBe(back);
    (await menu(document)).querySelector<HTMLButtonElement>('#more-reopen')!.click();
    await until(() => said(document) === back);
    expect(reopened(server).map((c) => c.body)).toEqual([{ revision: 3 }, { revision: 4 }]);
  });

  it('still says Sign in first to a viewer nobody signed in, with no Reopen', async () => {
    const { window, document } = await open('board.html', closed());
    await until(() => !!document.querySelector(`#card-list [data-more="${CARD}"]`));
    (window as unknown as { eval: (c: string) => unknown }).eval(`viewer=''`);
    const m = await menu(document);
    expect(m.querySelector('#more-reopen')).toBeNull();
    expect(m.querySelector('#more-edit')!.getAttribute('aria-disabled')).toBe('true');
    expect(m.textContent).toContain('Sign in first');
  });

  it('keeps Edit, and no Reopen, on an open card', async () => {
    const { document } = await open('board.html');
    const m = await menu(document);
    expect(m.querySelector('#more-reopen')).toBeNull();
    expect(m.querySelector('#more-edit')!.getAttribute('aria-disabled')).toBeNull();
  });
});

// Done on a card in the list once its session has read it: the reader's Done, without opening the card.
describe('Done on a card Claude has read (board.html)', () => {
  const READ = [{ handoff_id: HANDOFF, by_member_id: ADA, at: '2026-10-21T10:00:00+00:00', read_at: '2026-10-21T10:05:00+00:00' }];
  const QUEUED = [{ handoff_id: HANDOFF, by_member_id: ADA, at: '2026-10-21T10:00:00+00:00', read_at: null }];
  const errSel = '.card-line.err', retrySel = '[data-note-retry]', told = 'Done for everyone: Write the release notes.';
  const doneOn = (document: Document, id = CARD_OWNED) => document.querySelector<HTMLButtonElement>(`#card-list [data-card="${id}"] [data-done]`);
  const closes = (server: { calls: Call[] }) => writes(server.calls).filter((c) => c.path.endsWith('/archive'));
  afterEach(() => { control.ownedRouted = null; });
  async function shown(more: Parameters<typeof fakeServer>[0] = {}, query = '') {
    control.ownedRouted = READ;
    const loaded = await open('board.html', fakeServer(more), query);
    await until(() => !!doneOn(loaded.document));
    return loaded;
  }

  it('offers Done beside a read receipt, and Done closes the card into its row without opening it', async () => {
    const { document, server } = await shown();
    const b = doneOn(document)!;
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.textContent).toBe('Done');
    expect(b.getAttribute('aria-label')).toBe('Done: Write the release notes');
    expect(b.getAttribute('aria-disabled')).toBeNull();
    // Bottom left, styled as Send to Claude is; the Read receipt stays at the top.
    expect(b.parentElement!.classList.contains('card-foot')).toBe(true);
    expect(b.parentElement!.firstElementChild).toBe(b);
    expect(b.className).toBe(cardEl(document, CARD_OWNED)!.querySelector(`[data-send="${CARD_OWNED}"]`)!.className);
    expect(cardEl(document, CARD_OWNED)!.classList.contains('needs')).toBe(true);
    expect(cardEl(document, CARD_OWNED)!.querySelector('.card-head .badge.queued')!.textContent).toBe('Read');
    b.click();
    await until(() => !!document.querySelector(`#card-list [data-card="${CARD_OWNED}"].slim-row`));
    expect(closes(server).map((c) => c.body)).toEqual([{ revision: 7, outcome: 'done' }]);
    expect(said(document)).toBe(told);
    expect(document.querySelector('#reader')!.textContent).toBe('');
    expect(document.querySelector(`#card-list [data-card="${CARD_OWNED}"] [data-slim-undo]`)).not.toBeNull();
  });

  it('keeps the foot open on a card you sent once it is read, so its Done shows', async () => {
    const { window, document } = await open('board.html');
    await sendOwned(document);
    await until(() => said(document) === 'Queued.');
    expect(cardEl(document, CARD_OWNED)!.classList.contains('needs')).toBe(false);
    control.ownedRouted = READ;
    await poll(window);
    await until(() => !!doneOn(document));
    expect(cardEl(document, CARD_OWNED)!.classList.contains('needs')).toBe(true);
  });

  it('names the session alone when the read time cannot be read', async () => {
    const { window, document } = await open('board.html');
    await sendOwned(document);
    await until(() => said(document) === 'Queued.');
    control.ownedRouted = [{ ...READ[0], read_at: 'not a time' }];
    await poll(window);
    await until(() => !!doneOn(document));
    expect(cardEl(document, CARD_OWNED)!.querySelector('.badge.queued')!.textContent).toBe('Read by bwat repo @ ada-mac');
  });

  it('offers no Done while the receipt is Queued, nor on a card nobody sent', async () => {
    control.ownedRouted = QUEUED;
    const { document } = await open('board.html');
    await until(() => !!cardEl(document, CARD_OWNED)?.querySelector('.badge.queued'));
    expect(cardEl(document, CARD_OWNED)!.querySelector('.badge.queued')!.textContent).toBe('Queued');
    expect(doneOn(document)).toBeNull();
    expect(doneOn(document, CARD)).toBeNull();
  });

  it('offers no Done to a viewer nobody signed in', async () => {
    const { window, document } = await shown();
    (window as unknown as { eval: (c: string) => unknown }).eval(`viewer='';redraw()`);
    await until(() => !doneOn(document));
    expect(cardEl(document, CARD_OWNED)!.querySelector('.badge.queued')!.textContent).toBe('Read');
  });

  it('moves focus from a pressed Done to the list’s title, not to nothing', async () => {
    const { document } = await shown();
    doneOn(document)!.focus();
    doneOn(document)!.click();
    await until(() => !!document.querySelector(`#card-list [data-card="${CARD_OWNED}"].slim-row`));
    expect(document.activeElement!.id).toBe('results-title');
  });

  it('sends one close for a double click', async () => {
    const { document, server } = await shown();
    const b = doneOn(document)!;
    b.click();
    b.click();
    await until(() => said(document) === told);
    expect(closes(server)).toHaveLength(1);
  });

  it('says a refused Done on the card, and Try again closes it', async () => {
    const { document, server } = await shown({ archiveFailsOnce: true });
    doneOn(document)!.click();
    await until(() => !!cardEl(document, CARD_OWNED)?.querySelector(errSel));
    expect(cardEl(document, CARD_OWNED)!.querySelector(errSel)!.firstChild!.textContent).toBe('internal');
    expect(doneOn(document)).not.toBeNull();
    cardEl(document, CARD_OWNED)!.querySelector<HTMLButtonElement>(retrySel)!.click();
    await until(() => said(document) === told);
    expect(closes(server)).toHaveLength(2);
  });

  it('names who changed the card first when a Done is stale, and reloads it', async () => {
    const { window, document, server } = await shown({ archiveStaleOnce: true, staleBy: 'Bob' });
    ms(window).who = 50;
    doneOn(document)!.click();
    await until(() => !!cardEl(document, CARD_OWNED)?.querySelector('.card-line.who'));
    expect(cardEl(document, CARD_OWNED)!.querySelector('.card-line.who')!.textContent).toContain('Bob');
    await until(() => !!doneOn(document));
    doneOn(document)!.click();
    await until(() => said(document) === told);
    expect(closes(server).map((c) => c.body)).toEqual([{ revision: 7, outcome: 'done' }, { revision: 8, outcome: 'done' }]);
  });

  it('offers Done inside Zoom too, and it closes the card into its row', async () => {
    const { document, server } = await shown({}, '?surface=zoom');
    expect(doneOn(document)!.getAttribute('aria-label')).toBe('Done: Write the release notes');
    doneOn(document)!.click();
    await until(() => !!document.querySelector(`#card-list [data-card="${CARD_OWNED}"].slim-row`));
    expect(document.querySelector(`#card-list [data-card="${CARD_OWNED}"] [data-slim-undo]`)).not.toBeNull();
    expect(closes(server)).toHaveLength(1);
    expect(said(document)).toBe(told);
  });

  it('offers Done on a to-do only, not on a question Claude has read', async () => {
    control.ownedRouted = READ;
    const { document } = await open('board.html', fakeServer({ lifecycle: { routed: READ } }));
    await until(() => !!doneOn(document));
    await until(() => cardEl(document, QUESTION_NOW)?.querySelector('.badge.queued')?.textContent === 'Read');
    expect(doneOn(document, QUESTION_NOW)).toBeNull();
  });

  it('leaves another card’s open reader where it is', async () => {
    const { document } = await shown();
    document.querySelector<HTMLElement>(`[data-open="${CARD}"]`)!.click();
    await until(() => document.querySelector('#detail-title')?.textContent === 'Ship the release on Friday');
    doneOn(document)!.click();
    await until(() => said(document) === told);
    await until(() => !!document.querySelector(`#card-list [data-card="${CARD_OWNED}"].slim-row`));
    expect(document.querySelector('#detail-title')!.textContent).toBe('Ship the release on Friday');
    expect(new URLSearchParams(document.defaultView!.location.search).get('card')).toBe(CARD);
  });

  it('keeps the reader at Closing… while the card’s Done is on its way, and says its refusal there too', async () => {
    let answer = () => {};
    const { document, server } = await shown({ archiveFailsOnce: true, archiveGate: new Promise<void>((r) => { answer = r; }) });
    document.querySelector<HTMLElement>(`[data-open="${CARD_OWNED}"]`)!.click();
    await until(() => !!document.querySelector('#do-done'));
    doneOn(document)!.click();
    await until(() => closes(server).length === 1);
    document.querySelector<HTMLButtonElement>('#do-done')!.click();
    expect(document.querySelector('#action-status')!.textContent).toBe('Closing…');
    expect(document.querySelector('#do-done')!.getAttribute('aria-disabled')).toBe('true');
    answer();
    await until(() => !!document.querySelector(`#reader ${errSel}`));
    expect(document.querySelector(`#reader ${errSel}`)!.firstChild!.textContent).toBe('internal');
    expect(document.querySelector('#action-status')!.textContent).toBe('');
    expect(document.querySelector('#do-done')!.getAttribute('aria-disabled')).toBeNull();
    expect(closes(server)).toHaveLength(1);
  });

  it('keeps the reader’s refusal when its Try again finds a close already on its way', async () => {
    const { window, document, server } = await shown({ archiveFailsOnce: true });
    document.querySelector<HTMLElement>(`[data-open="${CARD_OWNED}"]`)!.click();
    await until(() => !!document.querySelector('#do-done'));
    document.querySelector<HTMLButtonElement>('#do-done')!.click();
    await until(() => !!document.querySelector(`#reader ${retrySel}`));
    (window as unknown as { eval: (c: string) => unknown }).eval(`CLOSING.set(${JSON.stringify(CARD_OWNED)},Promise.resolve(NOT_RUN))`);
    document.querySelector<HTMLButtonElement>(`#reader ${retrySel}`)!.click();
    await new Promise((r) => setTimeout(r, 200));
    // Nothing ran, so the refusal and its Try again are still there, as they were.
    expect((window as unknown as { eval: (c: string) => unknown }).eval(`NOTES.get(${JSON.stringify('reader:' + CARD_OWNED)}).text`)).toBe('internal');
    expect(document.querySelector(`#reader ${errSel}`)).not.toBeNull();
    expect(closes(server)).toHaveLength(1);
  });
});
