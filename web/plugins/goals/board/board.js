/* The goals plugin on the board (../README.md): the goal a card serves as a tag on its tile, a
 * Goal row in its detail panel to pick one or None, the board narrowed to a goal's cards, and a
 * Goals page for this period's and the next one's goals. What a feature plugin may add, and when
 * the board asks: pages/board/ui/plugins.js.
 */
'use strict';
(function () {
  const TAGS_PER_READ = 50;             // cards per tags read: a short request line (the backend takes up to 200)
  // A goal's description box, the same in the add and edit forms.
  const summaryField = (more = '') => `<textarea name="summary" maxlength="280" rows="4" aria-label="Description"${more} placeholder="Description: what done looks like"></textarea>`;
  const OUTCOMES = [['', 'No outcome'], ['met', 'Met'], ['missed', 'Missed'], ['carried', 'Carried']];
  // Why the backend refused a decision (its README), in words; anything else: try again.
  const REFUSED = {
    stale_revision: 'Someone changed this goal just now. Here it is as it is now.',
    carried_copy_edited: 'Its carried copy in the next period was edited, so it stays carried.',
  };
  let api = null;                       // this plugin's routes, as the signed-in person
  let current = null;                   // the last /current: the list, this period's goals and the next one's, can_decide
  // Its page and row, in the board's soft look (ui/soft.css tokens); core draws the rest.
  const STYLE = `
.goals-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:4px}
.goals-head h1{margin:0;font-size:26px;letter-spacing:-.8px;font-weight:650}
.goal-add,.goal-change{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.goal-add [name=title],.goal-change [name=title]{flex:1 1 200px;max-width:320px;min-width:0}
.goal-add [name=summary],.goal-change [name=summary]{flex:1 1 100%;max-width:640px;min-width:0;min-height:5.5em;resize:vertical}
.goal-tip{flex-basis:100%;margin:0}
.goal-period h2{margin:20px 0 8px;font-size:15px;font-weight:700;color:var(--sf-ink-3)}
.goal-list{background:var(--sf-card);border-radius:12px;box-shadow:var(--sf-shadow-card);overflow:hidden}
.goal-row{display:grid;grid-template-columns:36px minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:12px 16px;border-top:1px solid var(--sf-line);font-size:13px}
.goal-row:first-child{border-top:0}
.goal-label{color:var(--sf-muted);font-weight:700;font-variant-numeric:tabular-nums}
.goal-name{display:grid;grid-template-columns:auto 1fr;column-gap:6px;align-items:center;min-width:0}
.goal-name b{color:var(--sf-title);font-weight:600;overflow-wrap:anywhere}
.goal-name small{grid-column:1/-1;color:var(--sf-muted);font-size:12.5px;overflow-wrap:anywhere;white-space:pre-line}
.goal-badge{justify-self:start;font-size:11px;font-weight:600;padding:1px 7px;border-radius:5px;background:var(--sf-fill);color:var(--sf-ink-3)}
.goal-edit{min-width:28px;min-height:28px;color:var(--sf-muted)}
.goal-decide{display:flex;gap:8px;align-items:center}
.goal-cards{color:var(--sf-accent);font-weight:600;text-decoration:none;white-space:nowrap}
.goal-change{grid-column:1/-1}
.goal-empty{padding:12px 16px;color:var(--sf-muted);font-size:13px;margin:0}
.goal-button{min-height:34px;padding:5px 18px;border:1px solid var(--sf-solid);border-radius:8px;background:var(--sf-solid);color:#fff;font:inherit;font-size:13.5px;font-weight:500;cursor:pointer}
.goal-button:hover{border-color:var(--sf-solid-hover);background:var(--sf-solid-hover)}
@media (max-width:700px){
.goal-row{grid-template-columns:28px minmax(0,1fr) auto}
.goal-cards{grid-column:3;grid-row:1}
.goal-decide{grid-column:2/-1;grid-row:2}
.goal-decide:empty{display:none}}
`;

  // "G2 Board is easy to scan": a goal as tags, menus and the narrow bar name it; a draft has no label.
  const named = (g) => (g.label ? g.label + ' ' : '') + g.title;
  // Its number, the filters column's mark for it (G2 → 2).
  const mark = (g) => (g.label ? g.label.replace(/^G/, '') : '');

  window.bwatBoard.register('goals', {
    start(board) {
      api = board.api;
      const style = document.createElement('style');
      style.textContent = STYLE;
      document.head.append(style);
    },

    // This period's goals for the filters column (drafts and dismissed ones serve no card).
    async facets() {
      await readCurrent();
      return current ? current.goals.filter((g) => g.state === 'goal').map((g) => ({ key: g.id, label: named(g), mark: mark(g) })) : [];
    },

    async narrow(goalId) {
      const r = await api('GET', '/goals/' + encodeURIComponent(goalId) + '/cards');
      if (!r.ok) throw new Error('narrow: HTTP ' + r.status);
      return { label: 'Goal: ' + named(r.data.goal), ids: r.data.card_ids };
    },

    pageLabel: 'Goals',
    page: renderPage,

    async tags(ids) {
      const reads = [];
      for (let i = 0; i < ids.length; i += TAGS_PER_READ) reads.push(api('GET', '/links?cards=' + ids.slice(i, i + TAGS_PER_READ).join(',')));
      return (await Promise.all(reads)).flatMap((r) => {
        if (!r.ok) throw new Error('tags: HTTP ' + r.status);
        return r.data.links.map((l) => ({ card_id: l.card_id, key: l.goal.id, text: named(l.goal), mark: mark(l.goal) }));
      });
    },

    readerRow(card, row, board) {
      const tag = (card.tags || []).find((t) => t.plugin === 'goals');
      const chosen = tag ? tag.key : '';
      row.innerHTML = '<span id="goal-label">Goal</span><select name="goals" aria-labelledby="goal-label"></select><span class="muted small" role="status"></span>';
      const pick = row.querySelector('select');
      fill(pick, chosen, tag);
      readCurrent().then(() => fill(pick, chosen, tag));
      // A refused link (a goal dismissed meanwhile, 409; gone, 404) puts the menu back and says so.
      pick.onchange = async () => {
        const path = '/cards/' + encodeURIComponent(card.id) + '/goal';
        const r = pick.value ? await api('PUT', path, { goal_id: pick.value }) : await api('DELETE', path);
        if (r.ok) { board.refresh(); return; }
        pick.value = chosen;
        row.querySelector('[role=status]').textContent = 'Not saved. Try again.';
      };
    },
  });

  // None, then this period's goals (drafts and dismissed ones serve no card); `value` chosen. A
  // card's goal from another period (`tag`, not in the list) is kept as the chosen one.
  function fill(pick, value, tag) {
    const goals = current ? current.goals.filter((g) => g.state === 'goal') : [];
    const option = (v, text) => { const o = document.createElement('option'); o.value = v; o.textContent = text; o.defaultSelected = v === value; return o; };
    const listed = tag && !goals.some((g) => g.id === tag.key) ? [...goals, { id: tag.key, title: tag.text }] : goals;
    pick.replaceChildren(option('', 'None'), ...listed.map((g) => option(g.id, named(g))));
    pick.value = value;
  }

  async function readCurrent() {
    const r = await api('GET', '/current');
    if (r.ok) current = r.data;
  }

  // ---- The Goals page ----

  function renderPage(page, board) {
    page.innerHTML = '<div class="goals-head"><h1 id="goals-title" tabindex="-1">Goals</h1></div>'
      + '<form class="goal-add"><input name="title" maxlength="80" required aria-label="New goal" placeholder="New goal">'
      + summaryField(' aria-describedby="goal-tip"')
      + '<button type="submit" class="goal-button">Add</button>'
      + '<p class="muted small goal-tip" id="goal-tip">Try a SMART goal: specific, measurable, achievable, relevant and time-bound. '
      + 'For example, "Goals on the board, live in dev by Friday".</p></form>'
      + '<p class="muted small" id="goals-status" role="status"></p><div id="goal-periods"></div>';
    const add = page.querySelector('form.goal-add');
    add.onsubmit = async (e) => {
      e.preventDefault();
      const r = await api('POST', '/goals', { title: add.elements.title.value, summary: add.elements.summary.value });
      page.querySelector('#goals-status').textContent = r.ok ? '' : 'Not added. Try again.';
      if (!r.ok) return;
      add.reset();
      await listGoals(page, board);
    };
    listGoals(page, board);
  }

  // "This week" and "Next week", or the list's other rhythm: 2 weeks, a month, a quarter.
  function periodNames(cadence) {
    return cadence === '2weeks' ? ['These 2 weeks', 'Next 2 weeks'] : ['This ' + cadence, 'Next ' + cadence];
  }

  async function listGoals(page, board) {
    await readCurrent();
    if (!current) return;
    const [now, next] = periodNames(current.list.cadence);
    page.querySelector('#goal-periods').replaceChildren(period(now, current.goals, page, board), period(next, current.next.goals, page, board));
  }

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  function period(name, goals, page, board) {
    const box = el('section', 'goal-period');
    const list = el('div', 'goal-list');
    list.append(...(goals.length ? goals.map((g) => goalRow(g, page, board)) : [el('p', 'goal-empty', 'No goals yet.')]));
    box.append(el('h2', '', name), list);
    return box;
  }

  const button = (cls, text, g) => { const b = el('button', cls, text); b.type = 'button'; b.dataset.goal = g.id; return b; };

  // One goal: its label, title and summary, Draft or its outcome, ✎, what an owner or admin may decide, and its cards.
  function goalRow(g, page, board) {
    const row = el('div', 'goal-row');
    const name = el('span', 'goal-name');
    const edit = button('text-button goal-edit', '✎', g);
    edit.setAttribute('aria-label', 'Edit ' + g.title);
    edit.onclick = () => editRow(row, g, page, board);
    name.append(el('b', '', g.title), edit);
    if (g.summary) name.append(el('small', '', g.summary));
    if (g.state === 'draft') name.append(el('span', 'goal-badge', 'Draft'));
    else if (g.outcome) name.append(el('span', 'goal-badge', OUTCOMES.find(([v]) => v === g.outcome)[1]));
    const decide = el('span', 'goal-decide');
    if (current.can_decide) decide.append(...decisions(g, page, board));
    const cards = el('a', 'goal-cards', 'Cards →');
    cards.href = cardsHref(g.id);
    cards.setAttribute('aria-label', g.title + ': its cards on the board');
    row.append(el('span', 'goal-label', g.label || ''), name, decide, cards);
    return row;
  }

  // The list read again, the focus back on the goal's outcome, else its pencil, else the heading.
  async function relist(page, board, id) {
    await listGoals(page, board);
    (page.querySelector('select[name="outcome"][data-goal="' + id + '"]') || page.querySelector('.goal-edit[data-goal="' + id + '"]') || page.querySelector('#goals-title')).focus();
  }

  // A draft: Promote and Dismiss. A goal: its outcome. A refusal says why, and the goal shows as it is now.
  function decisions(g, page, board) {
    const after = async (r) => {
      page.querySelector('#goals-status').textContent = r.ok ? '' : REFUSED[r.data?.error] || 'Not saved. Try again.';
      await relist(page, board, g.id);
      if (r.ok) board.refresh();
    };
    const post = (action, body) => api('POST', '/goals/' + encodeURIComponent(g.id) + '/' + action, body);
    if (g.state === 'draft') {
      const promote = button('goal-button goal-promote', 'Promote', g);
      promote.onclick = async () => after(await post('promote', { revision: g.revision }));
      const dismiss = button('text-button goal-dismiss', 'Dismiss', g);
      dismiss.onclick = async () => after(await post('dismiss', { revision: g.revision }));
      return [promote, dismiss];
    }
    const pick = el('select');
    pick.name = 'outcome';
    pick.dataset.goal = g.id;
    pick.setAttribute('aria-label', 'Outcome of ' + g.title);
    pick.append(...OUTCOMES.map(([v, text]) => { const o = el('option', '', text); o.value = v; return o; }));
    pick.value = g.outcome || '';
    pick.onchange = async () => after(await post('outcome', { revision: g.revision, outcome: pick.value || null }));
    return [pick];
  }

  // A goal's title and summary in place of its row, with Save and Cancel; Save sends only what changed.
  function editRow(row, g, page, board) {
    const form = el('form', 'goal-change');
    form.innerHTML = '<input name="title" maxlength="80" required aria-label="Goal">' + summaryField()
      + '<button type="submit" class="goal-button">Save</button><button type="button" class="text-button goal-cancel">Cancel</button>'
      + '<p class="muted small" role="status"></p>';
    form.elements.title.value = g.title;
    form.elements.summary.value = g.summary;
    row.replaceChildren(form);
    form.elements.title.focus();
    // Back to the list, the focus on this goal's pencil.
    const back = async () => {
      await listGoals(page, board);
      page.querySelector('.goal-edit[data-goal="' + g.id + '"]')?.focus();
    };
    // Sends what was typed over the goal as the edit opened it, so another's change to the other field stays;
    // at the revision last read (a stale save moves it on).
    let revision = g.revision;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const change = { revision };
      if (form.elements.title.value !== g.title) change.title = form.elements.title.value;
      if (form.elements.summary.value !== g.summary) change.summary = form.elements.summary.value;
      if (Object.keys(change).length === 1) { await back(); return; }
      const r = await api('PATCH', '/goals/' + encodeURIComponent(g.id), change);
      if (r.ok) { await back(); board.refresh(); return; }
      // Someone else saved first (409 with the goal as it is now): what was typed stays, and Save again keeps it.
      const stale = r.data?.error === 'stale_revision';
      if (stale) revision = r.data.goal.revision;
      form.querySelector('[role=status]').textContent = stale
        ? 'Someone changed this goal just now. Save again to keep yours, or Cancel to see theirs.'
        : 'Not saved. Try again.';
    };
    form.querySelector('.goal-cancel').onclick = back;
  }

  // The board narrowed to the goal's open cards, from every meeting.
  function cardsHref(id) {
    const u = new URL(location.href);
    for (const k of ['page', 'card', 'q', 'week', 'when']) u.searchParams.delete(k);
    u.searchParams.set('source', 'open');
    u.searchParams.set('narrow', 'goals:' + id);
    return u.pathname + u.search;
  }
})();
