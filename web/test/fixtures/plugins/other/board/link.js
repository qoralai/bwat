/* A second feature plugin, beside a throwing one: every owned card links its record. */
'use strict';
window.bwatBoard.register('other', {
  start() {},
  cardAction: (card) => (card.owner ? { text: 'OTH-7', href: 'https://other.example/OTH-7' } : null),
});
