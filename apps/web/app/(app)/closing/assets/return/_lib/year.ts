import type { CalendarDate } from "@niho-finance/ledger";
import { defaultDepreciableAssetsReturnYear } from "@niho-finance/reports";

/** The earliest return year the screen accepts (a 4-digit `?year=` from it on). */
const MIN_RETURN_YEAR = 1990;

/** `?year=` of the page and the export: a 4-digit year, otherwise the default (16 §14.4). */
export function returnYearOf(
  value: string | string[] | null | undefined,
  today: CalendarDate,
): number {
  const text = Array.isArray(value) ? value[0] : value;
  if (text && /^\d{4}$/.test(text) && Number(text) >= MIN_RETURN_YEAR) return Number(text);
  return defaultDepreciableAssetsReturnYear(today);
}

export type ReturnExportFormat = "csv" | "pdf";

export function isReturnExportFormat(value: unknown): value is ReturnExportFormat {
  return value === "csv" || value === "pdf";
}

export function returnExportHref(year: number, format: ReturnExportFormat): string {
  return `/closing/assets/return/export?year=${year}&format=${format}`;
}
