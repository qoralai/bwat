// How bwat shows a secret: one * per hidden character, and the last 4 characters only
// when at least 12 stay hidden before them and the field does not have focus. The same
// rule as setup/onboard/secrets.ts; both are tested against setup/onboard/test/mask-cases.json.
(function (root) {
  'use strict';
  function parts(value) {
    return value.length - 4 >= 12 ? { hidden: value.length - 4, last4: value.slice(-4) } : { hidden: value.length, last4: null };
  }
  function show(p, focused) {
    var stars = new Array(p.hidden + 1).join('*');
    if (!p.last4) return stars;
    return focused ? stars + '****' : stars + p.last4;
  }
  root.bwatMask = { parts: parts, show: show };
})(typeof window !== 'undefined' ? window : globalThis);
