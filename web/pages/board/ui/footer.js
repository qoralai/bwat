// The page footer: a raw transcript tail that is filled only while it is open.
// The build this server runs moved to Settings (settings.js reads footerVersion).
// Text only, no innerHTML.
let footerVersion = '';
function footerTailText(tail) {
  return (tail || []).map((x) => '[' + (x && x.seq != null ? x.seq : '') + '] '
    + (x && x.speaker || '') + ': ' + (x && x.text || '')).join('\n');
}
function paintFooter() {
  let foot = document.getElementById('desk-footer');
  if (!foot) {
    foot = document.createElement('footer');
    foot.id = 'desk-footer';
    foot.className = 'desk-footer';
    foot.innerHTML = '<details class="foot-raw" id="foot-raw"><summary>Raw transcript tail</summary><pre id="foot-tail"></pre></details>';
    document.getElementById('main').append(foot);
    // Fill the tail the moment it opens, not on the next refresh.
    document.getElementById('foot-raw').addEventListener('toggle', paintFooter);
  }
  const raw = document.getElementById('foot-raw');
  if (raw.open) {
    // Written only when it changed: a poll then keeps a selection and the scroll.
    const tailEl = document.getElementById('foot-tail');
    const text = footerTailText(LIVE.api.tail) || 'No transcript lines yet.';
    if (tailEl.textContent !== text) tailEl.textContent = text;
  }
}
addHook('afterRender', 'footer', paintFooter);
// A poll that changed no card skips the render, but the tail moves with every line said.
addHook('afterPoll', 'footer', paintFooter);
// Which build is serving this page, so a deploy can be checked by looking.
fetch('/version', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => { if (j && j.version) footerVersion = String(j.version); })
  .catch(() => {});
