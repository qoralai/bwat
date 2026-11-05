// Take an unowned to-do from the card face (the mock-up): one button that makes
// the viewer its owner without opening the card; the opened card's Change owner assigns
// anyone. It goes through /assign (versioned, stale-aware) -- the same applyOwnerChange the
// reader uses -- and the new owner is held (holdOwner) so the card doesn't flicker back.

// The opened card offers it too, under its own id and look (study.js actionsHTML).
function takeControlHTML(c, id = 'take-' + c.id, cls = 'card-action') {
  const why = viewer ? '' : 'Sign in first';
  return actionButton(id, 'Take it', { show: true, why }, cls, false,
    ` data-take="${esc(c.id)}" aria-label="Take it: ${esc(c.label || c.id)}"`);
}

// A refusal says itself on the card; its Try again finds the card's Take it afresh, since the
// line's redraw has replaced the one pressed.
async function takeFromCard(b) {
  const c = b && cards.find((x) => x.id === b.dataset.take);
  if (!c || !viewer || b.getAttribute('aria-disabled') === 'true') return;
  b.disabled = true;
  const retry = () => takeFromCard(byAttr(document, 'data-take', c.id));
  const err = await applyOwnerChange(c, viewer);
  if (err) { b.disabled = false; noteCard(c.id, 'err', err, { retry }); redraw(); }
}

// Delegated once, on the document, not wired per row: the in-place refresh
// renders into a detached twin and moves fresh rows into the live list, so a
// per-row pass either missed them (it queried the page, not the twin) or left
// a per-row "wired" mark that made otherwise identical rows compare different.
// Capture phase, and stopped, so the click never reaches anything that opens the card.
document.addEventListener('click', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('button[data-take]') : null;
  if (!b) return;
  e.stopPropagation();
  takeFromCard(b);
}, true);
