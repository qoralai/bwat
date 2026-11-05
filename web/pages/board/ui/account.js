/* The account menu: your name in the header (t3/32.js #viewer-name) opens what
 * is yours and not the board's: who you are, your default Claude session and Sign out.
 * Board and Company settings stay under the gear. In Zoom the same menu is a full-width
 * sheet under the header, with bigger rows. The default session's list is the Send to
 * Claude picker's (study.js sessionListHTML), with pins and no notes: a row or its pin
 * makes that session the default, the filled pin clears it, and nothing is ever sent. */
'use strict';
(() => {
  let expanded = false;
  const menu = () => document.getElementById('account-menu');
  const nameButton = () => document.getElementById('viewer-name');
  const live = () => (LIVE.api.hub || []).filter((h) => h.router);
  function defaultName() {
    const h = live().find((x) => x.default) || LIVE.api.defaultOff;
    return h ? h.name || h.label || h.session_id.slice(0, 8) : 'None';
  }
  // The items the arrow keys move between: the menu's own, then the open list's rows.
  const items = (m) => [...m.querySelectorAll('[role=menuitem],#account-sessions [data-session]')];

  function paint() {
    const m = menu();
    if (!m) return;
    const row = m.querySelector('#account-default');
    if (row) {
      row.setAttribute('aria-expanded', String(expanded));
      row.querySelector('small').textContent = defaultName();
      row.querySelector('.account-chev').textContent = expanded ? '▴' : '▾';
    }
    const list = m.querySelector('#account-sessions');
    if (!list) return;
    list.hidden = !expanded;
    if (!expanded) { list.innerHTML = ''; return; }
    // A repaint puts focus back on the row or pin it was on.
    const a = document.activeElement, k = a && list.contains(a) && ['data-session', 'data-pin'].find((n) => a.hasAttribute(n)), v = k && a.getAttribute(k);
    list.innerHTML = sessionListHTML(LIVE.api.hub, LIVE.api.hubReason, LIVE.api.defaultOff, { notes: false });
    if (k) byAttr(list, k, v)?.focus();
    fitSendNames(list);
  }

  function close(back) {
    const m = menu();
    if (!m) return;
    m.remove();
    expanded = false;
    const b = nameButton();
    if (b) { b.setAttribute('aria-expanded', 'false'); if (back) b.focus(); }
  }

  function open(btn) {
    const zoom = !!LIVE.api.zoom, m = document.createElement('div');
    m.id = 'account-menu';
    m.className = 'account-menu' + (zoom ? ' sheet' : '');
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'Your account');
    const email = LIVE.api.email;
    const dflt = `<button type="button" role="menuitem" id="account-default" class="account-item" aria-expanded="false" aria-controls="account-sessions"><span class="account-label">Default Claude session</span> <small></small> <span class="account-chev" aria-hidden="true">▾</span></button><div id="account-sessions" class="account-sessions" hidden></div>`;
    // Zoom's panel signs itself in again from Zoom's app context on every load, and nothing
    // unlinks a Zoom user yet, so there is no Sign out to offer there. (Inside a plugin's product
    // there is no menu at all: t3/32.js leaves the name as text.)
    const sep = '<div class="account-sep" role="separator"></div>';
    const out = zoom ? '' : `${sep}<a role="menuitem" id="account-signout" class="account-item" href="/auth/logout">Sign out</a>`;
    m.innerHTML = `<div class="account-who"><span class="account-av" aria-hidden="true">${esc(String(viewer)[0].toUpperCase())}</span><span class="account-id"><b>${esc(viewer)}</b>${email ? `<small>${esc(email)}</small>` : ''}</span></div>${sep}${dflt}${out}`;
    document.body.append(m);
    if (zoom) {
      m.style.top = (scrollY + document.querySelector('.app-header').getBoundingClientRect().bottom + 6) + 'px';
    } else {
      const r = btn.getBoundingClientRect();
      m.style.top = (scrollY + r.bottom + 6) + 'px';
      m.style.left = Math.max(8, scrollX + r.right - m.offsetWidth) + 'px';
    }
    btn.setAttribute('aria-expanded', 'true');
    paint();
    items(m)[0]?.focus();
    LIVE.fetchSessions().then(paint);
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target : null, m = menu();
    if (t && t.closest('button#viewer-name')) { if (m) close(true); else if (viewer) open(nameButton()); return; }
    if (!m) return;
    if (!m.contains(t)) { close(false); return; }
    if (t.closest('#account-default')) {
      expanded = !expanded;
      paint();
      if (expanded) LIVE.fetchSessions().then(paint);
      return;
    }
    // A row, or its empty pin, makes that session the default; the filled pin (or a default
    // that is not running) clears it. The menu stays open, focus on what was clicked.
    const d = t.closest('#account-sessions [data-make-default],#account-sessions [data-clear-default],#account-sessions [data-session]');
    if (!d) return;
    const on = !d.hasAttribute('data-clear-default'), id = d.dataset.session || d.dataset.makeDefault || d.dataset.clearDefault;
    setDefaultSession(id, on).then((err) => {
      paint();
      if (err) document.getElementById('account-sessions')?.insertAdjacentHTML('afterbegin', defaultErrorHTML(err));
    });
  });

  document.addEventListener('keydown', (e) => {
    const m = menu();
    if (!m || !m.contains(e.target)) return;
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = items(m), i = all.indexOf(document.activeElement);
    if (!all.length) return;
    e.preventDefault();
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length].focus();
  });
})();
