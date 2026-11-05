// Current-meeting presence and explicit invitations. Never accepts a typed meeting link.
// Settings redesign C: while bwat isn't in the meeting, the invite box is the panel's empty
// state: the lens, one plain line, at most one action, and the three steps bwat walks in by.
// An answer is drawn once; a later check that answers the same changes nothing on screen.
(function () {
  const zoom = window.LIVE ? LIVE.api.zoom : new URLSearchParams(location.search).get('surface') === 'zoom';
  if (!zoom) return;
  // S15: the first check starts once the board has read its meetings (LIVE.ready), so the panel opens
  // on the meeting it was opened from, its cards under it, and the box comes only with the answer.
  const box = document.createElement('section');
  box.className = 'invite-box';
  box.hidden = true;
  box.setAttribute('aria-label', 'Meeting bot');
  box.innerHTML = '<div class="invite-text" role="status" aria-live="polite"><p class="invite-title"></p><p class="invite-line" hidden></p></div>'
    + '<ol class="invite-steps" aria-label="bwat’s way in" hidden></ol>'
    + '<div class="invite-act"><button type="button" class="invite-button" hidden>Invite bwat</button>'
    + '<a class="invite-fix" href="/admin/#/settings?place=connections&amp;row=zoom-s2s" target="_blank" rel="noopener" hidden>Connect it in Connections <span aria-hidden="true">↗</span></a>'
    + '<button type="button" class="invite-see" hidden>See the cards</button></div>'
    + '<details class="invite-details" hidden><summary>Details</summary><p></p></details>';
  // The lens is the header's, its orange arc on its own so it can turn (moment 11).
  const lens = document.querySelector('.brand .brand-lens').cloneNode(true);
  lens.classList.add('invite-lens');
  box.prepend(lens);
  const main = document.getElementById('main');
  main.prepend(box);
  const $ = (s) => box.querySelector(s);
  const title = $('.invite-title'), line = $('.invite-line'), steps = $('.invite-steps'), button = $('.invite-button');
  const fix = $('.invite-fix'), see = $('.invite-see'), details = $('.invite-details');
  steps.tabIndex = -1;
  // Focus on something the box just hid moves on: to the steps while they show, else the board.
  const refocus = () => {
    const a = document.activeElement;
    if (a && box.contains(a) && (box.hidden || a.hidden)) (box.hidden || steps.hidden ? main : steps).focus();
  };
  // What each answer says: [title, line]. Copy is the mock-up's (settings redesign C).
  const views = {
    absent: ['bwat isn’t in this meeting', 'Invite it to turn what’s said into cards. Everyone here sees the same board.'],
    queued: ['bwat is on its way', 'It joins as soon as a bot is free.'],
    waiting_for_host: ['bwat is on its way', 'It joins once the host starts the meeting.'],
    joining: ['bwat is joining…', ''],
    waiting_room: ['bwat is in the waiting room', ''],
    checking: ['Checking bwat’s connection…', ''],
    failed: ['bwat lost this meeting', ''],
    never_joined: ['bwat couldn’t join this meeting', ''],
    ended: ['This meeting has ended', ''],
    outside_meeting: ['Open bwat from a meeting', 'Then you can invite it from here.'],
    zoom_slow: ['Zoom is taking a while', 'Close and reopen bwat if this stays.'],
    breakout: ['bwat stays in the main room', 'Return to the main meeting to see its cards.'],
  };
  // C4: the step each in-flight answer stands on, named by what bwat is waiting for.
  const STEPS = { queued: [0, 'Waiting for a free bot'], waiting_for_host: [0, 'Waiting for the host'], joining: [1, 'Joining'], waiting_room: [1, 'In the waiting room'] };
  // Moment 17: what came out of an ended meeting, counted by card type in the board's order.
  const KINDS = [['do', 'to-do', 'to-dos'], ['ask', 'question', 'questions'], ['risk', 'risk', 'risks'], ['decided', 'decision', 'decisions']];
  const PATH = '<span class="invite-path"><span>Participants</span> › <span>Waiting room</span> › <span>Admit</span></span>';
  // C5: every problem is one plain line and one action; what a fixer needs goes behind Details.
  // [title, line, action, details]; the action 'retry' invites again, 'fix' is the admin's door.
  const INVITE = 'bwat couldn’t be invited', CHECK = 'bwat can’t check this meeting';
  const problems = {
    meeting_lookup_failed: [INVITE, 'Zoom didn’t send this meeting’s join details. Try again in a moment.', 'retry', 'Check the installation’s Zoom account access, then try again.'],
    wrong_zoom_identity: [CHECK, 'Your Zoom account has changed. Reopen bwat to link it.'],
    invalid_context: [CHECK, 'Zoom couldn’t confirm this meeting. Reopen bwat and try again.'],
    occurrence_conflict: [INVITE, 'Another session of this meeting still has bwat. Try again shortly.', 'retry'],
    rate_limited: [INVITE, 'Too many invitations. Try again in a minute.', 'retry'],
    bot_leaving: [INVITE, 'bwat is still leaving this meeting. Try again shortly.', 'retry'],
    context_api_missing: [CHECK, 'Zoom doesn’t let this board read the meeting.', null, 'Zoom’s getAppContext is unavailable. Enable it in the board app’s Zoom App SDK capabilities, then reopen the app.'],
  };
  // C6: a problem an admin can fix points an owner or admin to it; a member is told who can.
  const isAdmin = () => !!(window.LIVE && LIVE.api.admin);
  // The meeting's cards as the desk holds them (none in a page without the desk).
  const meetingCards = (source) => typeof cards === 'undefined' ? [] : cards.filter((c) => c.from === source);
  const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const leaveErrors = { leave_forbidden: 'Only a bwat admin or the current Zoom host can ask bwat to leave.' };
  let busy = false, timer, stopped = false, requestController;
  // The Live pill takes this panel's answer over the board's read only while it is fresh: for
  // ANSWER_MS after it came, and not once a check has failed (meeting-bot.js paint).
  const ANSWER_MS = 15000;
  let answeredAt = 0;
  // Nothing checks before the board is ready (LIVE.ready), however the panel is shown or focused.
  let started = false;
  // 10/23: one dropped check flashed "couldn’t reach bwat" between good answers; only a run of them is.
  let failures = 0;
  const OFFLINE_AFTER = 3;
  // Zoom's SDK arrives after the page, so no SDK counts as still loading until its script has
  // failed or the panel has been on screen SDK_GRACE ms. An SDK still missing then
  // says Zoom is slow, never that the panel is outside a meeting; only the server says that.
  const SDK_GRACE = 5000;
  // slow: the box says Zoom is slow, so an SDK that lands goes back to Loading… while it checks.
  let sdkLate = false, slow = false, grace;
  const LOADING = { state: 'looking', title: 'Loading…', spin: true };
  const endWait = () => { sdkLate = true; clearTimeout(grace); };
  const late = () => { endWait(); if (started) void update(); };
  // Only time on screen counts: hidden, the wait stops; shown again, it starts over.
  const waitForSdk = () => { if (sdkLate) return; clearTimeout(grace); if (!document.hidden) grace = setTimeout(late, SDK_GRACE); };
  // asked: this page asked bwat to leave and the server took it, so the next status that says
  // bwat is absent, failed or the meeting ended is bwat confirming it has gone (moment 9).
  // wantLeave: asked while a status check was out; it goes once that check has answered.
  let canLeave = false, asked = false, wantLeave = false, joinedAt = null;
  // Settings redesign B3/B4: a host or an admin (the server's can_leave) asks bwat to leave from
  // the board's Settings (settings.js, through meeting-bot.js); the Live pill is status only.
  const pill = document.getElementById('live-pill');
  const { pillState, pillLive } = MEETING_BOT;
  // Moment 9: the line saying what was kept goes above the box, which now says bwat isn't in.
  const left = (source) => MEETING_BOT.left(source ? meetingCards(source).length : null, box);
  function askLeave() {
    if (busy) { wantLeave = true; return; }
    // Leaving: the desk leaves the pill be until bwat confirms (or the server refuses).
    pillState('leaving', 'Leaving…');
    void update(false, true);
  }
  MEETING_BOT.use({
    load: async () => {},
    current: () => (lastState === 'present' && canLeave && !asked && !wantLeave && pill.dataset.state !== 'leaving' ? { joinedAt } : null),
    // What the last check found, while it is fresh; null when there is none, and the board's read stands.
    present: () => (lastState === null || Date.now() - answeredAt > ANSWER_MS ? null : lastState === 'present'),
    leave: askLeave,
  });
  // painted: the view on screen, so a check that answers the same redraws nothing (moment 11).
  // shown: its state, to tell a step forward (moment 13). problem: an invitation the server
  // refused, kept on screen while the answer stays the same.
  // sawIn: bwat has been in since it was last absent; lostAt: when this page saw it lost (moment 16).
  // seen: the meeting whose cards someone opened from the box (See the cards).
  let painted = '', shown = null, problem = null, lastState = null, later, sawIn = false, lostAt = null, lostSeen = null, occurrence = null, seen = null, here = null;
  // The moments decorate an answer the server has already given; none delays a click.
  // enter: the server accepted this page's invitation (moment 12).
  function paint(v, enter = false) {
    const key = JSON.stringify(v);
    if (key === painted) return;
    painted = key;
    const was = shown, to = STEPS[v.state];
    shown = v.state;
    clearTimeout(later);
    box.classList.remove('fold', 'fade');
    // Moment 12: the button the server accepted narrows into the first step's dot (0.3 s),
    // then the steps appear beside it; under Reduce Motion they cross-fade in at once.
    if (enter && to && !button.hidden && !DELIGHT.reduced()) {
      button.classList.add('morph');
      later = setTimeout(() => draw(v, was, enter), 300);
    } else draw(v, was, enter);
  }
  function draw(v, was, enter) {
    const from = STEPS[was], to = STEPS[v.state];
    box.hidden = false;
    title.textContent = v.title;
    line.innerHTML = v.line || '';
    line.hidden = !v.line;
    // Moments 15 and 17: the Zoom path, or an ended meeting's chips, come in once, on arriving.
    if (v.state !== was) line.querySelector('.invite-path, .invite-chips')?.classList.add('play');
    steps.hidden = !to;
    steps.classList.toggle('enter', enter);
    steps.innerHTML = to ? ['Invited', 'Joining', 'In the meeting'].map((name, i) => `<li${i < to[0] ? ' class="done"' : i === to[0] ? ' aria-current="step"' : ''}>`
      + `<span class="invite-dot${i <= to[0] ? ' on' : ''}" aria-hidden="true"></span><span>${i === to[0] ? to[1] : name}</span></li>`).join('') : '';
    // Moment 13: a real step forward fills the line to the next dot, which breathes once.
    if (from && to && to[0] > from[0]) steps.querySelector('[aria-current=step]').classList.add('walk');
    button.classList.remove('morph');
    button.hidden = !v.action;
    button.textContent = v.action || 'Invite bwat';
    fix.hidden = !v.fix;
    const hide = alone();
    see.hidden = !(v.see || (hide && meetingCards(here).length));
    details.hidden = !v.details;
    details.querySelector('p').textContent = v.details || '';
    refocus();
  }
  // C7 and moment 14: once bwat is in, the box folds away (a cross-fade under Reduce Motion) and
  // the Live pill takes over, its dot breathing once, then the listening row washes in to-do blue.
  // Only when the server's answer turned while this page watched (before: its last answer) and
  // bwat was not already in (wasIn): a reload with bwat in shows the board at once, and so does
  // a check that failed or asked after its connection meanwhile.
  function arrive(state, before, wasIn) {
    const turned = state === 'present' && !box.hidden && !!before && !wasIn;
    problem = null; painted = ''; shown = state;
    clearTimeout(later);
    alone();
    // In again after it was lost or had left: the pill says Live again.
    if (state === 'present' && ['lost', 'left', 'leaving'].includes(pill.dataset.state)) {
      asked = false;
      pillLive();
      MEETING_BOT.unleft();
    }
    if (!turned) { box.hidden = true; refocus(); return; }
    box.classList.add(DELIGHT.reduced() ? 'fade' : 'fold');
    later = setTimeout(() => {
      box.hidden = true;
      box.classList.remove('fold', 'fade');
      refocus();
      DELIGHT.play(pill.querySelector('.live-pill-dot'), 'breathe');
      DELIGHT.play(document.querySelector('.column-empty.listening'), 'invite-wash');
    }, 400);
  }
  // Z1: while bwat isn't in, the box is all the panel shows, the meeting's cards waiting under
  // it until someone opens them (See the cards); the box stays above them. An ended meeting's
  // box sits above its cards as before (moment 17).
  function alone() {
    const hide = !box.hidden && !['present', 'leaving', 'ended'].includes(lastState) && !(seen && seen === occurrence);
    document.body.classList.toggle('zoom-invite-alone', hide);
    return hide;
  }
  function stateView(r, source) {
    // Failed with nothing to show it was ever in (no time it was lost, no cards): a queued
    // bwat that no bot took up. The server says failed for both.
    const never = r.state === 'failed' && !lostAt && !meetingCards(source).length;
    const [t, l] = views[never ? 'never_joined' : r.state] || views.checking;
    const v = { state: r.state, title: t, line: l, action: r.can_invite === true && (r.state === 'failed' ? 'Invite again' : 'Invite bwat') };
    // Z1: whether the meeting has cards is part of the view, so cards the board loads after the
    // box was drawn bring See the cards on the next check.
    v.cards = meetingCards(source).length > 0;
    // Moment 15: the host (or an admin, the server's can_leave) is told the way in Zoom's own words.
    if (r.state === 'waiting_room') v.line = (r.can_leave ? 'Admit bwat: ' : 'Ask the host to admit it: ') + PATH;
    if (r.state === 'ended') {
      const list = meetingCards(source);
      const chips = KINDS.map(([kind, one, many]) => {
        const n = list.filter((c) => c.bucket === kind).length;
        return n ? `<span class="invite-chip" data-type="${kind}">${n} ${n === 1 ? one : many}</span>` : '';
      }).join('');
      v.line = chips && '<span class="invite-chips">' + chips + '</span>';
      v.see = !!chips;
    }
    if (r.state === 'failed') {
      const n = meetingCards(source).length;
      v.line = (lostAt ? 'It disconnected at ' + lostAt + '. ' : '') + (n ? 'The ' + n + (n === 1 ? ' card so far is kept.' : ' cards so far are kept.') : '');
      // Z4: behind Details, the exact time it was seen lost (the status names no reason).
      if (lostSeen) v.details = 'Seen at ' + lostSeen + '.';
    }
    return v;
  }
  function problemView(reason, stage, code) {
    if (reason === 'zoom_lookup_not_configured') {
      return isAdmin()
        ? { state: reason, title: 'bwat can’t be invited yet', line: 'Zoom’s server-to-server app isn’t connected, so bwat can’t look up this meeting.', fix: true }
        : { state: reason, title: 'bwat can’t be invited yet', line: 'Ask an admin to connect Zoom’s server-to-server app to bwat.' };
    }
    const known = problems[reason];
    if (known) return { state: reason, title: known[0], line: known[1], action: known[2] && 'Try again', details: known[3] };
    if (stage === 'setup') {
      return { state: stage, title: CHECK, line: 'Zoom didn’t start this board’s connection. Reopen bwat.',
        details: 'Zoom setup failed' + code + '. Check that getAppContext and getMeetingUUID are enabled for this board app, then reopen it.' };
    }
    if (stage === 'context') {
      return { state: stage, title: CHECK, line: 'Zoom didn’t say which meeting this is. Open bwat from inside the meeting.',
        details: 'Zoom could not supply the current meeting context' + code + '.' };
    }
    return { state: stage, title: CHECK, line: 'The board couldn’t reach bwat. It tries again by itself.', details: reason === 'timeout' ? 'The request timed out.' : '' };
  }
  const bounded = (promise, cancel) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { if (cancel) cancel(); reject(Error('timeout')); }, 10000);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timeout));
  });
  async function update(invite = false, leave = false) {
    // A hidden panel is not checked; it checks once on coming back. A click still asks.
    if (busy || stopped || (document.hidden && !invite && !leave)) return;
    clearTimeout(timer);
    const sdk = window.zoomSdk;
    if (!sdk) {
      failures = 0;
      if (!sdkLate) return;
      slow = true;
      paint(stateView({ state: 'zoom_slow' }));
      timer = setTimeout(update, 3000);
      return;
    }
    // Zoom's SDK is here: the wait for it is over, so its end asks nothing more.
    endWait();
    if (slow) { slow = false; paint(LOADING); }
    busy = true; button.disabled = true;
    let stage = 'setup';
    try {
      // getUserContext only lets the viewer self-identify: a board app without it runs as before.
      const capabilities = ['getAppContext', 'getMeetingUUID'];
      const configured = await bounded(sdk.config({ version: '0.16', capabilities: [...capabilities, 'getUserContext'] }))
        .catch(() => bounded(sdk.config({ version: '0.16', capabilities })).then(() => null));
      const selfIdentify = !!configured && !(configured.unsupportedApis || []).includes('getUserContext');
      stage = 'context';
      if (typeof sdk.getAppContext !== 'function') throw Error('context_api_missing');
      const { context } = await bounded(sdk.getAppContext());
      if (!context) throw Error('invalid_context');
      // This viewer's own id in the meeting, so their lines carry their name; the status check goes on without it.
      const user = selfIdentify && typeof sdk.getUserContext === 'function' ? await bounded(sdk.getUserContext()).catch(() => null) : null;
      const participantId = user && /^[1-9][0-9]{0,9}$/.test(user.participantId) ? user.participantId : null;
      if (stopped) return;
      stage = 'request';
      requestController = new AbortController();
      const cancel = () => requestController.abort();
      const response = await bounded(fetch('/meeting-bot', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        signal: requestController.signal,
        body: JSON.stringify({ context, invite, ...(leave ? { leave: true } : {}), ...(participantId ? { participant_id: participantId } : {}) }),
      }), cancel);
      const result = await bounded(response.json(), cancel);
      if (stopped) return;
      if (!response.ok) throw Error(result.error || 'unavailable');
      failures = 0;
      canLeave = result.can_leave === true;
      joinedAt = result.joined_at || null;
      const meeting = window.LIVE && LIVE.sourceForMeeting && result.occurrence_id;
      const source = meeting ? LIVE.sourceForMeeting(result.occurrence_id) : null;
      const gone = !leave && asked && ['absent', 'ended', 'failed'].includes(result.state);
      if (leave) {
        asked = result.state === 'leaving';
        // No claim to recall: the server answered plain status, so nothing is pending.
        if (!asked) pillLive();
      } else if (result.state === 'leaving') {
        // bwat is leaving, whoever asked: the pill says so, and the desk leaves it be.
        pillState('leaving', 'Leaving…');
      } else if (gone) {
        asked = false;
        left(source);
      } else if (!asked && result.state !== 'present' && pill.dataset.state === 'leaving') {
        // Someone else's leave has finished: no Left line here, the desk paints the pill again.
        pillLive();
      }
      const wasIn = sawIn;
      if (result.state === 'present') { sawIn = true; seen = null; }
      else if (result.state === 'absent' || result.state === 'ended') sawIn = false;
      if (result.state !== 'failed') lostAt = lostSeen = null;
      // Moment 16: lost after bwat was in, and not because it was asked to leave: the Live dot
      // fades to grey (delight.css) and the box says when, and what is kept.
      else if (sawIn && !gone && !asked) {
        sawIn = false;
        lostAt = clock();
        lostSeen = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        pillState('lost', 'Lost');
      }
      // The panel always describes Zoom's current meeting, even before it has cards.
      document.body.classList.toggle('zoom-meeting-unavailable', !source);
      if (source && typeof navigate === 'function' && new URLSearchParams(location.search).get('source') !== source) {
        navigate({ source, meeting: null, card: null });
      }
      const before = lastState;
      lastState = result.state;
      answeredAt = Date.now();
      MEETING_BOT.paint();
      here = source;
      occurrence = result.occurrence_id || null;
      // C7: once bwat is in, the box gets out of the way and the Live pill takes over.
      if (result.state === 'present' || result.state === 'leaving') arrive(result.state, before, wasIn);
      else if (result.state === 'ended' && occurrence && occurrence === seen) { box.hidden = true; alone(); }
      else if (problem && result.state === problem.during) paint(problem.view);
      else { problem = null; paint(stateView(result, source), invite); }
    } catch (err) {
      if (stopped) return;
      // A failed check says nothing of whether bwat is in: the pill follows the board's read. (A
      // refused leave is an answer, not a failed check.)
      if (!leave) { answeredAt = 0; MEETING_BOT.paint(); }
      // SDK errors can contain context or URLs. Show only the stage and a numeric code.
      const rawCode = err && (err.code ?? err.errorCode);
      const code = /^\d{1,8}$/.test(String(rawCode)) ? ' (code ' + rawCode + ')' : '';
      const reason = err && err.message;
      const ended = reason === 'meeting_ended' || reason === 'meeting_already_ended';
      const v = leave || ended ? null : problemView(reason, stage, code);
      // A dropped check (a busy backend's 503, a timeout) changes nothing until a run of them;
      // a clicked Invite bwat answers at once.
      if (v && !invite && v.state === 'request' && ++failures < OFFLINE_AFTER) return;
      // Anything else that is shown starts the count again.
      failures = 0;
      canLeave = false;
      // A refused leave: the pill says Live again, and a note says why.
      if (leave) {
        pillLive();
        MEETING_BOT.refused(leaveErrors[reason] || 'Could not ask bwat to leave.', reason === 'leave_forbidden' ? null : askLeave);
      } else if (ended) paint(stateView({ state: 'ended' }));
      else {
        if (invite && (problems[reason] || reason === 'zoom_lookup_not_configured')) problem = { during: lastState, view: v };
        paint(v);
      }
    } finally {
      if (requestController) requestController.abort();
      requestController = null;
      busy = false; button.disabled = false;
      if (wantLeave && !stopped) { wantLeave = false; askLeave(); } else if (!stopped) timer = setTimeout(update, 5000);
    }
  }
  button.addEventListener('click', () => { problem = null; void update(true); });
  // Zoom's own browser does not follow a new-tab link, so the admin's door opens through Zoom (bwat-api.js).
  fix.addEventListener('click', (e) => { e.preventDefault(); window.bwatHelpers.openInBrowser(fix.href); });
  see.addEventListener('click', () => {
    seen = occurrence; painted = '';
    if (lastState === 'ended') box.hidden = true;
    see.hidden = true;
    alone(); refocus();
  });
  document.addEventListener('visibilitychange', () => {
    waitForSdk();
    if (started && !document.hidden) void update();
  });
  // A refused invitation stays only until the person comes back to the page: an admin who
  // fixed it in the admin panel's tab finds Invite bwat again on the next check.
  window.addEventListener('focus', () => { problem = null; });
  window.addEventListener('pagehide', () => { stopped = true; failures = 0; clearTimeout(timer); clearTimeout(grace); if (requestController) requestController.abort(); });
  // Zoom's SDK is waited for from the moment the panel opens, not once the cards have loaded.
  waitForSdk();
  if (window.LIVE && LIVE.loadZoomSdk) void LIVE.loadZoomSdk().then(late);
  // The first check waits for the board: its meetings read, or its load error shown (study.js load).
  void Promise.resolve(window.LIVE && LIVE.ready).then(() => { started = true; return update(); });
})();
