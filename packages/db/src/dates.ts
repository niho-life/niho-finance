import { isCalendarDate, type CalendarDate } from "@niho-finance/ledger";

/** Calendar date → value for a `@db.Date` column (UTC midnight; Postgres keeps only the date). */
export function toDbDate(date: CalendarDate): Date {
  if (!isCalendarDate(date)) throw new RangeError(`"${String(date)}" is not a valid calendar date`);
  return new Date(`${date}T00:00:00.000Z`);
}

/** `@db.Date` column value → calendar date. */
export function fromDbDate(date: Date): CalendarDate {
  return date.toISOString().slice(0, 10) as CalendarDate;
}

/** Nullable `@db.Date` column value → calendar date or `null`. */
export function fromDbDateOrNull(date: Date | null): CalendarDate | null {
  return date === null ? null : fromDbDate(date);
}

const JAPAN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date in Japan (JST): accounting dates are JST calendar days (01-domain-model §9). */
export function todayInJapan(now: Date = new Date()): CalendarDate {
  return JAPAN_DATE.format(now) as CalendarDate;
}
