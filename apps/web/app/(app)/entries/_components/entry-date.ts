import type { EntryFormFiscalYear } from "@niho-finance/db";
import { daysBetween, firstOpenDate, type CalendarDate } from "@niho-finance/ledger";

type YearRange = Pick<EntryFormFiscalYear, "status" | "startDate" | "endDate" | "lockedThrough">;

/**
 * The date a new entry starts on (11 §4.6). Each open fiscal year takes entries from the day after
 * its close (or its start) to its end. Today when it falls in one of those ranges; otherwise the end
 * of a range nearest to today (before the founding: the first start; in a closed month: the first
 * open day; after the end: the last day), the earlier one on a tie. Today when nothing is open (the
 * server then refuses the entry and says why).
 */
export function defaultEntryDate(
  today: CalendarDate,
  fiscalYears: readonly YearRange[],
): CalendarDate {
  const ranges = fiscalYears.flatMap((year) => {
    if (year.status !== "open") return [];
    const start = firstOpenDate(year);
    return start ? [{ start, end: year.endDate }] : [];
  });
  if (ranges.length === 0) return today;
  if (ranges.some((range) => range.start <= today && today <= range.end)) return today;
  let best: { date: CalendarDate; distance: number } | null = null;
  for (const date of ranges.flatMap((range) => [range.start, range.end])) {
    const distance = Math.abs(daysBetween(today, date));
    if (!best || distance < best.distance || (distance === best.distance && date < best.date)) {
      best = { date, distance };
    }
  }
  return best?.date ?? today;
}
