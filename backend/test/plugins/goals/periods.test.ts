import { describe, expect, it } from 'vitest';
import { dayIn, isTimezone, nextPeriodStart, periodOf } from '../../../src/plugins/goals/periods.ts';

// QOR-4921: a goal list's periods, for each cadence.
describe('goal periods (QOR-4921)', () => {
  const ANCHOR = '2024-01-01';

  it('a week runs Monday to Monday', () => {
    expect(periodOf('2026-10-21', 'week', ANCHOR)).toEqual({ start: '2026-10-19', end: '2026-10-26' });
    expect(periodOf('2026-10-19', 'week', ANCHOR)).toEqual({ start: '2026-10-19', end: '2026-10-26' });
    expect(periodOf('2026-10-25', 'week', ANCHOR).start).toBe('2026-10-19');
  });

  it('two weeks count from the anchor, before it too', () => {
    // 2024-01-01 starts one; 2026-10-19 is 146 weeks on: an even count, so it starts one as well
    expect(periodOf('2026-10-21', '2weeks', ANCHOR)).toEqual({ start: '2026-10-19', end: '2026-11-02' });
    expect(periodOf('2026-10-28', '2weeks', ANCHOR).start).toBe('2026-10-19');
    expect(periodOf('2026-10-28', '2weeks', '2024-01-08').start).toBe('2026-10-26');
    expect(periodOf('2023-12-27', '2weeks', ANCHOR).start).toBe('2023-12-18');
  });

  it('a month starts on the 1st; a quarter on 1 Jan, Apr, Jul or Oct', () => {
    expect(periodOf('2026-10-21', 'month', ANCHOR)).toEqual({ start: '2026-10-01', end: '2026-11-01' });
    expect(nextPeriodStart('2026-12-01', 'month')).toBe('2027-01-01');
    expect(periodOf('2026-11-30', 'quarter', ANCHOR)).toEqual({ start: '2026-10-01', end: '2027-01-01' });
    expect(periodOf('2026-03-31', 'quarter', ANCHOR)).toEqual({ start: '2026-01-01', end: '2026-04-01' });
  });

  it("today is the day in the list's timezone", () => {
    const instant = Date.UTC(2026, 9, 19, 3, 0); // Monday 03:00 UTC: still Sunday in New York
    expect(dayIn(instant, 'America/New_York')).toBe('2026-10-18');
    expect(dayIn(instant, 'Europe/Berlin')).toBe('2026-10-19');
  });

  it('knows a timezone from anything else', () => {
    expect(isTimezone('America/New_York')).toBe(true);
    expect(isTimezone('Mars/Olympus')).toBe(false);
    expect(isTimezone('')).toBe(false);
    expect(isTimezone(7)).toBe(false);
  });
});
