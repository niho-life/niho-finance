/**
 * The period of a report (14-reports §1): a fiscal year, a preset (今月 / 今期 / 任意) resolved to
 * `from`..`to` inside the year, and the segment. The URL's search parameters are the source of
 * truth; this turns them into dates.
 */
import { dateParts, lastDayOfMonth, type CalendarDate } from "@niho-finance/ledger";
import type { ReportFiscalYear } from "./source";

export const PERIOD_PRESETS = ["month", "year", "custom"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_PRESET_LABELS: Readonly<Record<PeriodPreset, string>> = {
  month: "今月",
  year: "今期",
  custom: "任意",
};

export function isPeriodPreset(value: unknown): value is PeriodPreset {
  return typeof value === "string" && (PERIOD_PRESETS as readonly string[]).includes(value);
}

/** What the URL carries (already parsed; unknown values are `null`). */
export interface ReportQuery {
  /** 第 n 期 */
  fy?: number | null;
  period?: PeriodPreset | null;
  from?: CalendarDate | null;
  to?: CalendarDate | null;
  /** Segment id; empty or null is the whole company. */
  segment?: string | null;
}

export interface ReportPeriod {
  fiscalYear: ReportFiscalYear;
  preset: PeriodPreset;
  /** Inclusive, inside the fiscal year. */
  from: CalendarDate;
  to: CalendarDate;
  segmentId: string | null;
}

export interface MonthRange {
  /** `2026-11` */
  key: string;
  /** `2026/11` */
  label: string;
  year: number;
  month: number;
  /** Clipped to the requested range (the first month of a year may start mid-month). */
  from: CalendarDate;
  to: CalendarDate;
}

export function firstDayOfMonth(date: CalendarDate): CalendarDate {
  const { year, month } = dateParts(date);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01` as CalendarDate;
}

export function endOfMonth(date: CalendarDate): CalendarDate {
  const { year, month } = dateParts(date);
  return lastDayOfMonth(year, month);
}

function nextMonth(year: number, month: number): [year: number, month: number] {
  return month === 12 ? [year + 1, 1] : [year, month + 1];
}

export function monthKey(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function monthLabel(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}/${String(month).padStart(2, "0")}`;
}

/** The months touching `from`..`to`, each clipped to the range. */
export function monthsBetween(from: CalendarDate, to: CalendarDate): MonthRange[] {
  if (from > to) return [];
  const months: MonthRange[] = [];
  let { year, month } = dateParts(from);
  for (;;) {
    const start =
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01` as CalendarDate;
    if (start > to) break;
    const end = lastDayOfMonth(year, month);
    months.push({
      key: monthKey(year, month),
      label: monthLabel(year, month),
      year,
      month,
      from: start < from ? from : start,
      to: end > to ? to : end,
    });
    [year, month] = nextMonth(year, month);
  }
  return months;
}

/**
 * The fiscal year shown as 「第 n 期」 on `today`: the one containing it, the first one before the
 * books start, or the latest one after the last year ends (the same rule as the home).
 */
export function fiscalYearOn(
  fiscalYears: readonly ReportFiscalYear[],
  today: CalendarDate,
): ReportFiscalYear | null {
  const years = [...fiscalYears].sort((a, b) => a.no - b.no);
  const first = years[0];
  if (!first) return null;
  return (
    years.find((year) => year.startDate <= today && year.endDate >= today) ??
    (today < first.startDate ? first : years[years.length - 1]) ??
    first
  );
}

function clamp(date: CalendarDate, year: ReportFiscalYear): CalendarDate {
  if (date < year.startDate) return year.startDate;
  if (date > year.endDate) return year.endDate;
  return date;
}

/**
 * Resolves the URL's parameters to a period (14-reports §1). `null` without fiscal years.
 * - `fy` picks the year (default: the year of `today`).
 * - 今月: the month of `today`, clipped to the year (the first / last month when today is outside).
 * - 今期: the whole year. 任意: `from`..`to` clipped to the year, swapped when reversed; a missing
 *   bound falls back to the year's bound.
 */
export function resolveReportPeriod(
  query: ReportQuery,
  fiscalYears: readonly ReportFiscalYear[],
  today: CalendarDate,
): ReportPeriod | null {
  const fiscalYear =
    (query.fy !== null && query.fy !== undefined
      ? fiscalYears.find((year) => year.no === query.fy)
      : undefined) ?? fiscalYearOn(fiscalYears, today);
  if (!fiscalYear) return null;
  const preset = query.period ?? "year";
  const segmentId = query.segment ? query.segment : null;

  if (preset === "month") {
    const anchor = clamp(today, fiscalYear);
    return {
      fiscalYear,
      preset,
      from: clamp(firstDayOfMonth(anchor), fiscalYear),
      to: clamp(endOfMonth(anchor), fiscalYear),
      segmentId,
    };
  }
  if (preset === "custom") {
    let from = clamp(query.from ?? fiscalYear.startDate, fiscalYear);
    let to = clamp(query.to ?? fiscalYear.endDate, fiscalYear);
    if (from > to) [from, to] = [to, from];
    return { fiscalYear, preset, from, to, segmentId };
  }
  return {
    fiscalYear,
    preset: "year",
    from: fiscalYear.startDate,
    to: fiscalYear.endDate,
    segmentId,
  };
}

/** The URL parameters that reproduce a period (links between tabs keep them). */
export function periodSearchParams(period: ReportPeriod): Record<string, string> {
  const params: Record<string, string> = {
    fy: String(period.fiscalYear.no),
    period: period.preset,
  };
  if (period.preset === "custom") {
    params.from = period.from;
    params.to = period.to;
  }
  if (period.segmentId) params.segment = period.segmentId;
  return params;
}
