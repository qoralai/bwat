// Card lifecycle and receipts.
//
// "Is this still true?" has to be answerable without opening a card, so a
// card's state is on its face: done (struck), superseded (struck, drained,
// and naming its replacement) and answered (dimmed, naming the answer). Done and
// superseded cards sink to the bottom of their column; the feed's own order
// survives inside each rank (Array.prototype.sort is stable).
//
// The feed carries superseded_by and `answers` (every card that answered this one).
//
// Wraps the functions it extends (cardHTML, matching, relationships, render)
// rather than editing their minified lines, so it composes with the other
// overrides the same way desk.js / people.js / zoom.js do.
const LIFE = (() => {
  let cache = {}, n = 0;

  function compute(c) {
    return { sup: c.superseded_by ? [c.superseded_by] : [], ans: [...new Set((c.answers || []).filter(Boolean))] };
  }
  // Asked several times per render about the same card; keyed on id + rev (or
  // version) so a card that changes is re-read. Bounded: the page runs for days.
  function rel(c) {
    if (!c) return { sup: [], ans: [] };
    const k = c.id + ':' + (c.rev || c.version || '') + ':' + (c.detail || '').length;
    if (!cache[k]) { if (n > 3000) { cache = {}; n = 0; } cache[k] = compute(c); n++; }
    return cache[k];
  }
  const retired = (c) => rel(c).sup.length > 0;
  // A merge and a supersede share superseded_by; the words differ.
  const replacedLead = (c) => (c.merged_into ? 'Merged into' : 'Superseded by');
  const answered = (c) => rel(c).ans.length > 0;
  // open first, then done, then superseded
  const rank = (c) => (c.closed ? 1 : retired(c) ? 2 : 0);
  return { rel, retired, replacedLead, answered, rank };
})();

// ── Column order: done and superseded sink ──
addHook('sort', 'lifecycle', function (list) {
  // Rank once per card; sort is stable, so each rank keeps the feed's order.
  return list.map((c) => [c, LIFE.rank(c)]).sort((a, b) => a[1] - b[1]).map(([c]) => c);
});

// ── Card face: state classes and chips ──
// One link builder for a related card, on the card face and in the reader.
// A card in a week not loaded is still a link: opening it makes weeks.js
// find and load that week. Every one opens through the one [data-goto] handler.
function relLink(id) {
  const away = !cardById(id);
  return `<a href="${esc(url({ card: id }))}" data-goto="${esc(id)}"`
    + `${away ? ' class="elsewhere" title="In another week — opening it loads that week"' : ''}>${esc(bwatLabel(id))}</a>`;
}
function lifePointer(lead, ids, cls) {
  return `<span class="rel${cls ? ' ' + cls : ''}">${esc(lead)} ${ids.map(relLink).join(', ')}</span>`;
}
addHook('card', 'lifecycle', function (p, c) {
  const r = LIFE.rel(c), isRetired = r.sup.length > 0, isAnswered = r.ans.length > 0;
  // An answered question says so once: dimmed, with the card that answered it named below.
  const classes = [c.closed && 'done', isRetired && 'retired', answeredQuestion(c) && 'answered'].filter(Boolean);
  p.classes = classes.concat(p.classes);
  const marks = bwatMarks(c);
  const chips = [
    ...marks.chips.map(([kind, text]) => `<span class="state-chip ${kind}">${esc(text)}</span>`),
    c.done ? '<span class="state-chip done">Done</span>' : '',
    isRetired ? `<span class="state-chip retired">${c.merged_into ? 'Merged' : 'Superseded'}</span>` : '',
  ].filter(Boolean);
  p.chips = chips.concat(p.chips);
  if (c.merged_into) { p.actions = null; p.more = ''; }
  // The pointers go OUTSIDE the card's open button: a link inside a button is
  // not a link. Clicking one opens the card it names.
  // Who gave a to-do its owner is said in the opened card (study.js), not on the face.
  p.pointers = keepLineHTML(c)
    + (isRetired ? lifePointer(LIFE.replacedLead(c), r.sup, '') : '')
    + (isAnswered ? lifePointer('Answered by', r.ans, 'answered') : '')
    + hintHTML(c);
});

// ── A hint that this card may duplicate, or relate to, another ──
// The duplicate check names the other card of the same meeting; a person acts on that
// pair. Dismissing it is for good. Its buttons stay held while a request for them is
// in flight, across the polls that redraw the card meanwhile.
const HINTS = {
  duplicate: ['May duplicate', 'Not a duplicate', 'Merge now'],
  related: ['May relate to', 'Dismiss', 'Link now'],
};
// Merge now waits on the model; the card service and the edge give it 300 s.
const HINT_MS = 300000;
const hintsInFlight = new Set();   // card id + ':' + kind, or + ':keep' for Keep
// One request from a card's face: its buttons stay held while it is in flight (`held`, across
// the polls that redraw them); then `said` says what happened (a line on the card, which the
// refresh after draws, or to a screen reader). `send` never throws (LIVE.post): a drop, or the
// wait running out, is a refusal like any other, said on the card with Try again.
async function heldRequest(held, buttons, send, said) {
  if (hintsInFlight.has(held)) return NOT_RUN;
  hintsInFlight.add(held);
  buttons.forEach((x) => { x.disabled = true; });
  const r = await send();
  hintsInFlight.delete(held);
  try { said(r); } finally { await refresh(true); }
}
function hintHTML(c) {
  if (!c.hint) return '';
  return Object.keys(HINTS).filter((kind) => c.hint[kind]).map((kind) => {
    const [line, no, yes] = HINTS[kind], other = c.hint[kind];
    const held = hintsInFlight.has(c.id + ':' + kind) ? ' disabled' : '';
    const btn = (verb, label) => `<button type="button" class="text-button" data-hint="${esc(c.id)}" data-kind="${kind}" data-target="${esc(other.card_id)}" data-verb="${verb}"${held}>${label}</button>`;
    return `<span class="rel hint">${line} ${esc(other.display_id)} — ${esc(other.title)} ${btn('dismiss', no)} ${btn('act', yes)}</span>`;
  }).join('');
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-hint]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  // The card the hint named as shown: the card service refuses the pair if the hint has changed since.
  const id = b.dataset.hint, kind = b.dataset.kind, target_card_id = b.dataset.target;
  if (b.disabled) return;
  await hintRequest(b.dataset.verb === 'act', { id, kind, target_card_id }, [...b.parentElement.querySelectorAll('button')]);
});
// Done: the hint going is the answer, said to a screen reader; a named card that has gone is said
// on the card a while. Refused: said on the card, with Try again, the same request (its buttons
// found afresh, the redraw having replaced them), except after 504, when the board already shows
// what happened.
function hintRequest(act, body, buttons = []) {
  const again = () => hintRequest(act, body, [...document.querySelectorAll('#card-list [data-hint]')]
    .filter((x) => x.dataset.hint === body.id && x.dataset.kind === body.kind));
  return heldRequest(body.id + ':' + body.kind, buttons,
    () => (act ? LIVE.post('/hint-act', body, HINT_MS) : LIVE.post('/hint-dismiss', body)),
    (r) => {
      if (!r.ok) return noteCard(body.id, 'err', errText(r), { retry: r.status === 504 ? null : again });
      if (act && r.body.outcome === 'gone') return noteCard(body.id, 'note', r.body.message);
      clearError(body.id);
      announce(act ? r.body.message : 'Dismissed.');
    });
}

// ── Keep: an expiring card stays on the board until someone closes it, as the person's action ──
// One line under the source line: "Closes in 3 days · Keep", grey, amber at 2 days, red "Closes
// today" at 1 (soft.css). Keep's answer takes its place: the card's own line (study.js noteCard)
// reads "✓ Kept until you close it" for 2.5 s of reading time, then folds away.
function keepLineHTML(c) {
  if (NOTES.get(c.id)?.kind === 'ok') return '';
  const d = c.expiresIn;
  if (!d) return '';
  return `<div class="keep-line${d === 2 ? ' r2' : d === 1 ? ' r1' : ''}"><span class="lab">${d === 1 ? 'Closes today' : `Closes in ${d} days`}</span>`
    + `<span class="sep" aria-hidden="true"> · </span><button type="button" class="text-button keep" id="keep-${esc(c.id)}" data-keep="${esc(c.id)}"`
    + ` aria-label="Keep ${esc(c.label || c.id)} on the board until someone closes it"${hintsInFlight.has(c.id + ':keep') ? ' disabled' : ''}>Keep</button></div>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-keep]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  await keepCard(b.dataset.keep, [b]);
});
// Refused, Keep says so on the card; its Try again keeps the card as the board has it then.
function keepCard(id, buttons = []) {
  const c = cardById(id);
  if (!c) return undefined;
  return heldRequest(c.id + ':keep', buttons, () => LIVE.post('/keep', { id: c.id, version: c.version }),
    (r) => {
      if (r.body && r.body.stale) return changedBy(c.id, r.body);
      if (r.ok) return noteCard(c.id, 'ok', 'Kept until you close it', { ms: DELIGHT.ms.kept });
      noteCard(c.id, 'err', errText(r), { retry: () => keepCard(c.id) });
    });
}


// ── Reader: the real relations, both directions ──
relationships = function (c) {
  if (!c) return '';
  const r = LIFE.rel(c);
  const replaces = cards.filter((x) => x.id !== c.id && !x.merged_into && LIFE.rel(x).sup.includes(c.id)).map((x) => x.id);
  const answers = cards.filter((x) => x.id !== c.id && LIFE.rel(x).ans.includes(c.id)).map((x) => x.id);
  // A merge is undone from either end: on the duplicate, and here on the card
  // it went into, long after the merge.
  const undo = (id) => ' ' + unmergeButton(id, c.id);
  const rows = [[LIFE.replacedLead(c), r.sup], ['Replaces', replaces],
    ['Merged from', c.merges || [], undo], ['Related', c.related || []], ['Answered by', r.ans], ['Answers', answers]]
    .filter(([, ids]) => ids.length);
  if (!rows.length) return '';
  const total = rows.reduce((t, [, ids]) => t + ids.length, 0);
  const lines = rows.map(([lead, ids, extra]) => `<p class="rel-line"><b>${esc(lead)}</b> ${ids.map((id) => relLink(id) + (extra ? extra(id) : '')).join(' · ')}</p>`).join('');
  // One relation is a plain line; two or more keep their list.
  return total === 1 ? lines : `<details class="detail-disclosure" open><summary>Related · ${total}</summary>${lines}</details>`;
};

// an open card that has been replaced says so at the top, with the
// way to the current one -- never a silent switch, so nobody loses their place.
// Followed to the end of the chain: A1 -> A2 -> A3 names A3.
function currentOf(id) {
  const seen = {};
  let c = cardById(id);
  while (c && !seen[c.id]) {
    seen[c.id] = 1;
    const next = LIFE.rel(c).sup[0];
    if (!next) break;
    const n = cardById(next);
    if (!n) return next;                  // in another week: still a link
    c = n;
  }
  return c ? c.id : id;
}
// An Undo merge asked for from a card that was not loaded: once that card's reader shows it, its
// line opens and it comes into view, focused, and washes once.
function revealUnmerge() {
  if (!pendingUnmerge) return;
  // Another card opened first: the ask is dropped, not played on some later visit.
  if (state().card !== pendingUnmerge.via) { pendingUnmerge = null; return; }
  const btn = readerUnmerge(pendingUnmerge.id);
  if (!btn) return;
  pendingUnmerge = null;
  const line = btn.closest('details');
  if (line) line.open = true;
  btn.scrollIntoView?.({ block: 'nearest', behavior: DELIGHT.reduced() ? 'auto' : 'smooth' });
  btn.focus({ preventScroll: true });
  DELIGHT.play(btn, 'once-wash');
  announce('Undo merge is ready.');
}
if (typeof renderReader === 'function') {
  const lifeReader = renderReader;
  renderReader = function () {
    lifeReader();
    revealUnmerge();
    const c = cardById(state().card);
    if (!c || !LIFE.retired(c)) return;
    const to = currentOf(c.id);
    if (to === c.id) return;
    // A merged card is the survivor's now: acting on it would change a card
    // nobody can see, so its actions go and only Undo is offered.
    if (c.merged_into) document.querySelectorAll('#reader .action-row').forEach((el) => el.remove());
    const now = to !== (c.merged_into || c.superseded_by) ? ` (now ${relLink(to)})` : '';
    document.querySelector('#reader .reader-top')?.insertAdjacentHTML('afterend', c.merged_into
      ? `<p class="reader-replaced" role="note">Merged into ${relLink(c.merged_into)}${now} as a duplicate. ${unmergeButton(c.id)}</p>`
      : `<p class="reader-replaced" role="note">Replaced by ${relLink(to)}. This is the earlier card, kept for its history.</p>`);
  };
}

// Undo a merge. The duplicate comes back as its own card; both keep
// a line saying the merge was undone.
// `via` is the card on screen whose version is sent: the duplicate itself, or
// the survivor listing it -- the duplicate is often in a week not loaded.
function unmergeButton(id, via = id) {
  return `<button type="button" class="text-button" data-unmerge="${esc(id)}" data-via="${esc(via)}">Undo merge</button>`;
}
const readerUnmerge = (id) => byAttr($('#reader'), 'data-unmerge', id);
function unmergeRequest(id, via, who) {
  return ['/unmerge', { id, via: via.id, version: via.version, by: who || 'board', who: who || null }];
}
// The card on screen not loaded (a poll dropped it): it is opened, at its Undo merge (renderReader).
let pendingUnmerge = null;   // {id, via}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-unmerge]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const id = b.dataset.unmerge, via = b.dataset.via;
  if (!cardById(via)) {
    pendingUnmerge = { id, via };
    if (state().card === via) refresh(true); else navigate({ card: via });
    return;
  }
  b.disabled = true;
  if (!await unmerge(id, via)) b.disabled = false;
});
// True once the merge is undone. Refused, it says so on the card it was pressed on, with Try again;
// a merged duplicate's card is not in the list (hiddenCard), so then beside the button in the
// reader ('reader:'+id), which asks again.
async function unmerge(id, viaId) {
  const via = cardById(viaId);
  if (!via) return false;
  const r = await LIVE.post(...unmergeRequest(id, via, viewer));
  // The duplicate drops back in where the sort puts it (no place was recorded for it).
  if (r.ok) { clearError(via.id); clearError('reader:' + id); await refresh(true); DELIGHT.mark(DELIGHT.cardEl(id), 'is-new'); announce('Merge undone: ' + id + ' is its own card again.'); return true; }
  if (r.body && r.body.stale) { changedBy(via.id, r.body); await refresh(true); return false; }
  const b = !DELIGHT.cardEl(via.id) && readerUnmerge(id);
  if (!b) { noteCard(via.id, 'err', errText(r), { retry: () => unmerge(id, via.id) }); redraw(); return false; }
  noteCard('reader:' + id, 'err', errText(r));
  lineEl('reader:' + id)?.remove();
  b.insertAdjacentHTML('afterend', noteHTML('reader:' + id));
  return false;
}

// Related-card links, on a card face or in the reader, open the card they name.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('[data-goto]');
  if (!a) return;
  e.preventDefault(); e.stopPropagation();
  openCard(a.dataset.goto);
});
