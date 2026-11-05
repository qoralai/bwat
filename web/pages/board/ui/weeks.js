// Weeks, old links and the Zoom meeting.
//
// The desk holds this week and last; `?week=` holds one week instead,
//     from the week chips. The chips sit in the web sidebar
//     above the meeting list. A card link into a week that is not loaded
//     (`?card=`, or a related-record pointer) finds its week and loads it.
//     A shared link opens what it names: `?week=`, and `?meeting=` (a meeting's
//     id, as the admin's Recent meetings link it, or its Zoom uuid in either spelling).
//     Back/forward reload the week the URL names.
// On the Zoom surface the Apps SDK's meeting uuid, when it answers in
//     time, picks the meeting -- unless the link already chose one.
(function () {
  let booted = false, reloading = false, lastTried = null;
  const sought = {};

  // Swap the URL without a history entry, keeping the desk's saved state.
  function replaceURL(changes) { history.replaceState(history.state, '', url(changes)); }

  function reload() {
    if (reloading) return;
    reloading = true;
    // refresh() recomputes the default meeting when the week changes and
    // renders once; a second render here only doubled the work.
    Promise.resolve(refresh(true)).finally(() => { reloading = false; });
  }

  // The meeting a link or the SDK named: select it, loading its week if the
  // default pair does not hold it. True when anything changed.
  function openMeeting(m) {
    const k = LIVE.sourceForMeeting(m);
    if (!k) return false;
    const wk = (LIVE.api.allSources[k] || {}).week;
    const changes = { source: k, meeting: null, card: null, person: null };
    if (!sources[k] && wk) changes.week = wk;
    replaceURL(changes);
    if (changes.week) reload(); else render();
    return true;
  }

  function applyOldLinks() {
    const q = new URLSearchParams(location.search);
    const meeting = q.get('meeting');
    if (meeting && !q.get('source')) {
      if (!openMeeting(meeting)) replaceURL({ meeting: null });
      return true;
    }
    return false;
  }

  // Zoom's SDK that failed to load is asked for again, so a panel whose script failed once still
  // learns its meeting (Astra, 11/02): after 3 s, then twice as long each time up to a minute,
  // only while the panel is shown, and never once the page has gone.
  let zoomRetry = 3000, zoomTimer, zoomWaiting = false;
  const retryZoom = () => { if (document.hidden) zoomWaiting = true; else askZoom(); };
  document.addEventListener('visibilitychange', () => { if (zoomWaiting && !document.hidden) { zoomWaiting = false; askZoom(); } });
  window.addEventListener('pagehide', () => { clearTimeout(zoomTimer); zoomWaiting = false; });
  function askZoom() {
    if (!LIVE.api.zoom) return;
    LIVE.zoomMeeting().then((uuid) => {
      if (!LIVE.api.zoomAnswered) {
        zoomTimer = setTimeout(retryZoom, zoomRetry);
        zoomRetry = Math.min(zoomRetry * 2, 60000);
        return;
      }
      const q = new URLSearchParams(location.search);
      // Not over a meeting the link chose or a card the person opened: the poll moves the default then.
      const k = uuid && !q.get('source') && !q.get('meeting') && !q.get('card') && LIVE.sourceForMeeting(uuid);
      if (k && k !== state().source) openMeeting(uuid);
      else paintZoomTitle();   // Zoom has answered: the header can name the meeting (desk.js)
    });
  }

  // The URL names a week the loaded snapshot is not: load it (chips, links,
  // back/forward). A week the feed does not have falls back to the default.
  function followWeek() {
    const want = LIVE.requestedWeek();
    if (want && want !== LIVE.ALL_WEEKS && !(LIVE.api.weeks || []).some((w) => w.key === want)) { replaceURL({ week: null }); return true; }
    if ((snapshot.week || '') === want || lastTried === want) return false;
    if (reloading) return true;          // retried on the render after this reload
    lastTried = want;
    reload();
    return true;
  }

  // Open to-dos: Mine reads another list than Everything (owner=me), so a scope switch
  // there loads it, as a week switch does.
  function followOpen() {
    if ((snapshot.open || '') === LIVE.requestedOpen()) return false;
    reload();
    return true;
  }

  function findCard() {
    const id = state().card;
    if (!id || cards.some((c) => c.id === id) || sought[id]) return;
    sought[id] = 'looking';
    const title = document.getElementById('detail-title');
    if (title) title.textContent = 'Finding this card in another week…';
    LIVE.findCardWeek(id).then((wk) => {
      if (state().card !== id) return;
      if (wk && wk !== (snapshot.week || '')) {
        sought[id] = 'found';
        replaceURL({ week: wk, source: null, person: null });
        lastTried = wk;
        reload();
      } else {
        sought[id] = 'missing';
        const t = document.getElementById('detail-title');
        if (t) t.textContent = 'This card isn’t in any week the board holds.';
      }
    });
  }

  function paintWeeks() {
    const nav = document.querySelector('.meeting-nav');
    const links = document.getElementById('meeting-links');
    if (!nav || !links) return;
    // One standard dropdown, however many weeks the store holds (a chip per
    // week grew without bound). The default is the last two weeks.
    let row = document.getElementById('week-pick');
    if (!row) {
      row = document.createElement('label');
      row.id = 'week-pick';
      row.className = 'week-pick';
      row.innerHTML = '<span>Show</span><select id="week-select"></select>';
      links.before(row);
      row.querySelector('select').addEventListener('change', (e) => {
        const k = e.target.value;
        // Today (9/30): today's meetings, in the list and on the board.
        // They are in the default two weeks, so nothing more loads.
        if (k === 'today') { navigate({ week: null, source: null, card: null, person: null, when: 'today', days: 'today' }); return; }
        if ((snapshot.week || '') === k && state().days !== 'today') return;
        // Say what a switch costs while it loads.
        const all = LIVE.api.weeks || [];
        const want = k === LIVE.ALL_WEEKS ? all : k ? all.filter((w) => w.key === k) : all.slice(0, 2);
        const n = LIVE.uncachedWeeks(want).length;
        const t = document.getElementById('week-title');
        if (t && n) t.textContent = n === 1 ? 'Loading 1 week…' : `Loading ${n} weeks…`;
        // navigate() re-renders, and followWeek() then loads the new week.
        navigate({ week: k || null, source: null, card: null, person: null, when: null, days: null });
      });
    }
    const weeks = LIVE.api.weeks || [];
    const today = state().days === 'today', on = today ? 'today' : snapshot.week || '';
    row.hidden = weeks.length < 2;
    const sel = row.querySelector('select');
    if (document.activeElement !== sel) {
      // A number unknown (the counts not read yet) leaves the total unknown too.
      const total = weeks.some((w) => w.n == null) ? null : weeks.reduce((a, w) => a + w.n, 0);
      sel.innerHTML = [['today', 'Today', null], ['', 'Last 2 weeks', null], [LIVE.ALL_WEEKS, 'All weeks', total], ...weeks.map((w) => [w.key, 'Week of ' + w.label, w.n])]
        .map(([k, label, n]) => `<option value="${esc(k)}"${on === k ? ' selected' : ''}>`
          + `${esc(label)}${n == null ? '' : ` · ${esc(String(n))}`}</option>`).join('');
    }
    const cur = weeks.find((w) => w.key === on);
    const title = document.getElementById('week-title');
    const label = today ? 'Today' : on === LIVE.ALL_WEEKS ? 'All weeks' : cur ? 'Week of ' + cur.label : 'Last 2 weeks';
    if (title) title.textContent = label;
    const all = links.querySelector('a[data-meeting="all"] small');
    if (all) all.textContent = label;
  }

  addHook('afterRender', 'weeks', function () {
    if (!snapshot) return;
    if (!booted) {
      booted = true;
      // An old link that named no meeting the board has still leaves Zoom to say (desk.js header).
      const old = applyOldLinks();
      askZoom();
      if (old) return;
    }
    if (followWeek() || followOpen()) return;
    paintWeeks();
    findCard();
  });
})();
