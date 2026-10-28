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
