import { dateParts, formatYen, type CalendarDate, type Money } from "@niho-finance/ledger";

/** `2026-11-02` → `2026/11/02` (the mock's date style). */
export function formatDate(date: string | null | undefined): string {
  return date ? date.replaceAll("-", "/") : "—";
}

/** `2026/11/02 – 2027/03/31` */
export function formatPeriod(startDate: string, endDate: string): string {
  return `${formatDate(startDate)} – ${formatDate(endDate)}`;
}

/** `2026年11月` */
export function formatMonth(date: CalendarDate): string {
  const { year, month } = dateParts(date);
  return `${year}年${month}月`;
}

/** 3-digit grouping; `—` for no amount. The unit belongs to the column header. */
export function formatAmount(value: Money | null | undefined): string {
  return value === null || value === undefined ? "—" : formatYen(value);
}
