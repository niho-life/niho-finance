/**
 * 月次推移 (14-reports §4): the income statement by month of the fiscal year (or of the custom
 * range), one column per month plus the total, laid out with the statement's subtotals.
 */
import { normalSide, type Money } from "@niho-finance/ledger";
import { monthsBetween, type MonthRange, type ReportPeriod } from "./period";
import { indexSource, type ReportAccount, type ReportSource } from "./source";
import {
  layoutIncomeStatement,
  vectorOps,
  type AccountValue,
  type IncomeSubtotals,
  type StatementRow,
} from "./statements";

export interface MonthlyReport {
  period: ReportPeriod;
  columns: MonthRange[];
  /** `value[i]` is column `i`; the last element is the total of the columns. */
  rows: StatementRow<Money[]>[];
  subtotals: IncomeSubtotals<Money[]>;
  filteredBySegment: boolean;
  empty: boolean;
}

/** The months shown: the whole year, or the months of a custom range (14-reports §4). */
export function monthlyColumns(period: ReportPeriod): MonthRange[] {
  return period.preset === "custom"
    ? monthsBetween(period.from, period.to)
    : monthsBetween(period.fiscalYear.startDate, period.fiscalYear.endDate);
}

export function buildMonthlyTrend(source: ReportSource, period: ReportPeriod): MonthlyReport {
  const index = indexSource(source);
  const columns = monthlyColumns(period);
  const ops = vectorOps(columns.length + 1);
  const from = columns[0]?.from ?? period.from;
  const to = columns[columns.length - 1]?.to ?? period.to;
  const columnIndex = new Map(columns.map((column, i) => [column.key, i]));

  const values = new Map<string, { account: ReportAccount; value: Money[] }>();
  for (const entry of index.entries) {
    if (entry.entryDate < from || entry.entryDate > to) continue;
    const column = columnIndex.get(entry.entryDate.slice(0, 7));
    if (column === undefined) continue;
    for (const line of entry.lines) {
      const account = index.accountsById.get(line.accountId);
      if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
      if (account.kind !== "revenue" && account.kind !== "expense") continue;
      if (period.segmentId && line.segmentId !== period.segmentId) continue;
      let row = values.get(account.id);
      if (!row) {
        row = { account, value: ops.zero() };
        values.set(account.id, row);
      }
      const signed = (normalSide(account.kind) === line.side ? 1n : -1n) * line.amount;
      row.value[column] = (row.value[column] ?? 0n) + signed;
      row.value[columns.length] = (row.value[columns.length] ?? 0n) + signed;
    }
  }

  const accountValues: AccountValue<Money[]>[] = [...values.values()].filter(
    (row) => !ops.isZero(row.value),
  );
  const layout = layoutIncomeStatement(accountValues, ops);
  return {
    period,
    columns,
    rows: layout.rows,
    subtotals: layout.subtotals,
    filteredBySegment: period.segmentId !== null,
    empty: accountValues.length === 0,
  };
}
