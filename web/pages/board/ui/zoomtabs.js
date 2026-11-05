// Zoom surface: one column at a time behind single-select tabs.
// In a ~400px panel the stacked columns put the To-dos below every question.
// Here `cols` always holds exactly one of the fixed-order types -- the tab --
// so the desk renders that single column; the web surface is untouched.
// The desk's own column order and names (study.js labels, via desk.js).
// All four types, as icon tabs (make room): each tab is its type's mark, and only the
// selected one shows its name, so four fit in the panel. Risks and Decisions were the
// full board's only (UX sync 9/29) until the tabs got small enough to hold them;
// now each is off until the viewer turns it on in Settings (D199).
const ZOOM_TABS = ['do', 'ask', 'risk', 'decided'];
const zoomShownTabs = () => ZOOM_TABS.filter((k) => (k !== 'risk' && k !== 'decided') || BOARD_PREFS.get(k) === 'on');
function zoomTab() {
  const tabs = zoomShownTabs(), raw = (new URLSearchParams(location.search).get('cols') || '').split(',');
  return tabs.find((k) => raw.length === 1 && raw[0] === k) || 'do';
}
// Before the desk renders: `cols` holds exactly the one tab.
addHook('beforeRender', 'zoomtabs', function () {
  if (!LIVE.api.zoom) return;
  // Normalize invalid links.
  const tab = zoomTab();
  if (new URLSearchParams(location.search).get('cols') !== tab) history.replaceState(history.state, '', url({ cols: tab }));
});
// Also drawn on its own as the panel's shell, before the cards (study.js paintShell).
function paintZoomTabs() {
  if (!LIVE.api.zoom) return;
  let bar = document.getElementById('zoom-tabs');
  // One filter row: the tabs, then Mine as a switch at its end (the panel has no Everything /
  // Unassigned: everyone's cards, nobody's first, desk.js's sort).
  if (!bar) {
    const row = document.createElement('div');
    row.id = 'zoom-filter';
    row.className = 'zoom-filter';
    row.innerHTML = '<div id="zoom-tabs" class="zoom-tabs" role="tablist" aria-label="Card type"></div>'
      + '<label class="zoom-mine">Mine<span class="settings-switch"><input type="checkbox" role="switch" id="zoom-mine"><i aria-hidden="true"></i></span></label>';
    document.querySelector('.toolbar').before(row);
    bar = row.firstElementChild;
    row.querySelector('#zoom-mine').addEventListener('change', (e) => {
      const mine = e.target.checked;
      holdListHeight();
      navigate({ scope: mine ? 'mine' : 'team', card: null, person: null, type: mine ? 'do' : 'all' }, { focus: 'zoom-mine', scroll: scrollY });
    });
  }
  document.getElementById('zoom-mine').checked = state().scope === 'mine';
  const tabs = zoomShownTabs();
  const tab = zoomTab();
  // No count on a tab (design sync 9/30, a quieter board).
  bar.innerHTML = tabs.map((k) => `<button type="button" role="tab" id="tab-${k}" data-tab="${k}" class="type-chip${tabNews(k) ? ' has-news' : ''}"`
    + ` aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}" title="${deskNames[k]}">${typeMark(k)}<span class="tab-name">${deskNames[k]}</span></button>`).join('');
  bar.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    // Keep the page where it is (UX sync 9/29): no jump to the top on a tab click.
    if (b.dataset.tab !== zoomTab()) {
      holdListHeight();
      navigate({ cols: b.dataset.tab, type: null, card: null }, { keepReader: true, scroll: scrollY });
    }
    document.getElementById('tab-' + b.dataset.tab)?.focus({ preventScroll: true });
  }));
  // Arrow keys move between tabs, as a tablist should.
  bar.onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = tabs.indexOf(zoomTab()), n = tabs.length;
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n];
    document.getElementById('tab-' + next)?.click();
  };
}
addHook('afterRender', 'zoomtabs', paintZoomTabs);
