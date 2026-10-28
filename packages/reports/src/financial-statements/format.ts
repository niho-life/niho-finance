/**
 * Words and numbers of the statements (17-financial-statements §1, §4.5): 会社法の計算書類 show a
 * negative amount with 「△」 in front, dates as 「2027年3月31日」.
 */
import {
  dateParts,
  formatYen,
  isLastDayOfMonth,
  lastDayOfMonth,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";

/** `12345n` → `12,345`, `-12345n` → `△ 12,345` (screens, PDF, 決算公告). */
export function formatStatementAmount(amount: Money): string {
  return amount < 0n ? `△ ${formatYen(-amount)}` : formatYen(amount);
}

/** `2027-03-31` → `2027年3月31日` */
export function japaneseDate(date: CalendarDate): string {
  const { year, month, day } = dateParts(date);
  return `${year}年${month}月${day}日`;
}

/** 「第1期 自 2026年11月2日 至 2027年3月31日」 */
export function fiscalYearPeriodLabel(fiscalYear: {
  no: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
}): string {
  return `第${fiscalYear.no}期\u3000自 ${japaneseDate(fiscalYear.startDate)}\u3000至 ${japaneseDate(fiscalYear.endDate)}`;
}

/** 「2027年3月31日現在」 */
export function asOfLabel(date: CalendarDate): string {
  return `${japaneseDate(date)}現在`;
}

/** Adds months; a month end stays a month end (3/31 + 2 → 5/31), other days are clipped. */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const { year, month, day } = dateParts(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.trunc(index / 12);
  const targetMonth = (index % 12) + 1;
  const last = lastDayOfMonth(targetYear, targetMonth);
  if (isLastDayOfMonth(date)) return last;
  const lastDay = Number(last.slice(8));
  const dd = String(Math.min(day, lastDay)).padStart(2, "0");
  return `${last.slice(0, 8)}${dd}` as CalendarDate;
}
