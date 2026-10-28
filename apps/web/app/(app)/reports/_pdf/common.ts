import type { Money } from "@niho-finance/ledger";
import { formatAmount } from "@/lib/format";

/** An amount for a PDF cell: 3-digit grouping, empty for no amount. */
export function amountText(value: Money | null | undefined): string {
  return value === null || value === undefined ? "" : formatAmount(value);
}

/** What every report PDF shows in its header. */
export interface PdfReportHeader {
  company: string;
  /** 「2026/11/02 – 2027/03/31（第1期）」 */
  periodLabel: string;
  /** The segment (「セグメント: ① プラットフォーム」) or the account. */
  subtitle?: string | undefined;
  exportedAt?: Date;
}
