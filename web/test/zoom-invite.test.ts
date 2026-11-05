import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { fakeServer, loadPage, TOKEN, until } from './board-harness.ts';

const script = () => readFileSync(new URL('../pages/board/ui/zoom-invite.js', import.meta.url), 'utf8');
// The board's header as zoom-invite.js finds it: the lens the box copies, and the Live pill.
const PILL = '<span id="live-pill" class="live-pill" role="status"><span class="live-pill-dot" aria-hidden="true"></span><span class="live-pill-text">Live</span></span>';
const HEADER = `<header><a class="brand" href="board.html"><svg class="brand-lens" viewBox="0 0 68.84 68.84" aria-hidden="true"><path class="lens-arc" d="M0,0Z"/></svg></a>${PILL}</header><div id="alert" role="alert"></div>`;
const zoomPage = (main = '<main id="main"></main>') => new JSDOM(HEADER + main, { url: 'https://bwat.test/?surface=zoom', runScripts: 'outside-only', pretendToBeVisual: true });
// The board loads delight.js first; the box plays its moments through it, and says what bwat
// is doing through meeting-bot.js's Live pill.
const boot = (w: JSDOM['window']) => {
  w.eval(readFileSync(new URL('../pages/board/ui/delight.js', import.meta.url), 'utf8'));
  w.eval(readFileSync(new URL('../pages/board/ui/meeting-bot.js', import.meta.url), 'utf8'));
  w.eval(script());
};
type Bot = { current(): { joinedAt: string } | null; leave(): void };
const bot = (w: JSDOM['window']) => (w as unknown as { MEETING_BOT: Bot }).MEETING_BOT;
const inviteTitle = (w: JSDOM['window']) => w.document.querySelector('.invite-title')!.textContent;
// The status check's answer when bwat is not in the meeting.
const absent = async () => new Response(JSON.stringify({ state: 'absent', can_invite: true, occurrence_id: 'occ' }));
it('cancels timed-out status requests and the active request on page exit', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  let active = 0, peak = 0, calls = 0;
  Object.assign(dom.window, {
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async (_url: string, init?: RequestInit) => {
      calls++; active++; peak = Math.max(peak, active);
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        active--; reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true }));
    },
  });
  try {
    boot(dom.window);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(calls).toBeGreaterThan(1);
    expect(peak).toBe(1);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(0);
    const stoppedAt = calls;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(stoppedAt);
  } finally { dom.window.close(); vi.useRealTimers(); }
});

it('propagates cancellation through the real meeting-bot adapter', async () => {
  const fake = fakeServer();
  let signal: AbortSignal | null | undefined;
  const server = { ...fake, fetch: async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== '/v1/zoom/meeting-bot') return fake.fetch(url, init);
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () =>
      reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } };
  const page = await loadPage('board.html', server);
  try {
    const controller = new AbortController();
    const result = page.window.fetch('/meeting-bot', { method: 'POST', signal: controller.signal, body: JSON.stringify({ context: 'sealed' }) });
    await until(() => signal !== undefined);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
  } finally { page.window.close(); }
});

// Settings redesign B3/B4: a host or an admin asks bwat to leave from the board's Settings
// (settings.js); the Live pill is plain status. MEETING_BOT is the seam between them.
it('offers leave to a host or admin while bwat is in, and sends it only when asked, with fresh context', async () => {
  const dom = zoomPage();
  const w = dom.window;
  let leaves = 0, contexts = 0;
  Object.assign(w, {
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: `fresh-${++contexts}` }) },
    fetch: async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.leave) { leaves++; expect(body.context).toBe('fresh-2'); }
      return new Response(JSON.stringify(body.leave ? { state: 'leaving', can_leave: false } : { state: 'present', can_leave: true, joined_at: '2026-10-21T10:02:00.000Z' }));
    },
  });
  try {
    boot(w);
    const pill = w.document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => bot(w).current() !== null);
    expect(bot(w).current()).toEqual({ joinedAt: '2026-10-21T10:02:00.000Z' });
    expect(w.document.querySelector<HTMLElement>('.invite-box')!.hidden).toBe(true);
    // The pill is status only: a click opens nothing and asks nothing.
    pill.click();
    expect(w.document.querySelector('#live-pop')).toBeNull();
    expect(leaves).toBe(0);
    bot(w).leave();
    expect(pill.textContent).toBe('Leaving…');
    expect(pill.dataset.state).toBe('leaving');
    await until(() => leaves === 1);
    // Asked: nothing more to offer.
    expect(bot(w).current()).toBeNull();
  } finally { w.close(); }
});

it('says why a refused leave was refused beside the pill, which says Live again', async () => {
  const dom = zoomPage();
  const w = dom.window;
  let leaves = 0;
  Object.assign(w, {
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async (_url: string, init: RequestInit) => {
      if (JSON.parse(String(init.body)).leave) { leaves++; return new Response(JSON.stringify({ error: 'leave_forbidden' }), { status: 403 }); }
      return new Response(JSON.stringify({ state: 'present', can_leave: true }));
    },
  });
  try {
    boot(w);
    const pill = w.document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => bot(w).current() !== null);
    bot(w).leave();
    await until(() => leaves === 1 && !!w.document.querySelector('[data-line="pill"]'));
    const err = w.document.querySelector<HTMLElement>('[data-line="pill"]')!;
    expect(err.textContent).toBe('Only a bwat admin or the current Zoom host can ask bwat to leave.');
    expect(w.document.querySelector('#alert')!.textContent).toBe(err.textContent);
    // Asking again would be refused the same way: nothing to try again.
    expect(err.querySelector('button')).toBeNull();
    expect(err.previousElementSibling).toBe(pill);
    expect(pill.textContent).toBe('Live');
    expect(pill.dataset.state).toBeUndefined();
  } finally { w.close(); }
});

it('asks once the status check in flight has answered, so that answer cannot undo Leaving…', async () => {
  const dom = zoomPage();
  const w = dom.window;
  let leaves = 0, polls = 0, answer: (() => void) | null = null;
  Object.assign(w, {
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async (_url: string, init: RequestInit) => {
      if (JSON.parse(String(init.body)).leave) { leaves++; return new Response(JSON.stringify({ state: 'leaving', can_leave: false })); }
      // The second check is held, so the leave is asked while it is out.
      if (++polls === 2) await new Promise<void>((r) => { answer = r; });
      return new Response(JSON.stringify({ state: 'present', can_leave: true }));
    },
  });
  try {
    boot(w);
    const pill = w.document.querySelector<HTMLElement>('#live-pill')!;
    await until(() => bot(w).current() !== null);
    await until(() => answer !== null, 8000);
    bot(w).leave();
    expect(leaves).toBe(0);
    answer!();
    await until(() => leaves === 1);
    expect(pill.textContent).toBe('Leaving…');
  } finally { w.close(); }
});

it('offers a member no leave, and a host none until bwat is in', async () => {
  const dom = zoomPage();
  const w = dom.window;
  let polls = 0, answer = { state: 'present', can_leave: false };
  Object.assign(w, {
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async () => { polls++; return new Response(JSON.stringify(answer)); },
  });
  try {
    boot(w);
    await until(() => polls > 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(bot(w).current()).toBeNull();
    // A host, while bwat is still on its way (the server's can_leave is already true).
    answer = { state: 'joining', can_leave: true };
    await until(() => polls > 1, 8000);
    await new Promise((r) => setTimeout(r, 0));
    expect(bot(w).current()).toBeNull();
  } finally { w.close(); }
});

// Moment 9, the dot goes quiet: only once bwat confirms it has left (a later status check, not
// the click or the leave answer), the pill reads Left, its dot fades and one line says what was kept.
it('9 · says Left, and what was kept, only once bwat confirms it has left', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  const w = dom.window;
  let state = 'present';
  Object.assign(w, {
    LIVE: { api: { zoom: true }, sourceForMeeting: () => 'meeting-1' },
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async (_url: string, init: RequestInit) => {
      if (JSON.parse(String(init.body)).leave) state = 'leaving';
      return new Response(JSON.stringify({ state, can_leave: state === 'present', occurrence_id: 'occ' }));
    },
  });
  try {
    // The page's clock reads 10:42, so the line's time is pinned in the board's own time format.
    w.eval('Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(2026, 9, 20, 10, 42); } }');
    // The meeting's cards, as the desk holds them: two from this meeting, one from another.
    w.eval("var cards=[{from:'meeting-1'},{from:'meeting-1'},{from:'meeting-0'}]");
    boot(w);
    const pill = w.document.querySelector<HTMLElement>('#live-pill')!;
    const note = () => w.document.querySelector<HTMLElement>('.live-left-note');
    await vi.advanceTimersByTimeAsync(0);
    expect(bot(w).current()).not.toBeNull();
    bot(w).leave();
    await vi.advanceTimersByTimeAsync(0);
    // Asked, and the server took the request: still not left.
    expect(state).toBe('leaving');
    expect(pill.textContent).toBe('Leaving…');
    await vi.advanceTimersByTimeAsync(5000);
    expect(pill.classList.contains('fading')).toBe(false);
    expect(note()?.hidden ?? true).toBe(true);
    // bwat has disconnected: the next check says it is no longer in the meeting.
    state = 'absent';
    await vi.advanceTimersByTimeAsync(5000);
    expect(pill.textContent).toBe('Left');
    expect(pill.dataset.state).toBe('left');
    expect(pill.classList.contains('fading')).toBe(true);
    expect(note()!.getAttribute('role')).toBe('status');
    expect(note()!.textContent).toBe('bwat left at ' + new w.Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '. 2 cards and the transcript are kept.');
    expect(note()!.textContent).toContain('10:42');
    // Z3: above the invite box, which now says bwat isn't in.
    expect(note()!.nextElementSibling).toBe(w.document.querySelector('.invite-box'));
    // It plays once: the next check changes nothing.
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.document.querySelectorAll('.live-left-note')).toHaveLength(1);
    // Invited back in: the pill is Live again and the Left line goes with it.
    state = 'present';
    await vi.advanceTimersByTimeAsync(5000);
    expect(pill.textContent).toBe('Live');
    expect(note()).toBeNull();
  } finally { w.close(); vi.useRealTimers(); }
});

it('9 · never says Left for a bwat that was not asked to leave from this page', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  let state = 'present';
  Object.assign(dom.window, {
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async () => new Response(JSON.stringify({ state, can_leave: state === 'present' })),
  });
  try {
    boot(dom.window);
    await vi.advanceTimersByTimeAsync(0);
    state = 'absent';
    await vi.advanceTimersByTimeAsync(5000);
    const pill = dom.window.document.querySelector<HTMLButtonElement>('#live-pill')!;
    expect(pill.textContent).toBe('bwat not in meeting');
    expect(dom.window.document.querySelector('.live-left-note')).toBeNull();
  } finally { dom.window.close(); vi.useRealTimers(); }
});

it('identifies a Zoom SDK configuration failure without displaying raw error content', async () => {
  const dom = zoomPage();
  Object.assign(dom.window, { zoomSdk: { config: async () => { throw { code: 10013, message: 'private meeting content' }; } } });
  try {
    boot(dom.window);
    // C5: one plain line on screen; the stage and code are behind Details for whoever fixes it.
    const details = () => dom.window.document.querySelector<HTMLDetailsElement>('.invite-details')!;
    await until(() => !details().hidden);
    expect(details().textContent).toContain('Zoom setup failed (code 10013)');
    expect(dom.window.document.querySelector('.invite-text')!.textContent).toBe('bwat can’t check this meetingZoom didn’t start this board’s connection. Reopen bwat.');
    expect(dom.window.document.body.textContent).not.toContain('private meeting content');
  } finally { dom.window.close(); }
});
it('identifies a missing context API instead of the generic status-check error', async () => {
  const dom = zoomPage();
  Object.assign(dom.window, { zoomSdk: { config: async () => ({}) } });
  try {
    boot(dom.window);
    const details = () => dom.window.document.querySelector<HTMLDetailsElement>('.invite-details')!;
    await until(() => !details().hidden);
    expect(details().textContent).toContain('Zoom’s getAppContext is unavailable.');
    expect(dom.window.document.querySelector('.invite-text')!.textContent).not.toContain('getAppContext');
  } finally { dom.window.close(); }
});
it('the real board adapter authenticates the invitation and preserves its sealed context', async () => {
  const fake = fakeServer();
  let request: RequestInit | undefined;
  const server = { ...fake, fetch: async (url: string | URL, init?: RequestInit) => {
    if (String(url) === '/v1/zoom/meeting-bot') {
      request = init;
      return new Response(JSON.stringify({ state: 'queued', can_invite: false }));
    }
    return fake.fetch(url, init);
  } };
  const page = await loadPage('board.html', server);
  try {
    const result = await page.window.fetch('/meeting-bot', { method: 'POST', body: JSON.stringify({ context: 'signed-context', invite: true }) });
    expect(await result.json()).toEqual({ state: 'queued', can_invite: false });
    expect(new Headers(request?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(request?.body))).toEqual({ context: 'signed-context', invite: true });
  } finally { page.window.close(); }
});
it('offers an explicit invitation, forwards signed context without a link, and prevents double clicks', async () => {
  const dom = zoomPage();
  const w = dom.window;
  let state = 'absent', invites = 0;
  const calls: unknown[] = [];
  Object.assign(w, {
    LIVE: { api: { zoom: true } },
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed-current-meeting' }) },
    fetch: async (url: string, init?: RequestInit) => {
      if (url === '/whoami') return new Response(JSON.stringify({ id_token: 'member-token' }));
      const body = JSON.parse(String(init?.body)); calls.push(body);
      if (body.invite) { invites++; state = 'waiting_room'; }
      return new Response(JSON.stringify({ state, can_invite: state === 'absent' }));
    },
  });
  try {
    boot(w);
    await until(() => w.document.body.textContent!.includes('bwat isn’t in this meeting'));
    const button = w.document.querySelector<HTMLButtonElement>('.invite-button')!;
    button.click(); button.click();
    await until(() => w.document.body.textContent!.includes('bwat is in the waiting room'));
    expect(invites).toBe(1);
    expect(calls).toContainEqual({ context: 'sealed-current-meeting', invite: true });
    expect(button.hidden).toBe(true);
  } finally { w.close(); }
});

it('does not offer a simulated invitation in a browser or when context is unavailable', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  try {
    boot(dom.window);
    await vi.advanceTimersByTimeAsync(5000);
    expect(dom.window.document.body.textContent).toContain('Zoom is taking a while');
    expect(dom.window.document.querySelector<HTMLButtonElement>('.invite-button')!.hidden).toBe(true);
  } finally { dom.window.close(); vi.useRealTimers(); }
});

// The Zoom SDK arrives after the page, so on first open the panel said
// "Open bwat from a meeting" while it was still finding out. It says Loading… until it knows.
it('shows no box until the first answer when Zoom’s SDK and context arrive late', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  const w = dom.window;
  const later = <T,>(v: T, ms = 400) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  const zoomSdk = { config: () => later({}), getAppContext: () => later({ context: 'sealed' }) };
  Object.assign(w, {
    fetch: absent,
    // The board's loader: Zoom's script lands 1.2 s after the page.
    LIVE: { api: { zoom: true }, loadZoomSdk: () => later(null, 1200).then(() => { Object.assign(w, { zoomSdk }); }) },
  });
  try {
    boot(w);
    const $ = (s: string) => w.document.querySelector<HTMLElement>(s)!;
    const titles = [$('.invite-title').textContent];
    new w.MutationObserver(() => { if (titles.at(-1) !== $('.invite-title').textContent) titles.push($('.invite-title').textContent); })
      .observe($('.invite-title'), { childList: true, characterData: true, subtree: true });
    await vi.advanceTimersByTimeAsync(1900);
    // Zoom is still answering: no box says anything yet (S15), and nothing is offered.
    expect($('.invite-box').hidden).toBe(true);
    expect($('.invite-button').hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(titles.filter(Boolean)).toEqual(['bwat isn’t in this meeting']);
    expect($('.invite-box').hidden).toBe(false);
  } finally { w.close(); vi.useRealTimers(); }
});

it('on the board inside Zoom, asks for Zoom’s SDK at once, while the cards load', async () => {
  const fake = fakeServer();
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  // The meetings list (the first card read) waits until the test lets it go.
  const server = { ...fake, fetch: async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith('/v1/meetings?')) await held;
    return fake.fetch(url, init);
  } };
  const page = await loadPage('board.html', server, '?surface=zoom');
  try {
    const { document } = page;
    expect(page.offsite).toEqual(['https://appssdk.zoom.us/sdk.min.js']);
    expect(document.querySelector<HTMLElement>('.invite-box')!.hidden).toBe(true);
    expect(document.getElementById('loading')!.hidden).toBe(false);
    release();
    await until(() => document.getElementById('loading')!.hidden);
  } finally { release(); page.window.close(); }
});

// A missing SDK proves nothing about the meeting; only the server says outside_meeting.
it('says Zoom is taking a while, not that the panel is outside a meeting, once Zoom’s SDK has had five seconds to arrive', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  try {
    boot(dom.window);
    const title = () => inviteTitle(dom.window);
    await vi.advanceTimersByTimeAsync(4999);
    expect(dom.window.document.querySelector<HTMLElement>('.invite-box')!.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(title()).toBe('Zoom is taking a while');
    expect(dom.window.document.querySelector('.invite-line')!.textContent).toBe('Close and reopen bwat if this stays.');
    expect(dom.window.document.body.textContent).not.toContain('Open bwat from a meeting');
  } finally { dom.window.close(); vi.useRealTimers(); }
});

it.each([
  ['given', async () => ({ participantId: '16778240' }), { context: 'sealed', invite: false, participant_id: '16778240' }],
  ['refused', async () => { throw { code: 10002 }; }, { context: 'sealed', invite: false }],
  ['not a meeting user id', async () => ({ participantId: 'a-participant-id-zoom-may-one-day-send' }), { context: 'sealed', invite: false }],
])("sends the viewer's own Zoom participant id when Zoom has it (%s)", async (_case, getUserContext, expected) => {
  const dom = zoomPage();
  const bodies: unknown[] = [];
  let capabilities: string[] = [];
  Object.assign(dom.window, {
    zoomSdk: {
      config: async (options: { capabilities: string[] }) => { capabilities = options.capabilities; return {}; },
      getAppContext: async () => ({ context: 'sealed' }), getUserContext,
    },
    fetch: async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ state: 'present', can_invite: false }));
    },
  });
  try {
    boot(dom.window);
    await until(() => bodies.length > 0);
    expect(capabilities).toContain('getUserContext');
    expect(bodies[0]).toEqual(expected);
  } finally { dom.window.close(); }
});

it.each([
  ['refuses the capability', async (options: { capabilities: string[] }) => {
    if (options.capabilities.includes('getUserContext')) throw { code: 10047 };
    return {};
  }],
  ['reports it unsupported', async () => ({ unsupportedApis: ['getUserContext'] })],
])('runs the board as before when Zoom %s, without self-identifying', async (_case, config) => {
  const dom = zoomPage();
  const bodies: unknown[] = [];
  let asked = 0;
  Object.assign(dom.window, {
    zoomSdk: {
      config, getAppContext: async () => ({ context: 'sealed' }),
      getUserContext: async () => { asked++; return { participantId: '16778240' }; },
    },
    fetch: async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ state: 'absent', can_invite: true }));
    },
  });
  try {
    boot(dom.window);
    await until(() => dom.window.document.body.textContent!.includes('bwat isn’t in this meeting'));
    expect(dom.window.document.body.textContent).not.toContain('Zoom setup failed');
    expect(bodies[0]).toEqual({ context: 'sealed', invite: false });
    expect(asked).toBe(0);
  } finally { dom.window.close(); }
});

// Settings redesign C: the invite box. While bwat isn't in the meeting it is the panel's empty
// state: the lens, one plain line, one action and the three steps bwat walks in by. Copy, steps
// and moments 11-18 are the mock-up's; each moment follows a change the server has confirmed.
type Answer = Record<string, unknown> | [number, Record<string, unknown>];
function invitePage(answer: (body: { invite?: boolean; leave?: boolean }) => Answer, { role = 'member' as string | null, cards = '[]', reduced = false } = {}) {
  const dom = zoomPage('<main id="main" tabindex="-1"><div id="workspace"><div class="column-empty listening">Nothing yet.</div></div></main>');
  const w = dom.window;
  Object.assign(w, {
    LIVE: { api: { zoom: true, role, admin: role === 'owner' || role === 'admin' }, sourceForMeeting: () => 'meeting-1' },
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async (_url: string, init: RequestInit) => {
      const a = answer(JSON.parse(String(init.body)));
      const [status, json] = Array.isArray(a) ? a : [200, { occurrence_id: 'occ', ...a }];
      return new Response(JSON.stringify(json), { status });
    },
    ...(reduced ? { matchMedia: (q: string) => ({ matches: q.includes('reduce') }) } : {}),
  });
  w.eval('Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(2026, 9, 20, 10, 42); } }');
  w.eval(`var cards=${cards}`);
  boot(w);
  const $ = <T extends Element = HTMLElement>(s: string) => w.document.querySelector<T>(s);
  return {
    w, $,
    box: () => $('.invite-box')!,
    title: () => $('.invite-title')!.textContent,
    line: () => ($('.invite-line')!.hidden ? '' : $('.invite-line')!.textContent),
    button: () => $<HTMLButtonElement>('.invite-button')!,
    steps: () => [...w.document.querySelectorAll('.invite-steps li')].map((li) => li.textContent),
    now: () => [...w.document.querySelectorAll('.invite-steps li')].findIndex((li) => li.getAttribute('aria-current') === 'step'),
    pill: () => $('#live-pill')!,
  };
}

it('counts only the time the panel is shown towards Zoom’s five seconds', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  const w = dom.window;
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => hidden });
    w.document.dispatchEvent(new w.Event('visibilitychange'));
  };
  try {
    boot(w);
    const title = () => inviteTitle(w);
    await vi.advanceTimersByTimeAsync(1000);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(60_000);
    setHidden(false);
    // Back on screen: Zoom gets its five seconds again before the panel decides.
    await vi.advanceTimersByTimeAsync(4999);
    expect(w.document.querySelector<HTMLElement>('.invite-box')!.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(title()).toBe('Zoom is taking a while');
  } finally { w.close(); vi.useRealTimers(); }
});

it('checks once when Zoom’s SDK lands, with no second check when the five seconds end', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  const w = dom.window;
  let checks = 0;
  const zoomSdk = { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) };
  Object.assign(w, {
    fetch: async () => { checks++; return new Response(JSON.stringify({ state: 'absent', can_invite: true, occurrence_id: 'occ' })); },
    LIVE: { api: { zoom: true }, loadZoomSdk: () => new Promise<void>((r) => setTimeout(() => { Object.assign(w, { zoomSdk }); r(); }, 1000)) },
  });
  try {
    boot(w);
    await vi.advanceTimersByTimeAsync(5500);
    // The check when the SDK landed (1 s); the next is the usual one 5 s after it.
    expect(checks).toBe(1);
  } finally { w.close(); vi.useRealTimers(); }
});

it('says Zoom is taking a while at once when Zoom’s SDK could not load', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  // The board's loader answers once the script has loaded or failed; failed, there is no SDK.
  Object.assign(dom.window, { LIVE: { api: { zoom: true }, loadZoomSdk: async () => {} } });
  try {
    boot(dom.window);
    await vi.advanceTimersByTimeAsync(0);
    expect(dom.window.document.querySelector('.invite-title')!.textContent).toBe('Zoom is taking a while');
  } finally { dom.window.close(); vi.useRealTimers(); }
});

it('answers an SDK that arrives after the five seconds on the next check', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  const w = dom.window;
  Object.assign(w, { fetch: absent });
  try {
    boot(w);
    const title = () => inviteTitle(w);
    await vi.advanceTimersByTimeAsync(5000);
    expect(title()).toBe('Zoom is taking a while');
    Object.assign(w, { zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(title()).toBe('bwat isn’t in this meeting');
  } finally { w.close(); vi.useRealTimers(); }
});

// Astra, 10/29: an SDK landing after the guess took it back only once Zoom and bwat had answered.
it('goes back to Loading… while it checks an SDK that arrived after the five seconds', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  const w = dom.window;
  const later = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 400));
  Object.assign(w, { fetch: absent });
  try {
    boot(w);
    const title = () => inviteTitle(w);
    await vi.advanceTimersByTimeAsync(5000);
    expect(title()).toBe('Zoom is taking a while');
    Object.assign(w, { zoomSdk: { config: () => later({}), getAppContext: () => later({ context: 'sealed' }) } });
    // The next check finds the SDK (3 s on); Zoom is still answering it.
    await vi.advanceTimersByTimeAsync(3100);
    expect(title()).toBe('Loading…');
    await vi.advanceTimersByTimeAsync(1000);
    expect(title()).toBe('bwat isn’t in this meeting');
  } finally { w.close(); vi.useRealTimers(); }
});

it('shows no box through the first failed checks, and says so only after three', async () => {
  vi.useFakeTimers();
  const p = invitePage(() => [503, { error: 'unavailable' }]);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(p.box().hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.box().hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.title()).toBe('bwat can’t check this meeting');
  } finally { p.w.close(); vi.useRealTimers(); }
});

it.each([
  ['absent', true, false, 'bwat isn’t in this meeting', 'Invite it to turn what’s said into cards. Everyone here sees the same board.', 'Invite bwat', null],
  ['queued', false, false, 'bwat is on its way', 'It joins as soon as a bot is free.', null, [0, 'Waiting for a free bot']],
  ['waiting_for_host', false, false, 'bwat is on its way', 'It joins once the host starts the meeting.', null, [0, 'Waiting for the host']],
  ['joining', false, false, 'bwat is joining…', '', null, [1, 'Joining']],
  ['waiting_room', false, false, 'bwat is in the waiting room', 'Ask the host to admit it: Participants › Waiting room › Admit', null, [1, 'In the waiting room']],
  // 15: the host (or an admin: the server's can_leave) is spoken to.
  ['waiting_room', false, true, 'bwat is in the waiting room', 'Admit bwat: Participants › Waiting room › Admit', null, [1, 'In the waiting room']],
  ['checking', false, false, 'Checking bwat’s connection…', '', null, null],
  // Failed before this page saw bwat in, with no cards: it never joined.
  ['failed', true, false, 'bwat couldn’t join this meeting', '', 'Invite again', null],
  ['ended', false, false, 'This meeting has ended', '', null, null],
  ['outside_meeting', false, false, 'Open bwat from a meeting', 'Then you can invite it from here.', null, null],
  ['breakout', false, false, 'bwat stays in the main room', 'Return to the main meeting to see its cards.', null, null],
] as const)('C · draws %s (can_invite %s, can_leave %s) as one plain line and at most one action', async (state, canInvite, canLeave, title, line, button, step) => {
  vi.useFakeTimers();
  const p = invitePage(() => ({ state, can_invite: canInvite, can_leave: canLeave }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(p.box().hidden).toBe(false);
    expect(p.title()).toBe(title);
    expect(p.line()).toBe(line);
    expect(p.button().hidden ? null : p.button().textContent).toBe(button);
    // C4: the three steps, the one bwat stands on named by what it is waiting for.
    if (step) {
      const names: string[] = ['Invited', 'Joining', 'In the meeting'];
      names[step[0]] = step[1];
      expect(p.steps()).toEqual(names);
      expect(p.now()).toBe(step[0]);
      expect(p.w.document.querySelectorAll('.invite-steps li.done')).toHaveLength(step[0]);
      expect([...p.w.document.querySelectorAll('.invite-steps .invite-dot')].every((d) => d.getAttribute('aria-hidden') === 'true')).toBe(true);
    } else expect(p.$('.invite-steps')!.hidden).toBe(true);
    // C6: no fix button for anyone in a state with nothing to fix.
    expect(p.$('.invite-fix')!.hidden).toBe(true);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('C · shows nothing while bwat is leaving: the Live pill says so', async () => {
  vi.useFakeTimers();
  const p = invitePage(() => ({ state: 'leaving', can_invite: false }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(p.box().hidden).toBe(true);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('C1 · uses the board’s own colours, with a 36px button that grows to 44px on touch', () => {
  const css = readFileSync(new URL('../pages/board/ui/zoom-invite.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  expect(css).not.toContain('meeting-bot-notice');
  expect(css).toMatch(/\.invite-button\{[^}]*min-height:36px/);
  expect(css).toMatch(/@media \(pointer:coarse\)\{[^{]*\.invite-button[^{]*\{min-height:44px/);
  expect(css).toMatch(/@media \(pointer:coarse\)\{[^{]*\.invite-details summary[^{]*\{min-height:44px/);
});

it('C5 · a refused invitation keeps the button, says why in one plain line, and offers to try again', async () => {
  vi.useFakeTimers();
  const p = invitePage((b) => b.invite ? [409, { error: 'occurrence_conflict' }] : { state: 'absent', can_invite: true });
  try {
    await vi.advanceTimersByTimeAsync(0);
    p.button().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.title()).toBe('bwat couldn’t be invited');
    expect(p.line()).toBe('Another session of this meeting still has bwat. Try again shortly.');
    expect(p.button().hidden).toBe(false);
    expect(p.button().textContent).toBe('Try again');
  } finally { p.w.close(); vi.useRealTimers(); }
});

it.each([
  ['admin', 'Zoom’s server-to-server app isn’t connected, so bwat can’t look up this meeting.', true],
  ['owner', 'Zoom’s server-to-server app isn’t connected, so bwat can’t look up this meeting.', true],
  ['member', 'Ask an admin to connect Zoom’s server-to-server app to bwat.', false],
] as const)('C6 + 18 · zoom_lookup_not_configured gives a %s the right door, and stays until the answer changes', async (role, line, door) => {
  vi.useFakeTimers();
  let state = 'absent';
  const p = invitePage((b) => b.invite ? [503, { error: 'zoom_lookup_not_configured' }] : { state, can_invite: state === 'absent' }, { role });
  try {
    await vi.advanceTimersByTimeAsync(0);
    p.button().click();
    await vi.advanceTimersByTimeAsync(0);
    const fix = p.$<HTMLAnchorElement>('.invite-fix')!;
    const check = () => {
      expect(p.title()).toBe('bwat can’t be invited yet');
      expect(p.line()).toBe(line);
      expect(fix.hidden).toBe(!door);
      expect(p.button().hidden).toBe(true);
    };
    check();
    // The admin panel opens on Connections, at the server-to-server row.
    expect([fix.textContent, fix.getAttribute('href'), fix.target]).toEqual(['Connect it in Connections ↗', '/admin/#/settings?place=connections&row=zoom-s2s', '_blank']);
    expect(fix.querySelector('[aria-hidden="true"]')?.textContent).toBe('↗');
    // Zoom's own browser does not follow a new-tab link: the click opens it through Zoom (bwat-api.js).
    const opened: string[] = [];
    Object.assign(p.w, { bwatHelpers: { openInBrowser: (url: string) => opened.push(url) } });
    const click = new p.w.MouseEvent('click', { bubbles: true, cancelable: true });
    fix.dispatchEvent(click);
    expect([opened, click.defaultPrevented]).toEqual([['https://bwat.test/admin/#/settings?place=connections&row=zoom-s2s'], true]);
    await vi.advanceTimersByTimeAsync(5000);
    check();
    state = 'queued';
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.title()).toBe('bwat is on its way');
    expect(fix.hidden).toBe(true);
  } finally { p.w.close(); vi.useRealTimers(); }
});

// Every moment has a Reduce Motion version: what moves in the box is still under reduce.
const stillUnderReduce = () => {
  const css = readFileSync(new URL('../pages/board/ui/zoom-invite.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return /@media \(prefers-reduced-motion:reduce\)\{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? '';
};

// S15: the panel opens on the meeting. The first check waits for the board (LIVE.ready: its meetings
// read, or its load error shown), so the board has drawn the meeting it was opened from; no box until
// the check answers.
it('15 · checks nothing, and shows no box, until the board has read its meetings', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  const w = dom.window;
  let ready: () => void = () => {};
  let checks = 0;
  Object.assign(w, {
    LIVE: { api: { zoom: true }, sourceForMeeting: () => 'meeting-1', ready: new Promise<void>((r) => { ready = r; }) },
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async () => { checks++; return new Response(JSON.stringify({ state: 'absent', can_invite: true, occurrence_id: 'occ' })); },
  });
  boot(w);
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(checks).toBe(0);
    expect(w.document.querySelector<HTMLElement>('.invite-box')!.hidden).toBe(true);
    expect(w.document.body.textContent).not.toContain('Open bwat from a meeting');
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks).toBe(1);
    expect(w.document.querySelector('.invite-title')!.textContent).toBe('bwat isn’t in this meeting');
  } finally { w.dispatchEvent(new w.Event('pagehide')); w.close(); vi.useRealTimers(); }
});

// The panel's answer is fresher than the board's read only for a while: a panel left hidden (so not
// checking) hands the pill back to the board's read once its last answer is 15 s old.
it('lets its last answer expire, and the board’s read stands after it', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  const w = dom.window;
  Object.assign(w, {
    LIVE: { api: { zoom: true }, sourceForMeeting: () => 'meeting-1' },
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async () => new Response(JSON.stringify({ state: 'present', can_invite: false, occurrence_id: 'occ' })),
  });
  // The page's own clock (jsdom's Date is not the faked one).
  let now = Date.parse('2026-11-01T10:00:00Z');
  (w as unknown as { Date: { now(): number } }).Date.now = () => now;
  boot(w);
  const pill = () => w.document.querySelector<HTMLElement>('#live-pill')!;
  try {
    await vi.advanceTimersByTimeAsync(0);
    (w as unknown as { MEETING_BOT: { paint(m?: object): void } }).MEETING_BOT.paint({ id: 'meeting-1', live: true, bot: false });
    expect(pill().textContent).toBe('Live');
    Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => true });
    now += 14_000;
    await vi.advanceTimersByTimeAsync(14_000);
    (w as unknown as { MEETING_BOT: { paint(): void } }).MEETING_BOT.paint();
    expect(pill().textContent).toBe('Live');
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    (w as unknown as { MEETING_BOT: { paint(): void } }).MEETING_BOT.paint();
    expect(pill().textContent).toBe('bwat not in meeting');
  } finally { w.dispatchEvent(new w.Event('pagehide')); w.close(); vi.useRealTimers(); }
});

// Nothing reaches the check before the board is ready: not the panel coming back into view, not focus.
it('15 · sends no check when the panel is shown before the board is ready', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  const w = dom.window;
  let checks = 0;
  Object.assign(w, {
    LIVE: { api: { zoom: true }, sourceForMeeting: () => 'meeting-1', ready: new Promise<void>(() => {}) },
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async () => { checks++; return new Response(JSON.stringify({ state: 'absent', can_invite: true, occurrence_id: 'occ' })); },
  });
  boot(w);
  try {
    for (let i = 0; i < 3; i++) {
      w.document.dispatchEvent(new w.Event('visibilitychange'));
      w.dispatchEvent(new w.Event('focus'));
      await vi.advanceTimersByTimeAsync(6000);
    }
    expect(checks).toBe(0);
  } finally { w.dispatchEvent(new w.Event('pagehide')); w.close(); vi.useRealTimers(); }
});

// One check at a time: a slow answer is applied before the next request goes, however often the
// panel is shown or focused meanwhile.
it('15 · sends no second check before the first answer is applied', async () => {
  vi.useFakeTimers();
  const dom = zoomPage();
  const w = dom.window;
  const answers: ((r: Response) => void)[] = [];
  Object.assign(w, {
    LIVE: { api: { zoom: true }, sourceForMeeting: () => 'meeting-1' },
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: () => new Promise<Response>((r) => { answers.push(r); }),
  });
  boot(w);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      w.document.dispatchEvent(new w.Event('visibilitychange'));
      w.dispatchEvent(new w.Event('focus'));
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(answers).toHaveLength(1);
    answers[0]!(new Response(JSON.stringify({ state: 'absent', can_invite: true, occurrence_id: 'occ' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(w.document.querySelector('.invite-title')!.textContent).toBe('bwat isn’t in this meeting');
    expect(answers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(answers).toHaveLength(2);
  } finally { w.dispatchEvent(new w.Event('pagehide')); w.close(); vi.useRealTimers(); }
});

it('11 · a check that answers the same changes nothing on screen', async () => {
  vi.useFakeTimers();
  const p = invitePage(() => ({ state: 'queued', can_invite: false }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    let changes = 0;
    new p.w.MutationObserver((m) => { changes += m.filter((r) => r.type !== 'attributes' || r.attributeName !== 'disabled').length; })
      .observe(p.box(), { subtree: true, childList: true, characterData: true, attributes: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(changes).toBe(0);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('12 · the accepted Invite bwat narrows into the first step, then the three steps appear', async () => {
  vi.useFakeTimers();
  let state = 'absent';
  const p = invitePage((b) => { if (b.invite) state = 'queued'; return { state, can_invite: state === 'absent' }; });
  try {
    await vi.advanceTimersByTimeAsync(0);
    p.button().focus();
    p.button().click();
    await vi.advanceTimersByTimeAsync(0);
    // The server took it: the button narrows before the steps arrive.
    expect(p.button().classList.contains('morph')).toBe(true);
    expect(p.$('.invite-steps')!.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(p.button().hidden).toBe(true);
    expect(p.button().classList.contains('morph')).toBe(false);
    expect(p.now()).toBe(0);
    expect(p.$('.invite-steps')!.classList.contains('enter')).toBe(true);
    // The button is gone, so focus stays in the box, on the steps.
    expect(p.w.document.activeElement).toBe(p.$('.invite-steps'));
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('12 · a refused invitation never narrows the button', async () => {
  vi.useFakeTimers();
  const p = invitePage((b) => b.invite ? [429, { error: 'rate_limited' }] : { state: 'absent', can_invite: true });
  let morphed = false;
  try {
    await vi.advanceTimersByTimeAsync(0);
    new p.w.MutationObserver(() => { morphed ||= p.button().classList.contains('morph'); }).observe(p.button(), { attributes: true });
    p.button().click();
    await vi.advanceTimersByTimeAsync(300);
    expect(morphed).toBe(false);
    expect(p.button().hidden).toBe(false);
    expect(p.line()).toBe('Too many invitations. Try again in a minute.');
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('12 · under Reduce Motion the steps cross-fade in at once', async () => {
  vi.useFakeTimers();
  let state = 'absent';
  const p = invitePage((b) => { if (b.invite) state = 'queued'; return { state, can_invite: state === 'absent' }; }, { reduced: true });
  try {
    await vi.advanceTimersByTimeAsync(0);
    p.button().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.button().hidden).toBe(true);
    expect(p.now()).toBe(0);
    expect(p.$('.invite-steps')!.classList.contains('enter')).toBe(true);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('13 · the line fills and the next dot breathes only when a real check moves bwat on a step', async () => {
  vi.useFakeTimers();
  let state = 'queued';
  const p = invitePage(() => ({ state, can_invite: false }));
  const walking = () => p.$('.invite-steps li.walk');
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(walking()).toBeNull();
    state = 'waiting_for_host';
    await vi.advanceTimersByTimeAsync(5000);
    // The same step, waiting for something else: no walk.
    expect(walking()).toBeNull();
    state = 'joining';
    await vi.advanceTimersByTimeAsync(5000);
    expect(walking()?.getAttribute('aria-current')).toBe('step');
    state = 'waiting_room';
    await vi.advanceTimersByTimeAsync(5000);
    expect(walking()).toBeNull();
    expect(stillUnderReduce()).toContain('.invite-steps li.walk::before');
    expect(stillUnderReduce()).toContain('.invite-steps li.walk .invite-dot');
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('12 · bwat invited by someone else: the steps simply appear, with no button to narrow', async () => {
  vi.useFakeTimers();
  let state = 'absent';
  const p = invitePage(() => ({ state, can_invite: state === 'absent' }));
  let morphed = false;
  try {
    await vi.advanceTimersByTimeAsync(0);
    new p.w.MutationObserver(() => { morphed ||= p.button().classList.contains('morph'); }).observe(p.button(), { attributes: true });
    state = 'queued';
    await vi.advanceTimersByTimeAsync(5000);
    expect(morphed).toBe(false);
    expect(p.now()).toBe(0);
    expect(p.$('.invite-steps')!.classList.contains('enter')).toBe(false);
  } finally { p.w.close(); vi.useRealTimers(); }
});

const CARDS = "[{from:'meeting-1',bucket:'do'},{from:'meeting-1',bucket:'do'},{from:'meeting-1',bucket:'ask'},{from:'meeting-1',bucket:'decided'},{from:'meeting-0',bucket:'risk'}]";

it('14 · when bwat turns present the box folds away, the Live dot breathes and the listening row washes', async () => {
  vi.useFakeTimers();
  let state = 'joining';
  const p = invitePage(() => ({ state, can_invite: false }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    state = 'present';
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.box().classList.contains('fold')).toBe(true);
    expect(p.box().hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(p.box().hidden).toBe(true);
    expect(p.box().classList.contains('fold')).toBe(false);
    expect(p.pill().querySelector('.live-pill-dot')!.classList.contains('breathe')).toBe(true);
    expect(p.$('.column-empty.listening')!.classList.contains('invite-wash')).toBe(true);
    for (const moving of ['.live-pill-dot.breathe', '.invite-wash']) expect(stillUnderReduce()).toContain(moving);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('14 · under Reduce Motion the box cross-fades to the board', async () => {
  vi.useFakeTimers();
  let state = 'joining';
  const p = invitePage(() => ({ state, can_invite: false }), { reduced: true });
  try {
    await vi.advanceTimersByTimeAsync(0);
    state = 'present';
    await vi.advanceTimersByTimeAsync(5000);
    expect([p.box().classList.contains('fold'), p.box().classList.contains('fade')]).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(400);
    expect(p.box().hidden).toBe(true);
    expect(stillUnderReduce()).toContain('.invite-box{transition:opacity .4s}');
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('14 · a reload with bwat already in shows the board straight away', async () => {
  vi.useFakeTimers();
  const p = invitePage(() => ({ state: 'present', can_invite: false }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(p.box().hidden).toBe(true);
    expect(p.box().classList.contains('fold')).toBe(false);
    expect(p.pill().querySelector('.live-pill-dot')!.classList.contains('breathe')).toBe(false);
    expect(p.$('.invite-wash')).toBeNull();
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('15 · the Zoom path fades in a word at a time, once, on reaching the waiting room', async () => {
  vi.useFakeTimers();
  let state = 'joining', leave = false;
  const p = invitePage(() => ({ state, can_invite: false, can_leave: leave }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    state = 'waiting_room';
    await vi.advanceTimersByTimeAsync(5000);
    expect([...p.w.document.querySelectorAll('.invite-path span')].map((s) => s.textContent)).toEqual(['Participants', 'Waiting room', 'Admit']);
    expect(p.$('.invite-path')!.classList.contains('play')).toBe(true);
    // The host's line changes the words around it, not the path's entrance.
    leave = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.line()).toBe('Admit bwat: Participants › Waiting room › Admit');
    expect(p.$('.invite-path')!.classList.contains('play')).toBe(false);
    expect(stillUnderReduce()).toContain('.invite-path.play span');
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('16 · lost after bwat was in: the Live dot fades and the line says when, and what is kept', async () => {
  vi.useFakeTimers();
  let state = 'present';
  const p = invitePage(() => ({ state, can_invite: state === 'failed' }), { cards: CARDS });
  try {
    await vi.advanceTimersByTimeAsync(0);
    state = 'failed';
    await vi.advanceTimersByTimeAsync(5000);
    const at = new p.w.Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(at).toContain('10:42');
    expect(p.title()).toBe('bwat lost this meeting');
    expect(p.line()).toBe(`It disconnected at ${at}. The 4 cards so far are kept.`);
    expect(p.button().textContent).toBe('Invite again');
    expect(p.pill().classList.contains('fading')).toBe(true);
    expect(p.pill().dataset.state).toBe('lost');
    expect(p.pill().textContent).toBe('Lost');
    // Z4: the Details fold the other problems use, with the exact time it was seen. The status
    // names no reason, so none is shown.
    const details = p.$<HTMLDetailsElement>('.invite-details')!;
    expect(details.hidden).toBe(false);
    expect(details.querySelector('p')!.textContent).toBe('Seen at ' + new p.w.Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) + '.');
    expect(details.textContent).toContain('10:42:00');
    // Later checks keep the time it was seen.
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.line()).toBe(`It disconnected at ${at}. The 4 cards so far are kept.`);
    // Invited again and in: the pill is Live again.
    state = 'present';
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.pill().classList.contains('fading')).toBe(false);
    expect(p.pill().dataset.state).toBeUndefined();
    expect(p.pill().textContent).toBe('Live');
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('16 · lost on first sight names no time and leaves the pill alone', async () => {
  vi.useFakeTimers();
  const p = invitePage(() => ({ state: 'failed', can_invite: true }), { cards: CARDS });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(p.line()).toBe('The 4 cards so far are kept.');
    expect(p.pill().classList.contains('fading')).toBe(false);
    expect(p.pill().dataset.state).toBeUndefined();
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('16 · a bwat asked to leave that drops is Left (moment 9), not lost', async () => {
  vi.useFakeTimers();
  let state = 'present';
  const p = invitePage((b) => { if (b.leave) state = 'leaving'; return { state, can_invite: state === 'failed', can_leave: state === 'present' }; }, { cards: CARDS });
  try {
    await vi.advanceTimersByTimeAsync(0);
    bot(p.w).leave();
    await vi.advanceTimersByTimeAsync(0);
    state = 'failed';
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.pill().textContent).toBe('Left');
    expect(p.pill().dataset.state).toBe('left');
    expect(p.line()).toBe('The 4 cards so far are kept.');
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('17 · the ended meeting hands you its cards, counted by type, and See the cards opens them', async () => {
  vi.useFakeTimers();
  let state = 'present';
  const p = invitePage(() => ({ state, can_invite: false }), { cards: CARDS });
  try {
    await vi.advanceTimersByTimeAsync(0);
    state = 'ended';
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.title()).toBe('This meeting has ended');
    expect([...p.w.document.querySelectorAll('.invite-chip')].map((c) => [c.textContent, (c as HTMLElement).dataset.type]))
      .toEqual([['2 to-dos', 'do'], ['1 question', 'ask'], ['1 decision', 'decided']]);
    expect(p.$('.invite-chips')!.classList.contains('play')).toBe(true);
    expect(stillUnderReduce()).toContain('.invite-chips.play .invite-chip');
    // Z1 leaves the ended meeting as it was: the box sits above its cards.
    expect(p.w.document.body.classList.contains('zoom-invite-alone')).toBe(false);
    const see = p.$<HTMLButtonElement>('.invite-see')!;
    expect(see.hidden).toBe(false);
    see.focus();
    see.click();
    expect(p.box().hidden).toBe(true);
    // Focus moves on to the board, not left on a hidden button.
    expect(p.w.document.activeElement).toBe(p.$('#main'));
    // Later checks of the same ended meeting leave the cards open.
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.box().hidden).toBe(true);
  } finally { p.w.close(); vi.useRealTimers(); }
});

// Z1: while bwat isn't in, the box is all the panel shows, also over a meeting that has cards;
// See the cards opens them under the box, which stays with its Invite button.
const alone = (w: JSDOM['window']) => w.document.body.classList.contains('zoom-invite-alone');
it('Z1 · bwat left: the box is all the panel shows, and See the cards opens them under it', async () => {
  vi.useFakeTimers();
  let state = 'present';
  const bodies: { invite?: boolean; leave?: boolean }[] = [];
  const p = invitePage((b) => { bodies.push(b); if (b.leave) state = 'leaving'; return { state, can_invite: state === 'absent', can_leave: state === 'present' }; }, { cards: CARDS });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(alone(p.w)).toBe(false);
    bot(p.w).leave();
    await vi.advanceTimersByTimeAsync(0);
    state = 'absent';
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.title()).toBe('bwat isn’t in this meeting');
    expect(alone(p.w)).toBe(true);
    // Z3's note stays above the box.
    expect(p.$('.live-left-note')!.nextElementSibling).toBe(p.box());
    const see = p.$<HTMLButtonElement>('.invite-see')!;
    expect(see.hidden).toBe(false);
    see.focus();
    see.click();
    expect(alone(p.w)).toBe(false);
    expect(p.box().hidden).toBe(false);
    expect(see.hidden).toBe(true);
    expect(p.w.document.activeElement).toBe(p.$('#main'));
    // Later checks leave the cards open, and Invite bwat still invites.
    await vi.advanceTimersByTimeAsync(5000);
    expect(alone(p.w)).toBe(false);
    expect(see.hidden).toBe(true);
    p.button().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies.at(-1)!.invite).toBe(true);
    // In again: the box folds away (moment 14) and the cards show as before.
    state = 'present';
    await vi.advanceTimersByTimeAsync(5400);
    expect(p.box().hidden).toBe(true);
    expect(alone(p.w)).toBe(false);
    // Out again: the box is all the panel shows once more.
    state = 'absent';
    await vi.advanceTimersByTimeAsync(5000);
    expect(alone(p.w)).toBe(true);
    expect(see.hidden).toBe(false);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it.each([
  ['lost', ['present', 'failed']],
  ['absent with cards', ['absent']],
] as const)('Z1 · %s: the cards wait under the box behind See the cards', async (_name, states) => {
  vi.useFakeTimers();
  let i = 0;
  const p = invitePage(() => ({ state: states[Math.min(i++, states.length - 1)], can_invite: true }), { cards: CARDS });
  try {
    await vi.advanceTimersByTimeAsync(5000 * states.length);
    expect(p.box().hidden).toBe(false);
    expect(alone(p.w)).toBe(true);
    expect(p.$('.invite-see')!.hidden).toBe(false);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('Z1 · cards that load after the box was drawn are offered on the next check', async () => {
  vi.useFakeTimers();
  const p = invitePage(() => ({ state: 'absent', can_invite: true }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(alone(p.w)).toBe(true);
    expect(p.$('.invite-see')!.hidden).toBe(true);
    // The board's snapshot arrives with the meeting's cards.
    p.w.eval(`cards.push(...${CARDS})`);
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.$('.invite-see')!.hidden).toBe(false);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('Z1 · a meeting that ends while the box is alone shows its cards under the box again', async () => {
  vi.useFakeTimers();
  let state = 'absent';
  const p = invitePage(() => ({ state, can_invite: state === 'absent' }), { cards: CARDS });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(alone(p.w)).toBe(true);
    state = 'ended';
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.title()).toBe('This meeting has ended');
    expect(alone(p.w)).toBe(false);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('Z1 · the panel hides the board while the box is alone', () => {
  const css = readFileSync(new URL('../pages/board/ui/zoom-invite.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(css).toMatch(/\.zoom-invite-alone :is\(#workspace,#desk-footer\)\{display:none\}/);
});

it('17 · with no cards it simply says the meeting has ended', async () => {
  vi.useFakeTimers();
  const p = invitePage(() => ({ state: 'ended', can_invite: false }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(p.title()).toBe('This meeting has ended');
    expect(p.$('.invite-chip')).toBeNull();
    expect(p.$('.invite-see')!.hidden).toBe(true);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('14 · a check that failed while bwat was in does not replay its arrival', async () => {
  vi.useFakeTimers();
  let answer: Answer = { state: 'present', can_invite: false };
  const p = invitePage(() => answer);
  try {
    await vi.advanceTimersByTimeAsync(0);
    answer = [502, { error: 'unavailable' }];
    await vi.advanceTimersByTimeAsync(5000 * 3);
    expect(p.box().hidden).toBe(false);
    answer = { state: 'present', can_invite: false };
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.box().hidden).toBe(true);
    expect(p.box().classList.contains('fold')).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(p.pill().querySelector('.live-pill-dot')!.classList.contains('breathe')).toBe(false);
  } finally { p.w.close(); vi.useRealTimers(); }
});

// 10/23: a busy backend failed one check now and then, and the panel flashed
// "couldn't reach bwat" between good answers. Only a run of failed checks says so.
it('says the board couldn’t reach bwat only after three failed checks in a row', async () => {
  vi.useFakeTimers();
  let answer: Answer | 'hang' = { state: 'absent', can_invite: true };
  const p = invitePage(() => answer as Answer);
  const fetch = p.w.fetch;
  p.w.fetch = ((url: string, init: RequestInit) => answer === 'hang' ? new Promise(() => {}) : fetch(url, init)) as typeof fetch;
  const absent = 'bwat isn’t in this meeting', unreachable = 'bwat can’t check this meeting';
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(p.title()).toBe(absent);
    // The pool timeout answers 503; two in a row still show the last good answer.
    answer = [503, { error: 'unavailable' }];
    await vi.advanceTimersByTimeAsync(5000 * 2);
    expect(p.title()).toBe(absent);
    // A good check starts the count again.
    answer = { state: 'absent', can_invite: true };
    await vi.advanceTimersByTimeAsync(5000);
    answer = [503, { error: 'unavailable' }];
    await vi.advanceTimersByTimeAsync(5000);
    // A check past the board's 10 s limit is a failed check too.
    answer = 'hang';
    await vi.advanceTimersByTimeAsync(5000 + 10_000);
    expect(p.title()).toBe(absent);
    await vi.advanceTimersByTimeAsync(5000 + 10_000);
    expect(p.title()).toBe(unreachable);
    expect(p.line()).toBe('The board couldn’t reach bwat. It tries again by itself.');
    expect(p.$('.invite-details p')!.textContent).toBe('The request timed out.');
    answer = { state: 'absent', can_invite: true };
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.title()).toBe(absent);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('starts the count of failed checks again after any other answer: an ended meeting, or no Zoom', async () => {
  vi.useFakeTimers();
  let answer: Answer = { state: 'absent', can_invite: true };
  const p = invitePage(() => answer);
  const unreachable = 'bwat can’t check this meeting', ended = 'This meeting has ended';
  try {
    await vi.advanceTimersByTimeAsync(0);
    answer = [503, { error: 'unavailable' }];
    await vi.advanceTimersByTimeAsync(5000 * 2);
    answer = [410, { error: 'meeting_ended' }];
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.title()).toBe(ended);
    answer = [503, { error: 'unavailable' }];
    await vi.advanceTimersByTimeAsync(5000 * 2);
    expect(p.title()).toBe(ended);
    // Zoom's SDK goes away for a check, then comes back to two more failures.
    const sdk = (p.w as unknown as { zoomSdk: unknown }).zoomSdk;
    (p.w as unknown as { zoomSdk: unknown }).zoomSdk = undefined;
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.title()).toBe('Zoom is taking a while');
    (p.w as unknown as { zoomSdk: unknown }).zoomSdk = sdk;
    await vi.advanceTimersByTimeAsync(3000 + 5000);
    // Back, the SDK takes the no-meeting guess back: Loading… until bwat answers or a run fails.
    expect(p.title()).toBe('Loading…');
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.title()).toBe(unreachable);
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('counts an answer that is not JSON (a proxy’s 503 page) as a failed check', async () => {
  vi.useFakeTimers();
  let proxy = false;
  const p = invitePage(() => ({ state: 'absent', can_invite: true }));
  const fetch = p.w.fetch;
  p.w.fetch = ((url: string, init: RequestInit) => proxy ? Promise.resolve(new Response('<html>503 Service Unavailable</html>', { status: 503 })) : fetch(url, init)) as typeof fetch;
  try {
    await vi.advanceTimersByTimeAsync(0);
    proxy = true;
    await vi.advanceTimersByTimeAsync(5000 * 2);
    expect(p.title()).toBe('bwat isn’t in this meeting');
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.line()).toBe('The board couldn’t reach bwat. It tries again by itself.');
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('keeps Leave on offer through a failed check it does not show', async () => {
  vi.useFakeTimers();
  let answer: Answer = { state: 'present', can_invite: false, can_leave: true, joined_at: '2026-10-20T15:00:00Z' };
  const p = invitePage(() => answer, { role: 'admin' });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(bot(p.w).current()).not.toBeNull();
    answer = [503, { error: 'unavailable' }];
    await vi.advanceTimersByTimeAsync(5000);
    expect(bot(p.w).current()).not.toBeNull();
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('still says at once a problem the server names, and a failed Invite bwat', async () => {
  vi.useFakeTimers();
  let answer: Answer = { state: 'absent', can_invite: true };
  const p = invitePage((b) => b.invite ? [503, { error: 'unavailable' }] : answer);
  try {
    await vi.advanceTimersByTimeAsync(0);
    p.button().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.line()).toBe('The board couldn’t reach bwat. It tries again by itself.');
    answer = { state: 'absent', can_invite: true };
    await vi.advanceTimersByTimeAsync(5000);
    answer = [403, { error: 'wrong_zoom_identity' }];
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.line()).toBe('Your Zoom account has changed. Reopen bwat to link it.');
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('14 · a connection check while bwat is in does not replay its arrival', async () => {
  vi.useFakeTimers();
  let state = 'present';
  const p = invitePage(() => ({ state, can_invite: false }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    state = 'checking';
    await vi.advanceTimersByTimeAsync(5000);
    state = 'present';
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.box().hidden).toBe(true);
    expect(p.box().classList.contains('fold')).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(p.pill().querySelector('.live-pill-dot')!.classList.contains('breathe')).toBe(false);
    expect(p.$('.invite-wash')).toBeNull();
  } finally { p.w.close(); vi.useRealTimers(); }
});

it('C6 · once the admin comes back to the page, bwat can be invited again', async () => {
  vi.useFakeTimers();
  let connected = false;
  const p = invitePage((b) => b.invite && !connected ? [503, { error: 'zoom_lookup_not_configured' }] : { state: 'absent', can_invite: true }, { role: 'admin' });
  try {
    await vi.advanceTimersByTimeAsync(0);
    p.button().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.title()).toBe('bwat can’t be invited yet');
    // Connected in the admin panel's tab; back in Zoom, the next check offers the button again.
    connected = true;
    p.w.dispatchEvent(new p.w.Event('focus'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.title()).toBe('bwat isn’t in this meeting');
    expect(p.button().hidden).toBe(false);
    expect(p.$('.invite-fix')!.hidden).toBe(true);
  } finally { p.w.close(); vi.useRealTimers(); }
});

// A page that asks bwat to leave from the Live pill. `state` is what every later status check
// answers; the leave request answers `leaveAnswer` and moves `state` to it.
function leaveRig({ leaveAnswer = 'leaving', live = { api: { zoom: true }, sourceForMeeting: () => 'meeting-1' } as object | null } = {}) {
  const dom = zoomPage();
  const w = dom.window;
  const rig = {
    w, state: 'present',
    pill: () => w.document.querySelector<HTMLElement>('#live-pill')!,
    notes: () => w.document.querySelectorAll<HTMLElement>('.live-left-note'),
    async leave() {
      bot(w).leave();
      await vi.advanceTimersByTimeAsync(0);
    },
    async poll(state: string) { rig.state = state; await vi.advanceTimersByTimeAsync(5000); },
    close() { w.dispatchEvent(new w.Event('pagehide')); w.close(); },
  };
  Object.assign(w, {
    ...(live ? { LIVE: live } : {}),
    zoomSdk: { config: async () => ({}), getAppContext: async () => ({ context: 'sealed' }) },
    fetch: async (_url: string, init: RequestInit) => {
      if (JSON.parse(String(init.body)).leave) rig.state = leaveAnswer;
      return new Response(JSON.stringify({ state: rig.state, can_leave: rig.state === 'present', occurrence_id: 'occ' }));
    },
  });
  w.eval('Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(2026, 9, 20, 10, 42); } }');
  w.eval("var cards=[{from:'meeting-1'},{from:'meeting-1'},{from:'meeting-0'}]");
  boot(w);
  return rig;
}
const at = (w: JSDOM['window']) => new w.Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// No desk here: the board, not the panel, knows the meeting itself has ended (its pill then goes).
it.each(['absent', 'ended'])('drops Leaving… when the leave request answers %s (no claim to recall)', async (answer) => {
  vi.useFakeTimers();
  const rig = leaveRig({ leaveAnswer: answer });
  try {
    await vi.advanceTimersByTimeAsync(0);
    await rig.leave();
    expect(rig.pill().textContent).toBe('bwat not in meeting');
    expect(rig.pill().dataset.state).toBeUndefined();
    await rig.poll(answer);
    expect(rig.pill().textContent).toBe('bwat not in meeting');
    expect(rig.notes()).toHaveLength(0);
  } finally { rig.close(); vi.useRealTimers(); }
});

it('says Live again when bwat is still present after Leaving… or Left', async () => {
  vi.useFakeTimers();
  const rig = leaveRig();
  try {
    await vi.advanceTimersByTimeAsync(0);
    await rig.leave();
    expect(rig.pill().dataset.state).toBe('leaving');
    await rig.poll('present');
    expect(rig.pill().textContent).toBe('Live');
    expect(rig.pill().dataset.state).toBeUndefined();
    await rig.leave();
    await rig.poll('absent');
    expect(rig.pill().dataset.state).toBe('left');
    await rig.poll('present');
    expect(rig.pill().textContent).toBe('Live');
    expect(rig.pill().dataset.state).toBeUndefined();
    expect(rig.pill().classList.contains('fading')).toBe(false);
  } finally { rig.close(); vi.useRealTimers(); }
});

it.each(['checking', 'joining', 'queued'])('does not say Left while the status after a leave is %s', async (transient) => {
  vi.useFakeTimers();
  const rig = leaveRig();
  try {
    await vi.advanceTimersByTimeAsync(0);
    await rig.leave();
    await rig.poll(transient);
    expect(rig.pill().textContent).toBe('Leaving…');
    expect(rig.notes()).toHaveLength(0);
    await rig.poll('absent');
    expect(rig.pill().textContent).toBe('Left');
  } finally { rig.close(); vi.useRealTimers(); }
});

it.each(['absent', 'ended', 'failed'])('says Left once the status after a leave is %s', async (gone) => {
  vi.useFakeTimers();
  const rig = leaveRig();
  try {
    await vi.advanceTimersByTimeAsync(0);
    await rig.leave();
    await rig.poll(gone);
    expect(rig.pill().textContent).toBe('Left');
    expect(rig.notes()).toHaveLength(1);
  } finally { rig.close(); vi.useRealTimers(); }
});

it('says the cards and transcript so far are kept, without a count, when the meeting has no source', async () => {
  vi.useFakeTimers();
  const rig = leaveRig({ live: null });
  try {
    await vi.advanceTimersByTimeAsync(0);
    await rig.leave();
    await rig.poll('absent');
    expect(rig.notes()[0]!.textContent).toBe('bwat left at ' + at(rig.w) + '. The cards and transcript so far are kept.');
  } finally { rig.close(); vi.useRealTimers(); }
});

it('replaces the Left line on a second leave instead of adding another', async () => {
  vi.useFakeTimers();
  const rig = leaveRig();
  try {
    await vi.advanceTimersByTimeAsync(0);
    await rig.leave();
    await rig.poll('absent');
    await rig.poll('present');
    await rig.leave();
    await rig.poll('absent');
    expect(rig.notes()).toHaveLength(1);
    expect(rig.notes()[0]!.textContent).toBe('bwat left at ' + at(rig.w) + '. 2 cards and the transcript are kept.');
  } finally { rig.close(); vi.useRealTimers(); }
});

// The pill follows the server: bwat leaving at someone else's request (or already leaving when
// the page opens) reads Leaving… here too, but only this page's own ask ends in the Left line.
it('says Leaving… when the server says bwat is leaving, though this page did not ask', async () => {
  vi.useFakeTimers();
  const rig = leaveRig();
  rig.state = 'leaving';
  rig.pill().hidden = true;
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.pill().dataset.state).toBe('leaving');
    expect(rig.pill().hidden).toBe(false);
    expect(rig.pill().textContent).toBe('Leaving…');
    await rig.poll('present');
    expect(rig.pill().textContent).toBe('Live');
    expect(rig.pill().dataset.state).toBeUndefined();
  } finally { rig.close(); vi.useRealTimers(); }
});

it.each(['absent', 'ended', 'failed'])('hands a server-driven Leaving… back to the desk, without Left, once bwat is %s', async (gone) => {
  vi.useFakeTimers();
  const rig = leaveRig();
  rig.state = 'leaving';
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.pill().textContent).toBe('Leaving…');
    await rig.poll(gone);
    expect(rig.pill().dataset.state).toBeUndefined();
    expect(rig.pill().textContent).toBe('bwat not in meeting');
    expect(rig.notes()).toHaveLength(0);
  } finally { rig.close(); vi.useRealTimers(); }
});

it('checks nothing while the panel is hidden, and checks once when it is shown again', async () => {
  vi.useFakeTimers();
  let checks = 0;
  const p = invitePage(() => { checks++; return { state: 'absent', can_invite: true }; });
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(p.w.document, 'hidden', { configurable: true, get: () => hidden });
    p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
  };
  try {
    await vi.advanceTimersByTimeAsync(0);
    setHidden(true);
    const before = checks;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checks).toBe(before);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(checks).toBe(before + 1);
  } finally { p.w.close(); vi.useRealTimers(); }
});
