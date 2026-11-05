/* A feature plugin whose hooks answer junk instead of throwing: the board must show its cards regardless. */
'use strict';
window.bwatBoard.register('junk', {
  start() {},
  tags: async () => 'not a list',
  narrow: async () => ({ label: 'Junk', ids: 5 }),
});
