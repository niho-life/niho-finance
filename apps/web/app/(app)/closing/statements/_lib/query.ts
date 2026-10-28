import type { CalendarDate } from "@niho-finance/ledger";
import { addMonths, type FinancialStatementsFiscalYear } from "@niho-finance/reports";

/** What `searchParams` of a page gives. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

export function firstParam(value: string | string[] | undefined | null): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

/** The year of today: the one containing it, the first before the books, the latest after them. */
function yearOfToday(
  years: readonly FinancialStatementsFiscalYear[],
  today: CalendarDate,
): FinancialStatementsFiscalYear | null {
  const first = years[0];
  if (!first) return null;
  return (
    years.find((year) => year.startDate <= today && year.endDate >= today) ??
    (today < first.startDate ? first : years[years.length - 1]) ??
    first
  );
}

/**
 * The default year of 決算書 (17 §2): the year before while today is within 3 months of its end (決算
 * の作業中), otherwise the year containing today.
 */
export function defaultStatementsYear(
  fiscalYears: readonly FinancialStatementsFiscalYear[],
  today: CalendarDate,
): FinancialStatementsFiscalYear | null {
  const years = [...fiscalYears].sort((a, b) => a.no - b.no);
  const current = yearOfToday(years, today);
  if (!current) return null;
  const previous = years.find((year) => year.no === current.no - 1);
  if (previous && today > previous.endDate && today <= addMonths(previous.endDate, 3)) {
    return previous;
  }
  return current;
}

/** `fy=<n>` when it names a year; `null` when it is given but names none. */
export function yearOfParam(
  fiscalYears: readonly FinancialStatementsFiscalYear[],
  fy: string | undefined,
): FinancialStatementsFiscalYear | null | undefined {
  if (fy === undefined || fy === "") return undefined;
  if (!/^\d{1,4}$/.test(fy)) return null;
  return fiscalYears.find((year) => year.no === Number(fy)) ?? null;
}

/** The year a page shows: `fy` when it names one, else the default (an unknown `fy` is dropped). */
export function resolveStatementsYear(
  fiscalYears: readonly FinancialStatementsFiscalYear[],
  fy: string | undefined,
  today: CalendarDate,
): FinancialStatementsFiscalYear | null {
  return yearOfParam(fiscalYears, fy) ?? defaultStatementsYear(fiscalYears, today);
}
