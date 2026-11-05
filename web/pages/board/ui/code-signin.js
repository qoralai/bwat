// The install-code sign-in page's script (server/src/auth/routes.ts codePage): a file, not
// inline, so the Content-Security-Policy runs no script written into a page. The page to go
// back to is the form's data-back.
'use strict';
(function () {
  const form = document.querySelector('form'), status = document.querySelector('[role=status]'), button = form.querySelector('button');
  const back = form.dataset.back || '/';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('code').value.trim(), email = document.getElementById('email').value.trim();
    if (!code || !email) { status.textContent = 'Type the code and your email.'; return; }
    button.disabled = true;
    status.textContent = 'Signing in…';
    const r = await fetch('/auth/code', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ code, email, back }) }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (r && r.ok) { location.replace(body.next || '/'); return; }
    button.disabled = false;
    status.textContent = r && r.status === 401 ? "That code didn't work. Check it against what ./bwat setup showed."
      : r && r.status === 400 ? 'That email does not look right.'
      : r && r.status === 403 ? 'An admin removed this email. Ask them to invite you again.'
      : r && r.status === 429 ? 'Too many wrong codes. Wait a minute, then try again.'
      : 'bwat could not sign you in just now. Try again.';
  });
})();
