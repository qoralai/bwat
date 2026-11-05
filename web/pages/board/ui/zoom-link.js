// The script of the page inside Zoom that asks to link the person's account (server/src/auth/
// routes.ts linkPage), after ui/link.js: a file, not inline, so the Content-Security-Policy runs
// no script written into a page. The sign-in address is the Sign in button's data-url.
'use strict';
(function () {
  const open = document.getElementById('open');
  open.addEventListener('click', () => window.bwatLink.openInBrowser(open.dataset.url));
  window.bwatLink.pairForm(document.querySelector('form'), document.querySelector('[role=status]'), (u, init) => fetch(u, init));
})();
