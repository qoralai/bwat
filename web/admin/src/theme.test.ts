// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { followBoardTheme } from './theme';

/* The admin panel follows the board's Appearance choice: same origin, same stored key. */

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('followBoardTheme', () => {
  it.each(['light', 'dark'])('takes %s when the board was set to it', (choice) => {
    localStorage.setItem('bwat.theme', choice);
    followBoardTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe(choice);
  });

  it('leaves the theme to the device when the board follows the device', () => {
    followBoardTheme();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
