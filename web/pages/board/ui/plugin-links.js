// The switched-on plugins' links (GET /board-links, the web README, Web plugins): core names no
// plugin, it draws what each declares for a slot. `nav` links sit in the app header; `meeting`
// links in one meeting's line, beside its transcript (desk.js paintMeetingInfo, repainted once
// they arrive), with the meeting's id put in for {meeting_id}. Read once per page; none when the
// list cannot be read.
// Only on the web board: a link leaves the page, so in Zoom's panel it would replace the board, and
// on a page a plugin signs in (?surface=<its token>) it would leave that sign-in (a board framed in
// another product would show an ended session).
'use strict';
window.bwatPluginLinks = [];
const bwatWebBoard = new URLSearchParams(location.search).getAll('surface').every((s) => s === 'web');
if (bwatWebBoard) fetch('/board-links', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : { links: [] }))
  .then(({ links }) => {
    window.bwatPluginLinks = Array.isArray(links) ? links : [];
    const header = document.querySelector('.app-header');
    for (const l of window.bwatPluginLinks.filter((x) => x.slot === 'nav')) {
      const a = document.createElement('a');
      a.href = l.href;
      a.textContent = l.label;
      a.dataset.pluginLink = 'nav';
      header?.append(a);
    }
    // Only the meeting's line: the board's first render may already be on screen.
    if (typeof paintMeetingInfo === 'function' && typeof state === 'function') paintMeetingInfo(state());
  })
  .catch(() => {});
