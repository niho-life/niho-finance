/**
 * A calendar date (JST) as `YYYY-MM-DD`. Accounting dates never carry a time of day.
 * Lexicographic order of this format equals chronological order.
 */
export type CalendarDate = `${number}-${number}-${number}`;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function splitDate(value: string): [year: number, month: number, day: number] | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return null;
  return [Number(year), Number(month), Number(day)];
}

export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string") return false;
  const parts = splitDate(value);
  if (!parts) return false;
  const [year, month, day] = parts;
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function parseCalendarDate(value: string): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new RangeError(`"${value}" is not a valid calendar date (YYYY-MM-DD)`);
  }
  return value;
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function formatUtcDate(date: Date): CalendarDate {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}` as CalendarDate;
}

/** Adds (or subtracts, when negative) whole days. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  if (!Number.isSafeInteger(days)) throw new RangeError(`addDays: ${days} is not an integer`);
  const parts = splitDate(date);
  if (!parts || !isCalendarDate(date))
    throw new RangeError(`addDays: "${date}" is not a valid date`);
  const [year, month, day] = parts;
  return formatUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

/** Number of days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const a = splitDate(from);
  const b = splitDate(to);
  if (!a || !b) throw new RangeError(`daysBetween: invalid date "${from}" or "${to}"`);
  const msPerDay = 86_400_000;
  return (Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / msPerDay;
}
