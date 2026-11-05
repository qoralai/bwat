// "3 days ago", "yesterday", "45 minutes ago". Built on Intl, no library.
const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** An age in the largest whole unit from minutes up, or null under a minute. */
function largeUnit(seconds: number): string | null {
  for (const [unit, size] of units) {
    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  }
  return null;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  return largeUnit(Math.max(0, (now - Date.parse(iso)) / 1000)) ?? 'just now';
}

/** Like relativeTime, but counts seconds under a minute: a heartbeat 46 s old is not "just now". */
export function secondsAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return largeUnit(s) ?? format.format(s === 0 ? 0 : -s, 'second');
}
