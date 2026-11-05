import { afterEach, describe, expect, it } from 'vitest';
import { alerted, CARD_OWNED, errLine, fakeServer, loadPage, said, until } from './board-harness.ts';

// The board's core hook for a plugin's own send targets (pages/board/bwat-api.js sendTargets):
// a selected plugin that supplies sendLabel, listTargets and route replaces the send action's
// label, its rows and where a pick goes. The probe plugin (test/fixtures/plugins/probe/) is one.
let close: (() => void) | undefined;
// A list the page asked for just before the test ends settles first (the probe answers at once).
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 100));
  close?.();
});

type Row = { id: string; label: string; kind: string; available: boolean; default: boolean; stale?: boolean; age_s?: number };
interface Probe {
  rows: Row[];
  answer: unknown;
  fail: string | null;
  listed: number;
  routes: { card: { id: string; title: string }; row: Row; opts: { request_id: string } }[];
}

const PROBE = { boardPlugins: { plugins: [{ name: 'probe', token: 'probe-sel', scripts: ['/plugins/probe/targets.js'] }], reserved: ['probe-sel'] } };
const ROWS: Row[] = [
  { id: 'desk-101', label: 'jonah-agent', kind: 'agent', available: true, default: false, age_s: 30 },
  { id: 'desk-102', label: 'Research', kind: 'agent', available: true, default: true },
  { id: 'desk-103', label: 'Idle desk', kind: 'agent', available: false, default: false },
];

async function openProbe(rows: Row[] = ROWS, set: Partial<Probe> = {}, query = '') {
  const loaded = await loadPage('board.html', fakeServer(PROBE), '?surface=probe-sel' + query);
  close = () => loaded.window.close();
  const probe = (loaded.window as unknown as { __probe: Probe }).__probe;
  Object.assign(probe, { rows }, set);
  return { ...loaded, probe };
}
async function openSend(document: Document, ready = '#send-dialog [data-session]') {
  await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
  (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
  await until(() => !!document.querySelector(ready));
}
const pageEval = <T>(window: unknown, code: string) => (window as { eval(c: string): T }).eval(code);
const sessionCalls = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith('/v1/sessions') || c.path === '/v1/me/default-session' || c.path === '/v1/handoffs');

describe("a plugin's own send targets", () => {
  // QOR-4959: inside a plugin's product the sign-in is the plugin's own, which /auth/logout never
  // ends (and Google refuses to sign in inside its frame), and there is no default session, so the
  // account menu would hold nothing: the name is plain text, not a button that opens a menu.
  it('show your name as text, with no account menu', async () => {
    const { document, window } = await openProbe();
    await until(() => !!document.querySelector('#viewer-name')?.textContent);
    // Not the Zoom panel either: this is its own surface.
    expect(pageEval<boolean>(window, 'LIVE.api.zoom')).toBe(false);
    const name = document.querySelector('#viewer-name') as HTMLElement;
    expect(name.tagName).toBe('SPAN');
    expect(name.textContent).toBe('Ada');
    expect(name.hasAttribute('aria-haspopup') || name.hasAttribute('aria-expanded')).toBe(false);
    name.click();
    expect(document.querySelector('#account-menu') === null).toBe(true);
  });

  it("label the send action and fill its list, without the sessions' default or note", async () => {
    const { document, server, probe } = await openProbe();
    await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
    expect(document.querySelector(`[data-send="${CARD_OWNED}"]`)!.textContent).toBe('Send to probe');
    await openSend(document);
    expect(document.querySelector('#send-dialog-title')!.textContent).toBe('Send to probe');
    // The default first, then the other available row; the unavailable one is listed but cannot be picked.
    const picks = [...document.querySelectorAll('#send-dialog [data-session]')].map((b) => (b as HTMLElement).dataset.session);
    expect(picks).toEqual(['desk-102', 'desk-101']);
    const dead = [...document.querySelectorAll('#send-dialog button.send-session[disabled]')];
    expect(dead.map((b) => b.textContent)).toEqual([expect.stringContaining('Idle desk')]);
    expect(document.querySelector('#send-dialog')!.textContent).not.toMatch(/session|router/i);
    expect(document.querySelector('#send-dialog [data-make-default], #send-dialog [data-clear-default]')).toBeNull();
    expect(document.querySelector('#send-dialog [data-note-for], #send-dialog textarea')).toBeNull();
    // A row that reports no age is not shown as just heard from.
    expect(document.querySelector('#send-dialog [data-session="desk-102"] .send-dot.old')).not.toBeNull();
    expect(document.querySelector('#send-dialog [data-session="desk-101"] .send-dot.old')).toBeNull();
    expect(probe.listed).toBeGreaterThan(0);
    // Never the person's sessions.
    expect(sessionCalls(server.calls)).toEqual([]);
  });

  it("sends a pick to the plugin's route, with a request id, and says it was queued", async () => {
    const { document, server, probe } = await openProbe();
    await openSend(document);
    (document.querySelector('#send-dialog [data-session="desk-101"]') as HTMLButtonElement).click();
    // The card's Queued chip says it; no line besides.
    await until(() => said(document) === 'Queued.');
    expect(document.querySelector(`#card-list [data-card="${CARD_OWNED}"] .badge.queued`)!.textContent).toBe('Queued');
    expect(document.querySelector(`#card-list [data-card="${CARD_OWNED}"] .card-line`)).toBeNull();
    expect(probe.routes).toHaveLength(1);
    expect(probe.routes[0]!.card.id).toBe(CARD_OWNED);
    expect(probe.routes[0]!.row).toMatchObject({ id: 'desk-101', label: 'jonah-agent', available: true });
    expect(probe.routes[0]!.opts.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionCalls(server.calls)).toEqual([]);
  });

  it("shows the plugin's refusal on the card, and its Try again's pick carries the same request id", async () => {
    const { document, probe } = await openProbe(ROWS, { answer: { refused: true, why: 'That desk is busy.' } });
    await openSend(document);
    (document.querySelector('#send-dialog [data-session="desk-101"]') as HTMLButtonElement).click();
    await until(() => !!errLine(document));
    expect(errLine(document)!.firstChild!.textContent).toBe('Not sent: That desk is busy.');
    expect(alerted(document)).toBe(errLine(document)!.firstChild!.textContent);
    // The red line is the reading: #announcement does not say it again.
    expect(document.querySelector('#announcement')!.textContent).not.toBe('Not sent — needs attention.');
    probe.answer = { ok: true };
    // Try again opens the send again.
    (errLine(document)!.querySelector('[data-note-retry]') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#send-dialog [data-session="desk-101"]'));
    (document.querySelector('#send-dialog [data-session="desk-101"]') as HTMLButtonElement).click();
    await until(() => probe.routes.length === 2);
    expect(probe.routes[1]!.opts.request_id).toBe(probe.routes[0]!.opts.request_id);
    await until(() => said(document) === 'Queued.');
    expect(errLine(document)).toBeNull();
  });

  it('keeps the Not sent line while its Try again only opens the send, and after the send is cancelled', async () => {
    const { document } = await openProbe(ROWS, { answer: { refused: true, why: 'That desk is busy.' } });
    await openSend(document);
    (document.querySelector('#send-dialog [data-session="desk-101"]') as HTMLButtonElement).click();
    await until(() => !!errLine(document));
    const alert = document.querySelector('#alert')!.textContent;
    (errLine(document)!.querySelector('[data-note-retry]') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#send-dialog [data-session="desk-101"]'));
    await new Promise((r) => setTimeout(r, 50));
    expect(errLine(document)!.firstChild!.textContent).toBe('Not sent: That desk is busy.');
    (document.querySelector('#send-dialog-close') as HTMLButtonElement).click();
    await until(() => !(document.querySelector('#send-dialog') as HTMLDialogElement).open);
    expect(errLine(document)!.firstChild!.textContent).toBe('Not sent: That desk is busy.');
    expect(errLine(document)!.querySelector('[data-note-retry]')!.getAttribute('aria-disabled')).toBeNull();
    // Not read out again.
    expect(document.querySelector('#alert')!.textContent).toBe(alert);
  });

  it("shows the plugin's reason when it cannot list, and never the sessions", async () => {
    const { document, server } = await openProbe([], { fail: 'The parent did not answer.' });
    await openSend(document, '#send-dialog .send-empty');
    await until(() => /The parent did not answer\./.test(document.querySelector('#send-dialog')!.textContent || ''));
    expect(document.querySelector('#send-dialog [data-session]')).toBeNull();
    expect(sessionCalls(server.calls)).toEqual([]);
  });

  it('never reads a row as HTML, and leaves out a row not in its shape', async () => {
    const rows = [
      { id: 'desk-1', label: '<img src=x onerror="window.__owned=1">Ada', kind: 'agent', available: true, default: false },
      { id: 'desk-2', label: 7, kind: 'agent', available: true, default: false } as unknown as Row,
    ];
    const { document, window } = await openProbe(rows);
    await openSend(document);
    const dlg = document.querySelector('#send-dialog')!;
    expect(dlg.querySelector('img')).toBeNull();
    expect(dlg.querySelector('[data-session="desk-1"]')!.textContent).toContain('<img src=x');
    expect(dlg.querySelector('[data-session="desk-2"]')).toBeNull();
    expect((window as unknown as { __owned?: number }).__owned).toBeUndefined();
  });

  it('refuses a pick the list no longer holds or that cannot take it, without asking the plugin', async () => {
    const { window, probe } = await openProbe();
    await until(() => !!window.document.querySelector(`[data-send="${CARD_OWNED}"]`));
    await (await window.fetch('/sessions')).json();
    for (const session of ['desk-999', 'desk-103']) {
      const r = await window.fetch('/route', { method: 'POST', body: JSON.stringify({ id: CARD_OWNED, session, message_id: 'm-12345678' }) });
      expect(r.status).toBe(409);
    }
    expect(probe.routes).toEqual([]);
    const d = await window.fetch('/session-default', { method: 'POST', body: JSON.stringify({ id: 'desk-101', on: true }) });
    expect(d.status).toBe(409);
  });

  it("reads the plugin's send label as text, never as HTML", async () => {
    const label = '<b>&amp;</b> probe';
    const { document } = await openProbe(ROWS, {}, '&probe-label=' + encodeURIComponent(label));
    await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
    const button = document.querySelector(`[data-send="${CARD_OWNED}"]`)!;
    expect(button.textContent).toBe(label);
    expect(button.querySelector('b')).toBeNull();
    await openSend(document);
    expect(document.querySelector('#send-dialog-title')!.textContent).toBe(label);
    expect(document.querySelector('#send-dialog-title b')).toBeNull();
  });
});

describe('without such a plugin', () => {
  it('Send to Claude is unchanged: its label, the sessions and the hand-off', async () => {
    const loaded = await loadPage('board.html', fakeServer());
    close = () => loaded.window.close();
    const { document, server } = loaded;
    await openSend(document);
    expect(document.querySelector(`[data-send="${CARD_OWNED}"]`)!.textContent).toBe('Send to Claude');
    expect(document.querySelector('#send-dialog-title')!.textContent).toBe('Send to Claude');
    expect(document.querySelector('#send-dialog [data-note-for="sess-1"]')).not.toBeNull();
    expect(document.querySelector('#send-dialog [data-make-default="sess-1"]')).not.toBeNull();
    (document.querySelector('#send-dialog [data-session="sess-1"]') as HTMLButtonElement).click();
    await until(() => server.calls.some((c) => c.path === '/v1/handoffs'));
  });


});
