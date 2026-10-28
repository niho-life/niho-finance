import { addDays, dateParts, type CalendarDate } from "@niho-finance/ledger";

/**
 * A month as `YYYY-MM` (e.g. `"2026-11"`): the 対象月 of social insurance premiums.
 * Lexicographic order of this format equals chronological order.
 */
export type YearMonth = `${number}-${number}`;

const YEAR_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

export function isYearMonth(value: unknown): value is YearMonth {
  if (typeof value !== "string") return false;
  const match = YEAR_MONTH_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 1 && month >= 1 && month <= 12;
}

export function parseYearMonth(value: string): YearMonth {
  if (!isYearMonth(value)) {
    throw new RangeError(`"${String(value)}" is not a valid month (YYYY-MM)`);
  }
  return value;
}

export function compareYearMonths(a: YearMonth, b: YearMonth): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Year and month (1–12) of a valid `YYYY-MM`. */
export function yearMonthParts(value: YearMonth): { year: number; month: number } {
  const ym = parseYearMonth(value);
  return { year: Number(ym.slice(0, 4)), month: Number(ym.slice(5, 7)) };
}

function formatYearMonth(year: number, month: number): YearMonth {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}` as YearMonth;
}

/** The month a date belongs to, e.g. `"2026-12-25"` → `"2026-12"`. */
export function yearMonthOf(date: CalendarDate): YearMonth {
  const { year, month } = dateParts(date);
  return formatYearMonth(year, month);
}

/**
 * The day a person born on `birthDate` reaches the age `years` (「〜歳に達した日」): the day before
 * the corresponding birthday (年齢計算ニ関スル法律・民法第 143 条). For a 29 February birth this is
 * 28 February in every year, leap or not.
 */
export function reachedOn(birthDate: CalendarDate, years: number): CalendarDate {
  if (!Number.isSafeInteger(years) || years < 0) {
    throw new RangeError(`reachedOn: ${years} is not a whole number of years`);
  }
  const { year, month, day } = dateParts(birthDate);
  const targetYear = year + years;
  if (targetYear > 9999) throw new RangeError(`reachedOn: year ${targetYear} is out of range`);
  // The 1st of the birthday month plus (day − 2) days is the day before the birthday; JavaScript
  // dates roll a non-existent 29 February over, so a 29 February birth lands on 28 February.
  const firstOfMonth = `${formatYearMonth(targetYear, month)}-01` as CalendarDate;
  return addDays(firstOfMonth, day - 2);
}

/** Which insurances cover a person in a premium month, judged by age only (22-payroll §2.9). */
export interface AgeCoverage {
  health: boolean;
  care: boolean;
  pension: boolean;
}

/**
 * Age-based coverage for the premium month `premiumMonth` (22-payroll §2.9):
 * - 介護保険（第 2 号）: from the month of the day the person reaches 40, until the month before
 *   the month of the day they reach 65.
 * - 厚生年金: until the month before the month of the day they reach 70.
 * - 健康保険: until the month before the month of the 75th birthday (後期高齢者医療). For a
 *   29 February birth in a common year the birthday is taken as 1 March (the day after reaching 75).
 */
export function coverageByAge(birthDate: CalendarDate, premiumMonth: YearMonth): AgeCoverage {
  const month = parseYearMonth(premiumMonth);
  const careFrom = yearMonthOf(reachedOn(birthDate, 40));
  const careUntil = yearMonthOf(reachedOn(birthDate, 65));
  const pensionUntil = yearMonthOf(reachedOn(birthDate, 70));
  const healthUntil = yearMonthOf(addDays(reachedOn(birthDate, 75), 1));
  return {
    health: compareYearMonths(month, healthUntil) < 0,
    care: compareYearMonths(careFrom, month) <= 0 && compareYearMonths(month, careUntil) < 0,
    pension: compareYearMonths(month, pensionUntil) < 0,
  };
}
