import type { Money } from "@niho-finance/ledger";
import type { ReportSource, SegmentReport, TrialBalanceReport } from "@niho-finance/reports";
import type { ProfitFigures } from "./profit-card";
import type { SegmentBar } from "./segment-bars";

/**
 * 売上 ・ 費用 ・ 利益 of a period from the income statement (14-reports §9): the period amounts of
 * the revenue and expense accounts; 利益 is the statement's 当期純利益 (= 売上 − 費用; internal
 * accounts net to 0 and are not on the statement).
 */
export function profitFigures(report: TrialBalanceReport, source: ReportSource): ProfitFigures {
  const kinds = new Map(source.accounts.map((account) => [account.id, account.kind]));
  let revenue: Money = 0n;
  let expenses: Money = 0n;
  for (const row of report.incomeStatement.rows) {
    if (row.kind !== "account" || !row.accountId) continue;
    const kind = kinds.get(row.accountId);
    if (kind === "revenue") revenue += row.value.period;
    else if (kind === "expense") expenses += row.value.period;
  }
  return { revenue, expenses, profit: report.incomeStatement.netIncome };
}

export function segmentBars(report: SegmentReport): SegmentBar[] {
  return report.bars.map((bar) => ({
    key: bar.segmentId ?? "unassigned",
    label: bar.label,
    value: bar.value,
  }));
}
