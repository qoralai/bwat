/* Live data for the meeting desk.
 *
 * The desk's renderer (study.js / desk.js, from an earlier desk prototype)
 * reads one shape: {items, sources}. This file fills that shape from the
 * board's own endpoints instead of the prototype's synthetic snapshot:
 *
 *   board_feed.json + board_week_*.json   the meeting cards, by week
 *   /open-todos                           every meeting's open cards, for the
 *                                         Open to-dos view (?source=open) only
 *   /whoami, /sessions                    who is looking, and their sessions
 *
 * Nothing here writes. Every string that reaches card HTML is escaped here,
 * because the renderer treats `detail` as HTML (it re-sanitises it too).
 */
'use strict';
window.LIVE = (function () {
  const WEEKS = 2;                       // this week and last
  const ALL_WEEKS = 'all';               // every week the feed lists
  const WEEK_FETCHES = 4;                // week files fetched at once
  const PLUGIN_READ_MS = 5000;           // a plugin's tags or narrowing, at most, per snapshot
  const api = {
    people: [], colors: {},              // roster names from the feed
    hub: [], hubReason: '',              // the viewer's Claude Code sessions
    locked: false, me: null,             // locked = Zoom proved who this is
    capture: null,
    zoom: false, zoomAnswered: false,  // zoomAnswered: Zoom's meeting lookup has ended, named or not
  };
  // Settled once the board's first load is done: its meetings read, or its error shown (study.js load).
  let loaded;
  const ready = new Promise((resolve) => { loaded = resolve; });
  const surface = new URLSearchParams(location.search).get('surface');
  api.zoom = surface === 'zoom' || (surface !== 'web' && /zoom/i.test(navigator.userAgent || ''));

  // canonUuid: one spelling for a meeting uuid (Zoom and the store write "/" and "+" as
  // "_" and "-" in some places).
  const { escText, canonUuid, loadZoomSdk } = window.bwatHelpers;

  function getJSON(u) {
    // A fetch that got no answer (dropped, or timed out) is marked unreached; an answer keeps its status.
    return fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
      .then((r) => { if (!r.ok) throw Object.assign(Error('HTTP ' + r.status), { status: r.status }); return r.json(); },
        (e) => { throw Object.assign(e, { unreached: true }); });
  }

  // The last good copy of each part, so a failed fetch keeps what was shown
  // instead of emptying the board.
  const lastGood = { weeks: {}, revs: {}, orders: {} };

  async function whoami() {
    try {
      const w = await getJSON('/whoami');
      // The meeting Zoom opened the panel from: proof the viewer is in Zoom.
      // A Zoom meeting or a Zoom-proved viewer means the page is inside the
      // Zoom app, unless the link says otherwise.
      if (w && w.meeting) api.meeting = w.meeting;
      if (w && w.locked && w.name) { api.locked = true; api.me = w.name; }
      // The viewer's role: an owner or an admin is offered the admin panel and its fixes.
      api.role = (w && w.member && w.member.role) || null;
      // The account menu says who is signed in: the name, and the email under it.
      api.email = (w && w.member && w.member.email) || null;
      api.admin = ['owner', 'admin'].includes(api.role);
      // A plugin's own send targets (bwat-api.js sendTargets) name the send action; else Send to Claude.
      api.sendLabel = (w && typeof w.send_label === 'string' && w.send_label) || null;
      // bwat: every viewer is signed in, so a proved name says nothing about Zoom.
      if (w && w.meeting && surface !== 'web') api.zoom = true;
    } catch { /* an unconfigured board simply has no proved viewer */ }
    return api;
  }

  function safeHttps(u) {
    try { const x = new URL(String(u || '')); return x.protocol === 'https:' ? x.href : ''; } catch { return ''; }
  }

  // ── Weeks ──
  // `?week=` picks one week (the sidebar's week chips, weeks.js); without
  // it the desk holds this week and last. api.loadedWeek says which ('' is
  // the default pair), so the page can tell when the URL asks for another.
  const cardWeek = {};                  // card id -> week key, as files are read
  const scanned = {};                   // week key -> the rev of it last scanned for ids
  function requestedWeek() { return new URLSearchParams(location.search).get('week') || ''; }
  // Open to-dos (?source=open): every meeting's open cards, not the weeks' own. Mine reads
  // the viewer's (owner=me); Everything and Unassigned read everyone's. '' off that view.
  const OPEN = 'open';
  function requestedOpen() {
    const q = new URLSearchParams(location.search);
    return q.get('source') !== OPEN ? '' : q.get('scope') === 'mine' || (!q.get('scope') && q.get('view') === 'lane') ? 'mine' : 'team';
  }
  function pickWeeks(all) {
    const want = requestedWeek();
    // `week=all` holds every week the feed lists.
    if (want === ALL_WEEKS) { api.loadedWeek = ALL_WEEKS; return all.slice(); }
    const one = want && all.find((w) => w.key === want);
    api.loadedWeek = one ? one.key : '';
    return one ? [one] : all.slice(0, WEEKS);
  }
  // Weeks whose current rev has not been read yet: what a switch would fetch.
  function uncachedWeeks(list) {
    return (list || []).filter((w) => !(w.rev && lastGood.revs[w.key] === w.rev && lastGood.weeks[w.key]));
  }
  // At most `n` requests in flight, results in input order.
  async function mapLimit(list, n, fn) {
    const out = new Array(list.length);
    let next = 0;
    async function worker() { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } }
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
    return out;
  }
  // The week holding a card id, reading week files not yet loaded (only their
  // ids are kept, never the items). Resolves null when no week has it.
  async function findCardWeek(id) {
    if (cardWeek[id]) return cardWeek[id];
    for (const w of api.weeks || []) {
      if (!w.file || scanned[w.key] === (w.rev || '')) continue;
      try {
        const j = await getJSON(w.file + '?rev=' + encodeURIComponent(w.rev || ''));
        scanned[w.key] = w.rev || '';
        lastGood.weeks[w.key] = j; lastGood.revs[w.key] = w.rev || '';
        for (const it of j.items || []) cardWeek[it.id] = w.key;
        if (cardWeek[id]) return cardWeek[id];
      } catch { /* an unreadable week is skipped; the next is tried */ }
    }
    return null;
  }
  // An old `?meeting=` link: a source id, or a meeting uuid in either spelling.
  function sourceForMeeting(m) {
    const srcs = api.allSources || {};
    if (!m) return null;
    if (srcs[m]) return m;
    for (const [k, s] of Object.entries(srcs)) if (s && s.uuid && canonUuid(s.uuid) === canonUuid(m)) return k;
    return null;
  }

  // ── The Zoom meeting this panel is in ──
  // The Zoom Apps SDK is loaded only on the Zoom surface. Zoom is asked once; `ms` caps
  // how long a caller waits (the first render, study.js), counting no answer by then as none,
  // and the board shows its default meeting (the /whoami meeting cookie, then the live
  // meeting) meanwhile. Only Zoom's own answer, however late, settles which meeting the
  // panel is in (Astra, 10/29: a slow answer is not a no). The SDK's one loader is
  // ui/link.js's; the invite box starts it as the page opens (zoom-invite.js).
  // A lookup (the SDK's script, then Zoom's answer) not done in ZOOM_ASK_MS counts as not
  // answered yet, so it is asked again.
  const ZOOM_ASK_MS = 10000, UNANSWERED = {};
  const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(UNANSWERED), ms))]);
  let sdkAsk = null;
  function zoomMeeting(ms) {
    if (!api.zoom) return Promise.resolve(null);
    if (!sdkAsk) sdkAsk = within(loadZoomSdk().then(() => {
      const sdk = window.zoomSdk;
      if (!sdk || !sdk.config) return UNANSWERED;
      return sdk.config({ capabilities: ['getMeetingUUID'] })
        .then(() => sdk.getMeetingUUID())
        .then((r) => (r && r.meetingUUID) || null)
        .catch(() => null);     // null: not in a meeting, or not in Zoom at all
    }), ZOOM_ASK_MS).then((uuid) => {
      // No SDK (its script failed) or no answer in time is no answer: the header keeps waiting,
      // and the next ask tries again.
      if (uuid === UNANSWERED) { sdkAsk = null; return null; }
      if (uuid) api.meeting = uuid;
      api.zoomAnswered = true;
      return uuid;
    });
    return ms ? within(sdkAsk, ms).then((uuid) => (uuid === UNANSWERED ? null : uuid)) : sdkAsk;
  }

  // onFeed(sources): told the meetings as soon as the feed has them, before their cards are read.
  async function fetchSnapshot(onFeed) {
    const open = requestedOpen();
    const openAsk = open ? getJSON('/open-todos?mine=' + (open === 'mine' ? 1 : 0) + '&t=' + Date.now()) : null;
    // Each meeting's shared to-do order; the last good copy on a miss.
    const ordersAsk = getJSON('/order?t=' + Date.now() + (api.me ? '&who=' + encodeURIComponent(api.me) : '')).then((o) => (o && o.orders) || {}, () => lastGood.orders);
    const feed = await getJSON('board_feed.json?t=' + Date.now());
    if (onFeed) onFeed(feed.sources || {});
    const weeks = pickWeeks(feed.weeks || []);
    const warnings = [];
    let weekMissed = false;
    const weekFiles = await mapLimit(weeks, WEEK_FETCHES, (w) => {
      const k = w.key;
      // A week whose rev is unchanged is not refetched -- the feed's rev
      // is exactly what says the file's content is the same.
      if (w.rev && lastGood.revs[k] === w.rev && lastGood.weeks[k]) return lastGood.weeks[k];
      return getJSON(w.file + '?rev=' + encodeURIComponent(w.rev || ''))
        .then((j) => { lastGood.weeks[k] = j; lastGood.revs[k] = w.rev || ''; return j; })
        .catch(() => {
          weekMissed = true;
          warnings.push('Feed unavailable — showing the last good copy');
          return lastGood.weeks[k] || { items: [] };
        });
    });
    const items = weekFiles.flatMap((w) => (w && w.items) || []);
    // Open to-dos: the open list's copy of a card replaces the week's (it says which list
    // it came from); a failed read keeps the last good list, as a week does.
    if (openAsk) {
      const got = await openAsk.then((o) => o, () => null);
      if (got) lastGood.open = { scope: open, items: got.items || [], more: !!got.more };
      else warnings.push('Open to-dos unavailable — showing the last good copy');
      if (lastGood.open && lastGood.open.scope === open && lastGood.open.more) {
        warnings.push('Open to-dos: showing the newest ' + lastGood.open.items.length + '; open a meeting for older ones');
      }
      const held = lastGood.open && lastGood.open.scope === open ? lastGood.open.items : [];
      const ids = new Set(held.map((c) => c.id));
      items.splice(0, items.length, ...items.filter((c) => !ids.has(c.id)), ...held);
    }
    // The plugins' tags and narrowing, read while the rest is put together.
    const pluginsAsk = Promise.all([pluginTags(items), pluginCardData(items), pluginNarrow()]);
    // Keep only the weeks now held: after one "All weeks" visit the cache would
    // otherwise be the whole store for the life of a page that runs for days.
    const held = new Set(weeks.map((w) => w.key));
    for (const k of Object.keys(lastGood.weeks)) if (!held.has(k)) { delete lastGood.weeks[k]; delete lastGood.revs[k]; }
    api.weeks = (feed.weeks || []).map((w) => ({ key: w.key, label: w.label, n: w.n ?? null, file: w.file, rev: w.rev }));
    api.allSources = feed.sources || {};
    for (const w of weeks) for (const it of (lastGood.weeks[w.key] || {}).items || []) cardWeek[it.id] = w.key;
    const sources = Object.assign({}, feed.sources || {});
    // An open card's meeting the feed has not listed (yet): named by what the card says of it.
    for (const c of items) {
      if (!c.meeting || sources[c.from]) continue;
      const start = new Date(c.meeting.starts_at || '');
      const ok = Number.isFinite(start.getTime());
      sources[c.from] = { label: c.meeting.title || 'Meeting', start: ok ? c.meeting.starts_at : '', date: ok ? (start.getMonth() + 1) + '/' + start.getDate() : '' };
    }
    api.warnings = [...new Set(warnings)];

    api.people = (feed.people || []).map((p) => p[0]);
    // One colour per person: the feed's roster colours. Only a hex colour is
    // kept -- it goes into a style attribute.
    const HEXCOL = /^#[0-9a-fA-F]{3,8}$/;
    api.colors = {};
    for (const [name, color] of feed.people || []) if (HEXCOL.test(color || '')) api.colors[name] = color;
    // ...and a card's own owner colour, for a name the room gave that is on no roster.
    for (const it of items) {
      if (it && it.owner && HEXCOL.test(it.ownerColor || '') && !api.colors[it.owner]) api.colors[it.owner] = it.ownerColor;
    }
    api.capture = feed.capture || null;
    // Each meeting's last extraction pass this feed includes;
    // attentive.js follows a finished pass until it shows up here. Advanced
    // only when every week file it describes loaded: on a fallback to a
    // cached week the cards may not be on screen, so the old ack stays and
    // the follow keeps retrying.
    if (!weekMissed) api.extractionSeen = (feed.extraction_seen && typeof feed.extraction_seen === 'object') ? feed.extraction_seen : {};
    api.tail = Array.isArray(feed.tail) ? feed.tail : [];   // raw transcript tail (footer)
    // Only sources something on the desk comes from, so the meeting list is
    // not every recording the store has ever held.
    const used = new Set(items.map((c) => c.from));
    // ...except a meeting in progress, which legitimately has no cards yet: a
    // board that hides it looks like a board that stopped working.
    const shown = Object.fromEntries(Object.entries(sources).filter(([k, s]) => used.has(k) || (s && s.live)));
    // Every meeting's order and yours (dnd.js reads api.orders); on the
    // snapshot too, so a poll where only an order changed repaints (study.js
    // refresh's sig) and a drag always starts from the order it shows.
    lastGood.orders = await ordersAsk;
    await pluginsAsk;
    api.orders = lastGood.orders;
    return { items, sources: shown, orders: lastGood.orders, week: api.loadedWeek, open };
  }

  // One plugin read: what it answers, or a rejection when it throws or has not answered in
  // PLUGIN_READ_MS (22 Oct), so one plugin never holds the board's snapshot.
  function pluginRead(f, slot, ...args) {
    return Promise.race([
      Promise.resolve().then(() => f[slot](...args)),
      new Promise((_, reject) => setTimeout(() => reject(new Error(slot + ': no answer')), PLUGIN_READ_MS)),
    ]);
  }

  // Each feature plugin's tags on the cards it names, as `tags`: [{plugin, key, text}], read on
  // every snapshot, so a tag that changed is a changed card. A plugin that cannot answer tags nothing.
  async function pluginTags(items) {
    const ids = items.map((c) => c.id);
    // Whatever one plugin answers or throws, it tags nothing: the board reads on.
    const lists = await Promise.all(window.bwatBoard.features().filter((f) => typeof f.tags === 'function')
      .map((f) => pluginRead(f, 'tags', ids)
        .then((rows) => rows.map((r) => ({ card_id: r.card_id, tag: { plugin: f.name, key: String(r.key), text: String(r.text), mark: r.mark == null ? '' : String(r.mark) } })))
        .catch(() => [])));
    const byCard = {};
    for (const r of lists.flat()) (byCard[r.card_id] ||= []).push(r.tag);
    for (const c of items) c.tags = byCard[c.id] || [];
  }

  // Each feature plugin's own data on the cards it names, as `pluginData`: {<plugin>: {...}},
  // read on every snapshot (cardData), for its other hooks to draw from (cardAction). A plugin
  // that cannot answer gives no card any data.
  async function pluginCardData(items) {
    const ids = items.map((c) => c.id);
    const lists = await Promise.all(window.bwatBoard.features().filter((f) => typeof f.cardData === 'function')
      .map((f) => pluginRead(f, 'cardData', ids).then((rows) => rows.map((r) => [r.card_id, f.name, r])).catch(() => [])));
    // Keyed only by the cards asked about: a row naming any other id (__proto__ included) is dropped.
    const byCard = new Map(ids.map((id) => [id, {}]));
    for (const [id, name, r] of lists.flat()) if (byCard.has(id)) byCard.get(id)[name] = r;
    for (const c of items) c.pluginData = byCard.get(c.id);
  }

  // ?narrow=<plugin>:<key>: the board narrowed to the cards that plugin names for it, as
  // api.narrow {label, ids}, read on every snapshot; null when none is asked for or it cannot answer.
  async function pluginNarrow() {
    const [name, ...rest] = (new URLSearchParams(location.search).get('narrow') || '').split(':');
    const f = window.bwatBoard.features().find((x) => x.name === name && typeof x.narrow === 'function');
    api.narrow = f ? await pluginRead(f, 'narrow', rest.join(':'))
      .then((got) => ({ label: String(got.label), ids: new Set(got.ids) })).catch(() => null) : null;
  }

  async function fetchSessions() {
    try {
      const j = await getJSON('/sessions?t=' + Date.now() + (api.me ? '&who=' + encodeURIComponent(api.me) : ''));
      api.hub = (j.hub || []).filter((s) => s && s.session_id);
      api.hubReason = j.hub_reason || '';
      api.defaultOff = j.default_off || null;
    } catch { api.hub = []; api.hubReason = 'sessions unavailable'; api.defaultOff = null; }
    return api.hub;
  }

  const sameMeeting = (a, b) => !!a && !!b && canonUuid(a) === canonUuid(b);

  // Newest first by `at`: gen_board always fills it (start time, else the day),
  // where `start` is often missing -- sorting by it put a 15:01 meeting after
  // a 15:07 one.
  const byAtDesc = (a, b) => String(b[1].at || '').localeCompare(String(a[1].at || ''));

  // The meeting the Zoom panel was opened from, else the newest meeting that
  // is capturing now, else the newest meeting.
  // `open`: the viewer's board setting. 'all' opens on every
  // meeting, except that the meeting Zoom opened the panel from still wins.
  function defaultSource(sources, open) {
    const rows = Object.entries(sources || {}).sort(byAtDesc);
    const mine = api.meeting && rows.find(([, s]) => sameMeeting(s.uuid, api.meeting));
    if (mine) return mine[0];
    if (open === 'all') return 'all';
    // `live` is gen_board's "in progress now"; `capture` is only how the
    // receipt was captured, and is 'live' for every operator-captured meeting.
    const live = rows.find(([, s]) => s.live);
    return (live || rows[0] || ['all'])[0];
  }

  // Inside Zoom, whether the meeting on screen (`source`) is known to be the one the panel is
  // in: it is the meeting Zoom named (its app context, /whoami, or the SDK), or Zoom has answered
  // and named none. Else it is a guess.
  function meetingSettled(sources, source) {
    if (!api.meeting) return api.zoomAnswered;
    const s = sources && sources[source];
    return !!s && sameMeeting(s.uuid, api.meeting);
  }

  // `ms`: a longer wait for a call the hub does slowly.
  function postJSON(u, body, ms) {
    return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(ms || 15000) })
      .then((r) => r.json().catch(() => ({})).then((j) => ({ ok: r.ok && j.ok !== false, status: r.status, body: j })));
  }
  // postJSON's answer, never a throw: a request that could not be sent at all answers status 0,
  // in the board's one wording for it.
  const post = (u, body, ms) => postJSON(u, body, ms).catch(() => ({ ok: false, status: 0, body: { error: 'Couldn’t reach the board.' } }));

  return { api, ready, loaded, whoami, fetchSnapshot, fetchSessions, defaultSource, meetingSettled, postJSON, post, getJSON, escText, safeHttps, byAtDesc, canonUuid,
    requestedWeek, requestedOpen, OPEN, findCardWeek, sourceForMeeting, loadZoomSdk, zoomMeeting, uncachedWeeks, mapLimit, ALL_WEEKS };
})();
