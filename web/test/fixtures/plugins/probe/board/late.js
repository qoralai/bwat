/* A probe feature plugin that learns at start, after a read, whether it offers its card action:
 * it asks the board to read again once it knows. Its label carries markup, drawn as text. */
'use strict';
(function () {
  let ready = false;
  window.bwatBoard.register('probe', {
    start(board) {
      board.api('GET', '/config').then((r) => { ready = r.ok; board.refresh(); });
    },
    cardAction(card) {
      return ready && card.owner ? { label: '<b>Late</b> probe', run: async () => { throw new Error('probe broke'); } } : null;
    },
  });
})();
