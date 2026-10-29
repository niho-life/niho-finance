import type { Money } from "@niho-finance/ledger";
import {
  slashDate,
  slashPeriod,
  type CashReport,
  type CsvCell,
  type MonthlyReport,
  type SegmentReport,
} from "@niho-finance/reports";
import type { TrialBalanceLine, TrialBalanceView } from "./trial-balance-view";

/**
 * CSV rows of the tabs that `@niho-finance/reports` does not shape itself (14-reports §3–§6).
 * Amounts are signed integers; the caller encodes (`csvText` → `encodeCsv`).
 */
type CsvRow = CsvCell[];

const TRIAL_BALANCE_HEADER = ["区分", "科目コード", "科目", "期首", "借方", "貸方", "期間", "残高"];

function trialBalanceLineCells(line: TrialBalanceLine): CsvRow {
  if (line.kind === "section") return [line.label];
  const label =
    line.kind === "subAccount" && line.parentLabel
      ? `${line.parentLabel} / ${line.label}`
      : line.label;
  const isLeaf = line.kind === "account" || line.kind === "subAccount";
  return [
    line.kind === "group" || isLeaf ? (line.groupLabel ?? "") : "",
    line.code ?? "",
    label,
    line.opening,
    line.debit,
    line.credit,
    line.period,
    line.balance,
  ];
}

/** Two blocks: 貸借対照表（`to` 時点）and 損益計算書（`from`〜`to`）. */
export function trialBalanceCsvRows(view: TrialBalanceView, segmentLabel: string | null): CsvRow[] {
  const { period } = view.report;
  const rows: CsvRow[] = [[`貸借対照表（${slashDate(period.to)} 時点）`], TRIAL_BALANCE_HEADER];
  rows.push(...view.balanceSheet.map(trialBalanceLineCells));
  rows.push([]);
  rows.push([
    `損益計算書（${slashPeriod(period.from, period.to)}）${segmentLabel ? ` セグメント: ${segmentLabel}` : ""}`,
  ]);
  rows.push(TRIAL_BALANCE_HEADER);
  rows.push(...view.incomeStatement.map(trialBalanceLineCells));
  return rows;
}

/**
 * 科目コード ・ 科目 ・ 各月 ・ 合計 (the subtotal rows included). With 前年同月 (§15.6), each month
 * and 合計 is followed by 「YYYY/MM 前年」 (empty where the screen shows 「—」).
 */
export function monthlyCsvRows(report: MonthlyReport): CsvRow[] {
  const labels = [...report.columns.map((c) => c.label), "合計"];
  if (!report.comparing) {
    const rows: CsvRow[] = [["科目コード", "科目", ...labels]];
    for (const row of report.rows) rows.push([row.code ?? "", row.label, ...row.value]);
    return rows;
  }
  const rows: CsvRow[] = [
    ["科目コード", "科目", ...labels.flatMap((label) => [label, `${label} 前年`])],
  ];
  for (const row of report.rows) {
    rows.push([
      row.code ?? "",
      row.label,
      ...row.value.flatMap((value, i): CsvCell[] => [value, row.prior?.[i] ?? null]),
    ]);
  }
  return rows;
}

/** Rows × segments (the last column is 合計). */
export function segmentsCsvRows(report: SegmentReport): CsvRow[] {
  const rows: CsvRow[] = [["科目コード", "科目", ...report.columns.map((c) => c.label)]];
  for (const row of report.rows) {
    rows.push(
      row.kind === "section"
        ? [row.code ?? "", row.label]
        : [row.code ?? "", row.label, ...row.values],
    );
  }
  return rows;
}

export const UNASSIGNED_CASH_LABEL = "口座に紐づかない現預金";

/**
 * 口座 × 月末残高 and 合計. Cash on accounts that no active wallet owns gets its own row, so that
 * the rows add up to 合計 (= the trial balance's cash).
 */
export function cashMonthEndRows(report: CashReport): { label: string; balances: Money[] }[] {
  const { monthEnds } = report;
  const rows = monthEnds.rows.map((row) => ({ label: row.label, balances: row.balances }));
  const rest = monthEnds.total.map(
    (total, i) => total - monthEnds.rows.reduce((sum, row) => sum + (row.balances[i] ?? 0n), 0n),
  );
  if (rest.some((value) => value !== 0n))
    rows.push({ label: UNASSIGNED_CASH_LABEL, balances: rest });
  return rows;
}

export function cashCsvRows(report: CashReport): CsvRow[] {
  const rows: CsvRow[] = [["口座", ...report.monthEnds.columns.map((c) => `${c.label} 月末`)]];
  for (const row of cashMonthEndRows(report)) rows.push([row.label, ...row.balances]);
  rows.push(["合計", ...report.monthEnds.total]);
  return rows;
}
