/* A probe plugin that supplies its own send targets, for the board's core tests (send-targets.test.ts). */
'use strict';
(function () {
  // The test sets what it lists and answers, and reads what it was asked.
  const probe = { rows: [], answer: { ok: true }, fail: null, listed: 0, routes: [] };
  window.__probe = probe;
  window.bwatBoard.register('probe', {
    // A test may name it in the page's address (?probe-label=...), read once as the plugin registers.
    sendLabel: new URLSearchParams(location.search).get('probe-label') || 'Send to probe',
    listTargets: async () => {
      probe.listed += 1;
      if (probe.fail) throw new Error(probe.fail);
      return probe.rows;
    },
    route: async (card, row, opts) => {
      probe.routes.push({ card, row, opts });
      return probe.answer;
    },
  });
})();
