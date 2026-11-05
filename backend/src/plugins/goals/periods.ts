/**
 * A goal list's periods (QOR-4921). Dates are YYYY-MM-DD calendar days; "today" is the day in
 * the list's timezone, decided by the server's clock. A period is [start, next start).
 */

export const CADENCES = ['week', '2weeks', 'month', 'quarter'] as const;
export type Cadence = (typeof CADENCES)[number];

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A YYYY-MM-DD date as UTC midnight, or NaN when it is not a real calendar date. */
function utcDay(date: string): number {
  const m = ISO_DATE.exec(date);
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = Date.UTC(y, mo - 1, d);
  const back = new Date(at);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? at : NaN;
}

const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Whether this is a real YYYY-MM-DD calendar date. */
export const isIsoDate = (date: string): boolean => !Number.isNaN(utcDay(date));

/** The date `days` calendar days from `date`. */
export const addDays = (date: string, days: number): string => isoOf(utcDay(date) + days * DAY_MS);

/** Whether the date is a Monday. */
export const isMonday = (date: string): boolean => new Date(utcDay(date)).getUTCDay() === 1;

/** Whether the runtime knows this IANA timezone. */
export function isTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day holding this instant in `timezone`. */
export function dayIn(instant: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The Monday of the week holding this date. */
const mondayOf = (date: string): string => addDays(date, -((new Date(utcDay(date)).getUTCDay() + 6) % 7));

/** The first day of the period holding `date`. `anchor` (a Monday) places 2-week periods. */
export function periodStart(date: string, cadence: Cadence, anchor: string): string {
  const d = new Date(utcDay(date));
  switch (cadence) {
    case 'week':
      return mondayOf(date);
    case '2weeks': {
      const weeks = Math.floor((utcDay(mondayOf(date)) - utcDay(anchor)) / (7 * DAY_MS));
      return addDays(mondayOf(date), -7 * (((weeks % 2) + 2) % 2));
    }
    case 'month':
      return isoOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    case 'quarter':
      return isoOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (d.getUTCMonth() % 3), 1));
  }
}

/** The first day of the period after the one starting on `start`. */
export function nextPeriodStart(start: string, cadence: Cadence): string {
  const d = new Date(utcDay(start));
  switch (cadence) {
    case 'week':
      return addDays(start, 7);
    case '2weeks':
      return addDays(start, 14);
    case 'month':
      return isoOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    case 'quarter':
      return isoOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1));
  }
}

/** A period: its first day and the first day after it. */
export interface Period {
  start: string;
  end: string;
}

/** The period holding `date`. */
export function periodOf(date: string, cadence: Cadence, anchor: string): Period {
  const start = periodStart(date, cadence, anchor);
  return { start, end: nextPeriodStart(start, cadence) };
}
