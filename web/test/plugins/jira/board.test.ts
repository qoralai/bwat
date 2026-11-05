import { afterEach, describe, expect, it } from 'vitest';
import { CARD, CARD_OWNED, fakeServer, loadPage, TOKEN, until } from '../../board-harness.ts';

// The jira plugin on the board (web/plugins/jira/board/board.js), as the board page loads it from
// /board-plugins: Route to Jira on an open to-do or risk while the install has Jira set up; a
// card already sent links its issue.
let close: (() => void) | undefined;
afterEach(() => close?.());

const ISSUE = { key: 'ABC-1', url: 'https://example.atlassian.net/browse/ABC-1' };

/** The board with the plugin on: `enabled` says whether Jira is set up; `sent` the cards already sent. */
type Answer = () => [number, unknown] | Promise<[number, unknown]>;
function server({ enabled = true, sent = [] as string[], file = (() => [200, { ...ISSUE, revision: 8 }]) as Answer, status = (() => [200, { enabled }]) as Answer } = {}) {
  const issues = new Set(sent);
  const s = fakeServer({
    boardPlugins: { plugins: [{ name: 'jira', token: null, scripts: ['/plugins/jira/board.js'] }], reserved: [] },
    extra: {
      'GET /v1/plugins/jira/status': status,
      'GET /v1/plugins/jira/issues': (url) => [200, {
        issues: url.searchParams.get('cards')!.split(',').filter((id) => issues.has(id)).map((card_id) => ({ card_id, ...ISSUE })),
      }],
      [`POST /v1/plugins/jira/cards/${CARD_OWNED}`]: async () => {
        const answer = await file();
        // Filing keeps the issue and writes "Sent to Jira" on the card, a new revision.
        if (answer[0] === 200) { issues.add(CARD_OWNED); s.touchOwned(); }
        return answer;
      },
    },
  });
  return s;
}
const open = async (s: ReturnType<typeof server>) => {
  const loaded = await loadPage('board.html', s);
  close = () => loaded.window.close();
  return loaded;
};
const tile = (document: Document, id: string) => document.querySelector(`#card-list [data-card="${id}"]`);
const button = (document: Document, id: string) =>
  [...(tile(document, id)?.querySelectorAll<HTMLButtonElement>('[data-plugin-action="jira"]') ?? [])][0];
const issueLink = (document: Document, id: string) => tile(document, id)?.querySelector<HTMLAnchorElement>(`a[href="${ISSUE.url}"]`);
const writes = (calls: { method: string; path: string; authorization: string | null }[]) => calls.filter((c) => c.method !== 'GET');

describe('Route to Jira, the jira plugin, on the board', () => {
  it('is offered on an open to-do once Jira is set up', async () => {
    const { document } = await open(server());
    await until(() => !!button(document, CARD_OWNED));
    expect(button(document, CARD_OWNED)!.textContent).toBe('Route to Jira');
  });

  it('is not offered while Jira is not set up', async () => {
    const { document } = await open(server({ enabled: false }));
    await until(() => !!tile(document, CARD_OWNED)?.querySelector('[data-send]'));
    expect(button(document, CARD_OWNED)).toBeFalsy();
  });

  it('files a card with one POST, says so, links its issue and takes the new revision', async () => {
    const { document, server: s } = await open(server());
    await until(() => !!button(document, CARD_OWNED));
    button(document, CARD_OWNED)!.click();
    expect(button(document, CARD_OWNED)!.textContent).toBe('Sending to Jira…');
    await until(() => !!issueLink(document, CARD_OWNED));
    expect(writes(s.calls)).toEqual([expect.objectContaining({ method: 'POST', path: `/v1/plugins/jira/cards/${CARD_OWNED}`, authorization: `Bearer ${TOKEN}` })]);
    expect(issueLink(document, CARD_OWNED)!.textContent).toBe('ABC-1');
    expect(button(document, CARD_OWNED)).toBeFalsy();
    expect(document.getElementById('whisper')!.textContent).toContain('In Jira as ABC-1.');
    // Filing moved the card from revision 7 to 8: its next change goes at 8.
    (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#do-done'));
    (document.querySelector('#do-done') as HTMLButtonElement).click();
    await until(() => writes(s.calls).some((c) => c.path.endsWith('/archive')));
    expect((writes(s.calls).find((c) => c.path.endsWith('/archive')) as unknown as { body: unknown }).body).toEqual({ revision: 8, outcome: 'done' });
  });

  it("links a card already sent, and never offers to send it again", async () => {
    const { document } = await open(server({ sent: [CARD_OWNED] }));
    await until(() => !!issueLink(document, CARD_OWNED));
    expect(issueLink(document, CARD_OWNED)!.target).toBe('_blank');
    expect(button(document, CARD_OWNED)).toBeFalsy();
    expect(issueLink(document, CARD)).toBeFalsy();
  });

  it("says why when Jira does not take the card, and the button is pressable again", async () => {
    const { document } = await open(server({ file: () => [502, { error: 'jira_failed', status: 400 }] }));
    await until(() => !!button(document, CARD_OWNED));
    button(document, CARD_OWNED)!.click();
    await until(() => document.getElementById('whisper')!.textContent!.includes('Jira did not take the card just now. Try again.'));
    expect(button(document, CARD_OWNED)!.hasAttribute('aria-disabled')).toBe(false);
    expect(button(document, CARD_OWNED)!.textContent).toBe('Route to Jira');
  });

  it("asks again whether Jira is set up, with the board's next read, when it could not tell at first", async () => {
    let asked = 0;
    const { document } = await open(server({ status: () => (++asked === 1 ? [503, { error: 'unavailable' }] : [200, { enabled: true }]) }));
    await until(() => !!button(document, CARD_OWNED));
    expect(asked).toBe(2);
  });

  it("reads the board again when the card was filed but its line could not be written, so the issue link shows", async () => {
    let filed = false;
    const s = server({ file: () => { filed = true; return [502, { error: 'cards_unavailable' }]; } });
    // Filed in Jira and kept, though the card service did not take the card's line.
    const { document } = await open(s);
    await until(() => !!button(document, CARD_OWNED));
    const reads = s.calls.filter((c) => c.path === '/v1/plugins/jira/issues').length;
    button(document, CARD_OWNED)!.click();
    await until(() => filed);
    await until(() => document.getElementById('whisper')!.textContent!.includes('The card could not be read just now. Try again.'));
    await until(() => s.calls.filter((c) => c.path === '/v1/plugins/jira/issues').length > reads);
  });

  it("says the card may have gone through when Jira's answer is lost, and the button is pressable again", async () => {
    const { document } = await open(server({ file: () => { throw new Error('connection reset'); } }));
    await until(() => !!button(document, CARD_OWNED));
    button(document, CARD_OWNED)!.click();
    await until(() => document.getElementById('whisper')!.textContent!.includes('No answer from Jira yet.'));
    expect(button(document, CARD_OWNED)!.hasAttribute('aria-disabled')).toBe(false);
  });
});
