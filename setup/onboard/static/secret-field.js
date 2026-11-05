// The secret field: a real <input type="password"> whose value is never allowed to change.
// A password input keeps macOS Secure Event Input and screen readers' protection; an empty
// one gives autofill, password managers, form restore and the back-forward cache nothing
// to keep. The characters live in one variable here, are sent to the server once when the
// person leaves the field or presses Enter, and are then dropped. What shows is the mask (mask.js), drawn over the input.
//
// Keys: a key that produces a character (space included) appends it; Backspace clears
// the whole field; Tab moves focus; the paste shortcuts paste; every other key does
// nothing. A paste appends its text without line breaks.
(function () {
  'use strict';

  function isPasteShortcut(e) {
    var key = e.key.toLowerCase();
    return ((e.ctrlKey || e.metaKey) && key === 'v') || (e.shiftKey && e.key === 'Insert');
  }

  // AltGr arrives as Ctrl+Alt on Windows; its symbols still count as characters.
  function producesCharacter(e) {
    if (e.key.length !== 1) return false;
    var altGraph = e.getModifierState && e.getModifierState('AltGraph');
    return altGraph || !(e.ctrlKey || e.metaKey);
  }

  /**
   * Builds the field for key. status is the server's mask of the saved value, or null;
   * save(key, value) resolves with the new mask's parts.
   */
  function create(document, key, status, save) {
    var mask = document.defaultView.bwatMask;
    var value = '';
    var saved = status && status.set ? { hidden: status.hidden, last4: status.last4 } : null;
    var focused = false;
    var sending = false; // a save is on its way

    var wrap = document.createElement('div');
    wrap.className = 'onboard-field onboard-secret';
    var id = 'secret-' + key;
    var label = document.createElement('label');
    label.className = 'field-label';
    label.setAttribute('for', id);
    // The guide says 🔒 marks a secret; screen readers read the key, not the mark.
    var lock = document.createElement('span');
    lock.setAttribute('aria-hidden', 'true');
    lock.textContent = '🔒 ';
    label.appendChild(lock);
    label.appendChild(document.createTextNode(key));
    var row = document.createElement('div');
    row.className = 'onboard-field-row';
    var box = document.createElement('div');
    box.className = 'onboard-secret-box';
    var input = document.createElement('input');
    input.id = id;
    input.type = 'password';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('data-1p-ignore', '');
    input.setAttribute('data-lpignore', 'true');
    input.setAttribute('data-bwignore', '');
    var shown = document.createElement('output');
    shown.id = id + '-mask';
    shown.className = 'onboard-secret-mask';
    shown.setAttribute('aria-live', 'polite');
    input.setAttribute('aria-describedby', shown.id);
    var note = document.createElement('p');
    note.className = 'draft-status';
    note.setAttribute('aria-live', 'polite');

    // Just after a save, the mask is drawn once as its asterisks and its last four, so
    // onboard.css can let them arrive; the text is the same either way.
    var arriving = false;
    function arrive() {
      var stars = document.createElement('span');
      stars.className = 'onboard-mask-stars';
      stars.textContent = mask.show({ hidden: saved.hidden, last4: null }, false);
      shown.textContent = '';
      shown.appendChild(stars);
      if (saved.last4) {
        var four = document.createElement('span');
        four.className = 'onboard-mask-four';
        four.textContent = saved.last4;
        shown.appendChild(four);
      }
      shown.appendChild(document.createTextNode('  saved'));
    }

    function draw() {
      input.value = '';
      shown.classList.toggle('onboard-mask-arrive', arriving && !value && !focused);
      if (value) shown.textContent = mask.show(mask.parts(value), focused);
      else if (saved && arriving && !focused) arrive();
      else if (saved) shown.textContent = mask.show(saved, focused) + (focused ? '' : '  saved');
      else shown.textContent = focused ? '' : 'Paste or type the secret';
      arriving = false;
      shown.classList.toggle('muted', !value);
    }

    function add(text) {
      value += text;
      note.textContent = '';
      draw();
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') return;
      if (e.key === 'Enter') { e.preventDefault(); if (value) send(); return; }
      if (isPasteShortcut(e)) return;
      e.preventDefault();
      if (e.key === 'Backspace') { value = ''; draw(); return; }
      if (producesCharacter(e)) add(e.key);
    });
    input.addEventListener('paste', function (e) {
      e.preventDefault();
      var text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      add(text.replace(/[\r\n]/g, ''));
    });
    // Whatever reaches the value another way (autofill, a dead key, an input method) is dropped.
    input.addEventListener('input', function () { input.value = ''; });
    ['drop', 'dragover', 'cut', 'copy'].forEach(function (name) {
      input.addEventListener(name, function (e) { e.preventDefault(); });
    });
    input.addEventListener('focus', function () { focused = true; draw(); });
    // Saves itself when the person leaves the field or presses Enter.
    input.addEventListener('blur', function () { focused = false; if (value) send(); else draw(); });

    function drop() { value = ''; draw(); }
    document.defaultView.addEventListener('pagehide', drop);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') drop(); });

    function send() {
      if (!value || sending) return;
      var text = value;
      value = '';
      sending = true;
      note.textContent = 'Saving…';
      draw();
      save(key, text).then(function (parts) {
        saved = parts;
        sending = false;
        note.textContent = 'Saved.';
        arriving = true;
        draw();
      }, function (error) {
        sending = false;
        note.textContent = error.message;
        draw();
      });
      text = '';
    }

    box.appendChild(input);
    box.appendChild(shown);
    row.appendChild(box);
    wrap.appendChild(label);
    wrap.appendChild(row);
    wrap.appendChild(note);
    // The server's mask changed elsewhere (the assistant asked, the person saved in another tab).
    wrap.bwatSetStatus = function (next) {
      saved = next && next.set ? { hidden: next.hidden, last4: next.last4 } : null;
      draw();
    };
    draw();
    return wrap;
  }

  window.bwatSecretField = { create: create };
})();
