import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { maskParts, masked } from '../secrets.ts';

type Case = { value: string; parts: { hidden: number; last4: string | null }; unfocused: string; focused: string };
const cases = JSON.parse(readFileSync(new URL('./mask-cases.json', import.meta.url), 'utf8')) as Case[];

// The page's copy of the rule, a classic script, run as the browser would.
const page = (() => {
  const context: { bwatMask?: { parts: (v: string) => Case['parts']; show: (p: Case['parts'], focused: boolean) => string } } = {};
  runInNewContext(readFileSync(new URL('../static/mask.js', import.meta.url), 'utf8'), { globalThis: context, window: context });
  return context.bwatMask!;
})();

describe('the mask rule', () => {
  it('the server and the page give every case the same parts and the same look', () => {
    for (const c of cases) {
      assert.deepEqual(maskParts(c.value), c.parts, c.value);
      assert.deepEqual({ ...page.parts(c.value) }, c.parts, c.value);
      assert.equal(masked(c.value), c.unfocused, c.value);
      assert.equal(page.show(c.parts, false), c.unfocused, c.value);
      assert.equal(page.show(c.parts, true), c.focused, c.value);
    }
  });

  it('shows the last 4 from 16 characters, so at least 12 stay hidden', () => {
    assert.deepEqual(maskParts('a'.repeat(15)), { hidden: 15, last4: null });
    assert.deepEqual(maskParts('a'.repeat(12) + 'wxyz'), { hidden: 12, last4: 'wxyz' });
  });

  it('never shows a prefix, and shows only asterisks while focused', () => {
    const value = 'GOCSPX-' + 'q'.repeat(24) + 'a1b2';
    assert.equal(masked(value), '*'.repeat(31) + 'a1b2');
    assert.equal(page.show(page.parts(value), true), '*'.repeat(35));
  });
});
