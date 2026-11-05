/* A probe feature plugin that adds a card action, for the board's cardAction hook: an owned to-do
 * offers "Probe it"; once probed, the card links its probe instead. */
'use strict';
(function () {
  let api = null;
  const probed = new Map();
  const refused = new Set();
  window.bwatBoard.register('probe', {
    start(board) { api = board.api; },
    cardAction(card) {
      if (probed.has(card.id)) return { text: probed.get(card.id), href: 'https://probe.example/' + probed.get(card.id) };
      if (card.bucket !== 'do' || !card.owner) return null;
      return {
        label: refused.has(card.id) ? 'Retry probe' : 'Probe it',
        busy: 'Probing…',
        async run(c, board) {
          const r = await api('POST', '/cards/' + c.id);
          if (!r.ok) { refused.add(c.id); board.toast('Probe refused.'); return; }
          probed.set(c.id, r.data.key);
          board.toast('Probed as ' + r.data.key + '.');
          await board.refresh();
        },
      };
    },
  });
})();
