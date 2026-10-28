import { addDays, type CalendarDate } from "./date";
import type { FiscalYearContext } from "./types";

type PeriodBounds = Pick<FiscalYearContext, "startDate" | "endDate">;

export function isWithinFiscalYear(date: CalendarDate, fiscalYear: PeriodBounds): boolean {
  return date >= fiscalYear.startDate && date <= fiscalYear.endDate;
}

/** True when the date is on or before the monthly close (`lockedThrough`). */
export function isLocked(
  date: CalendarDate,
  fiscalYear: Pick<FiscalYearContext, "lockedThrough">,
): boolean {
  return fiscalYear.lockedThrough !== null && date <= fiscalYear.lockedThrough;
}

/**
 * The first date that can still be posted to in the fiscal year, or `null` when none is left.
 * Corrections of entries in a closed month are dated here (01-domain-model §3).
 */
export function firstOpenDate(
  fiscalYear: Pick<FiscalYearContext, "startDate" | "endDate" | "lockedThrough" | "status">,
): CalendarDate | null {
  if (fiscalYear.status === "closed") return null;
  const candidate =
    fiscalYear.lockedThrough !== null && fiscalYear.lockedThrough >= fiscalYear.startDate
      ? addDays(fiscalYear.lockedThrough, 1)
      : fiscalYear.startDate;
  return candidate > fiscalYear.endDate ? null : candidate;
}
