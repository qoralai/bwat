// Reorder to-dos by drag-and-drop.
//
// Your own view -- "My to-dos", or your own person chip -- has YOUR order:
// every open to-do you own, across all meetings. It is kept on the
// server as the order "mine:<you>" (POST /order, saved by you only), and a drag
// in a filtered view moves only what it shows, leaving the hidden cards where
// they were.
//
// (standup 9/25, A139): a meeting's To-dos list also has ONE shared
// order -- everyone sees it, anyone can drag it. It is kept on the server per
// meeting (POST /order, refused when someone else moved it first) and arrives
// on each poll as the meeting's `order` (live.js).

// Your own to-dos, in your own view.
function ownTodoView(s) {
  return !!viewer && (s.scope === 'mine' || s.person === viewer);
}
// Any open to-do of yours, meeting card or to-do: what your order holds.
function ownMovable(c) {
  return !!viewer && sharedMovable(c) && cardOwner(c) === viewer;
}
// Your own order's key: the server files it under the name that saved it.
const MINE = 'mine:', personalKey = () => MINE + viewer, isPersonal = (m) => m.startsWith(MINE);

// The meeting view whose To-dos list is dragged into the shared order: one
// meeting, everyone's cards, no search or person filter -- a filtered column
// sent as the whole order would drop the hidden cards from it.
function sharedView(s) {
  return !ownTodoView(s) && s.scope === 'team' && !s.q && !s.person
    && !!s.source && s.source !== 'all' && !openView(s) && !s.source.includes(',');
}
function sharedMovable(c) {
  return !!c && c.bucket === 'do' && !c.closed && !(typeof LIFE !== 'undefined' && LIFE.retired(c));
}

// A meeting's movable to-dos by place in its order; cards the order has not
// seen yet (new ones) before them, in the order they already had -- newest
// first (desk.js), so a new card shows at the top and a drag still wins
// (9/29). Done and
// retired cards (sunk by lifecycle) and other buckets keep their positions.
function sharedSort(list, orderOf, movable, groupOf = (c) => c.from) {
  const out = list.slice(), groups = {};
  list.forEach((c, i) => {
    if (!movable(c)) return;
    const g = groupOf(c), order = orderOf(g);
    if (!order) return;
    (groups[g] || (groups[g] = { order, at: [] })).at.push(i);
  });
  for (const g of Object.values(groups)) {
    const place = new Map(g.order.map((id, i) => [id, i]));
    const ranked = g.at.map((i, k) => [list[i], place.has(list[i].id) ? place.get(list[i].id) : k - g.at.length])
      .sort((a, b) => a[1] - b[1]).map((p) => p[0]);
    g.at.forEach((i, k) => { out[i] = ranked[k]; });
  }
  return out;
}

// `from` moved before (or after) `to`; null when either is not in the list.
function moveIn(order, from, to, after) {
  if (from === to || !order.includes(from)) return null;
  const next = order.filter((x) => x !== from);
  const at = next.indexOf(to);
  if (at < 0) return null;
  next.splice(after ? at + 1 : at, 0, from);
  return next;
}

// A drag in a filtered view: `shown` is the new order of what it shows; the
// full order keeps every hidden card in its place, and shown cards it has not
// seen yet go after.
function mergeShown(full, shown) {
  const inShown = new Set(shown), queue = shown.slice();
  const out = full.map((id) => (inShown.has(id) ? queue.shift() : id)).filter((id) => id !== undefined);
  return out.concat(queue);
}

// Your own order names no meeting: the server keys it by who saved it.
function orderRequest(m, order, version, who) {
  return { ...(isPersonal(m) ? { mine: true } : { meeting: m }), order, version, who: who || null };
}

// The newest order this page knows for a meeting: the poll's, or the one a
// save of ours answered with when the poll predates it. A save in flight
// shows its order at once (pendingOrder).
const seenOrder = {}, pendingOrder = {};
function knownOrder(m) {
  const polled = (LIVE.api.orders || {})[m] || null;
  const mine = seenOrder[m] || null;
  return !polled ? mine : !mine || polled.version >= mine.version ? polled : mine;
}
function orderOf(m) { return pendingOrder[m] || (knownOrder(m) || {}).order || null; }

// Your own view follows your order; any other view follows each meeting's shared order.
addHook('sort', 'dnd', function (out, s) {
  if (!ownTodoView(s)) return sharedSort(out, orderOf, sharedMovable);
  return sharedSort(out, () => orderOf(personalKey()), ownMovable, () => 'mine');
});

let dndBusy = false;

// `drawn` is the version the list on screen was drawn from (its column's
// data-order-version): a poll may already know a newer one whose repaint was
// deferred, and saving at that newer version would overwrite an order the
// viewer never saw. The server refuses the drawn one when stale.
async function applyShared(m, order, drawn) {
  if (dndBusy) return NOT_RUN;
  const base = drawn !== undefined ? drawn : (knownOrder(m) || { version: 0 }).version;
  dndBusy = true;
  busy.add('order');            // no poll repaints the old order mid-save
  for (const id of order) HELD.place.delete(id);   // a card placed by hand stays where it was put
  pendingOrder[m] = order;
  cardsChanged();
  render({ keepReader: true });
  announce('Reordering the to-dos…');
  const r = await LIVE.post('/order', orderRequest(m, order, base, viewer));
  delete pendingOrder[m];
  // Someone else moved it first: theirs is shown, never overwritten. The column's line is drawn
  // with the list.
  const stale = !r.ok && r.body && r.body.stale && Array.isArray(r.body.order);
  if (r.ok || stale) seenOrder[m] = r.body;
  if (r.ok) {
    clearError('col:do');
    announce('Order saved.');
  } else if (stale) changedBy('col:do', isPersonal(m) ? { who: viewer } : r.body);
  // Try again saves the same order at the same version.
  else noteCard('col:do', 'err', 'Order not saved: ' + errText(r), { retry: () => applyShared(m, order, drawn) });
  busy.delete('order');
  dndBusy = false;
  cardsChanged();
  render({ keepReader: true });
}


// Which order a drag here edits: your own places, the meeting's, or none.
function dragMode(s) { return ownTodoView(s) ? 'own' : sharedView(s) ? 'shared' : ''; }
function canDrag(c, mode, s) {
  if (c && c.row) return false;   // a closed card's row (study.js) is not dragged
  return mode === 'own' ? ownMovable(c) : mode === 'shared' ? sharedMovable(c) && c.from === s.source : false;
}

// The cards a drag in this mode moves, in the column's order. A closed card's row keeps its
// card's slot, so Undo after a drag still finds it there.
function colOrder(col, mode, s) {
  return [...col.querySelectorAll('article.card[data-card]')]
    .map((el) => el.dataset.card)
    .filter((id) => cardById(id)?.row || canDrag(cardById(id), mode, s));
}

const colOf = (el) => el.closest('section.desk-column');
const drawnVersion = (col) => Number(col.dataset.orderVersion || 0);

addHook('afterRender', 'dnd', function (options = {}) {
  const s = state();
  // The list being rendered (study.js cardListEl: the twin during an in-place refresh).
  const list = cardListEl();
  const col = list && list.querySelector('section.desk-column[aria-labelledby="heading-do"]');
  const mode = dragMode(s);
  // The version this column is drawn from: part of the list's markup, so a
  // newer one never patches in silently -- it swaps the list or waits.
  if (col && mode) col.dataset.orderVersion = String((knownOrder(mode === 'own' ? personalKey() : s.source) || { version: 0 }).version);
  if (!col || !mode) {
    col?.querySelectorAll('.prio-draggable').forEach((el) => { el.removeAttribute('draggable'); el.classList.remove('prio-draggable'); });
    return;
  }
  for (const el of col.querySelectorAll('article.card[data-card]')) {
    const id = el.dataset.card, c = cardById(id);
    if (!canDrag(c, mode, s)) {
      el.removeAttribute('draggable'); el.classList.remove('prio-draggable');
      continue;
    }
    el.setAttribute('draggable', 'true');
    el.classList.add('prio-draggable');
    if (el.dataset.dndWired) continue;
    el.dataset.dndWired = '1';
    el.addEventListener('dragstart', (e) => {
      if (dndBusy) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      el.classList.add('prio-dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('prio-dragging');
      colOf(el)?.querySelectorAll('.prio-drop-before,.prio-drop-after').forEach((x) => x.classList.remove('prio-drop-before', 'prio-drop-after'));
    });
    el.addEventListener('dragover', (e) => {
      const s = state();
      if (!canDrag(cardById(el.dataset.card), dragMode(s), s)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      el.classList.toggle('prio-drop-after', after);
      el.classList.toggle('prio-drop-before', !after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('prio-drop-before', 'prio-drop-after'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = e.dataTransfer.getData('text/plain'), to = el.dataset.card;
      const after = el.classList.contains('prio-drop-after');
      el.classList.remove('prio-drop-before', 'prio-drop-after');
      if (!from || from === to) return;
      const col = colOf(el);
      if (!col) return;
      const s = state();
      if (dragMode(s) === 'shared') {
        const next = moveIn(colOrder(col, 'shared', s), from, to, after);
        if (next) applyShared(s.source, next, drawnVersion(col));
        return;
      }
      if (dragMode(s) !== 'own') return;
      const shown = moveIn(colOrder(col, 'own', s), from, to, after);
      if (shown) applyShared(personalKey(), mergeShown(orderOf(personalKey()) || [], shown), drawnVersion(col));
    });
  }
});
