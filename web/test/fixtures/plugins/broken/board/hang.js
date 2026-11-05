/* A feature plugin whose reads never answer: the board must show its cards regardless. */
'use strict';
window.bwatBoard.register('hang', {
  start() {},
  tags: () => new Promise(() => {}),
  narrow: () => new Promise(() => {}),
});
