/**
 * セグメント損益 (14-reports §5): revenue, expenses and internal transactions of `from`..`to` by
 * segment, with the total column. Internal accounts net to 0 in the total.
 */
import { normalSide, type Money } from "@niho-finance/ledger";
import { segmentLabels, TOTAL_LABEL, UNASSIGNED_SEGMENT_LABEL } from "./labels";
import type { ReportPeriod } from "./period";
import {
  compareAccounts,
  compareSegments,
  indexSource,
  withoutClosingOf,
  type ReportAccount,
  type ReportSegment,
  type ReportSource,
} from "./source";

export interface SegmentColumn {
  key: string;
  label: string;
  /** `null` for 未設定 and 合計. */
  segmentId: string | null;
  kind: "segment" | "unassigned" | "total";
}

export type SegmentRowKind = "section" | "account" | "subtotal" | "total";

export interface SegmentRow {
  kind: SegmentRowKind;
  key: string;
  label: string;
  level: number;
  /** One per column (the last is the total). Revenue positive, expenses positive, internal: cost positive. */
  values: Money[];
  code?: string;
  accountId?: string;
}

export interface SegmentBar {
  segmentId: string | null;
  label: string;
  /** Profit of the segment. */
  value: Money;
}

export interface SegmentReport {
  period: ReportPeriod;
  columns: SegmentColumn[];
  rows: SegmentRow[];
  revenue: Money[];
  expenses: Money[];
  internal: Money[];
  /** revenue − expenses − internal, per column. */
  profit: Money[];
  bars: SegmentBar[];
  empty: boolean;
}

/** The segment columns of a report: active segments in order, then inactive ones that are used. */
export function segmentColumns(
  segments: readonly ReportSegment[],
  usedSegmentIds: ReadonlySet<string>,
  hasUnassigned: boolean,
): SegmentColumn[] {
  const ordered = [...segments].sort(compareSegments);
  const active = ordered.filter((segment) => segment.isActive);
  const labels = segmentLabels(active);
  const columns: SegmentColumn[] = active.map((segment) => ({
    key: segment.id,
    label: labels.get(segment.id) ?? segment.name,
    segmentId: segment.id,
    kind: "segment",
  }));
  for (const segment of ordered) {
    if (segment.isActive || !usedSegmentIds.has(segment.id)) continue;
    columns.push({ key: segment.id, label: segment.name, segmentId: segment.id, kind: "segment" });
  }
  if (hasUnassigned) {
    columns.push({
      key: "unassigned",
      label: UNASSIGNED_SEGMENT_LABEL,
      segmentId: null,
      kind: "unassigned",
    });
  }
  columns.push({ key: "total", label: TOTAL_LABEL, segmentId: null, kind: "total" });
  return columns;
}

export function buildSegmentReport(source: ReportSource, period: ReportPeriod): SegmentReport {
  // Without the year's 決算振替, which would zero every segment (14 §1).
  const index = indexSource(withoutClosingOf(source, period.fiscalYear.id));

  // First pass: which segments are used and whether any P&L line lacks one.
  const used = new Set<string>();
  let hasUnassigned = false;
  const lines: { account: ReportAccount; segmentId: string | null; signed: Money }[] = [];
  for (const entry of index.entries) {
    if (entry.entryDate < period.from || entry.entryDate > period.to) continue;
    for (const line of entry.lines) {
      const account = index.accountsById.get(line.accountId);
      if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
      if (account.kind !== "revenue" && account.kind !== "expense" && account.kind !== "internal")
        continue;
      if (line.segmentId) used.add(line.segmentId);
      else hasUnassigned = true;
      const signed = (normalSide(account.kind) === line.side ? 1n : -1n) * line.amount;
      lines.push({ account, segmentId: line.segmentId, signed });
    }
  }
  const columns = segmentColumns(source.segments, used, hasUnassigned);
  const columnIndex = new Map<string | null, number>();
  columns.forEach((column, i) => {
    if (column.kind === "segment") columnIndex.set(column.segmentId, i);
    if (column.kind === "unassigned") columnIndex.set(null, i);
  });
  const total = columns.length - 1;
  const zero = () => Array.from({ length: columns.length }, () => 0n);

  const values = new Map<string, { account: ReportAccount; values: Money[] }>();
  for (const { account, segmentId, signed } of lines) {
    const column = columnIndex.get(segmentId);
    if (column === undefined) continue;
    let row = values.get(account.id);
    if (!row) {
      row = { account, values: zero() };
      values.set(account.id, row);
    }
    row.values[column] = (row.values[column] ?? 0n) + signed;
    row.values[total] = (row.values[total] ?? 0n) + signed;
  }

  const sum = (rows: { values: Money[] }[]) =>
    rows.reduce((acc, row) => acc.map((value, i) => value + (row.values[i] ?? 0n)), zero());
  const ofKind = (kind: ReportAccount["kind"]) =>
    [...values.values()]
      .filter((row) => row.account.kind === kind && row.values.some((value) => value !== 0n))
      .sort((a, b) => compareAccounts(a.account, b.account));
  const revenueRows = ofKind("revenue");
  const expenseRows = ofKind("expense");
  const internalRows = ofKind("internal");
  const revenue = sum(revenueRows);
  const expenses = sum(expenseRows);
  const internal = sum(internalRows);
  const profit = revenue.map((value, i) => value - (expenses[i] ?? 0n) - (internal[i] ?? 0n));

  const accountRow = (row: { account: ReportAccount; values: Money[] }): SegmentRow => ({
    kind: "account",
    key: `account:${row.account.id}`,
    label: row.account.name,
    level: 1,
    values: row.values,
    code: row.account.code,
    accountId: row.account.id,
  });
  const rows: SegmentRow[] = [
    { kind: "section", key: "section:revenue", label: "収益", level: 0, values: revenue },
    ...revenueRows.map(accountRow),
    { kind: "subtotal", key: "subtotal:revenue", label: "収益 計", level: 0, values: revenue },
    { kind: "section", key: "section:expenses", label: "費用", level: 0, values: expenses },
    ...expenseRows.map(accountRow),
    { kind: "subtotal", key: "subtotal:expenses", label: "費用 計", level: 0, values: expenses },
  ];
  if (internalRows.length > 0) {
    rows.push(
      { kind: "section", key: "section:internal", label: "内部取引", level: 0, values: internal },
      ...internalRows.map(accountRow),
    );
  }
  rows.push({ kind: "total", key: "total:profit", label: "利益", level: 0, values: profit });

  const bars: SegmentBar[] = columns
    .filter((column) => column.kind !== "total")
    .map((column, i) => ({
      segmentId: column.segmentId,
      label: column.label,
      value: profit[i] ?? 0n,
    }));

  return {
    period,
    columns,
    rows,
    revenue,
    expenses,
    internal,
    profit,
    bars,
    empty: lines.length === 0,
  };
}
