import { describe, expect, it } from 'vitest';
import { relativeTime, secondsAgo } from './relativeTime';

const now = Date.parse('2026-09-30T12:00:00.000Z');
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

describe('relativeTime', () => {
  it.each([
    [ago(20), 'just now'],
    [ago(60), '1 minute ago'],
    [ago(2 * 3600), '2 hours ago'],
    [ago(26 * 3600), 'yesterday'],
    [ago(10 * 86400), 'last week'],
    [ago(20 * 86400), '2 weeks ago'],
    [ago(65 * 86400), '2 months ago'],
    [ago(800 * 86400), '2 years ago'],
    [new Date(now + 90_000).toISOString(), 'just now'],
  ])('%s -> %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});

describe('secondsAgo', () => {
  it.each([
    [0, 'now'],
    [1, '1 second ago'],
    [12, '12 seconds ago'],
    [46, '46 seconds ago'],
    [59, '59 seconds ago'],
    [200, '3 minutes ago'],
    [2 * 3600, '2 hours ago'],
  ])('%s s -> %s', (seconds, expected) => {
    expect(secondsAgo(seconds)).toBe(expected);
  });
});
