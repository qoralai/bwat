import { afterEach, expect, it } from 'vitest';
import { CARD, CARD_OWNED, fakeServer, loadPage, until } from './board-harness.ts';

let close: (() => void) | undefined;
afterEach(() => close?.());

it('shows merged history and sends authenticated undo with the displayed revision', async () => {
  const server = fakeServer({ merged: true });
  const { window, document } = await loadPage('board.html', server);
  close = () => window.close();
  await until(() => !!document.querySelector(`[data-open="${CARD}"]`));
  (document.querySelector(`[data-open="${CARD}"]`) as HTMLElement).click();
  await until(() => !!document.querySelector(`#reader [data-unmerge="${CARD_OWNED}"]`));
  (document.querySelector(`#reader [data-unmerge="${CARD_OWNED}"]`) as HTMLButtonElement).click();
  await until(() => server.calls.some((c) => c.path.endsWith('/unmerge')));
  const call = server.calls.find((c) => c.path.endsWith('/unmerge'))!;
  expect(call.path).toBe(`/v1/cards/${CARD_OWNED}/unmerge`);
  expect(call.body).toEqual({ revision: 3, via: CARD });
  expect(call.authorization).toBeTruthy();
});
