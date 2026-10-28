import { dateParts, type CalendarDate } from "@niho-finance/ledger";

/** JST is UTC+9 all year (no daylight saving). */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * The JST month of `today` as instants, `from <= at < to` (今月の読み取り, 20-reader §9): from the
 * 1st 00:00 JST to the next month's 1st 00:00 JST.
 */
export function japanMonthRange(today: CalendarDate): { from: Date; to: Date } {
  const { year, month } = dateParts(today);
  return {
    from: new Date(Date.UTC(year, month - 1, 1) - JST_OFFSET_MS),
    to: new Date(Date.UTC(year, month, 1) - JST_OFFSET_MS),
  };
}
