// Linking a Zoom user no member holds yet, one copy for the two places that ask: the board
// (bwat-api.js askToLink) and the page the server shows inside Zoom in its place
// (server/src/auth/routes.ts linkPage, ui/zoom-link.js). Loaded before either.
'use strict';
window.bwatLink = (() => {
  // The Zoom Apps SDK's script is added once, page-wide, and answers when it has loaded or failed
  // (at once while the SDK is already there). A failed load is forgotten, so the next caller tries again.
  let sdkLoad = null;
  function loadZoomSdk() {
    if (window.zoomSdk) return Promise.resolve();
    if (!sdkLoad) sdkLoad = new Promise((resolve) => {
      const tag = document.createElement('script');
      tag.src = 'https://appssdk.zoom.us/sdk.min.js';
      tag.async = true;
      tag.onload = () => resolve();
      tag.onerror = () => { sdkLoad = null; tag.remove(); resolve(); };
      document.head.appendChild(tag);
    });
    return sdkLoad;
  }

  return Object.freeze({
    loadZoomSdk,
    // Zoom's openUrl opens the system browser; anywhere else (or if Zoom says no), a new tab.
    openInBrowser(url) {
      const fallback = () => window.open(url, '_blank', 'noopener');
      void loadZoomSdk().then(() => {
        const sdk = window.zoomSdk;
        if (!sdk || !sdk.config) { fallback(); return; }
        sdk.config({ capabilities: ['openUrl'] }).then(() => sdk.openUrl({ url })).catch(fallback);
      });
    },
    // The code form: the code typed in goes to /auth/zoom-pair through `post` (a fetch); linked,
    // the page reloads, signed in; otherwise `status` says why.
    pairForm(form, status, post) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = form.querySelector('input').value.trim();
        if (!code) return;
        status.textContent = 'Linking…';
        const r = await post('/auth/zoom-pair', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ code }),
        }).catch(() => null);
        if (r && r.ok) { location.reload(); return; }
        status.textContent = r && r.status === 400 ? "That code didn't work. Check it and try again; after five tries, close bwat and open it again."
          : r && r.status === 401 ? 'Close bwat and open it again, then sign in once more.'
          : 'bwat could not link just now. Try again.';
      });
    },
  });
})();
