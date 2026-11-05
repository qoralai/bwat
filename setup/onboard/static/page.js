// The onboarding page: the chosen flow's steps, in the board's look. A classic script,
// like the board's own, so web/test can load it into jsdom. It reads and writes only
// through the server's API (window.bwatOnboard.render's api); it keeps nothing in browser
// storage.
(function () {
  'use strict';

  function el(document, tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) { node.setAttribute(name, attrs[name]); });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Whether a named condition applies: true, false, or null while its answer is not given.
  // A name the server did not report applies.
  function applies(guide, name) {
    var condition = name && guide.conditions && guide.conditions[name];
    return condition ? condition.applies : true;
  }

  function appliesNote(document, guide, name) {
    return el(document, 'p', { class: 'muted small onboard-applies' }, 'Applies when ' + guide.conditions[name].label);
  }

  // The chosen flow's steps, without those whose condition does not apply.
  function stepsOf(guide, flow) {
    return guide.steps.filter(function (step) {
      return step.flows.indexOf(flow) >= 0 && applies(guide, step.when) !== false;
    });
  }

  // Drops the "Applies when" note a node carries directly, so it can be put right again.
  function dropNote(node) {
    Array.prototype.slice.call(node.children).forEach(function (child) {
      if (child.classList.contains('onboard-applies')) child.remove();
    });
  }

  // A block of a step under a condition: hidden when it does not apply, noted when unknown.
  // Safe to run again when an answer changes the conditions.
  function conditionBlocks(document, body, guide) {
    body.querySelectorAll('.bwat-when').forEach(function (block) {
      var name = block.getAttribute('data-when');
      var now = applies(guide, name);
      block.hidden = now === false;
      dropNote(block);
      if (now === null) block.insertBefore(appliesNote(document, guide, name), block.firstChild);
    });
  }

  // Shows or hides every step card and conditioned block to match the guide's conditions,
  // without redrawing anything else: what the person has typed stays where it is.
  function applyConditions(root, guide) {
    var document = root.ownerDocument;
    root.querySelectorAll('[data-step]').forEach(function (card) {
      var step = guide.steps.filter(function (s) { return s.id === card.getAttribute('data-step'); })[0];
      if (!step) return;
      var now = applies(guide, step.when);
      card.hidden = now === false;
      dropNote(card);
      if (now === null) card.insertBefore(appliesNote(document, guide, step.when), card.querySelector('.onboard-body'));
      conditionBlocks(document, card.querySelector('.onboard-body'), guide);
    });
  }

  // The guide's own text, rendered by the server from this clone's docs (the page's CSP runs
  // no script in it), for this install and with the saved address in place.
  function guideBody(document, html, ctx) {
    var body = el(document, 'div', { class: 'onboard-body' });
    body.innerHTML = html;
    forThisInstall(body, ctx);
    fillAddress(document, body, ctx.answers.values.BWAT_PUBLIC_URL);
    return body;
  }

  // A part of the master (parts are server-rendered from this clone's docs, like steps).
  function partBox(document, guide, id, tag, ctx) {
    var part = (guide.parts || []).filter(function (p) { return p.id === id; })[0];
    if (!part) return null;
    var box = el(document, tag, { class: 'onboard-part', 'data-part': id });
    var body = guideBody(document, part.html, ctx);
    if (tag === 'details') box.appendChild(el(document, 'summary', {}, part.title));
    else body.insertBefore(el(document, 'h2', {}, part.title), body.firstChild);
    box.appendChild(body);
    return box;
  }

  // Text for other ways of running bwat stays hidden, and every "More detail" box starts
  // folded, remembering that as its own default.
  function forThisInstall(body, ctx) {
    body.querySelectorAll('.bwat-flows').forEach(function (block) {
      block.hidden = (block.getAttribute('data-flows') || '').split(',').indexOf(ctx.flow) < 0;
    });
    // So is text for other computers, once the server says which one this is.
    var platform = ctx.guide.platform;
    if (platform) {
      body.querySelectorAll('.bwat-os').forEach(function (block) {
        block.hidden = !(block.getAttribute('data-os') || '').split(',').some(function (name) { return platform.indexOf(name) >= 0; });
      });
    }
    body.querySelectorAll('details.bwat-more').forEach(function (box) {
      box.open = false;
      box.setAttribute('data-auto', 'closed');
    });
  }

  // The page's link to its setup server (setup delight FR-9), from app.js: lost when the
  // events stream ends or a check fails twice, back at the next answer.
  var OFFLINE = 'The setup server stopped. Run ./bwat setup --web again; your progress is kept.';
  function connection(document, ok) {
    if (document.body.classList.contains('onboard-finished')) return;
    var status = document.getElementById('status');
    var was = document.body.classList.contains('onboard-offline');
    document.body.classList.toggle('onboard-offline', !ok);
    if (!ok && status) status.textContent = OFFLINE;
    else if (was && status) status.textContent = 'Connected again. Nothing was lost.';
  }

  // A field's name for a person: its key without the BWAT_ prefix, in words.
  var WORDS = { id: 'ID', url: 'URL', tls: 'TLS', sdk: 'SDK', s2s: 'Server-to-Server', jev: 'Jev', zoom: 'Zoom', google: 'Google', openrouter: 'OpenRouter' };
  // The panels' own names for the fields they ask: the page's only text for a field that is
  // not in the master (its help is the master's paragraph after it), so the master cannot change these.
  var LABELS = {
    BWAT_FIRST_OWNER_EMAIL: 'Your email', BWAT_ZOOM_CONTACT_NAME: 'Your name', BWAT_BOT_NAME: 'Bot name', BWAT_ZOOM_COMPANY: 'Company name',
    ZOOM_CLIENT_ID: 'Client ID', ZOOM_CLIENT_SECRET: 'Client secret', OPENROUTER_API_KEY: 'OpenRouter key',
  };
  function fieldName(key) {
    if (LABELS[key]) return LABELS[key];
    var text = key.replace(/^BWAT_/, '').toLowerCase().split('_').map(function (word) { return WORDS[word] || word; }).join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  // The friendly name replaces the key; a secret's 🔒 (secret-field.js) stays in front of it.
  function nameLabel(label, key) {
    var mark = label.querySelector('[aria-hidden="true"]');
    label.textContent = fieldName(key);
    if (mark) label.insertBefore(mark, label.firstChild);
  }

  // Each key's "Saved" message, so the redraw after a save does not lose it.
  var savedNote = {};

  // Saves itself when the person leaves the field or presses Enter, when it has changed.
  function answerField(document, key, answers, api, notify) {
    var wrap = el(document, 'div', { class: 'onboard-field' });
    var id = 'answer-' + key;
    var label = el(document, 'label', { class: 'field-label', for: id });
    nameLabel(label, key);
    wrap.appendChild(label);
    var row = el(document, 'div', { class: 'onboard-field-row' });
    var input = el(document, 'input', { id: id, type: 'text', autocomplete: 'off', spellcheck: 'false' });
    input.value = answers.values[key] || '';
    // What the file holds, to tell the person's unsaved typing from a value to refresh.
    input.setAttribute('data-saved', input.value);
    var status = el(document, 'p', { class: 'draft-status', 'aria-live': 'polite' });
    if (savedNote[key]) status.textContent = savedNote[key];
    input.addEventListener('input', function () {
      delete savedNote[key];
      status.textContent = '';
    });
    input.addEventListener('change', function () { if (wrap.changed()) saveIt(); });
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter' && wrap.changed()) saveIt(); });
    // Resolves true once saved, false when the server refused it (the reason is shown).
    function saveIt() {
      status.textContent = 'Saving…';
      return api('/api/answer', { method: 'POST', body: { key: key, value: input.value } }).then(
        function () {
          input.setAttribute('data-saved', input.value);
          status.textContent = savedNote[key] = 'Saved.';
          if (notify) notify();
          return true;
        },
        function (error) {
          status.textContent = error.message;
          return false;
        });
    }
    row.appendChild(input);
    wrap.appendChild(row);
    wrap.appendChild(status);
    wrap.saveIt = saveIt;
    wrap.changed = function () { return input.value !== input.getAttribute('data-saved'); };
    wrap.saved = function () { return Boolean(savedNote[key]); };
    if (!answers.file) {
      input.disabled = true;
      status.textContent = 'Getting ready…';
    }
    return wrap;
  }

  function copyButton(document, text) {
    var button = el(document, 'button', { type: 'button', class: 'text-button' }, 'Copy');
    button.addEventListener('click', function () {
      var clipboard = document.defaultView.navigator.clipboard;
      if (!clipboard) return;
      clipboard.writeText(text).then(function () { button.textContent = 'Copied'; });
    });
    return button;
  }

  function shotFigure(document, figure, shot) {
    if (!shot) return;
    if (shot.image) {
      figure.appendChild(el(document, 'img', { src: shot.image, alt: shot.caption + (shot.labels.length ? ' ' + shot.labels.join(' ') : ''), loading: 'lazy' }));
      if (shot.labels.length) {
        var labels = el(document, 'ol', { class: 'onboard-shot-labels small' });
        shot.labels.forEach(function (label) { labels.appendChild(el(document, 'li', {}, label.replace(/^\d+\. /, ''))); });
        figure.appendChild(labels);
      }
    } else {
      figure.appendChild(el(document, 'p', { class: 'onboard-shot-missing muted small' }, 'Screenshot to come.'));
    }
    var caption = el(document, 'figcaption', { class: 'small' }, shot.caption);
    if (shot.captured) caption.appendChild(el(document, 'span', { class: 'muted' }, ' Captured ' + shot.captured.slice(0, 7) + '.'));
    figure.appendChild(caption);
    var open = el(document, 'a', { href: shot.url, target: '_blank', rel: 'noopener noreferrer', class: 'onboard-open' }, 'Open this page in a new tab');
    figure.appendChild(open);
  }

  // OpenRouter makes the key once the person signs in and allows it, then sends them back to
  // this server, which saves it; the field shows it through the 'answer' event. The tab
  // opens within the click (a popup blocker allows that), then goes to the server's link.
  function connectOpenRouter(document, ctx) {
    var button = el(document, 'button', { type: 'button', class: 'primary onboard-connect' }, 'Connect OpenRouter');
    button.addEventListener('click', function () {
      var tab = document.defaultView.open('', '_blank');
      ctx.api('/api/openrouter/start', { method: 'POST', body: {} }).then(function (reply) { tab.location = reply.url; });
    });
    return button;
  }

  // The guide writes a field's explanation as the paragraph after it: move it into the
  // field, under its input and above its status line, and describe the input with it.
  function attachHelp(node) {
    var field = node.querySelector('.onboard-field');
    var help = node.nextElementSibling;
    if (!field || !help || help.tagName !== 'P') return;
    var input = field.querySelector('input');
    help.id = (input ? input.id : node.getAttribute('data-key')) + '-help';
    help.classList.add('onboard-field-help');
    // A secret's field is kept across redraws (app.js), so it still holds the last one's help.
    field.querySelectorAll('.onboard-field-help').forEach(function (old) { old.remove(); });
    field.insertBefore(help, field.lastElementChild);
    if (input) input.setAttribute('aria-describedby', ((input.getAttribute('aria-describedby') || '') + ' ' + help.id).trim());
  }

  // Fills the placeholders flow.ts put into a step's text.
  function enhance(document, body, step, ctx) {
    body.querySelectorAll('.bwat-answer').forEach(function (node) {
      node.appendChild(answerField(document, node.getAttribute('data-key'), ctx.answers, ctx.api, ctx.recheck));
      attachHelp(node);
    });
    body.querySelectorAll('.bwat-secret').forEach(function (node) {
      if (ctx.secretField) {
        node.appendChild(ctx.secretField(node.getAttribute('data-key')));
        node.querySelectorAll('.field-label').forEach(function (label) { nameLabel(label, node.getAttribute('data-key')); });
        if (node.getAttribute('data-key') === 'OPENROUTER_API_KEY') node.insertBefore(connectOpenRouter(document, ctx), node.firstChild);
        return attachHelp(node);
      }
      var key = node.getAttribute('data-key');
      node.appendChild(el(document, 'p', { class: 'muted small' }, 'Secret ' + key + ': copy it, then run ./bwat secret ' + key + ' in a terminal.'));
    });
    body.querySelectorAll('.bwat-run').forEach(function (node) {
      var run = step.runs.filter(function (r) { return r.id === node.getAttribute('data-run'); })[0];
      // The server writes the answers file and the Zoom manifest itself.
      if (/^prep/.test(node.getAttribute('data-run'))) { node.hidden = true; return; }
      var bar = el(document, 'div', { class: 'onboard-run-bar' });
      bar.appendChild(copyButton(document, run ? run.command : node.textContent));
      // The command and its output fold under the Run button.
      var holder = el(document, 'details', { class: 'onboard-tech', 'data-run-fold': node.getAttribute('data-run'), 'data-auto': 'closed' });
      holder.appendChild(el(document, 'summary', {}, 'Show the command and its output'));
      Array.prototype.slice.call(node.children).forEach(function (child) { holder.appendChild(child); });
      node.appendChild(bar);
      node.appendChild(holder);
      // Setup and the plugin start on their own (renderPage); their panels show how far they are.
      if (ctx.runs && run && (run.id === 'setup' || run.id === 'plugin')) runPanel(document, holder, bar, run, ctx);
    });
    body.querySelectorAll('.bwat-shot').forEach(function (node) {
      shotFigure(document, node, ctx.shots[node.getAttribute('data-shot')]);
    });
    body.querySelectorAll('a[target="_blank"]').forEach(function (link) {
      link.addEventListener('click', ctx.splitHint);
    });
  }

  // A Run button and its output under a command; ctx.runs.panels lets app.js feed it events.
  function runPanel(document, node, bar, run, ctx) {
    var button = el(document, 'button', { type: 'button', class: 'primary', 'data-run-button': run.id, hidden: '' }, 'Run');
    var status = el(document, 'span', { class: 'onboard-run-status small', 'aria-live': 'polite' });
    var output = el(document, 'pre', { class: 'onboard-output', hidden: '' });
    bar.insertBefore(status, bar.firstChild);
    bar.appendChild(button);
    node.appendChild(output);
    var panel = { button: button, status: status, output: output };
    if (run.id === 'plugin') {
      // ./bwat plugin exits 3 when the plugin points at another bwat: the person chooses.
      panel.repoint = el(document, 'button', { type: 'button', class: 'primary', hidden: '' }, 'Point it here');
      panel.repoint.addEventListener('click', function () {
        panel.repoint.disabled = true;
        ctx.api('/api/run', { method: 'POST', body: { id: 'plugin-repoint', command: './bwat plugin --repoint' } }).catch(function (error) {
          panel.repoint.disabled = false;
          status.textContent = error.message;
        });
      });
      bar.appendChild(panel.repoint);
      // The repoint's events show here too: it has no panel of its own.
      ctx.runs.panels['plugin-repoint'] = panel;
    }
    ctx.runs.panels[run.id] = panel;
    button.addEventListener('click', function () {
      button.disabled = true;
      ctx.api('/api/run', { method: 'POST', body: { id: run.id, command: run.command } }).catch(function (error) {
        button.disabled = false;
        status.textContent = error.message;
      });
    });
    var last = ctx.runs.last[run.id];
    if (last) {
      last.lines.forEach(function (line) { applyRunEvent(ctx.runs.panels, { type: 'line', id: run.id, line: line }); });
      if (last.progress) applyRunEvent(ctx.runs.panels, Object.assign({ type: 'progress', id: run.id }, last.progress));
      if (last.exit !== undefined && last.exit !== null) applyRunEvent(ctx.runs.panels, { type: 'exit', id: run.id, exit: last.exit });
      else applyRunEvent(ctx.runs.panels, { type: 'start', id: run.id, keep: true });
    }
    // A repoint after the plugin's stop answers it: its end shows instead.
    var repoint = panel.repoint && ctx.runs.last['plugin-repoint'];
    if (repoint && repoint.exit !== undefined && repoint.exit !== null && (!last || String(repoint.started) >= String(last.started))) {
      applyRunEvent(ctx.runs.panels, { type: 'exit', id: 'plugin-repoint', exit: repoint.exit });
    }
  }

  /** Shows one runner event (runner.ts RunEvent) in its command's panel. */
  function applyRunEvent(panels, event) {
    var panel = panels[event.id];
    if (!panel) return;
    if (event.type === 'start') {
      if (!event.keep) panel.output.textContent = '';
      panel.output.hidden = false;
      panel.button.disabled = true;
      panel.status.textContent = 'Running…';
      // Setup and the plugin run by themselves: their output shows while they run.
      var running = event.id === 'setup' || event.id === 'plugin' ? panel.output.closest('details.onboard-tech') : null;
      if (running) { running.open = true; running.setAttribute('data-auto', 'open'); }
    } else if (event.type === 'line') {
      panel.output.hidden = false;
      // Appended as a text node: rebuilding the whole text per line grows with the output.
      panel.output.appendChild(panel.output.ownerDocument.createTextNode(event.line + '\n'));
      panel.output.scrollTop = panel.output.scrollHeight;
    } else if (event.type === 'progress') {
      panel.status.textContent = 'Step ' + event.step + ' of ' + event.of + ': ' + event.title;
    } else if (event.type === 'exit') {
      panel.button.disabled = false;
      var otherBwat = event.id === 'plugin' && event.exit === 3;
      var repointed = event.id === 'plugin-repoint' && event.exit === 0;
      // The choice stays while it is open: after the stop, and after a repoint that failed.
      if (panel.repoint) { panel.repoint.hidden = !(otherBwat || (event.id === 'plugin-repoint' && !repointed)); panel.repoint.disabled = false; }
      panel.status.textContent = otherBwat
        ? 'The bwat plugin in Claude Code points at another bwat. Point it here to use this one; your sign-in to the other bwat then stops working in Claude Code.'
        : repointed ? 'Pointed here. Restart Claude Code, then type /bwat:login.'
          : event.exit === 0 ? 'Finished.' : 'Stopped with exit code ' + event.exit + ': see the output.';
      // A failure shows its output, unfolding it; the boxes around
      // the step are the person's.
      var fold = event.exit === 0 ? null : panel.output.closest('details.onboard-tech');
      if (fold) fold.open = true;
    }
  }

  // The guide writes <address> for the install's address; once it is saved, the page
  // shows the address itself. Text nodes only, so a value can never become markup.
  function fillAddress(document, body, address) {
    if (!address) return;
    var walker = document.createTreeWalker(body, document.defaultView.NodeFilter.SHOW_TEXT);
    var alone = [];
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.indexOf('<address>') < 0) continue;
      // The plugin accepts plain http only for 127.0.0.1, so its base URL never says localhost.
      var plugin = address.replace(/^(https?:\/\/)localhost(?=[:\/]|$)/, '$1127.0.0.1');
      if (node.nodeValue === '<address>' && node.parentNode.tagName === 'CODE') alone.push(node.parentNode);
      node.nodeValue = node.nodeValue.split('<address>/v1').join(plugin + '/v1').split('<address>').join(address);
    }
    // The address on its own is a link to it, in a new tab; never one already in a link.
    if (!/^https?:\/\//.test(address)) return;
    alone.forEach(function (code) {
      if (code.closest('a')) return;
      var link = el(document, 'a', { href: address, target: '_blank', rel: 'noopener noreferrer' });
      code.parentNode.insertBefore(link, code);
      link.appendChild(code);
    });
  }

  // A local install's sign-in code (D202), which setup leaves for this page at the end of the
  // install: the server hands it over once and deletes it, so the page asks for it by itself
  // when it shows the sign-in step (only once bwat is installed) and keeps it for this load
  // only, never in storage.
  var shownCode = null;
  // null until asked, then 'asking', 'shown' or 'none' (no code was waiting).
  var codeState = null;
  var NO_CODE = 'No new code is waiting: setup shows a code once, when it makes one. Lost it? Run ./bwat setup --new-code in a terminal.';
  function signinCodeBox(document, ctx) {
    var box = el(document, 'div', { class: 'onboard-signin-code', 'data-signin-code': '' });
    if (codeState === 'none') {
      box.appendChild(el(document, 'p', { class: 'muted small', role: 'status' }, NO_CODE));
      return box;
    }
    if (shownCode) {
      box.appendChild(el(document, 'p', {}, 'Your sign-in code, shown once. Copy it somewhere safe.'));
      var row = el(document, 'div', { class: 'onboard-code-row' });
      row.appendChild(el(document, 'pre', { class: 'onboard-code-value' }, shownCode));
      row.appendChild(copyButton(document, shownCode));
      box.appendChild(row);
      box.appendChild(el(document, 'p', { class: 'muted small' }, 'Anyone with it can sign in, as any email.'));
      return box;
    }
    var status = el(document, 'p', { class: 'muted small', role: 'status', 'aria-live': 'polite' }, 'Getting your sign-in code…');
    box.appendChild(status);
    if (codeState === null) {
      codeState = 'asking';
      ctx.api('/api/signin-code', { method: 'POST', body: {} }).then(function (answer) {
        if (!answer || !answer.code) return 'none';
        shownCode = answer.code;
        ctx.reload();
        return 'shown';
      }, function () { return 'none'; }).then(function (state) {
        codeState = state;
        if (state === 'none') status.textContent = NO_CODE;
      });
    }
    return box;
  }

  // The Zoom Meeting SDK (QOR-5044): what this computer has, the meeting bot's build, which
  // the server starts on its own once a finished file is here, and a place to drop the file,
  // which lands on the machine running this page (a cloud server, through an SSH tunnel).
  // The box asks the server itself every few seconds, so the page is not redrawn for it.
  var SDK_POLL = 4000;
  // A browser saves a second download as "name (1).tar.xz"; the server takes Zoom's name only.
  function sdkName(name) { return name.replace(/ \(\d+\)(?=\.tar\.)/, ''); }
  function sdkStatusText(s) {
    var note = s.version && s.kind === 'untested' ? ' Version ' + s.version + ' is newer than the tested ' + s.tested + '; bwat tries to build it all the same.'
      : s.version && s.kind === 'built-here' ? ' Version ' + s.version + ' has built on this computer before.' : '';
    if (s.image === 'current') return 'The meeting bot is built' + (s.version ? ' (Zoom Meeting SDK ' + s.version + ')' : '') + '.';
    if (s.uploading) return 'Receiving the SDK file…';
    if (s.building) {
      var minutes = Math.max(0, Math.floor((Date.now() - Date.parse(s.build.started)) / 60000));
      return 'Building the meeting bot from ' + s.file + (minutes ? ' (' + minutes + ' min so far)' : '') + '. Carry on: it finishes on its own.' + note;
    }
    if (!s.file) return 'No SDK file here yet. Download it as above and this page finds it in your Downloads folder. Downloaded on another computer? Drop the file here.';
    if (!s.docker) return 'Found ' + s.file + '. Start Docker, and the meeting bot builds here on its own.' + note;
    if (s.build && s.build.exit !== null && s.build.exit !== 0) return 'The build from ' + s.file + ' stopped: see its output. Fix what it says, then select Build again.';
    return 'Found ' + s.file + '. The meeting bot starts building in a moment.' + note;
  }
  function sdkBox(document, ctx) {
    var box = el(document, 'div', { class: 'onboard-sdk', 'data-sdk': '' });
    var status = el(document, 'p', { class: 'onboard-sdk-status', role: 'status', 'aria-live': 'polite' }, 'Looking for the SDK file…');
    var drop = el(document, 'div', { class: 'onboard-sdk-drop', 'data-sdk-drop': '' });
    var input = el(document, 'input', { type: 'file', accept: '.xz,.gz,.bz2', 'data-sdk-file': '' });
    var choose = el(document, 'label', { class: 'button' }, 'Choose the file');
    choose.appendChild(input);
    drop.appendChild(el(document, 'span', {}, 'Drop zoom-meeting-sdk-linux_x86_64-….tar.xz here, or '));
    drop.appendChild(choose);
    var progress = el(document, 'progress', { max: '100', value: '0', hidden: '' });
    var bar = el(document, 'div', { class: 'onboard-run-bar' });
    var runStatus = el(document, 'span', { class: 'onboard-run-status small', 'aria-live': 'polite' });
    var build = el(document, 'button', { type: 'button', 'data-sdk-build': '', hidden: '' }, 'Build again');
    bar.appendChild(runStatus);
    bar.appendChild(build);
    var fold = el(document, 'details', { class: 'onboard-tech', 'data-run-fold': 'sdk-build', 'data-auto': 'closed', hidden: '' });
    fold.appendChild(el(document, 'summary', {}, "Show the build's output"));
    var output = el(document, 'pre', { class: 'onboard-output', hidden: '' });
    fold.appendChild(output);
    [status, drop, progress, bar, fold].forEach(function (node) { box.appendChild(node); });
    // The build's live lines arrive as runner events (app.js); this panel takes them.
    if (ctx.runs) ctx.runs.panels['sdk-build'] = { button: el(document, 'button'), status: runStatus, output: output };

    var timer = null;
    function show(s) {
      if (s.file && !ctx.sdkFile && ctx.reload) ctx.reload();
      status.textContent = sdkStatusText(s);
      var failed = Boolean(s.build && s.build.exit !== null && s.build.exit !== 0);
      drop.hidden = s.building || s.uploading || s.image === 'current';
      build.hidden = !(s.file && s.docker && !s.building && failed);
      fold.hidden = !s.build;
      if (s.build && !output.textContent) { output.textContent = s.build.lines.join('\n'); output.hidden = !s.build.lines.length; }
      if (failed && !fold.hasAttribute('data-opened')) { fold.open = true; fold.setAttribute('data-opened', ''); }
    }
    function look() {
      if (!box.isConnected && timer !== null) { clearInterval(timer); return; }
      if (document.visibilityState === 'hidden') return;
      ctx.api('/api/sdk').then(show, function () {});
    }
    function send(file) {
      if (!ctx.upload) return;
      var name = sdkName(file.name);
      drop.hidden = true;
      progress.hidden = false;
      progress.value = 0;
      status.textContent = 'Sending ' + name + '…';
      ctx.upload('/api/sdk', name, file, function (fraction) { progress.value = Math.round(fraction * 100); }).then(function () {
        progress.hidden = true;
        look();
      }, function (error) {
        progress.hidden = true;
        drop.hidden = false;
        status.textContent = error.message;
      });
    }
    input.addEventListener('change', function () { if (input.files && input.files[0]) send(input.files[0]); });
    drop.addEventListener('dragover', function (event) { event.preventDefault(); drop.classList.add('onboard-sdk-over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('onboard-sdk-over'); });
    drop.addEventListener('drop', function (event) {
      event.preventDefault();
      drop.classList.remove('onboard-sdk-over');
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files[0]) send(files[0]);
    });
    build.addEventListener('click', function () {
      build.disabled = true;
      ctx.api('/api/sdk/build', { method: 'POST', body: {} }).then(function () { output.textContent = ''; build.disabled = false; look(); }, function (error) {
        build.disabled = false;
        status.textContent = error.message;
      });
    });
    look();
    timer = setInterval(look, SDK_POLL);
    return box;
  }

  // What the person has open, taken before a redraw and put back after it: a pending Allow
  // prompt, each field holding typing that is not saved yet (by id), and the focused field.
  function keepOpen(root) {
    var document = root.ownerDocument;
    var prompts = Array.prototype.slice.call(root.querySelectorAll('[data-request]'));
    var typed = {};
    root.querySelectorAll('input[data-saved]').forEach(function (input) {
      if (input.value !== input.getAttribute('data-saved')) typed[input.id] = input.value;
    });
    var opened = Array.prototype.slice.call(root.querySelectorAll('details[data-part][open]')).map(function (d) { return d.getAttribute('data-part'); });
    // A "More detail" box or a command's fold the person opened or folded against the page's
    // own choice (data-auto) stays that way.
    var folds = {};
    root.querySelectorAll('details[data-auto]').forEach(function (d) {
      var name = ['data-more', 'data-run-fold'].filter(function (a) { return d.hasAttribute(a); })[0];
      if (!name) return;
      var key = '[' + name + '="' + d.getAttribute(name) + '"]';
      if (d.open !== (d.getAttribute('data-auto') === 'open')) folds[key] = d.open;
    });
    var active = document.activeElement;
    var focus = active && active.id && root.contains(active) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    // Emptying root drops the page's height, and with it the scroll: the same panel keeps it,
    // a new one opens at the top.
    var view = document.defaultView;
    var was = root.querySelector('[data-panel]');
    was = was && was.getAttribute('data-panel');
    var scrolled = view.scrollY;
    return function () {
      prompts.slice().reverse().forEach(function (ask) { root.insertBefore(ask, root.firstChild); });
      Object.keys(typed).forEach(function (id) {
        var input = document.getElementById(id);
        if (input) input.value = typed[id];
      });
      opened.forEach(function (part) {
        var box = root.querySelector('details[data-part="' + part + '"]');
        if (box) box.open = true;
      });
      Object.keys(folds).forEach(function (key) {
        root.querySelectorAll('details' + key).forEach(function (box) { box.open = folds[key]; });
      });
      var back = focus && document.getElementById(focus.id);
      if (back) {
        back.focus({ preventScroll: true });
        try { if (focus.start !== null) back.setSelectionRange(focus.start, focus.end); } catch (e) { /* not a text field */ }
      }
      var now = root.querySelector('[data-panel]');
      var to = now && now.getAttribute('data-panel') === was ? scrolled : 0;
      if (view.scrollY !== to) view.scrollTo(0, to);
    };
  }

  /** Draws the whole page into root from the server's guide, state and answers. */
  function render(root, data, ctx) {
    var restore = renderPage(root, data, ctx);
    restore();
  }

  // Whether secret key is saved.
  function secretSet(data, key) {
    return Boolean(data.secrets && data.secrets[key] && data.secrets[key].set);
  }

  // Whether the Zoom app's Client ID and Client Secret are saved.
  function zoomCredentials(data) {
    return Boolean(data.answers.values.ZOOM_CLIENT_ID) && secretSet(data, 'ZOOM_CLIENT_SECRET');
  }

  // The page is one panel at a time, one step of setup each, in three groups: the first step
  // not done, or a done one the person went back to with its dot. Fields save themselves, a
  // panel moves on once its step is done, bwat installs itself once the first four are, and
  // Claude Code is connected once the owner has signed in. A panel with confirm is one the page
  // cannot see done: once ready, it asks the person to say so with that button.
  var PANELS = [
    { id: 'model-key', group: 'OpenRouter', title: 'Connect OpenRouter', steps: ['model-key'] },
    { id: 'company', group: 'Zoom', title: 'Name your bwat', steps: ['owner-local', 'company'] },
    { id: 'zoom-main', group: 'Zoom', title: 'Create the Zoom app', steps: ['zoom-main'], confirm: 'I uploaded the manifest and added the app', ready: zoomCredentials },
    { id: 'zoom-sdk', group: 'Zoom', title: 'Download the Meeting SDK', steps: ['zoom-sdk'] },
    { id: 'install', group: 'bwat', title: 'Install bwat', steps: ['install'] },
    { id: 'sign-in', group: 'bwat', title: 'Sign in', steps: ['sign-in'] },
    { id: 'claude-here', group: 'bwat', title: 'Connect Claude Code', steps: ['claude-here'] },
  ];
  var GROUPS = ['OpenRouter', 'Zoom', 'bwat'];
  var SERVER_GUIDE = 'https://github.com/qoralai/bwat/blob/main/docs/onboarding.md#for-the-installer';


  // Whether each panel's step is done, from what the server has and the last checks.
  function finished(data, ctx) {
    var values = data.answers.values;
    var check = function (id) { return Boolean(data.checks && data.checks[id] && data.checks[id].ok); };
    // A step the server ticked done (not skipped) stays done: a live check can fail once (a slow reply), and the
    // page draws before its first check.
    var ticked = function (id) { var s = data.state && data.state.steps && data.state.steps[id]; return Boolean(s && s.state === 'done'); };
    var setup = ctx.runs && ctx.runs.last && ctx.runs.last.setup;
    return {
      'model-key': check('openrouter-key') || ticked('model-key'),
      // The owner's email is Zoom's contact too: the server saves it as both.
      company: ['BWAT_FIRST_OWNER_EMAIL', 'BWAT_ZOOM_CONTACT_NAME', 'BWAT_BOT_NAME', 'BWAT_ZOOM_COMPANY', 'BWAT_ZOOM_CONTACT_EMAIL']
        .every(function (key) { return Boolean(values[key]); }),
      // Zoom shows the credentials before the manifest is uploaded, and the page cannot see the
      // upload or the Add: the person says so. Checks never tick it now (PERSON_CONFIRMS); a setup
      // from before that has their tick, and is not pulled back.
      'zoom-main': zoomCredentials(data) && ticked('zoom-main'),
      // The file is here; the meeting bot builds from it in the background.
      'zoom-sdk': Boolean(data.sdkFile),
      // bwat answers, and setup's run, when this page knows of one, has ended well.
      install: check('edge-healthy') && !(setup && setup.exit !== 0),
      'sign-in': check('owner-signed-in') || ticked('sign-in'),
      'claude-here': check('claude-connected'),
    };
  }

  // The step at hand: the first one not done (none once all are).
  function firstUndone(done) {
    return PANELS.filter(function (p) { return !done[p.id]; })[0];
  }

  // Which panel the person may bring up: a done one, or the step at hand.
  function canVisit(done, id) {
    var first = firstUndone(done);
    return Boolean(first) && (Boolean(done[id]) || id === first.id);
  }

  // Shows panel id, or the step at hand for null; the next draw keeps it while it is done.
  function visit(done, id) {
    viewing = id === firstUndone(done).id ? null : id;
  }

  // One step of the guide inside a panel: its text and its fields. The panel names it.
  function stepSection(document, step, ctx) {
    var section = el(document, 'section', { class: 'onboard-step', id: 'step-' + step.id, 'data-step': step.id });
    var body = guideBody(document, step.html, ctx);
    conditionBlocks(document, body, ctx.guide);
    enhance(document, body, step, ctx);
    if (step.id === 'sign-in') body.appendChild(signinCodeBox(document, ctx));
    if (step.id === 'zoom-sdk') body.appendChild(sdkBox(document, ctx));
    section.appendChild(body);
    return section;
  }

  function stepById(guide, id) {
    return guide.steps.filter(function (s) { return s.id === id; })[0];
  }

  function runOf(guide, stepId, runId) {
    return ((stepById(guide, stepId) || { runs: [] }).runs).filter(function (r) { return r.id === runId; })[0];
  }

  // A line at the top, only when this computer cannot run bwat as it is.
  function problemBanner(document, guide, problems, ctx) {
    var box = el(document, 'section', { class: 'status-box onboard-problem', role: 'alert' });
    problems.forEach(function (text) { box.appendChild(el(document, 'p', {}, text)); });
    var step = stepById(guide, 'prerequisites');
    if (step) {
      var more = el(document, 'details', { class: 'bwat-more' });
      more.appendChild(el(document, 'summary', {}, 'More detail'));
      more.appendChild(guideBody(document, step.html, ctx));
      box.appendChild(more);
    }
    return box;
  }

  // Where the person is: three labelled groups of dots, then "Step N of 7". The shown step's
  // dot is ringed; a done step's dot is filled and goes back to it; the first step not done
  // brings the person back; a later one waits.
  function progressNav(document, done, shown, go) {
    var nav = el(document, 'nav', { class: 'onboard-progress', 'aria-label': 'Setup progress' });
    var groups = el(document, 'div', { class: 'onboard-groups' });
    GROUPS.forEach(function (name) {
      var members = PANELS.filter(function (p) { return p.group === name; });
      var all = members.every(function (p) { return done[p.id]; });
      var here = members.some(function (p) { return p.id === shown; });
      var group = el(document, 'div', { class: 'onboard-group' + (all ? ' onboard-group-done' : here ? ' onboard-group-current' : '') });
      group.appendChild(el(document, 'span', { class: 'onboard-group-label' }, (all ? '✓ ' : '') + name));
      var row = el(document, 'div', { class: 'onboard-dots' });
      members.forEach(function (panel) {
        var dot = el(document, 'button', { type: 'button', class: 'onboard-dot', 'data-dot': panel.id, 'aria-label': 'Step ' + (PANELS.indexOf(panel) + 1) + ': ' + panel.title });
        if (panel.id === shown) { dot.classList.add('onboard-dot-current'); dot.setAttribute('aria-current', 'step'); }
        else if (done[panel.id]) dot.classList.add('onboard-dot-done');
        dot.disabled = !canVisit(done, panel.id);
        dot.addEventListener('click', function () { go(panel.id); });
        row.appendChild(dot);
      });
      group.appendChild(row);
      groups.appendChild(group);
    });
    nav.appendChild(groups);
    var at = PANELS.map(function (p) { return p.id; }).indexOf(shown) + 1;
    nav.appendChild(el(document, 'p', { class: 'onboard-counter' }, shown ? 'Step ' + at + ' of ' + PANELS.length : 'All ' + PANELS.length + ' steps done'));
    return nav;
  }

  // The shown step: its group, its name, the guide's text for it, and a line on how it moves on.
  function panelBox(document, panel, data, done, ctx) {
    var guide = data.guide;
    var box = el(document, 'article', { class: 'onboard-panel', 'data-panel': panel.id });
    box.appendChild(el(document, 'p', { class: 'onboard-panel-group' }, panel.group));
    box.appendChild(el(document, 'h2', {}, panel.title));
    // The page cannot read the OpenRouter balance (that needs a management key): it says only
    // that OpenRouter accepts the key, and the guide's text says credit is needed.
    if (panel.id === 'model-key' && done['model-key']) box.appendChild(el(document, 'p', { class: 'onboard-connected' }, 'Connected. OpenRouter accepts the key.'));
    panel.steps.forEach(function (id) {
      var step = stepById(guide, id);
      if (!step || step.flows.indexOf('local') < 0 || applies(guide, step.when) === false) return;
      box.appendChild(stepSection(document, step, ctx));
    });
    // Only once ready: a click before then would tick the step for nothing.
    if (panel.confirm && !done[panel.id] && panel.ready(data)) {
      var added = el(document, 'button', { type: 'button', class: 'primary', 'data-confirm': '' }, panel.confirm);
      added.addEventListener('click', function () {
        added.disabled = true;
        ctx.api('/api/step', { method: 'POST', body: { id: panel.id, state: 'done' } })
          .then(function () { return ctx.reload && ctx.reload(); })
          .catch(function () { added.disabled = false; });
      });
      box.appendChild(added);
    }
    var fields = box.querySelector('.bwat-answer, .bwat-secret');
    box.appendChild(el(document, 'p', { class: 'muted small onboard-foot' },
      (fields ? 'Saves when you leave a field or press Enter. ' : '') +
      (panel.confirm ? 'Moves on once it is filled in and you select ' + panel.confirm + '.' : 'Moves on by itself when this step is done.')));
    return box;
  }

  // The step a done dot went back to, until it is cleared or no longer done.
  var viewing = null;
  // Asked once per page: the install, connecting Claude Code, and at the end deleting what
  // setup kept here.
  var installAsked = false;
  var pluginAsked = false;
  var destroyAsked = false;

  function renderPage(root, data, ctx) {
    var original = data;
    var document = root.ownerDocument;
    data = Object.assign({}, data, { state: Object.assign({}, data.state, { flow: 'local' }) });
    var shots = {};
    data.guide.shots.forEach(function (shot) { shots[shot.name] = shot; });
    var done = finished(data, ctx);
    var full = Object.assign({ guide: data.guide, shots: shots, answers: data.answers, flow: 'local', sdkFile: data.sdkFile }, ctx);
    full.refresh = function () {
      return ctx.api('/api/guide').then(function (guide) { applyConditions(root, guide); }).catch(function () {});
    };
    full.recheck = ctx.recheck || full.refresh;
    var keep = keepOpen(root);
    root.textContent = '';
    if (data.problems && data.problems.length) root.appendChild(problemBanner(document, data.guide, data.problems, full));

    var first = firstUndone(done);
    if (viewing && !done[viewing]) viewing = null;
    var shown = first ? viewing || first.id : null;
    function go(id) {
      visit(done, id);
      render(root, original, ctx);
    }
    root.appendChild(progressNav(document, done, shown, go));

    if (!first) {
      document.body.classList.add('onboard-finished');
      root.appendChild(endBox(document, data.guide, full));
      if (!destroyAsked) { destroyAsked = true; ctx.api('/api/destroy', { method: 'POST', body: {} }).catch(function () {}); }
      return keep;
    }
    root.appendChild(panelBox(document, PANELS.filter(function (p) { return p.id === shown; })[0], data, done, full));

    var last = (ctx.runs && ctx.runs.last) || {};
    // Install is the step at hand: setup runs by itself, once, unless it ran already.
    var setup = runOf(data.guide, 'install', 'setup');
    if (first.id === 'install' && setup && !installAsked && !last.setup) {
      installAsked = true;
      ctx.api('/api/run', { method: 'POST', body: { id: setup.id, command: setup.command } }).catch(function () { installAsked = false; });
    }
    // Connecting Claude Code is: the plugin goes in by itself, once, unless it ran already.
    var plugin = runOf(data.guide, 'claude-here', 'plugin');
    if (first.id === 'claude-here' && plugin && !pluginAsked && !last.plugin) {
      pluginAsked = true;
      ctx.api('/api/run', { method: 'POST', body: { id: plugin.id, command: plugin.command } }).catch(function () { pluginAsked = false; });
    }

    var trouble = partBox(document, data.guide, 'troubleshooting', 'details', full);
    if (trouble) root.appendChild(trouble);
    root.appendChild(el(document, 'p', { class: 'muted small onboard-cloud' }))
      .appendChild(el(document, 'a', { href: SERVER_GUIDE, target: '_blank', rel: 'noopener noreferrer' }, 'Installing on a cloud server instead?'));
    return keep;
  }

  // The end: bwat is ready, the Zoom account settings to check before the first meeting, a
  // link to the board, and the rest for whoever wants it.
  function endBox(document, guide, ctx) {
    var box = el(document, 'section', { class: 'onboard-panel onboard-end' });
    box.appendChild(el(document, 'p', { class: 'onboard-panel-group' }, 'All done'));
    box.appendChild(el(document, 'h2', {}, 'bwat is ready'));
    var lead = el(document, 'p', {});
    lead.appendChild(document.createTextNode('Send bwat to a meeting from Claude Code with '));
    lead.appendChild(el(document, 'code', {}, '/bwat:join'));
    lead.appendChild(document.createTextNode(' and a meeting link, then say its name to talk to it. The cards it writes show up on your board. Setup has deleted the files it kept.'));
    box.appendChild(lead);
    var zoom = stepById(guide, 'zoom-account');
    if (zoom) {
      var settings = el(document, 'div', { class: 'onboard-settings' });
      settings.appendChild(el(document, 'h3', {}, 'Before your first meeting, check these in Zoom'));
      settings.appendChild(guideBody(document, zoom.html, ctx));
      box.appendChild(settings);
    }
    var address = ctx.answers.values.BWAT_PUBLIC_URL;
    if (address && /^https?:\/\//.test(address)) {
      box.appendChild(el(document, 'a', { class: 'button primary onboard-board', href: address, target: '_blank', rel: 'noopener noreferrer' }, 'Open the board'));
    }
    var step = stepById(guide, 'first-meeting');
    if (step) {
      var more = el(document, 'details', { class: 'bwat-more' });
      more.appendChild(el(document, 'summary', {}, 'More detail'));
      more.appendChild(el(document, 'h3', {}, step.title));
      var text = guideBody(document, step.html, ctx);
      text.querySelectorAll('.bwat-check').forEach(function (node) { node.remove(); });
      more.appendChild(text);
      box.appendChild(more);
    }
    return box;
  }

  /** Shows each check's result (checks.ts) under the steps that wait for it. */
  function applyChecks(root, results) {
    root.querySelectorAll('.bwat-check').forEach(function (node) {
      var result = results[node.getAttribute('data-check')];
      if (!result) return;
      var line = node.querySelector('p') || node.appendChild(root.ownerDocument.createElement('p'));
      line.className = 'small onboard-check ' + (result.ok ? 'onboard-check-ok' : 'muted');
      line.textContent = (result.ok ? 'Checked: ' : 'Not yet: ') + result.detail;
    });
  }

  // An answer was written elsewhere (the person's other tab, or the server itself). Nothing is
  // redrawn, so a half-typed field, a pending Allow prompt and focus all stay: the named
  // field takes the new value unless it has focus or holds unsaved typing, and the guide's
  // conditions are applied again, since the answer can change which steps apply.
  function refreshAnswer(root, key, ctx) {
    var document = root.ownerDocument;
    var input = document.getElementById('answer-' + key);
    var secret = document.getElementById('secret-' + key);
    var first = secret
      ? ctx.api('/api/secrets').then(function (all) { if (ctx.setSecret) ctx.setSecret(key, all[key] || null); })
      : ctx.api('/api/answers').then(function (answers) {
        var value = answers.values[key];
        if (!input || value === undefined || document.activeElement === input) return;
        if (input.value !== input.getAttribute('data-saved')) return;
        input.value = value;
        input.setAttribute('data-saved', value);
      });
    first.catch(function () {}).then(function () {
      return ctx.api('/api/guide').then(function (guide) { applyConditions(root, guide); });
    }).catch(function () {});
  }

  /**
   * What reaches the page over /api/events besides a command's run: the assistant asking to
   * run a command, which waits for the person's answer, and an answer written elsewhere,
   * which refreshes that field. The page leads: nothing here moves it.
   */
  function applyPageEvent(root, event, ctx) {
    var document = root.ownerDocument;
    if (event.type === 'allow') {
      var ask = el(document, 'section', { class: 'status-box onboard-allow', role: 'alertdialog', 'aria-labelledby': 'allow-' + event.request, 'data-request': event.request });
      ask.appendChild(el(document, 'h3', { id: 'allow-' + event.request }, 'Your assistant asks to run a command'));
      var pre = el(document, 'pre', { class: 'onboard-output' });
      pre.textContent = event.command;
      ask.appendChild(pre);
      var yes = el(document, 'button', { type: 'button', class: 'primary', 'data-allow': 'yes' }, 'Allow');
      var no = el(document, 'button', { type: 'button', 'data-allow': 'no' }, 'Don\'t allow');
      function answer(allow) {
        yes.disabled = true;
        no.disabled = true;
        ctx.api('/api/allow', { method: 'POST', body: { request: event.request, allow: allow } }).catch(function () {}).then(function () { ask.remove(); });
      }
      yes.addEventListener('click', function () { answer(true); });
      no.addEventListener('click', function () { answer(false); });
      ask.appendChild(yes);
      ask.appendChild(no);
      root.insertBefore(ask, root.firstChild);
      yes.focus();
    } else if (event.type === 'answer') {
      refreshAnswer(root, event.key, ctx);
    } else if (event.type === 'allowed') {
      var open = root.querySelector('[data-request="' + event.request + '"]');
      if (open) open.remove();
    }
  }

  window.bwatOnboard = { render: render, stepsOf: stepsOf, applyRunEvent: applyRunEvent, applyChecks: applyChecks, applyPageEvent: applyPageEvent, connection: connection };
})();
