/**
 * @niho-finance/reports — journals, ledgers, trial balance, monthly trends, segment P&L,
 * financial statements and exports (e-Tax CSV, freee/Yayoi CSV, beancount).
 *
 * TODO(S7): build the reports on top of `trialBalance` / `computeBalances` from the ledger.
 */
import type { CalendarDate } from "@niho-finance/ledger";

export const REPORT_KINDS = [
  "journal",
  "general_ledger",
  "trial_balance",
  "monthly_trend",
  "segment_pl",
  "financial_statements",
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface ReportPeriod {
  from: CalendarDate;
  to: CalendarDate;
}

export interface ReportRequest {
  kind: ReportKind;
  fiscalYearId: string;
  period: ReportPeriod;
}
