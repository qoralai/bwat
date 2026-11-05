/* A probe feature plugin that reads its own record of each card with every board read
 * (cardData), and links it from the card's action row (cardAction). */
'use strict';
(function () {
  let api = null;
  window.bwatBoard.register('probe', {
    start(board) { api = board.api; },
    async cardData(ids) {
      const r = await api('GET', '/records?cards=' + ids.join(','));
      if (!r.ok) throw new Error('records: HTTP ' + r.status);
      // A row for a card it was not asked about, and one that would reach Object.prototype: both dropped.
      return [...r.data.records, { card_id: '__proto__', key: 'X', url: 'https://probe.example/X' }, { card_id: 'not-asked', key: 'Y', url: 'https://probe.example/Y' }];
    },
    cardAction(card) {
      const record = card.pluginData && card.pluginData.probe;
      return record ? { text: record.key, href: record.url } : null;
    },
  });
})();
