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

/** `2026-11-02` → `2026/11/02`, the date style of the screens and of owner-facing messages. */
export function displayDate(date: CalendarDate): string {
  return date.replaceAll("-", "/");
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

/** Year, month (1–12) and day of a valid calendar date. */
export function dateParts(date: CalendarDate): { year: number; month: number; day: number } {
  const parts = splitDate(date);
  if (!parts || !isCalendarDate(date)) throw new RangeError(`"${date}" is not a valid date`);
  const [year, month, day] = parts;
  return { year, month, day };
}

/** The last day of a month, e.g. `(2028, 2)` → `"2028-02-29"`. */
export function lastDayOfMonth(year: number, month: number): CalendarDate {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999) {
    throw new RangeError(`lastDayOfMonth: ${year} is not a valid year`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`lastDayOfMonth: ${month} is not a valid month`);
  }
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(daysInMonth(year, month)).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}` as CalendarDate;
}

export function isLastDayOfMonth(date: CalendarDate): boolean {
  const { year, month } = dateParts(date);
  return lastDayOfMonth(year, month) === date;
}

/** Number of days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const a = splitDate(from);
  const b = splitDate(to);
  if (!a || !b) throw new RangeError(`daysBetween: invalid date "${from}" or "${to}"`);
  const msPerDay = 86_400_000;
  return (Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / msPerDay;
}
