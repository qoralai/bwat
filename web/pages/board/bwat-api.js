/* The board's data, from the bwat backend and card service (D173, D181).
 *
 * The desk was ported as it was from the prototype, which read one
 * generated feed (board_feed.json and its week files) and posted to its own
 * small server (/assign, /archive, /route, /sessions, /whoami). This file is
 * the one place that speaks the new API: it wraps window.fetch, answers those
 * old paths by calling /v1/* with the signed-in person's Google id_token as the
 * bearer, and passes every other request through untouched. Loaded as a plain script
 * by board.html, before the desk's own (after ui/link.js, the account-linking helpers it uses).
 *
 *   /whoami            the sign-in server's /whoami: the member, and the bearer
 *                      (inside Zoom, a board token; or "link your account" once;
 *                      with a plugin's sign-in, that plugin's bearer, with embedded: true)
 *   board_feed.json    GET /v1/meetings and GET /v1/members; GET /v1/cards/counts, each meeting's
 *                      cards counted (a week sums them); the current meeting's newest transcript lines
 *   board_week_*.json  GET /v1/occurrences/{meeting id}/cards per meeting that week
 *   /open-todos        GET /v1/cards?status=open, every page: every meeting's open cards
 *                      (?mine=1: owner=me, the viewer's by member, never by name)
 *   /assign            PUT  /v1/cards/{id}/owner
 *   /archive           POST /v1/cards/{id}/archive, with Done or Won't do
 *   /unarchive         POST /v1/cards/{id}/unarchive (Undo)
 *   /keep              POST /v1/cards/{id}/keep: Save on a card about to expire
 *   /edit              PATCH /v1/cards/{id}: a new title, a note
 *   /editing           GET and POST /v1/editing: who is editing which card
 *   /clarify           POST /v1/cards/{id}/clarify: a question's answer, which closes it, and its to-do
 *   /order             GET and PUT /v1/orders: a meeting's drag order, and your own
 *   /extraction-activity  GET /v1/occurrences/{meeting id}/activity: the card writer's last pass
 *   /sessions          GET  /v1/sessions
 *   /route             POST /v1/handoffs
 *   /hint-dismiss      POST /v1/cards/{id}/hint/dismiss {kind, target_card_id}: Not a duplicate, or Dismiss
 *   /hint-act          POST /v1/cards/{id}/hint/act {kind, target_card_id}: Merge now, or Link now;
 *                      both refused (409 hint_changed) once the hint no longer names that card
 *   /allocations       GET and POST /v1/allocations: the meeting bots, and Send bwat to a meeting
 *                      {zoom_url} (any signed-in person; its error code passes through)
 *   /recall            PATCH /v1/allocations/{id} {recall: true}: an owner or an admin asks bwat to leave
 *
 * The transcript download (/transcript) and /version are the web server's own.
 *
 * Plugins: before any identity or data request, the page reads which plugins the web server
 * runs (/board-plugins) and loads their board scripts (/plugins/<name>/...), each of which
 * registers itself with window.bwatBoard.register(name, provider); a feature plugin (one that gives
 * `start`) runs on every page (window.bwatBoard.features). A page whose address asks for a plugin's sign-in (?surface=<its token>)
 * is that plugin's for its whole life: every request it makes to this site carries X-Bwat-Surface: <its token>, the server answers as the
 * plugin's person only, and a 401 is the plugin's to show, never a Google sign-in. If that
 * plugin is off, or its script fails, or the list cannot be read, the page stops and says the
 * board is not available here; a page that asks for no plugin carries on without it.
 * Where a card is sent: the selected plugin may supply its own targets (`sendLabel`,
 * `listTargets()`, `route(card, row, { request_id })`); then /sessions lists its rows and /route
 * goes to it, never to the person's sessions (sendTargets below). Otherwise Send to Claude, as ever.
 * What bwat does not hold answers honestly: merged cards support undo, and a hand-off's read status is the
 * card's: it says "Queued", then "Read" once the session marks it read.
 */
'use strict';
(function () {
  const nativeFetch = window.fetch.bind(window);
  // A fetch that never reached the server is marked, so the shim says so in the desk's words while
  // any other error keeps its own.
  const realFetch = (input, init) => nativeFetch(input, init).catch((err) => {
    if (err && err.name === 'TypeError') err.unreached = true;
    throw err;
  });
  const BUCKET = { task: 'do', decision: 'decided', question: 'ask', risk: 'risk' };
  // Owner chip colours, as the prototype's chips.py gave them: mid-tones that carry
  // white text on both grounds, one per name from a hash of it, so a person keeps
  // their colour however many people the board holds.
  const CHIP_HUES = ['#2f6690', '#7a4e8c', '#1f7a5a', '#b0562a', '#8c3b52', '#2a6f7a', '#6b6a2c', '#4a6e8a'];
  // The card service's and the backend's refusals, in the prototype board's words.
  const ERRORS = {
    merged_card: 'Unmerge this card before changing it',
    not_merged: 'This card has no active merge to undo',
    archived: 'that card is no longer on the board',
    not_found: 'that card is no longer on the board',
    not_a_question: 'that card is not a question',
    not_open: 'that card is already closed',
    invalid_body: 'nothing to save',
    too_long: 'that text is too long',
    too_large: 'that card is too long to send',
    forbidden: 'not one of your sessions',
    session_unreachable: 'that session is not reachable right now',
    meeting_deleted: 'that meeting was deleted',
    cards_unavailable: 'bwat could not reach the cards just now; try again',
    backend_unavailable: 'bwat could not reach the cards just now; try again',
    database_unavailable: 'bwat could not reach the cards just now; try again',
    busy: 'bwat is busy just now; try again',
    unauthorized: 'you are signed out; reload the board',
  };
  const sentence = (r) => ERRORS[r.data.error] || r.data.error || 'HTTP ' + r.status;
  // A read the backend refused: its status kept, so the feed can tell a gateway that could not reach
  // it (502-504) from an answer of the backend's own.
  const httpError = (what, status) => Object.assign(new Error(what + 'HTTP ' + status), { status });

  let who = null;                       // the /whoami answer: {member, id_token, occurrence_id, embedded?}
  // The plugins' board side (the file header): each script registers once while it runs, during
  // activation only. The selected one (`provider`, with its `token`) is fixed for the page's life.
  const providers = new Map();
  let registering = true;
  window.bwatBoard = Object.freeze({
    register(name, p) {
      if (registering && typeof name === 'string' && p && !providers.has(name)) providers.set(name, Object.freeze({ ...p }));
    },
    // The feature plugins, for the board's own scripts (ui/plugins.js): every registered plugin
    // that gave `start`, each started once with its own routes (`api('GET', '/x')` asks
    // /v1/plugins/<name>/x as the signed-in person). What each may supply: ui/plugins.js.
    // One this person hid in Settings is still started but left out, so nothing of it is drawn.
    features: () => { const hid = hidden(); return features.filter((f) => !hid.includes(f.name)); },
    // Every started feature plugin, hidden or not, with the name Settings shows for it.
    installed: () => features.map((f) => ({ name: f.name, label: f.pageLabel || f.name[0].toUpperCase() + f.name.slice(1) })),
    setHidden(name, hide) {
      const hid = hidden().filter((n) => n !== name);
      if (hide) hid.push(name);
      try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hid)); } catch { /* this page only */ }
      hiddenHere = hid;
    },
  });
  let features = [];
  // The plugins this person hid from their own board, kept in this browser like the rest of
  // Settings; where the browser keeps nothing, for this page only.
  const HIDDEN_KEY = 'bwat.hidden-plugins';
  let hiddenHere = null;
  // Read once a page: features() is asked for every card drawn.
  function hidden() {
    if (hiddenHere) return hiddenHere;
    try {
      const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
      hiddenHere = Array.isArray(v) ? v : [];
    } catch { hiddenHere = []; }
    return hiddenHere;
  }
  const SURFACE = 'x-bwat-surface';
  const VIEWS = ['zoom', 'web'];               // the board's own views, never a plugin's selector
  const framed = (() => { try { return window.self !== window.top; } catch { return true; } })();
  let provider = null;                         // the selected plugin's sign-in
  let token = null;                            // its selector, sent as X-Bwat-Surface
  let selected = false;                        // the address asked for a plugin's sign-in
  let stopped = false;                         // the page could not be that plugin's: nothing more is sent
  const PLUGINS_MS = 3000;                     // the plain board's wait for the plugin list (and zoom's, web's)
  // Startup, or the request's own abort, whichever comes first: no request waits on the plugin list
  // past its deadline, though a plugin's sign-in keeps waiting for it (activate).
  const readyFor = (signal) => (!signal ? ready : Promise.race([ready, new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })]));
  const ready = activate().catch(() => { if (selected) stop(); }).finally(() => {
    registering = false;
    if (stopped) return;
    // A plugin whose start throws is left out; the board runs without it.
    features = [...providers].filter(([name, p]) => {
      if (typeof p.start !== 'function') return false;
      // refresh(): the board reads again (ui/plugins.js), so what the plugin learned since it
      // started, say its own setup, shows without waiting for the next poll.
      const refresh = () => window.dispatchEvent(new Event('bwat:plugin-refresh'));
      try { p.start({ api: (method, path, body) => api(method, '/v1/plugins/' + name + path, body), refresh }); return true; } catch { return false; }
    }).map(([name, p]) => ({ name, ...p }));
  });

  async function activate() {
    const surfaces = new URLSearchParams(location.search).getAll('surface');
    const read = realFetch('/board-plugins', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    // A page asking for a plugin's sign-in waits for the list however long it takes (it must never run
    // as anyone else); any other page, the board's own views (?surface=zoom, web) included, waits
    // PLUGINS_MS at most, then carries on without its feature plugins.
    const signIn = surfaces.some((s) => !VIEWS.includes(s));
    const list = await (signIn ? read : Promise.race([read, new Promise((resolve) => setTimeout(() => resolve(null), PLUGINS_MS))]));
    const plugins = list && Array.isArray(list.plugins) ? list.plugins : [];
    // More than one surface: the server refuses it; the page never runs as anyone.
    if (surfaces.length > 1) { selected = true; return stop(); }
    // A page asking for no plugin's sign-in still runs the board's feature plugins (features below).
    const asked = surfaces.length ? surfaces[0] : 'web';
    // Any value that is not one of the board's views asks for a plugin's sign-in. One no listed
    // plugin answers (off, its code missing, the list unreadable, or no such plugin) stops the
    // page: never the ordinary sign-in.
    selected = !VIEWS.includes(asked);
    for (const p of plugins) {
      let loaded = true;
      try { for (const src of p.scripts || []) await load(src); } catch { loaded = false; }
      if (selected && p.token === asked && (!loaded || !providers.has(p.name))) return stop();
    }
    if (!selected) return;
    const entry = plugins.find((p) => p.token === asked);
    const p = entry && providers.get(entry.name);
    if (!p) return stop();
    // The plugin's own policy: it may decline a page it does not take as its own (a frame-only
    // plugin, a page of its own): the selector leaves the address and the page runs without it.
    if (typeof p.admit === 'function' && p.admit({ framed }) === 'strip') {
      selected = false;
      const plain = new URL(location.href);
      plain.searchParams.delete('surface');
      history.replaceState(history.state, '', plain.pathname + plain.search + plain.hash);
      return;
    }
    provider = p;
    token = asked;
    if (typeof p.install === 'function') p.install({ send, notify, dialog });
  }

  // A plugin's board script, from this site only, as its own script tag.
  function load(src) {
    return new Promise((resolve, reject) => {
      const url = new URL(src, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/plugins/')) { reject(new Error('not ours')); return; }
      const tag = document.createElement('script');
      const timer = setTimeout(() => reject(new Error('timed out')), 10000);
      tag.src = url.pathname;
      tag.onload = () => { clearTimeout(timer); resolve(); };
      tag.onerror = () => { clearTimeout(timer); reject(new Error('not loaded')); };
      document.head.appendChild(tag);
    });
  }

  // A full-screen sentence over the page, which it leaves out of reach (inert): the page's own
  // stop below, and a plugin's (install's `dialog`), so both screens behave alike. Shown once per id.
  function dialog(id, text) {
    const show = () => {
      if (document.getElementById(id)) return;
      const box = document.createElement('div');
      box.id = id;
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', id + '-text');
      box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;'
        + 'padding:16px;background:Canvas;color:CanvasText;font:15px/1.5 system-ui,sans-serif';
      const p = document.createElement('p');
      p.id = id + '-text';
      p.tabIndex = -1;
      p.style.cssText = 'max-width:340px;margin:0;text-align:center';
      p.textContent = text;
      box.appendChild(p);
      for (const el of document.body.children) el.inert = true;
      document.body.appendChild(box);
      p.focus();
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }

  // The page asked for a plugin's sign-in it cannot have: nothing more is sent, and it says so.
  // Never a Google sign-in: it may be inside a frame Google refuses.
  function stop() {
    stopped = true;
    dialog('bwat-unavailable', 'This board is not available here. Close it and open it again.');
  }

  // The selected plugin's own send targets, when it supplies them: its rows in the send list and
  // its route for a pick, in place of the person's sessions (no default, no note: those are the
  // sessions'). Rows: { id, label, kind, available, default, keywords?, stale?, age_s? }; one that
  // is not `available` is listed but cannot be picked. The plugin's reasons are its own sentences.
  const sendTargets = () => (provider && typeof provider.listTargets === 'function' && typeof provider.route === 'function' ? provider : null);
  const TARGETS_MAX = 100;
  const TEXT_MAX = 300;
  const NOT_AVAILABLE = 'Sending is not available here.';
  let targetRows = new Map();                  // row id -> the row, as the send list last showed it
  const textOf = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
  const reasonOf = (e) => textOf(e && e.message, TEXT_MAX) || NOT_AVAILABLE;
  // A row is shown only in the send list's own shape, every field checked; anything else is left out.
  function targetRow(r) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 200) return null;
    const label = textOf(r.label, 200);
    if (!label) return null;
    return {
      id: r.id, label, available: r.available === true, default: r.default === true,
      stale: r.stale === true, age_s: Number.isFinite(r.age_s) && r.age_s >= 0 ? Math.round(r.age_s) : null,
      keywords: Array.isArray(r.keywords) ? r.keywords.map((k) => textOf(k, 64)).filter(Boolean).slice(0, 20) : [],
    };
  }
  async function listTargets() {
    let rows;
    try { rows = await sendTargets().listTargets(); } catch (e) {
      targetRows = new Map();
      return json(200, { sessions: [], hub: [], default_off: null, hub_reason: reasonOf(e) });
    }
    const shown = (Array.isArray(rows) ? rows : []).slice(0, TARGETS_MAX).map(targetRow).filter(Boolean);
    targetRows = new Map(shown.map((r) => [r.id, r]));
    const hub = [...targetRows.values()].map((r) => ({
      session_id: r.id, label: r.label, stale: r.stale, router: r.available, age_s: r.age_s, default: r.default, keywords: r.keywords,
    }));
    for (const h of hub) sessionLabels[h.session_id] = h.label;
    return json(200, { sessions: [], hub, default_off: null, hub_reason: hub.length ? '' : 'Nothing here to send it to.' });
  }
  async function routeToTarget(b) {
    const row = targetRows.get(b.session);
    if (!row) return json(409, { ok: false, error: 'that is no longer in the list; choose again' });
    if (!row.available) return json(409, { ok: false, error: 'that one cannot take it right now' });
    const card = { id: b.id, title: typeof b.title === 'string' ? b.title : '' };
    const res = await Promise.resolve()
      .then(() => sendTargets().route(card, { ...row }, { request_id: typeof b.message_id === 'string' ? b.message_id : '' }))
      .catch((e) => ({ refused: true, why: reasonOf(e) }));
    if (!res || res.ok !== true) return json(409, { ok: false, error: textOf(res && res.why, TEXT_MAX) || NOT_AVAILABLE });
    // The target took it (the card may carry a new revision, as after a hand-off).
    return json(200, { ok: true, target: row.label, ...(await freshCard(b.id)) });
  }

  // The selected plugin's session ended (a 401): its own screen, or ours.
  const signedOut = () => (provider && typeof provider.signedOut === 'function' ? provider.signedOut() : stop());

  // `init` with the selector added when a plugin's sign-in is selected; as it was anywhere else.
  const marked = (init) => {
    if (!token) return init;
    const headers = new Headers(init && init.headers);
    headers.set(SURFACE, token);
    return { ...init, headers };
  };
  // A request to this site, marked when a plugin's sign-in is selected (a Request's own headers kept).
  const send = (input, init) => {
    if (!token) return realFetch(input, init);
    if (typeof input !== 'string' && !(input instanceof URL)) {
      const headers = new Headers((init && init.headers) || input.headers);
      headers.set(SURFACE, token);
      return realFetch(input, { ...init, headers });
    }
    return realFetch(input, marked(init));
  };
  let members = [];                     // GET /v1/members
  let meetings = [];                    // GET /v1/meetings, newest first
  const cardMeeting = {};               // card id -> meeting id, as week files are read
  const sessionLabels = {};             // session id -> its label, as /sessions is read
  const labels = {};                    // card id -> the label the board shows (display_id)
  const cardsOf = {};                   // meeting id -> its cards on the board, as last read
  let counts = null;                    // meeting id -> {cards, cards_version}, as last counted; null until one count
  // A week's cards are read again when one of its meetings' cards changed, and at least this
  // often for what never changes a card: Jev's hints, "expires in" days, owner names, meeting titles.
  const WEEK_WINDOW_MS = 180_000;
  // Meetings whose cards are read again on the next feed whatever the counts say (meeting id ->
  // when marked): one whose read failed, and one whose card this board just changed (the counts
  // can lag a change by seconds). A read takes its meeting off as it begins, so a mark made while
  // it is in flight stays. A mark lasts one window, which re-reads every shown week anyway, so a
  // meeting in a week not shown does not keep its week's rev moving.
  const reread = new Map();
  const mark = (meetingId) => reread.set(meetingId, Date.now());
  const isMarked = (meetingId) => Date.now() - (reread.get(meetingId) ?? -Infinity) < WEEK_WINDOW_MS;
  // The routes that write a card, not every POST: /editing beats every 8 s while a card is open,
  // and would read the week again each time.
  const WRITES = new Set(['/assign', '/archive', '/unarchive', '/keep', '/unmerge', '/edit', '/clarify', '/route', '/hint-dismiss', '/hint-act']);

  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  async function whoami(again, signal) {
    await readyFor(signal);
    if (stopped) throw new Error('stopped');
    if (who && !again) return who;
    const r = await realFetch('/whoami', marked({ cache: 'no-store', credentials: 'same-origin', signal }));
    if (selected && r.status === 401) { signedOut(); throw new Error('signed out'); }
    // The selector refused (malformed 400, the plugin off 404): never anyone else. Any other
    // failure is a passing one, as without a plugin; that includes 503 (the plugin list could
    // not be read just now), which the server still refuses until a read succeeds.
    if (selected && [400, 404].includes(r.status)) { stop(); throw new Error('stopped'); }
    if (r.status === 401) {
      const body = await r.json().catch(() => ({}));
      if (body.error === 'link_needed') { askToLink(body.link_url); throw new Error('link needed'); }
      // Back to this page after sign-in, its meeting and card included.
      location.assign('/auth/login?back=' + encodeURIComponent(location.pathname + location.search));
      throw new Error('signed out');
    }
    if (!r.ok) throw httpError('', r.status);
    who = await r.json();
    return who;
  }

  // Inside Zoom, a Zoom user no member holds yet links once: they sign in with Google
  // in the browser (Google refuses sign-in inside an embedded window), which shows a
  // code, and type it in here. The board is then signed in, now and from then on.
  function askToLink(url) {
    if (document.getElementById('bwat-link')) return;
    const show = () => {
      const box = document.createElement('div');
      box.id = 'bwat-link';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'bwat-link-title');
      box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;'
        + 'padding:16px;background:Canvas;color:CanvasText;font:15px/1.5 system-ui,sans-serif';
      const field = 'font:inherit;padding:8px 12px';
      box.innerHTML = '<div style="max-width:340px;text-align:center">'
        + '<h1 id="bwat-link-title" style="font-size:18px;margin:0 0 8px">Link your bwat account</h1>'
        + '<p style="margin:0 0 16px">Once only: sign in with Google in your browser, then type the code it shows here.</p>'
        + '<button type="button" style="' + field + ';cursor:pointer">Sign in with Google</button>'
        + '<form style="display:flex;gap:8px;justify-content:center;margin:16px 0 0">'
        + '<label for="bwat-link-code" style="position:absolute;left:-9999px">Code from your browser</label>'
        + '<input id="bwat-link-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH"'
        + ' style="' + field + ';width:9em;text-transform:uppercase;letter-spacing:1px">'
        + '<button type="submit" style="' + field + ';cursor:pointer">Link</button></form>'
        + '<p role="status" aria-live="polite" style="margin:12px 0 0;min-height:1.5em"></p></div>';
      box.querySelector('button').addEventListener('click', () => openInBrowser(url));
      window.bwatLink.pairForm(box.querySelector('form'), box.querySelector('[role=status]'), realFetch);
      // The board underneath is out of reach until the person has linked.
      for (const el of document.body.children) el.inert = true;
      document.body.appendChild(box);
      box.querySelector('button').focus();
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }

  // Zoom's openUrl opens the system browser; anywhere else, a new tab (ui/link.js).
  function openInBrowser(url) {
    window.bwatLink.openInBrowser(url);
  }

  // One /v1 call with the person's bearer; a 401 re-reads /whoami once (a
  // token that lapsed since the last read) and tries again. Never with a plugin's sign-in: there
  // a 401 is the plugin's to show, and nothing is retried, so an action started as the plugin's
  // person never runs as anyone else.
  async function api(method, path, body, signal) {
    const call = async () => {
      const w = await whoami(false, signal);
      const headers = { authorization: 'Bearer ' + w.id_token, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      return realFetch(path, marked({ method, headers, cache: 'no-store', signal, body: body === undefined ? undefined : JSON.stringify(body) }));
    };
    let r = await call();
    if (r.status === 401 && selected) signedOut();
    else if (r.status === 401) { await whoami(true, signal); r = await call(); }
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, data };
  }

  // The name the desk shows and match people by: a member has no display name
  // until they set one (a first owner, say), so the email stands in; a name two
  // members share carries the email too, or picking one would assign the other.
  const label = (m) => {
    if (!m.display_name) return m.email;
    const shared = members.filter((x) => x.display_name === m.display_name).length > 1;
    return shared ? m.display_name + ' (' + m.email + ')' : m.display_name;
  };
  const nameOf = (id) => { const m = members.find((x) => x.id === id); return m ? label(m) : null; };
  const idOf = (name) => (members.find((m) => label(m) === name) || {}).id || null;
  const colorOf = (name) => CHIP_HUES[sha1Head(String(name).trim().toLowerCase()) % CHIP_HUES.length];

  // The first 32 bits of SHA-1 (what chips.py reads as int(hexdigest()[:8], 16)):
  // synchronous, as the colour is wanted while a card is mapped.
  function sha1Head(text) {
    const bytes = new TextEncoder().encode(text);
    const words = new Uint32Array((((bytes.length + 8) >> 6) + 1) * 16);
    bytes.forEach((b, i) => { words[i >> 2] |= b << (24 - (i % 4) * 8); });
    words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
    words[words.length - 1] = bytes.length * 8;
    const rotl = (x, n) => (x << n) | (x >>> (32 - n));
    const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    const w = new Uint32Array(80);
    for (let block = 0; block < words.length; block += 16) {
      for (let t = 0; t < 80; t++) w[t] = t < 16 ? words[block + t] : rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
      let [a, b, c, d, e] = h;
      for (let t = 0; t < 80; t++) {
        const f = t < 20 ? (b & c) | (~b & d) : t < 40 || t >= 60 ? b ^ c ^ d : (b & c) | (b & d) | (c & d);
        const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const next = (rotl(a, 5) + f + e + k + w[t]) >>> 0;
        e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = next;
      }
      [a, b, c, d, e].forEach((v, i) => { h[i] = (h[i] + v) >>> 0; });
    }
    return h[0];
  }

  // One spelling for a Zoom meeting uuid, as live.js has it: Zoom writes "/" and "+" as
  // "_" and "-" in some places.
  const canonUuid = (u) => String(u || '').trim().replace(/_/g, '/').replace(/-/g, '+');

  // Monday of the meeting's week, as the prototype's week keys were.
  // In the viewer's own time zone, as the start time beside it is.
  const localDate = (d) =>
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const mondayOf = (iso) => { const d = new Date(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)); };
  const weekOf = (iso) => localDate(mondayOf(iso));

  // Each meeting's cards on the board, as the week files show them: archiving is
  // how a card is dismissed, so it leaves the board for everyone.
  async function readCards(mt, signal) {
    const r = await api('GET', '/v1/occurrences/' + encodeURIComponent(mt.id) + '/cards', undefined, signal);
    if (!r.ok) throw httpError('cards: ', r.status);
    cardsOf[mt.id] = r.data.filter((c) => !c.archived);
    return cardsOf[mt.id];
  }
  // A card's new revision, after something wrote on it (a hand-off, a filing), as the page takes it:
  // { card: { id, version } }, or {} when it can't be read (its meeting unknown or unreadable).
  async function freshCard(id) {
    const fresh = cardMeeting[id] ? (await readCards({ id: cardMeeting[id] }).catch(() => [])).find((c) => c.id === id) : null;
    return fresh ? { card: { id: fresh.id, version: fresh.revision } } : {};
  }

  // The newest lines of a meeting's transcript, as the prototype's feed carried its last 30 frames.
  async function tailOf(mt, signal) {
    if (!mt) return [];
    const r = await api('GET', '/v1/meetings/' + encodeURIComponent(mt.id) + '/transcript?tail=30', undefined, signal);
    return r.ok ? r.data.segments || [] : [];
  }

  async function loadMembers(signal) {
    const p = await api('GET', '/v1/members', undefined, signal);
    members = p.ok ? p.data.members || [] : [];
  }

  // `signal`: the page's request for the feed, whose deadline every read here keeps (live.js getJSON), so a
  // read that never answers ends the feed in the page's load error rather than holding it for ever.
  async function feed(signal) {
    // Asked at once, as it needs neither the members nor the meetings.
    const counted = api('GET', '/v1/cards/counts', undefined, signal).catch(() => null);
    await loadMembers(signal);
    // The whole history, page by page, as "All weeks" needs it.
    const all = [];
    for (let cursor = ''; ;) {
      const m = await api('GET', '/v1/meetings?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), undefined, signal);
      if (!m.ok) throw httpError('meetings: ', m.status);
      all.push(...(m.data.meetings || []));
      if (!m.data.next_cursor) break;
      cursor = m.data.next_cursor;
    }
    meetings = all;
    // A week counts its cards, as the prototype's did, from the card service's count of each
    // meeting's: only a week shown reads its cards. A count that fails, however, keeps the last;
    // until one succeeds a week's number is unknown (null), never 0.
    const c = await counted;
    if (c?.ok) counts = Object.fromEntries(c.data.meetings.map((m) => [m.meeting_id, m]));
    const sources = {};
    const weeks = {};
    for (const mt of meetings) {
      const week = weekOf(mt.started_at);
      const start = new Date(mt.started_at);
      sources[mt.id] = {
        // A meeting Zoom has not named: "Meeting 14:05", the prototype's placeholder.
        label: mt.title || 'Meeting ' + start.toTimeString().slice(0, 5),
        uuid: mt.occurrence_id,
        week,
        // The desk reads `at` as the local start, YYYYMMDDhhmmss (Today, newest first).
        at: localDate(start).replace(/-/g, '') + start.toTimeString().slice(0, 8).replace(/:/g, ''),
        // The prototype's "10/1"; `start` the full time, which the desk shows with its zone.
        date: (start.getMonth() + 1) + '/' + start.getDate(),
        start: mt.started_at,
        duration_min: mt.duration_seconds == null ? null : Math.round(mt.duration_seconds / 60),
        // Live while the backend has a claim open for it: a bot that left with no final
        // push leaves ended_at null, and that meeting is not live.
        live: mt.occurrence_state === 'live',
        // A bot is in it now (joined, heard from lately): what the board's Live pill says.
        bot: mt.bot_present === true,
      };
      // A week is named by its Monday, "Sep 28".
      weeks[week] ??= { label: mondayOf(mt.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), n: counts && 0, reread: false, versions: [] };
      const m = counts && counts[mt.id];
      if (counts) weeks[week].n += m ? m.cards : 0;
      weeks[week].reread ||= isMarked(mt.id);
      weeks[week].versions.push(mt.id + ':' + (m ? m.cards_version : 0));
    }
    // Inside Zoom, the meeting the board was opened from, or none while bwat has not listed
    // it: a meeting number reused every day makes yesterday's meeting the live or newest one.
    // Elsewhere the meeting being captured now, else the newest. The transcript tail and the
    // card writer's status are this one's.
    const zoom = canonUuid((await whoami(false, signal)).occurrence_id);
    const current = zoom
      ? meetings.find((mt) => canonUuid(mt.occurrence_id) === zoom)
      : meetings.find((mt) => mt.occurrence_state === 'live') || meetings[0];
    const tail = await tailOf(current, signal);
    const [credit, links] = await Promise.all([outOfCredit(current, signal), connections(signal)]);
    showOutOfCredit(credit);
    showNotConnected(links);
    fitBanners();
    return {
      sources,
      // A week's rev moves when one of its meetings' cards changed, or its window is up; when
      // this feed could not count, on every feed, so no change goes unseen.
      weeks: Object.keys(weeks).sort().reverse().map((k) => ({
        key: k, label: weeks[k].label, n: weeks[k].n, file: 'board_week_' + k + '.json',
        rev: !c?.ok || weeks[k].reread ? String(Date.now()) : Math.floor(Date.now() / WEEK_WINDOW_MS) + '|' + weeks[k].versions.join(','),
      })),
      // Everyone the board can assign, by name.
      people: members.map(label).sort((a, b) => a.localeCompare(b)).map((name) => [name, colorOf(name)]),
      capture: {
        source: current ? current.id : null,
        status: !current ? 'WAITING' : current.occurrence_state === 'live' ? 'LIVE' : 'ENDED',
      },
      tail: tail.map((s) => ({ seq: s.seq, speaker: s.speaker.label || 'Unknown speaker', text: s.text })),
    };
  }

  // The model key out of credit: the bot in the live meeting reports it (GET /v1/meetings
  // bot_error), or the card writer's last pass for it does (its activity's error). Either
  // clears once that part's next call succeeds.
  const OUT_OF_CREDIT = 'model_out_of_credit';
  async function outOfCredit(mt, signal) {
    if (!mt || mt.occurrence_state !== 'live') return false;
    if (mt.bot_error === OUT_OF_CREDIT) return true;
    try {
      const a = await api('GET', '/v1/occurrences/' + encodeURIComponent(mt.id) + '/activity', undefined, signal);
      return a.ok && a.data?.error === OUT_OF_CREDIT;
    } catch {
      return false; // the banner is advice; a failed lookup never breaks the feed
    }
  }

  // The one sticky area at the top of the page the banners stack in, so two never overlap.
  // After the desk's skip link, so a Tab still reaches that first.
  function bannerArea() {
    let area = document.getElementById('bwat-banners');
    if (area) return area;
    area = document.createElement('div');
    area.id = 'bwat-banners';
    area.style.cssText = 'position:sticky;top:0;z-index:2147483646';
    const skip = document.querySelector('body > .skip');
    if (skip) skip.after(area); else document.body.prepend(area);
    window.addEventListener('resize', fitBanners);
    return area;
  }

  // The banners' height as --bwat-banners, which the desk's sticky card bar sits below.
  function fitBanners() {
    const area = document.getElementById('bwat-banners');
    document.documentElement.style.setProperty('--bwat-banners', (area ? area.offsetHeight : 0) + 'px');
  }

  // One banner, in the banners' look with its own colours.
  function newBanner(id, role, colours) {
    const bar = document.createElement('div');
    bar.id = id;
    bar.setAttribute('role', role);
    bar.style.cssText = 'padding:10px 16px;font:14px/1.5 system-ui,sans-serif;text-align:center;' + colours;
    return bar;
  }

  // A banner across the top of the page, inside Zoom too, while the key is out of credit.
  function showOutOfCredit(on) {
    const shown = document.getElementById('bwat-out-of-credit');
    if (!on) { if (shown) shown.remove(); return; }
    if (shown) return;
    const bar = newBanner('bwat-out-of-credit', 'alert', 'background:#b42318;color:#fff');
    bar.innerHTML = "bwat's AI model key is out of credit, so transcription and cards have stopped. "
      + 'Ask your bwat owner to add credit at <a href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener"'
      + ' style="color:inherit;text-decoration:underline">https://openrouter.ai/settings/credits</a>.';
    bannerArea().prepend(bar);
  }

  // The person's links bwat needs, read again every feed so the banner clears once it is connected
  // (GET /v1/me/connections). Null when the read fails.
  async function connections(signal) {
    try {
      const r = await api('GET', '/v1/me/connections', undefined, signal);
      return r.ok ? r.data : null;
    } catch {
      return null; // the banner is advice; a failed lookup never breaks the feed
    }
  }

  // A banner across the top of either page, below the credit one, while the person's Zoom login is
  // not linked, with the step that fixes it. Built once while it stays unlinked, so it is announced
  // once; a failed read (null) keeps whatever is shown. The board works without a Claude session,
  // so no banner says so: Send to Claude does, when it is used (study.js sessionListHTML).
  function showNotConnected(links) {
    if (!links) return;
    const shown = document.getElementById('bwat-not-connected');
    if (links.zoom !== false) { shown?.remove(); return; }
    if (shown) return;
    const bar = newBanner('bwat-not-connected', 'status', 'background:#fef0c7;color:#7a2e0e');
    const line = document.createElement('p');
    line.style.margin = '0';
    line.textContent = 'Your Zoom login is not linked: open bwat inside Zoom and link your account.';
    bar.appendChild(line);
    bannerArea().append(bar);
  }

  // Every open card of every meeting, with no time window: the card service's open list, Mine
  // (owner=me) or everyone's, page by page, read again on every refresh. A card says which list
  // it came from, and its owner member, so the desk's Open to-dos never matches a person by name.
  // At most OPEN_PAGES pages a refresh: the newest 1,000, as far as the card service counts
  // `total` (only its first page answers it; kept from there). Past that, `more` says the view
  // shows the newest only, and the page says so.
  const OPEN_PAGES = 5;                 // 200 a page
  async function openTodos(mine, signal) {
    const items = [];
    let total = null, more = false;
    for (let page = 0, cursor = ''; ; page++) {
      if (page === OPEN_PAGES) { more = true; break; }
      const r = await api('GET', '/v1/cards?status=open&limit=200' + (mine ? '&owner=me' : '')
        + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), undefined, signal);
      if (!r.ok) throw httpError('open cards: ', r.status);
      if (page === 0 && typeof r.data.total === 'number') total = r.data.total;
      for (const c of r.data.cards || []) {
        items.push({ ...item(c, c.meeting.id), open: mine ? 'mine' : 'team', ownerId: c.owner_member_id || null, meeting: c.meeting });
      }
      if (!r.data.next) break;
      cursor = r.data.next;
    }
    return { items, mine, total, more };
  }

  async function week(key, signal) {
    const inWeek = meetings.filter((mt) => weekOf(mt.started_at) === key);
    // A meeting whose cards cannot be read shows what was last read of it, or none.
    const lists = await Promise.all(inWeek.map(async (mt) => {
      reread.delete(mt.id);
      const cards = await readCards(mt, signal).catch(() => { mark(mt.id); return cardsOf[mt.id] || []; });
      return cards.map((c) => item(c, mt.id));
    }));
    return { week: key, items: lists.flat() };
  }

  function item(c, meetingId) {
    cardMeeting[c.id] = meetingId;
    labels[c.id] = c.display_id;
    for (const l of [c.superseded_by, c.merged_into, ...(c.related || []), ...(c.merged_from || []), ...(c.answered_by || [])]) if (l) labels[l.id] = l.display_id;
    const owner = nameOf(c.owner_member_id) || c.owner_label || null;
    const ownerColor = owner ? colorOf(owner) : null;
    const superseded = c.merged_into?.id || c.superseded_by?.id || null;
    const answers = (c.answered_by || []).map((l) => l.id);
    // The speaker's own words first, the name and then the quote in quotation marks, so the
    // excerpt a card shows is what was said; then the card's notes.
    const evidence = (c.evidence || []).filter((e) => e.quote);
    const groups = new Map();
    for (const e of evidence) {
      const sourceMeeting = e.meeting_id || meetingId;
      const key = sourceMeeting + ':' + (e.epoch || 0);
      if (!groups.has(key)) groups.set(key, { meeting: sourceMeeting, epoch: e.epoch || 0, evidence: [] });
      groups.get(key).evidence.push(e);
    }
    const receipts = [...groups.values()].map((g) => {
      const meeting = meetings.find((m) => m.id === g.meeting);
      const label = meeting?.title || 'Meeting ' + g.meeting.slice(0, 8);
      const seqs = g.evidence.map((e) => e.seq);
      const range = 'e' + g.epoch + ' seq ' + Math.min(...seqs) + '-' + Math.max(...seqs);
      return { ...g, range, receipt: label + ' · ' + range };
    });
    const separateSources = receipts.length > 1 || receipts.some((g) => g.meeting !== meetingId);
    // Off the open list: Done, closed with no response, or a draft bwat closed itself
    // (neither shown as Done).
    const closed = !!c.done || c.status === 'no_response' || !!c.withdrawn;
    const quotes = receipts.map((g) => (separateSources ? '<p><b>Source:</b> ' + escText(g.receipt) + '</p>' : '')
      + g.evidence.map((e) => '<p><b>' + escText(e.speaker || 'Unknown speaker') + '</b> “' + escText(e.quote) + '”</p>').join('')).join('');
    return {
      id: c.id,
      label: c.display_id,
      bucket: BUCKET[c.kind] || 'do',
      title: c.title,
      owner,
      ownerColor,
      // Who said it first (the card service's source quote), by name as People picks; null for a speaker no member is.
      raisedBy: nameOf(c.source?.speaker_member_id),
      // Who last set or cleared the owner: 'agent' for the card writer, else a member's name.
      ownerBy: c.owner_by === 'agent' ? 'agent' : nameOf(c.owner_by),
      done: !!c.done,
      noResponse: c.status === 'no_response',
      withdrawn: !!c.withdrawn,
      closed,
      // On the board like any card until its meeting ends or a person acts on it.
      draft: c.status === 'draft',
      // From day 5 of a live card nobody acts on, the days it has left; else null.
      expiresIn: c.expires_in_days ?? null,
      // The card writer's read of a to-do for the session it is handed to: {confidence 0-100,
      // action act|investigate|leave}, or null.
      autoApply: c.auto_apply_confidence != null && c.suggested_action ? { confidence: c.auto_apply_confidence, action: c.suggested_action } : null,
      // The card's hand-offs, oldest first; each read_at is null until its session marks it read.
      routed: c.routed || [],
      // Jev's hint: {duplicate, related}, each the card it names ({card_id, display_id, title}) or null; or null.
      hint: c.hint || null,
      from: meetingId,
      superseded_by: superseded,
      merged_into: c.merged_into?.id || null,
      merges: (c.merged_from || []).map((l) => l.id),
      related: (c.related || []).map((l) => l.id),
      // Every card that answered this one: the desk reads `answers` as "Answered by".
      answers,
      // An answer the card service saved on a question (POST /v1/cards/{id}/clarify): its
      // own paragraph tag, which a person's escaped note can't make (cards/api/app.py CLARIFY_MARK).
      clarified: (c.detail_html || '').includes('<p data-clarify="'),
      detail: quotes + sanitize(c.detail_html || ''),
      // The first thing said, which the opened card quotes (desk.js).
      quote: evidence[0] ? { speaker: evidence[0].speaker || 'Unknown speaker', text: evidence[0].quote } : null,
      // The receipt: the transcript range the quotes came from, "e0 seq 120-140".
      src: receipts.map((g) => separateSources ? g.receipt : g.range).join('; '),
      version: c.revision,
      // Whether a row is drawn again: anything on it that can change.
      rev: [c.revision, owner, ownerColor, superseded, answers.join(','), c.expires_in_days].join('|'),
      // How far into the meeting it was said, for newest first within a meeting. The
      // transcript numbers lines from 0 again when the bot rejoins (a new epoch).
      seq: Math.max(0, ...(c.evidence || []).map((e) => (e.epoch || 0) * 1e6 + (e.seq || 0))),
    };
  }

  // A card's label for a link to it, wherever it is (a card may link one in another week).
  window.bwatLabel = (id) => labels[id] || id;

  // A card's passive marks, in words: [kind, text] chips (draft, no
  // response, closed by bwat) and its auto-apply line, or null, which the desk shows in the
  // reader. The days left are said with the card's own Keep.
  window.bwatMarks = (it) => ({
    chips: [
      it.draft && ['draft', 'Draft'],
      it.noResponse && ['done', 'No response'],
      it.withdrawn && ['done', 'Closed by bwat'],
    ].filter(Boolean),
    autoApply: it.autoApply ? 'Auto-apply ' + it.autoApply.confidence + '% · ' + it.autoApply.action : null,
  });

  const escText = (s) => String(s ?? '').replace(/[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  // The helpers the desk's own scripts use too (live.js, study.js, settings.js, zoom-invite.js): one copy each, here.
  window.bwatHelpers = Object.freeze({ escText, canonUuid, localDate, openInBrowser, loadZoomSdk: window.bwatLink.loadZoomSdk });

  // detail_html is written by a model and may quote meeting chat: untrusted.
  // Only these tags survive, with no attributes except an https link.
  const ALLOWED = new Set(['P', 'B', 'I', 'EM', 'STRONG', 'UL', 'OL', 'LI', 'BR', 'CODE', 'BLOCKQUOTE', 'A']);
  const DROPPED = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'NOSCRIPT']);
  function sanitize(html) {
    const doc = new DOMParser().parseFromString('<body>' + html, 'text/html');
    const clean = (node) => {
      let out = '';
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { out += escText(n.textContent); continue; }
        if (n.nodeType !== 1) continue;
        // SVG and MathML elements report a lower-case tagName.
        const tagName = n.tagName.toUpperCase();
        if (DROPPED.has(tagName)) continue;
        const inner = clean(n);
        if (!ALLOWED.has(tagName)) { out += inner; continue; }
        const tag = n.tagName.toLowerCase();
        if (tag === 'br') { out += '<br>'; continue; }
        if (tag === 'a') {
          const href = n.getAttribute('href') || '';
          out += /^https:\/\//i.test(href)
            ? '<a href="' + escText(href) + '" rel="noopener noreferrer" target="_blank">' + inner + '</a>' : inner;
          continue;
        }
        out += '<' + tag + '>' + inner + '</' + tag + '>';
      }
      return out;
    };
    return clean(doc.body);
  }

  // A stale revision or order is someone else's edit landing first: the desk reads `stale`.
  // Any other refusal (a closed card, not a question) passes through in plain words.
  const STALE = ['stale_revision', 'stale_order'];
  const changed = (r, ok) => (r.status === 409 && STALE.includes(r.data.error) ? json(200, { ...r.data, ok: false, stale: true })
    : r.ok ? json(200, { ok: true, ...(ok && ok(r.data)) }) : json(r.status, { ok: false, error: sentence(r) }));
  const card = (id) => '/v1/cards/' + encodeURIComponent(id);
  // The card's new version: an Undo goes back at the version the close wrote.
  const versioned = (c) => ({ version: c.revision });
  const PERSONAL = 'mine:';

  // The hand-off body: the card names itself and the backend fetches its
  // brief from the card service; a repeated request_key is the same hand-off.
  function handoff(b) {
    return {
      source_kind: 'card',
      source_id: b.id,
      occurrence_id: cardMeeting[b.id],
      target_session_id: b.session,
      request_key: b.message_id,
      ...(b.note ? { note: b.note } : {}),
    };
  }

  const routes = {
    'POST /meeting-bot': async (body, _url, signal) => {
      const r = await api('POST', '/v1/zoom/meeting-bot', body, signal);
      return json(r.status, r.data);
    },
    'GET /allocations': async () => {
      const r = await api('GET', '/v1/allocations');
      return json(r.status, r.data);
    },
    'POST /allocations': async (b) => {
      const r = await api('POST', '/v1/allocations', { zoom_url: b.zoom_url });
      return json(r.status, r.data);
    },
    'POST /recall': async (b) => {
      const r = await api('PATCH', '/v1/allocations/' + encodeURIComponent(b.id), { recall: true });
      return json(r.status, r.data);
    },
    'GET /whoami': async (_b, _url, signal) => {
      const w = await whoami(true, signal);
      // The viewer's name must match their row in the roster, shared names included.
      if (!members.length) await loadMembers(signal);
      // Inside Zoom, the meeting the board was opened from (its Zoom id, as `uuid` on a source).
      // A plugin that supplies its own send targets names the send action (sendTargets).
      const targets = sendTargets();
      return json(200, {
        locked: true, name: label(w.member), member: w.member, meeting: w.occurrence_id || null,
        send_label: targets ? textOf(targets.sendLabel, 40) || 'Send' : null,
      });
    },
    'GET board_feed.json': async (_b, _url, signal) => json(200, await feed(signal)),
    'GET /open-todos': async (_b, url, signal) => json(200, await openTodos(url.searchParams.get('mine') === '1', signal)),
    'GET /sessions': async () => {
      if (sendTargets()) return listTargets();
      const [r, d] = await Promise.all([api('GET', '/v1/sessions'), api('GET', '/v1/me/default-session')]);
      const now = Date.now();
      // "name @ machine", the folder standing in for an unnamed session, as the prototype's registry had it;
      // the picker shows the name and the machine apart.
      const nameOf = (s) => (s.client && (s.client.name || s.client.cwd)) || s.session_id.slice(0, 8);
      const machineOf = (s) => (s.client && s.client.machine) || '';
      const labelOf = (s) => nameOf(s) + (machineOf(s) ? ' @ ' + machineOf(s) : '');
      // The person's default session: first in the list when live, else shown as not running.
      const dflt = d.ok && d.data && d.data.session_id ? d.data : null;
      const hub = (r.ok ? r.data : []).map((s) => ({
        session_id: s.session_id,
        label: labelOf(s),
        name: nameOf(s),
        machine: machineOf(s),
        stale: false,
        router: true,
        age_s: Math.max(0, Math.round((now - Date.parse(s.last_seen_at)) / 1000)),
        default: !!dflt && dflt.session_id === s.session_id,
        keywords: (s.client && Array.isArray(s.client.keywords)) ? s.client.keywords : [],
      }));
      for (const h of hub) sessionLabels[h.session_id] = h.label;
      const defaultOff = dflt && !hub.some((h) => h.default) ? { session_id: dflt.session_id, label: labelOf(dflt), name: nameOf(dflt) } : null;
      return json(200, { sessions: [], hub, default_off: defaultOff,
        hub_reason: r.ok ? '' : 'sessions unavailable' });
    },
    // Make a session the person's default, or clear it.
    'POST /session-default': async (b) => {
      if (sendTargets()) return json(409, { ok: false, error: 'there is no default here' });
      const r = await api(b.on ? 'PUT' : 'DELETE', '/v1/sessions/' + encodeURIComponent(b.id) + '/default');
      return r.ok ? json(200, { ok: true }) : json(r.status, { ok: false, error: sentence(r) });
    },
    'POST /assign': async (b) => {
      const owner = b.owner ? idOf(b.owner) : null;
      if (b.owner && !owner) return json(400, { ok: false, error: 'not a member: ' + b.owner });
      return changed(await api('PUT', card(b.id) + '/owner', { owner_member_id: owner, revision: b.version }), versioned);
    },
    'POST /archive': async (b) => changed(await api('POST', card(b.id) + '/archive', { revision: b.version, outcome: b.outcome }), versioned),
    'POST /unarchive': async (b) => changed(await api('POST', card(b.id) + '/unarchive', { revision: b.version }), versioned),
    'POST /keep': async (b) => changed(await api('POST', card(b.id) + '/keep', { revision: b.version }), versioned),
    'POST /unmerge': async (b) => changed(await api('POST', card(b.id) + '/unmerge', { revision: b.version, via: b.via || b.id }), versioned),
    'POST /edit': async (b) => changed(
      await api('PATCH', card(b.id), { revision: b.version, ...(b.title ? { title: b.title } : {}), ...(b.note ? { note: b.note } : {}) }),
      (c) => ({ changed: true, card: { id: c.id, version: c.revision } })),
    'GET /editing': async () => {
      const r = await api('GET', '/v1/editing');
      return json(r.ok ? 200 : r.status, r.ok ? r.data : { editing: {} });
    },
    'POST /editing': async (b) => changed(await api('POST', '/v1/editing', { card_id: b.id, on: !!b.on })),
    'POST /clarify': async (b) => {
      // The to-do's owner by name, as /assign takes it.
      const owner = b.todo_owner ? idOf(b.todo_owner) : null;
      if (b.todo_owner && !owner) return json(400, { ok: false, error: 'not a member: ' + b.todo_owner });
      return changed(await api('POST', card(b.question_id) + '/clarify', {
        revision: b.version, answer: b.answer, request_id: b.request_id, ...(b.todo ? { todo: b.todo } : {}),
        ...(owner ? { todo_owner_member_id: owner } : {}),
      }),
      // `repeated`: this answer was saved already, and the desk says "Already saved".
      (c) => ({ question: { id: c.id, version: c.revision }, ...(c.repeated ? { repeated: true } : {}) }));
    },
    // Each meeting's shared order, and the viewer's own under 'mine:<their name>'.
    'GET /order': async (_b, _url, signal) => {
      const r = await api('GET', '/v1/orders', undefined, signal);
      if (!r.ok) return json(r.status, { ok: false, error: r.data.error || 'HTTP ' + r.status });
      const w = await whoami(false, signal);
      if (!members.length) await loadMembers(signal);
      const orders = { ...r.data.meetings };
      if (r.data.mine) orders[PERSONAL + label(w.member)] = r.data.mine;
      return json(200, { orders });
    },
    'POST /order': async (b) => changed(
      await api('PUT', '/v1/orders', { ...(b.mine ? { mine: true } : { meeting_id: b.meeting }), order: b.order, version: b.version }),
      (o) => ({ meeting: b.mine ? undefined : b.meeting, order: o.order, version: o.version })),
    // The card writer's last pass for one meeting: its phase, never its text.
    'GET /extraction-activity': async (_b, url) => {
      const r = await api('GET', '/v1/occurrences/' + encodeURIComponent(url.searchParams.get('source') || '') + '/activity');
      return json(200, r.ok ? r.data : { phase: 'unavailable' });
    },
    'POST /route': async (b) => {
      if (sendTargets()) return routeToTarget(b);
      const r = await api('POST', '/v1/handoffs', handoff(b));
      if (!r.ok) return json(r.status, { ok: false, error: sentence(r) });
      // The hand-off wrote "Queued" on the card, a new revision: the page takes it, or
      // the person's next Done or note on this card is refused as stale.
      return json(200, { ok: true, target: sessionLabels[b.session] || b.session, handoff_id: r.data.handoff_id, ...(await freshCard(b.id)) });
    },
    // A hint that the card may duplicate (kind 'duplicate') or relate to ('related')
    // another. Dismissing it is for good; acting on it runs the clean-up for this one
    // card, which can take tens of seconds, and the card service says what came of it.
    // Both send the card the board showed the hint naming, so a hint that changed since is refused.
    'POST /hint-dismiss': async (b) => changed(await api('POST', card(b.id) + '/hint/dismiss', { kind: b.kind, target_card_id: b.target_card_id }), versioned),
    'POST /hint-act': async (b) => {
      const r = await api('POST', card(b.id) + '/hint/act', { kind: b.kind, target_card_id: b.target_card_id });
      if (r.ok) return json(200, { ok: true, outcome: r.data.outcome, message: r.data.message, ...versioned(r.data.card) });
      // The connection gave up before the card service answered: the merge may have happened.
      if (r.status === 504) return json(504, { ok: false, error: 'No answer in time. The board shows what happened.' });
      return json(r.status, { ok: false, error: r.data.message || sentence(r) });
    },
  };

  // A short message in the page's header line: whisper() is the desk's (ui/study.js), defined
  // before a plugin can call this.
  function notify(text) {
    window.whisper(String(text));
  }

  window.fetch = async function (input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
    // Every request to this site waits for the plugins and goes marked when a plugin's sign-in is
    // selected; another site's, as it was. A stopped page sends nothing more.
    if (url.origin !== location.origin) return realFetch(input, init);
    await readyFor(init && init.signal);
    if (stopped) return json(503, { ok: false, error: 'stopped' });
    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/auth/')) return send(input, init);
    const method = ((init && init.method) || 'GET').toUpperCase();
    const file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    const wk = /^board_week_(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
    try {
      if (method === 'GET' && wk) return json(200, await week(wk[1], init && init.signal));
      const route = routes[method + ' ' + (file === 'board_feed.json' ? file : url.pathname)];
      if (route) {
        const body = init && init.body ? JSON.parse(init.body) : {};
        try {
          return await route(body, url, init && init.signal);
        } finally {
          // Every card the write names (the card, a question answered, the survivor of an undone
          // merge, the other card of a hint), once the write has settled, saved or not: an answer
          // lost on the way back may still have been saved.
          if (method === 'POST' && WRITES.has(url.pathname)) {
            for (const id of [body.id, body.question_id, body.via, body.target_card_id]) if (cardMeeting[id]) mark(cardMeeting[id]);
          }
        }
      }
    } catch (err) {
      if (init && init.signal && init.signal.aborted) throw err;
      // Not reached (no answer, or a gateway's 502-504): 503. Anything else keeps the backend's status.
      const unreached = err && (err.unreached || [502, 503, 504].includes(err.status));
      return json(unreached ? 503 : (err && err.status) || 500, { ok: false, error: unreached ? 'Couldn’t reach the board.' : String((err && err.message) || err) });
    }
    return send(input, init);
  };
})();
