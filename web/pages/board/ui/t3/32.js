// The Zoom surface's header.
// - "Full board ↗": one small link to the same view with surface=web,
//   in place of the nav the Zoom surface drops.
// - No search box in Zoom: t3/32.css hides it.
// - The signed-in viewer's name is shown. It is the button that opens the account menu (account.js), except inside a plugin's
//   product, where that menu would hold nothing (no default session, no Sign out): text there.
addHook('afterRender', 't3-32', function (options = {}) {
  const label = document.querySelector('.viewer-label');
  if (label) {
    let name = document.getElementById('viewer-name');
    const menu = !pluginTargets();
    if (name && (name.tagName === 'BUTTON') !== menu) { name.remove(); name = null; }
    if (!name) {
      name = document.createElement(menu ? 'button' : 'span');
      name.id = 'viewer-name';
      name.className = 'viewer-name';
      name.innerHTML = '<span class="viewer-name-text"></span>';
      if (menu) {
        name.type = 'button';
        name.setAttribute('aria-haspopup', 'menu');
        name.setAttribute('aria-expanded', 'false');
        name.insertAdjacentHTML('beforeend', '<span class="viewer-chev" aria-hidden="true">▾</span>');
      }
      label.appendChild(name);
    }
    const locked = !!LIVE.api.locked && !!viewer;
    label.classList.toggle('locked', locked);
    name.firstElementChild.textContent = locked ? viewer : '';
    // bwat: every viewer is signed in with Google, so say so plainly.
    name.title = locked ? 'Signed in as ' + viewer : '';
    const caption = document.getElementById('viewer-caption');
    if (caption) caption.textContent = locked ? 'Signed in as' : 'Your name';
    name.setAttribute('data-initial', locked ? viewer[0].toUpperCase() : '');
  }
});

// The link's target follows whatever the viewer is looking at, so it is
// worked out when clicked rather than kept in step with every render.
// Zoom's embedded browser drops target=_blank, so inside Zoom the
// board opens in the viewer's own browser through zoomSdk.openUrl, which
// wants an absolute URL. Outside Zoom it stays a plain link.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('#open-full');
  if (!a) return;
  const href = new URL(url({ surface: 'web' }), location.href).href;
  a.href = href;
  if (!LIVE.api.zoom) return;
  e.preventDefault();
  const sdk = window.zoomSdk, fallback = () => window.open(href, '_blank', 'noopener');
  if (!sdk || !sdk.config || !sdk.openUrl) { fallback(); return; }
  // 'openUrl' is asked for here, at click time, and waited on: in the start-up
  // config an unauthorised capability would fail the whole call and take
  // meeting detection (getMeetingUUID) down with it.
  sdk.config({ capabilities: ['getMeetingUUID', 'openUrl'] })
    .then(() => sdk.openUrl({ url: href }))
    .catch(fallback);
});
