// The filters column opens from the ☰ button in the header (design sync 9/30; the filters
// column mock-up, 23 Oct standup): the meetings, then a group for each plugin's items (its
// `facets`, ui/plugins.js) and one for people. It pushes the cards aside and never covers them.
// Unpinned, a click outside it closes it; pinned, it stays open and opens with the page (the
// stored 'open' of the old sidebar is a pin). Configure ticks whether it shows the meetings and
// the people; a plugin is shown or hidden in Settings (the gear), the one place for it, which
// Configure links to. Its edge drags it wider. Zoom has no column.
// Each group shows its first few (CAP), each with its card count on the board, the busiest first
// (meetings: the newest first); More shows the rest. A plugin's group lists its items and each of
// its tags on the board's cards, so last week's goal on a card is listed too.
(function () {
  const KEY = 'board.nav', HIDE = 'board.nav.hide', WIDTH = 'board.nav.width';
  const MIN = 180, MAX = 560, STEP = 16;
  const CAP = { meetings: 4, people: 10 }, PLUGIN_CAP = 8;
  const btn = document.getElementById('nav-toggle'), nav = document.getElementById('meeting-nav');
  if (!btn || !nav) return;
  const pin = document.getElementById('nav-pin'), cfgBtn = document.getElementById('nav-configure');
  const config = document.getElementById('filter-config'), box = document.getElementById('filter-groups');
  const meetingsBox = document.getElementById('filter-meetings');
  const grip = document.getElementById('nav-grip'), shell = nav.closest('.app-shell');
  let pinned = read(KEY, 'closed') === 'open', configuring = false;
  // Each plugin's items, asked for when the column opens and again on leaving a plugin's page
  // (where one may have been added): null while asked, [] if it cannot say.
  const facets = new Map();
  let lastPage = '', drawn = '', drawnMeetings = '';
  // The groups opened to all their items with More, while this page is open.
  const more = new Set();

  function isOpen() { return document.body.classList.contains('nav-open'); }
  function set(open) {
    document.body.classList.toggle('nav-open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) facets.clear(); else configuring = false;
    paint();
  }
  function hidden() { const v = read(HIDE, []); return Array.isArray(v) ? v : []; }

  btn.addEventListener('click', () => {
    const open = !isOpen();
    set(open);
    if (open) nav.querySelector('#filter-meetings a, #meeting-links a')?.focus();
  });
  pin.addEventListener('click', () => {
    pinned = !pinned;
    write(KEY, pinned ? 'open' : 'closed');
    paint();
  });
  // Built once each time Configure opens, so a redraw or a tick never takes the focus away.
  cfgBtn.addEventListener('click', () => {
    configuring = !configuring;
    if (configuring) config.innerHTML = configHTML(hidden());
    paint();
  });
  function configHTML(off) {
    return '<p class="eyebrow">Show in this column</p>' + [['meetings', 'Meetings'], ['people', 'People']].map(([g, label]) =>
      `<label class="filter-config-row"><input type="checkbox" data-show="${g}"${off.includes(g) ? '' : ' checked'}><span><b>${label}</b></span></label>`).join('')
      + '<p class="muted small">Only on your board.</p>'
      + (window.bwatBoard.installed().length && !LIVE.api.zoom ? '<button type="button" class="text-button filter-config-plugins" data-open-plugins>Show or hide plugins in Settings</button>' : '');
  }
  // A click a redraw has since taken off the page (a link in the column) is not outside it.
  document.addEventListener('click', (e) => {
    if (pinned || !isOpen() || !e.target.isConnected || nav.contains(e.target) || btn.contains(e.target)) return;
    set(false);
  });

  config.addEventListener('change', (e) => {
    const g = e.target.dataset.show;
    if (!g) return;
    write(HIDE, e.target.checked ? hidden().filter((x) => x !== g) : [...hidden(), g]);
    paint();
  });
  config.addEventListener('click', (e) => { if (e.target.closest('[data-open-plugins]')) window.BOARD_PREFS.open('plugins'); });

  // A group's link: chosen again, it clears. A plugin's item names open cards from every
  // meeting, so it shows them all (Open to-dos), as the plugin's own Cards links do. More opens
  // a group to all its items; a plugin's heading link opens its page.
  function onClick(e) {
    const m = e.target.closest('[data-more]');
    if (m) {
      const g = m.dataset.more;
      if (more.has(g)) more.delete(g); else more.add(g);
      paint();
      nav.querySelector(`[data-more="${g}"]`)?.focus();
      return;
    }
    const page = e.target.closest('a[data-plugin-page]');
    if (page) {
      e.preventDefault();
      navigate({ page: page.dataset.pluginPage, card: null });
      document.querySelector('#plugin-page h1')?.focus();
      return;
    }
    const a = e.target.closest('a[data-filter]');
    if (!a) return;
    e.preventDefault();
    const on = a.getAttribute('aria-current') === 'true', v = a.dataset.value;
    // The page keeps its place; the redraw puts the focus back on the picked link (redraw).
    const keep = { scroll: scrollY };
    if (a.dataset.filter === 'meetings') { navigate({ source: on ? null : v, card: null, q: null }, keep); return; }
    if (a.dataset.filter === 'people') { navigate({ person: on ? null : v, scope: 'team', type: 'all', card: null }, keep); return; }
    navigate(on ? { narrow: null, source: null } : { narrow: a.dataset.filter + ':' + v, source: LIVE.OPEN, week: null, when: null, card: null, q: null }, keep);
    PLUGIN_BOARD.refresh();
  }
  box.addEventListener('click', onClick);
  meetingsBox.addEventListener('click', onClick);

  // One group. items: {v, text, n, mark, you}, in the order shown. Past `cap` only More shows
  // them, but the picked one always shows. `page`: its plugin's page, linked from the heading.
  // `rows: false` draws only the heading and More (all meetings: their full list shows instead).
  function groupHTML(name, title, items, current, cap, { page = false, alwaysMore = false, rows = true } = {}) {
    const open = more.has(name), shown = open ? items : items.slice(0, cap);
    if (!open && current != null && !shown.some((x) => x.v === current)) shown.push(...items.filter((x) => x.v === current));
    const head = `<div class="filter-head"><p class="eyebrow">${esc(title)}</p>`
      + (page ? `<a href="${esc(url({ page: name, card: null }))}" class="filter-page" data-plugin-page="${esc(name)}">Open page</a>` : '') + '</div>';
    const list = !rows ? '' : !items.length ? '<p class="muted small">None yet.</p>'
      : shown.map((x, i) => `<a href="#" id="filter-${esc(name)}-${i}" class="${x.n ? '' : 'zero'}" data-filter="${esc(name)}" data-value="${esc(x.v)}" aria-current="${x.v === current}">`
        + `<span class="fi-mark" aria-hidden="true">${esc(x.mark || '')}</span><span class="fi-text">${esc(x.text)}${x.you ? ' <small>(you)</small>' : ''}</span><b>${x.n}</b></a>`).join('');
    const word = title.toLowerCase();
    const toggle = alwaysMore || items.length > cap
      ? `<button type="button" class="text-button filter-more" data-more="${esc(name)}">${open ? 'Fewer ' + esc(word) : 'More ' + esc(word) + '…'}</button>` : '';
    return `<div class="filter-group" data-group="${esc(name)}">${head}${list}${toggle}</div>`;
  }
  // Draws a group box afresh; a link or More focused in it keeps the focus, found again by what it is.
  function redraw(el, html) {
    const f = el.contains(document.activeElement) ? document.activeElement : null;
    el.innerHTML = html;
    const again = f && [...el.querySelectorAll('[data-more], a[data-filter]')].find((x) => f.dataset.more
      ? x.dataset.more === f.dataset.more : !!f.dataset.filter && x.dataset.filter === f.dataset.filter && x.dataset.value === f.dataset.value);
    again?.focus({ preventScroll: true });
  }
  const byCount = (a, b) => b.n - a.n;
  const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  function paint() {
    const s = state(), open = isOpen(), off = hidden();
    pin.setAttribute('aria-pressed', String(pinned));
    pin.title = pinned ? 'Kept open. Click to let it close.' : 'Keep it open';
    cfgBtn.setAttribute('aria-pressed', String(configuring));
    cfgBtn.textContent = configuring ? 'Done' : 'Configure';
    btn.classList.toggle('filtered', !open && (!!s.person || narrowing(s)));
    nav.classList.toggle('no-meetings', off.includes('meetings'));
    nav.classList.toggle('configuring', configuring);
    nav.classList.toggle('all-meetings', more.has('meetings'));
    config.hidden = !configuring;
    box.hidden = configuring;
    meetingsBox.hidden = configuring;
    if (configuring) return;
    if (!open) return;
    if (lastPage && lastPage !== s.page) facets.clear();
    lastPage = s.page;
    const shown = visibleCards();
    // Meetings, the newest first. More shows the board's whole list instead: the week picker,
    // the days and every meeting (#meeting-links, study.js).
    let mHtml = '';
    if (!off.includes('meetings')) {
      const per = {};
      for (const c of shown) for (const m of cardMeetings(c)) per[m] = (per[m] || 0) + 1;
      // In the Today view only today's, as the full list (study.js renderBase).
      const today = s.days === 'today' ? todayIds() : null;
      const ids = Object.entries(sources).filter(([id]) => id !== 'todo-unknown' && (!today || today.has(id))).sort(LIVE.byAtDesc).map(([id]) => id);
      mHtml = groupHTML('meetings', 'Meetings', ids.map((id) => ({ v: id, text: meetingName(id), n: per[id] || 0 })),
        sources[s.source] ? s.source : null, CAP.meetings, { alwaysMore: true, rows: !more.has('meetings') });
    }
    if (drawnMeetings !== mHtml) { redraw(meetingsBox, mHtml); drawnMeetings = mHtml; }
    const [narrowName, ...key] = s.narrow.split(':');
    let html = '';
    for (const f of window.bwatBoard.features().filter((x) => typeof x.facets === 'function')) {
      if (!facets.has(f.name)) {
        facets.set(f.name, null);
        Promise.resolve().then(() => f.facets()).then((list) => (Array.isArray(list) ? list : []), () => [])
          .then((list) => { facets.set(f.name, list.map((x) => ({ v: String(x.key), text: String(x.label), mark: x.mark == null ? '' : String(x.mark) }))); paint(); });
      }
      const list = facets.get(f.name);
      if (!list) continue;
      // Its items, then each of its tags on the board's cards it did not list; counted on the cards.
      const items = list.map((x) => ({ ...x, n: 0 })), at = new Map(items.map((x) => [x.v, x]));
      for (const c of shown) for (const t of c.tags || []) {
        if (t.plugin !== f.name) continue;
        if (!at.has(t.key)) { const x = { v: t.key, text: t.text, mark: t.mark || '', n: 0 }; at.set(t.key, x); items.push(x); }
        at.get(t.key).n++;
      }
      const label = window.bwatBoard.installed().find((p) => p.name === f.name).label;
      html += groupHTML(f.name, label, items.sort(byCount), narrowName === f.name ? key.join(':') : null, PLUGIN_CAP, { page: typeof f.page === 'function' });
    }
    if (!off.includes('people')) {
      const per = {};
      // As picking them shows them (filterCards, study.js): what they own, and the questions,
      // risks and decisions they raised.
      for (const c of shown) { const o = cardOwner(c) || (c.bucket !== 'do' ? c.raisedBy : ''); if (o) per[o] = (per[o] || 0) + 1; }
      const items = (LIVE.api.people || []).map((n) => ({ v: n, text: n, n: per[n] || 0, mark: initials(n), you: !!viewer && n === viewer }));
      html += groupHTML('people', 'People', items.sort(byCount), s.person || null, CAP.people);
    }
    // Against what was last drawn, not the serialised DOM, which writes ' and " back unescaped.
    if (drawn !== html) { redraw(box, html); drawn = html; }
  }
  addHook('afterRender', 'filters', paint);

  // The width: dragged, or the arrow keys on the edge; a double-click goes back to the default.
  function width(w, keep) {
    if (w == null) shell.style.removeProperty('--nav-w');
    else shell.style.setProperty('--nav-w', w + 'px');
    grip.setAttribute('aria-valuenow', String(w ?? Math.round(nav.getBoundingClientRect().width)));
    if (keep) write(WIDTH, w);
  }
  const clamp = (w) => Math.max(MIN, Math.min(MAX, Math.round(w)));
  const saved = read(WIDTH, null);
  width(typeof saved === 'number' ? clamp(saved) : null, false);
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const now = Number(grip.getAttribute('aria-valuenow')) || nav.getBoundingClientRect().width;
    width(clamp(now + (e.key === 'ArrowRight' ? STEP : -STEP)), true);
  });
  grip.addEventListener('dblclick', () => width(null, true));
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture?.(e.pointerId);
    const left = shell.getBoundingClientRect().left;
    const move = (m) => width(clamp(m.clientX - left), false);
    const up = (u) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      width(clamp(u.clientX - left), true);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  set(pinned);
})();
