/* A probe feature plugin whose card action is a link that is not https. */
'use strict';
window.bwatBoard.register('probe', {
  start() {},
  cardAction: () => ({ text: 'Not a web link', href: 'javascript:alert(1)' }),
});
