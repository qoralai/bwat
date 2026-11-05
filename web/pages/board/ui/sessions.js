// Keep the "Send to Claude" session list current.
// The overlay fetches /sessions when it opens (study.js openSendDialog); while
// it stays open, refetch every 15s and repaint its list (keeping focus on the
// same session) so a router started meanwhile is offered and the "last seen"
// ages stay honest. Closed, nothing is polled.
(function () {
  const EVERY_MS = 15000;
  let inFlight = false;
  async function tick() {
    const dlg = document.getElementById('send-dialog');
    if (inFlight || document.hidden || !viewer || !dlg || !dlg.open) return;
    inFlight = true;
    try {
      await LIVE.fetchSessions();
      paintSendDialog();
    } catch { /* the next tick retries; the overlay keeps its last list */ }
    finally { inFlight = false; }
  }
  setInterval(tick, EVERY_MS);
})();
