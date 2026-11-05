import { afterEach, describe, expect, it } from 'vitest';
import { CARD_OWNED, fakeServer, loadPage, until, type Call } from './board-harness.ts';

let close: (() => void) | undefined;
afterEach(() => close?.());

const handoffs = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.path === '/v1/handoffs');
const keyOf = (c: Call) => (c.body as { request_key: string }).request_key;

// Once a card is Queued for a session, picking that session again posts nothing and says so.
// A deliberate resend is the receipt's Send again, under a new request id.
describe('a queued hand-off is not sent again by picking its session', () => {
  async function queued(sessions = [{ id: 'sess-1', name: 'bwat repo' }]) {
    const server = fakeServer({ sessions });
    const loaded = await loadPage('board.html', server);
    close = () => loaded.window.close();
    const { document } = loaded;
    const pick = async (session: string) => {
      await until(() => !!document.querySelector(`[data-send="${CARD_OWNED}"]`));
      (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
      await until(() => !!document.querySelector(`#send-dialog[open] [data-session="${session}"]`));
      (document.querySelector(`#send-dialog [data-session="${session}"]`) as HTMLButtonElement).click();
    };
    await pick('sess-1');
    await until(() => document.querySelector('#announcement')!.textContent === 'Queued.');
    // The dialog fades out after a pick (sentAndGone, ~560 ms).
    await until(() => !document.querySelector('#send-dialog[open]'));
    return { server, document, pick };
  }

  it('the same session again: no POST, the dialog stays and says it is already queued there', async () => {
    const { server, document, pick } = await queued();
    await pick('sess-1');
    await until(() => /Already queued for bwat repo @ ada-mac\. To send it again, use Send again on the card\./.test(document.querySelector('#send-dialog-list')!.textContent!));
    await new Promise((r) => setTimeout(r, 300));
    expect(handoffs(server.calls)).toHaveLength(1);
    expect(document.querySelector('#send-dialog[open]')).not.toBeNull();
    expect(document.querySelector('#announcement')!.textContent).toBe('Already queued for bwat repo @ ada-mac. To send it again, use Send again on the card.');
  });

  it('the same session again with a note: no POST either', async () => {
    const { server, document } = await queued();
    (document.querySelector(`[data-send="${CARD_OWNED}"]`) as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#send-dialog[open] [data-note-for="sess-1"]'));
    (document.querySelector('#send-dialog [data-note-for="sess-1"]') as HTMLButtonElement).click();
    const note = document.querySelector('#send-dialog textarea') as HTMLTextAreaElement;
    note.value = 'one more thing';
    note.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    (document.querySelector('#send-dialog [data-send-note="sess-1"]') as HTMLButtonElement).click();
    await until(() => /Already queued for/.test(document.querySelector('#send-dialog-list')!.textContent!));
    await new Promise((r) => setTimeout(r, 300));
    expect(handoffs(server.calls)).toHaveLength(1);
  });

  it('Send again on the receipt, then the same session: sent, as a new hand-off', async () => {
    const { server, document } = await queued();
    (document.querySelector(`[data-open="${CARD_OWNED}"]`) as HTMLElement).click();
    await until(() => !!document.querySelector('#route-again'));
    (document.querySelector('#route-again') as HTMLButtonElement).click();
    await until(() => !!document.querySelector('#send-dialog[open] [data-session="sess-1"]'));
    (document.querySelector('#send-dialog [data-session="sess-1"]') as HTMLButtonElement).click();
    await until(() => handoffs(server.calls).length === 2);
    const [first, second] = handoffs(server.calls);
    expect(keyOf(second!)).not.toBe(keyOf(first!));
  });

  it('another session: sent, as a new hand-off', async () => {
    const { server, pick } = await queued([{ id: 'sess-1', name: 'bwat repo' }, { id: 'sess-2', name: 'docs repo' }]);
    await pick('sess-2');
    await until(() => handoffs(server.calls).length === 2);
    const [first, second] = handoffs(server.calls);
    expect(keyOf(second!)).not.toBe(keyOf(first!));
  });
});
