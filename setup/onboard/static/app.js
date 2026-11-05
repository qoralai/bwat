// The onboarding page's entry. The token arrives in the link's fragment, which the browser
// never sends to a server; the page keeps it in memory and sends it in a header.
(function () {
  'use strict';
  var token = location.hash.slice(1);
  var status = document.getElementById('status');
  var steps = document.getElementById('steps');

  function api(path, init) {
    init = init || {};
    var headers = { authorization: 'Bearer ' + token };
    var options = { method: init.method || 'GET', headers: headers };
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      options.body = JSON.stringify(init.body);
    }
    return fetch(path, options).then(function (res) {
      return res.json().then(function (reply) {
        if (!res.ok) throw new Error(reply.error || path + ': ' + res.status);
        return reply;
      });
    });
  }

  // A file sent as it is, with its progress: XHR, since fetch reports no upload progress.
  function upload(path, name, file, onProgress) {
    return new Promise(function (done, fail) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.setRequestHeader('authorization', 'Bearer ' + token);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('x-sdk-name', name);
      xhr.upload.onprogress = function (event) { if (event.lengthComputable) onProgress(event.loaded / event.total); };
      xhr.onload = function () {
        var reply = {};
        try { reply = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) done(reply);
        else fail(new Error(reply.error || 'The file was not taken (' + xhr.status + ').'));
      };
      xhr.onerror = function () { fail(new Error('The file did not arrive: is the setup server still running?')); };
      xhr.send(file);
    });
  }

  // Once per page: the vendors' pages open in a new tab, best kept beside this one.
  var hinted = false;
  function splitHint() {
    if (hinted) return;
    hinted = true;
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.textContent = 'Tip: put the new tab beside this one (split view or a second window) to follow along.';
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'OK';
    close.addEventListener('click', function () { toast.remove(); });
    toast.appendChild(close);
    document.body.appendChild(toast);
  }

  // Sent once, in the request body; the reply is the mask's parts only.
  function saveSecret(key, value) {
    return api('/api/secret', { method: 'POST', body: { key: key, value: value } }).then(function (reply) {
      check(true);
      return { hidden: reply.hidden, last4: reply.last4 };
    });
  }

  // The secret fields by key, so an answer event can show a new mask in place.
  var secretWraps = {};
  function setSecret(key, status) {
    if (secretWraps[key]) secretWraps[key].bwatSetStatus(status);
  }

  // The runner's events, read with fetch: EventSource cannot send the token's header.
  var runs = { panels: {}, last: {} };
  function listen() {
    fetch('/api/events', { headers: { authorization: 'Bearer ' + token } }).then(function (res) {
      if (!res.ok) throw new Error('refused');
      window.bwatOnboard.connection(document, true);
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) throw new Error('closed');
          buffer += decoder.decode(chunk.value, { stream: true });
          var parts = buffer.split('\n\n');
          buffer = parts.pop();
          parts.forEach(function (part) {
            if (part.indexOf('data: ') !== 0) return;
            var event = JSON.parse(part.slice(6));
            window.bwatOnboard.applyRunEvent(runs.panels, event);
            window.bwatOnboard.applyPageEvent(steps, event, { api: api, reload: reload, setSecret: setSecret });
            // A finished command may have made a check pass: look now, not at the next round,
            // and redraw once for both.
            if (event.type === 'exit') check(true);
          });
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      // The stream ended or never opened: the server stopped (setup delight FR-9).
      window.bwatOnboard.connection(document, false);
      setTimeout(listen, 2000);
    });
  }

  // The last checks' results and the preflight's problems, which the cards are drawn from.
  var lastResults = null;
  var problems = [];
  function reload() {
    return Promise.all([api('/api/guide'), api('/api/state'), api('/api/answers'), api('/api/secrets'), api('/api/runs'), api('/api/sdk')]).then(function (all) {
      runs.panels = {};
      runs.last = {};
      all[4].runs.forEach(function (run) { runs.last[run.id] = run; });
      status.textContent = 'Connected to the setup server on this computer. Your progress is saved there.';
      var secrets = all[3];
      window.bwatOnboard.render(steps, { guide: all[0], state: all[1], answers: all[2], secrets: secrets, sdkFile: all[5].file, checks: lastResults, problems: problems }, {
        api: api, upload: upload, reload: reload, splitHint: splitHint, runs: runs, recheck: function () { return check(true); },
        // A secret field already on the page is kept as it is, so a redraw (the checks, a
        // command's end) does not lose a secret the person has pasted but not saved.
        secretField: function (key) {
          var wrap = secretWraps[key];
          if (wrap) wrap.bwatSetStatus(secrets[key] || null);
          else {
            wrap = window.bwatSecretField.create(document, key, secrets[key] || null, saveSecret);
            secretWraps[key] = wrap;
          }
          return wrap;
        },
      });
    });
  }

  // The checks tick steps on the server; a changed result (or redraw) redraws the page.
  // One round at a time: a slow round (docker exec) never stacks another behind it.
  var lastChecks = '';
  var missed = 0;
  var checking = null;
  var lastRound = 0;
  function check(redraw) {
    if (checking) return redraw ? checking.then(reload) : checking;
    // A tab in the background checks once a minute, not never: an assistant may be moving it
    // on while the person looks at another tab.
    if (document.visibilityState === 'hidden' && Date.now() - lastRound < 60000) return redraw ? reload() : Promise.resolve();
    lastRound = Date.now();
    checking = api('/api/checks').then(function (results) {
      missed = 0;
      window.bwatOnboard.connection(document, true);
      var seen = JSON.stringify(results);
      var changed = seen !== lastChecks;
      lastResults = results;
      lastChecks = seen;
      return (changed || redraw ? reload() : Promise.resolve()).then(function () { window.bwatOnboard.applyChecks(steps, results); });
    }).catch(function () {
      // Two missed rounds in a row: the server is gone, not just slow (FR-9).
      if (++missed >= 2) window.bwatOnboard.connection(document, false);
    }).then(function () { checking = null; });
    return checking;
  }

  api('/api/preflight').then(function (reply) { problems = reply.problems; if (problems.length) reload(); }, function () {});
  reload().then(function () {
    listen();
    check();
    setInterval(function () { check(); }, 15000);
    // Back from Google or Zoom in another tab: check at once.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') check();
    });
  }).catch(function () {
    status.textContent = 'Open this page with the link the setup command printed, including the part after #.';
  });
})();
