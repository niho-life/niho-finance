import type { Money } from "@niho-finance/ledger";
import {
  compareSegments,
  segmentLabels,
  type ReportPeriod,
  type ReportSegment,
} from "@niho-finance/reports";
import { formatPeriod } from "@/lib/format";

const JST_DATE_TIME = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const JST_SHORT_DATE_TIME = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** `2026/11/02 06:00` (JST). */
export function formatDateTime(date: Date): string {
  return JST_DATE_TIME.format(date);
}

/** `11/02 06:00` (JST): the cards' last sync / import. */
export function formatShortDateTime(date: Date): string {
  return JST_SHORT_DATE_TIME.format(date);
}

/** 「第1期 2026/11/02 – 2027/03/31」 */
export function fiscalYearLabel(period: Pick<ReportPeriod, "fiscalYear">): string {
  const year = period.fiscalYear;
  return `第${year.no}期 ${formatPeriod(year.startDate, year.endDate)}`;
}

/** The right side of a PDF header: 「2026/11/02 – 2027/03/31（第1期）」. */
export function pdfPeriodLabel(period: ReportPeriod): string {
  return `${formatPeriod(period.from, period.to)}（第${period.fiscalYear.no}期）`;
}

/** The segment's label (「① プラットフォーム」) or 全社. */
export function segmentName(segments: readonly ReportSegment[], segmentId: string | null): string {
  if (!segmentId) return "全社";
  const labels = segmentLabels(
    segments.filter((segment) => segment.isActive).sort(compareSegments),
  );
  return (
    labels.get(segmentId) ?? segments.find((segment) => segment.id === segmentId)?.name ?? "全社"
  );
}

/** The sum of amounts (bigint yen). */
export function sumMoney(values: Iterable<Money>): Money {
  let total: Money = 0n;
  for (const value of values) total += value;
  return total;
}
