// Light / dark theme for the meeting desk.
// Loaded synchronously in <head> so the stored theme is set before first paint.
// No stored choice follows the system setting. The choice is made in the
// Settings drawer (settings.js); the header's own toggle is gone
// (9/29: "we have that option now in the settings").
(function () {
  var KEY = 'bwat.theme';
  var root = document.documentElement;
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function system() { return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  function apply(theme) { root.setAttribute('data-theme', theme); }
  apply(stored() || system());
  // The settings drawer's three-way choice; 'system' clears the stored one.
  window.BWAT_THEME = {
    choice: function () { return stored() || 'system'; },
    set: function (choice) {
      try { if (choice === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch (e) { /* this page only */ }
      apply(choice === 'system' ? system() : choice);
    }
  };
  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (!stored()) apply(system());
    });
  }
})();
