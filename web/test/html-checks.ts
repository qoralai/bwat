import { afterEach, expect } from 'vitest';
import { violations } from './inline-script.ts';

// Set up for every test file (vitest.config.ts): a page rendered with an inline script, found by
// appFor's check or the route walk (csp.test.ts), fails the test that rendered it.
afterEach(() => {
  expect(violations.splice(0), 'pages that need an inline script').toEqual([]);
});
