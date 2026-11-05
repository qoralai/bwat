/* The jira plugin on the board (../README.md): Route to Jira on an open to-do or risk, once the
 * install has Jira set up; a card already sent links its issue instead. What a feature plugin may
 * add, and when the board asks: pages/board/ui/plugins.js.
 */
'use strict';
(function () {
  const ISSUES_PER_READ = 50;           // cards per issues read: a short request line (the backend takes up to 200)
  const SEND_MS = 60000;                // filing waits on the card service and on Jira
  const WHY = {
    jira_not_configured: 'Jira is not set up for bwat.',
    jira_failed: 'Jira did not take the card just now. Try again.',
    cards_unavailable: 'The card could not be read just now. Try again.',
  };
  let api = null;                       // this plugin's routes, as the signed-in person
  let board = null;
  let enabled = false;                  // whether the install has Jira set up (GET /status)
  let asking = false;                   // a status read is on its way

  // Whether Jira is set up, asked at start and again with each board read until it says yes,
  // so one that could not tell at first (a deploy, a blip) offers the button once it can.
  function checkStatus() {
    if (enabled || asking) return;
    asking = true;
    api('GET', '/status').then((r) => {
      enabled = r.ok && r.data.enabled === true;
      if (enabled) board.refresh();
    }, () => {}).finally(() => { asking = false; });
  }

  // The answer, or null once `ms` has passed or the request failed: the page never waits on Jira
  // for ever, and a failed request is not an answer.
  const within = (ms, ask) => Promise.race([ask.catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

  window.bwatBoard.register('jira', {
    start(started) {
      api = started.api;
      board = started;
      // Set up or not is known once this answers: the board draws the buttons then.
      checkStatus();
    },

    async cardData(ids) {
      checkStatus();
      const reads = [];
      for (let i = 0; i < ids.length; i += ISSUES_PER_READ) reads.push(api('GET', '/issues?cards=' + ids.slice(i, i + ISSUES_PER_READ).join(',')));
      return (await Promise.all(reads)).flatMap((r) => {
        if (!r.ok) throw new Error('issues: HTTP ' + r.status);
        return r.data.issues;
      });
    },

    cardAction(card) {
      const issue = card.pluginData && card.pluginData.jira;
      if (issue) return { text: issue.key, href: issue.url };
      if (!enabled || card.closed || (card.bucket !== 'do' && card.bucket !== 'risk')) return null;
      return { label: 'Route to Jira', busy: 'Sending to Jira…', run };
    },
  });

  // One press files the card; the board then reads its issue and the card's "Sent to Jira" line.
  // With no answer in time, or none at all, the card may still have gone in: the board reads it
  // again when a late answer comes, and its issue link shows then.
  async function run(card, shown) {
    const asked = api('POST', '/cards/' + encodeURIComponent(card.id));
    const r = await within(SEND_MS, asked);
    if (!r) {
      shown.toast('No answer from Jira yet. If it took the card, the card links its issue shortly.');
      asked.then((late) => { if (late.ok) shown.refresh(); }, () => {});
      return;
    }
    if (!r.ok) {
      shown.toast(WHY[r.data && r.data.error] || 'Jira could not be reached. Try again.');
      // The card may be filed all the same (Jira took it, the card service did not take its
      // line): the board reads its issue again.
      await shown.refresh();
      return;
    }
    shown.toast('In Jira as ' + r.data.key + '.');
    await shown.refresh();
  }
})();
