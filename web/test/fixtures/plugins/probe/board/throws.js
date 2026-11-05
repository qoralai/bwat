/* A probe feature plugin whose card action throws. */
'use strict';
window.bwatBoard.register('probe', {
  start() {},
  cardAction() { throw new Error('probe broke'); },
});
