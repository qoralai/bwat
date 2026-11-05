/* A feature plugin whose every hook throws: the board must show its cards regardless. */
'use strict';
window.bwatBoard.register('broken', {
  start() {},
  tags() { throw new Error('tags broke'); },
  readerRow() { throw new Error('row broke'); },
  meetingSection() { throw new Error('section broke'); },
  pageLabel: 'Broken',
  page() { throw new Error('page broke'); },
});
