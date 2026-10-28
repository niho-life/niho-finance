import {
  addDays,
  dateParts,
  isCalendarDate,
  isLastDayOfMonth,
  lastDayOfMonth,
  type CalendarDate,
} from "./date";

/** A fiscal year's dates (both inclusive). */
export interface FiscalYearPeriod {
  startDate: CalendarDate;
  endDate: CalendarDate;
}

export function isMonthNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12;
}

function assertMonth(month: number, what: string): void {
  if (!isMonthNumber(month)) {
    throw new RangeError(`${what}: ${String(month)} is not a month (1–12)`);
  }
}

/** 決算月 from the first month of the fiscal year, e.g. 4 → 3. */
export function fiscalYearEndMonthFromStartMonth(startMonth: number): number {
  assertMonth(startMonth, "fiscalYearEndMonthFromStartMonth");
  return ((startMonth + 10) % 12) + 1;
}

/** First month of the fiscal year from 決算月, e.g. 3 → 4. */
export function fiscalYearStartMonthFromEndMonth(endMonth: number): number {
  assertMonth(endMonth, "fiscalYearStartMonthFromEndMonth");
  return (endMonth % 12) + 1;
}

/**
 * The first fiscal year: from the founding date to the end of the next 決算月
 * (the founding month itself when it is the 決算月, e.g. founded 03-15 with 決算月 3 → 03-31).
 */
export function deriveFirstFiscalYear(
  foundedOn: CalendarDate,
  fiscalYearEndMonth: number,
): FiscalYearPeriod {
  assertMonth(fiscalYearEndMonth, "deriveFirstFiscalYear");
  const { year, month } = dateParts(foundedOn);
  const endYear = month <= fiscalYearEndMonth ? year : year + 1;
  return { startDate: foundedOn, endDate: lastDayOfMonth(endYear, fiscalYearEndMonth) };
}

/**
 * The fiscal year after one ending on `previousEndDate`: from the next day for 12 months.
 * A month-end close stays on month ends (03-31 → next 03-31, 02-28 → 02-29 in a leap year);
 * any other day keeps the same day of the month (clamped to the month's last day).
 */
export function deriveNextFiscalYear(previousEndDate: CalendarDate): FiscalYearPeriod {
  const { year, month, day } = dateParts(previousEndDate);
  const startDate = addDays(previousEndDate, 1);
  const monthEnd = lastDayOfMonth(year + 1, month);
  if (isLastDayOfMonth(previousEndDate)) return { startDate, endDate: monthEnd };
  const sameDay = sameDayOfMonth(year + 1, month, day);
  return { startDate, endDate: sameDay ?? monthEnd };
}

function sameDayOfMonth(year: number, month: number, day: number): CalendarDate | null {
  const candidate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isCalendarDate(candidate) ? candidate : null;
}

/**
 * The latest end date a fiscal year starting on `startDate` may have: a business year is
 * at most one year (会社法・法人税法). Counted like 民法 §143: the day before the same date a year
 * later, or the end of that month when the date does not exist (02-29 → next 02-28).
 */
export function maxFiscalYearEndDate(startDate: CalendarDate): CalendarDate {
  const { year, month, day } = dateParts(startDate);
  const sameDay = sameDayOfMonth(year + 1, month, day);
  return sameDay ? addDays(sameDay, -1) : lastDayOfMonth(year + 1, month);
}

export const FISCAL_YEAR_PERIOD_PROBLEMS = [
  "INVALID_DATE",
  "END_BEFORE_START",
  "LONGER_THAN_A_YEAR",
] as const;
export type FiscalYearPeriodProblem = (typeof FISCAL_YEAR_PERIOD_PROBLEMS)[number];

export type FiscalYearPeriodCheck =
  { ok: true } | { ok: false; code: FiscalYearPeriodProblem; message: string };

/** Checks the dates of a fiscal year. `message` is owner-facing Japanese. */
export function checkFiscalYearPeriod(period: {
  startDate: string;
  endDate: string;
}): FiscalYearPeriodCheck {
  if (!isCalendarDate(period.startDate) || !isCalendarDate(period.endDate)) {
    return { ok: false, code: "INVALID_DATE", message: "期間の日付が正しくありません" };
  }
  if (period.endDate < period.startDate) {
    return {
      ok: false,
      code: "END_BEFORE_START",
      message: "終了日は開始日より後の日付にしてください",
    };
  }
  const latest = maxFiscalYearEndDate(period.startDate);
  if (period.endDate > latest) {
    return {
      ok: false,
      code: "LONGER_THAN_A_YEAR",
      message: `会計期間は 1 年以内です。終了日は ${latest} までにしてください`,
    };
  }
  return { ok: true };
}
