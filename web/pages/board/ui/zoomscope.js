// "Current meeting" / "Today" / "This week" / "All meetings" (standup
// 9/25 A140; the time scale from the 9/28 end-of-day artifact review).
// The first button is "Last meeting" while no meeting on the board is live
// (10/28): it opens the desk's default meeting, the live one or else
// the newest.
// The full board's switch over which meetings it shows. It changes only the
// meetings, never My to-dos / Everything / Unassigned or the column tab.
// Today and This week: `?when=` names the window, and study.js's state()
// turns it into that window's meetings on every render, so a meeting that
// starts later joins without a click (whenSource). All meetings is every
// meeting over every week the feed lists (weeks.js loads LIVE.ALL_WEEKS).
// The Zoom panel has no switch (UX sync, 9/29): in the meeting it
// is about this meeting only, and "Open full board" is the way to the rest.
// State lives in the URL like the rest of the desk.
// Open to-dos is every meeting's open to-dos, with no time window (live.js reads them).
const ZOOM_SCOPES = [['this', ''], ['today', 'Today'], ['week', 'This week'], ['all', 'All meetings'], ['open', 'Open to-dos']];
const thisLabel = () => (Object.values(sources).some((m) => m.live) ? 'Current meeting' : 'Last meeting');
function zoomWhen() { const w = new URLSearchParams(location.search).get('when'); return w === 'today' || w === 'week' ? w : ''; }
// A window applies only while no link chose meetings or a week (state()'s rule).
function zoomWindow() { const q = new URLSearchParams(location.search); return q.get('source') || q.get('week') ? '' : zoomWhen(); }
// Which button is pressed: every week is All meetings, a window is its
// window, the meeting it opens is Current/Last meeting, and any other is none of them.
function zoomScope(s) {
  if (s.page) return '';
  if (openView(s)) return 'open';
  if (s.source === 'all' && LIVE.requestedWeek() === LIVE.ALL_WEEKS) return 'all';
  return zoomWindow() || (s.source === LIVE.defaultSource(sources, 'live') ? 'this' : '');
}
function zoomScopeChanges(scope) {
  // The sidebar follows: Today lists today's meetings there too (weeks.js).
  const base = { type: null, person: null, card: null, q: null, when: null, days: null, narrow: null };
  if (scope === 'all') return { ...base, source: 'all', week: LIVE.ALL_WEEKS };
  if (scope === 'open') return { ...base, source: LIVE.OPEN, week: null };
  if (scope === 'today' || scope === 'week') return { ...base, source: null, week: null, when: scope, days: scope === 'today' ? 'today' : null };
  // Current/Last meeting: no source, so the desk's default meeting and default weeks. A
  // board that opens on All names the live-else-newest meeting instead (10/28).
  return { ...base, source: BOARD_PREFS.get('open') === 'all' ? LIVE.defaultSource(sources, 'live') : null, week: null };
}
// Zoom is this meeting only, with no switch, picker or search to undo a wider
// view: before each render a link's several meetings, every
// week, time window or search is dropped. One meeting (weeks.js puts the Zoom
// meeting in `source`) and one week (a card link into an older week) stay.
function zoomOnlyThis(q) {
  const drop = {};
  const src = q.get('source') || '';
  if (src === 'all' || src.includes(',')) drop.source = null;
  if (q.get('week') === LIVE.ALL_WEEKS) drop.week = null;
  for (const k of ['when', 'q']) if (q.get(k)) drop[k] = null;
  // The panel has no Unassigned: nobody's cards sort first instead (desk.js).
  if (q.get('scope') === 'unassigned') drop.scope = null;
  return drop;
}
addHook('beforeRender', 'zoomscope', function () {
  if (!LIVE.api.zoom) return;
  const drop = zoomOnlyThis(new URLSearchParams(location.search));
  if (Object.keys(drop).length) history.replaceState(history.state, '', url(drop));
});
function pickZoomScope(k) {
  if (k === 'this' || zoomScope(state()) !== k) navigate(zoomScopeChanges(k), { focus: 'zoom-scope-' + k });
}
addHook('afterRender', 'zoomscope', function () {
  let bar = document.getElementById('zoom-scope');
  if (LIVE.api.zoom) { if (bar) bar.hidden = true; return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'zoom-scope';
    bar.className = 'segmented zoom-scope';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Which meetings');
    // In the header, where the My to-dos / Meetings nav was (design sync 9/30).
    document.querySelector('.app-header .brand').after(bar);
    bar.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-zoom-scope]');
      if (b) pickZoomScope(b.dataset.zoomScope);
    });
  }
  bar.hidden = false;
  const on = zoomScope(state());
  const html = ZOOM_SCOPES.map(([k, label]) =>
    `<button type="button" id="zoom-scope-${k}" data-zoom-scope="${k}" aria-pressed="${on === k}">${label || thisLabel()}</button>`).join('');
  if (bar.innerHTML !== html) bar.innerHTML = html;
});
