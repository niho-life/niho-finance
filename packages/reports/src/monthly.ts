/**
 * 月次推移 (14-reports §4): the income statement by month of the fiscal year (or of the custom
 * range), one column per month plus the total, laid out with the statement's subtotals. From the
 * second year, 前年同月 (§15.6) puts the same month a year earlier under each amount.
 */
import {
  addDays,
  dateParts,
  lastDayOfMonth,
  normalSide,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";
import { monthsBetween, type MonthRange, type ReportPeriod } from "./period";
import {
  closingEntryIdsOf,
  indexSource,
  withoutClosingOf,
  type ReportAccount,
  type ReportEntry,
  type ReportSource,
  type SourceIndex,
} from "./source";
import {
  layoutIncomeStatement,
  vectorOps,
  type AccountValue,
  type IncomeSubtotals,
  type StatementRow,
} from "./statements";

export interface MonthlyRow extends StatementRow<Money[]> {
  /**
   * 前年同月 (§15.6), only while comparing: one per column, then the total of the prior months.
   * `null` = 「—」 (the month a year earlier is wholly before the books).
   */
  prior?: (Money | null)[];
}

/** The days of 前年同月 for one column (`null`: wholly before the books). */
export interface PriorRange {
  from: CalendarDate;
  to: CalendarDate;
}

export interface MonthlyReport {
  period: ReportPeriod;
  columns: MonthRange[];
  /** `value[i]` is column `i`; the last element is the total of the columns. */
  rows: MonthlyRow[];
  subtotals: IncomeSubtotals<Money[]>;
  filteredBySegment: boolean;
  empty: boolean;
  /** A fiscal year before this one exists: the 前年同月 switch is offered (§15.6). */
  hasPriorYear: boolean;
  /** 前年同月 is shown: asked for, and `hasPriorYear`. */
  comparing: boolean;
  /** While comparing: the days counted for each column's 前年同月. */
  priorRanges?: (PriorRange | null)[];
}

/** The months shown: the whole year, or the months of a custom range (14-reports §4). */
export function monthlyColumns(period: ReportPeriod): MonthRange[] {
  return period.preset === "custom"
    ? monthsBetween(period.from, period.to)
    : monthsBetween(period.fiscalYear.startDate, period.fiscalYear.endDate);
}

/** The same day a year earlier (29 Feb → 28 Feb). */
function yearEarlier(date: CalendarDate): CalendarDate {
  const { year, month, day } = dateParts(date);
  const last = lastDayOfMonth(year - 1, month);
  const candidate =
    `${String(year - 1).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CalendarDate;
  return candidate > last ? last : candidate;
}

/**
 * 前年同月 of each column (§15.6): the column's days a year earlier, counting only days in the books
 * (from the first year's start) and before this year's start; `null` when nothing is left.
 */
export function priorRangesOf(
  source: ReportSource,
  period: ReportPeriod,
  columns: readonly MonthRange[],
): (PriorRange | null)[] {
  const starts = source.fiscalYears.map((year) => year.startDate).sort();
  const booksStart = starts[0];
  const limit = addDays(period.fiscalYear.startDate, -1);
  return columns.map((column) => {
    if (booksStart === undefined) return null;
    let from = yearEarlier(column.from);
    let to = yearEarlier(column.to);
    if (from < booksStart) from = booksStart;
    if (to > limit) to = limit;
    return from > to ? null : { from, to };
  });
}

type AccountVectors = Map<string, { account: ReportAccount; value: Money[] }>;

/** Adds the P&L lines of `entries` to one vector per account (`columnOf` picks the column). */
function accumulate(
  index: SourceIndex,
  entries: Iterable<ReportEntry>,
  columnOf: (entry: ReportEntry) => number | undefined,
  options: { width: number; segmentId: string | null },
): AccountVectors {
  const values: AccountVectors = new Map();
  const totalAt = options.width - 1;
  for (const entry of entries) {
    const column = columnOf(entry);
    if (column === undefined) continue;
    for (const line of entry.lines) {
      const account = index.accountsById.get(line.accountId);
      if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
      if (account.kind !== "revenue" && account.kind !== "expense") continue;
      if (options.segmentId && line.segmentId !== options.segmentId) continue;
      let row = values.get(account.id);
      if (!row) {
        row = { account, value: Array.from({ length: options.width }, () => 0n) };
        values.set(account.id, row);
      }
      const signed = (normalSide(account.kind) === line.side ? 1n : -1n) * line.amount;
      row.value[column] = (row.value[column] ?? 0n) + signed;
      row.value[totalAt] = (row.value[totalAt] ?? 0n) + signed;
    }
  }
  return values;
}

export function buildMonthlyTrend(
  source: ReportSource,
  period: ReportPeriod,
  options: { compareWithPriorYear?: boolean } = {},
): MonthlyReport {
  // Without the year's 決算振替, which would zero the last month (14 §1).
  const index = indexSource(withoutClosingOf(source, period.fiscalYear.id));
  const columns = monthlyColumns(period);
  const width = columns.length + 1;
  const ops = vectorOps(width);
  const from = columns[0]?.from ?? period.from;
  const to = columns[columns.length - 1]?.to ?? period.to;
  const columnIndex = new Map(columns.map((column, i) => [column.key, i]));
  const hasPriorYear = source.fiscalYears.some(
    (year) => year.startDate < period.fiscalYear.startDate,
  );
  const comparing = Boolean(options.compareWithPriorYear) && hasPriorYear;

  const current = accumulate(
    index,
    index.entries,
    (entry) =>
      entry.entryDate < from || entry.entryDate > to
        ? undefined
        : columnIndex.get(entry.entryDate.slice(0, 7)),
    { width, segmentId: period.segmentId },
  );
  const currentValues: AccountValue<Money[]>[] = [...current.values()].filter(
    (row) => !ops.isZero(row.value),
  );

  if (!comparing) {
    const layout = layoutIncomeStatement(currentValues, ops);
    return {
      period,
      columns,
      rows: layout.rows,
      subtotals: layout.subtotals,
      filteredBySegment: period.segmentId !== null,
      empty: currentValues.length === 0,
      hasPriorYear,
      comparing,
    };
  }

  // 前年同月: each prior month without the 決算振替 of its own (earlier) year.
  const priorRanges = priorRangesOf(source, period, columns);
  const excluded = new Set<string>();
  for (const year of source.fiscalYears) {
    if (year.startDate >= period.fiscalYear.startDate) continue;
    for (const id of closingEntryIdsOf(source.entries, year.id)) excluded.add(id);
  }
  const priorIndex = new Map<string, number>();
  priorRanges.forEach((range, i) => {
    if (range) priorIndex.set(range.from.slice(0, 7), i);
  });
  const prior = accumulate(
    index,
    source.entries,
    (entry) => {
      if (excluded.has(entry.id)) return undefined;
      const column = priorIndex.get(entry.entryDate.slice(0, 7));
      const range = column === undefined ? null : priorRanges[column];
      if (!range || entry.entryDate < range.from || entry.entryDate > range.to) return undefined;
      return column;
    },
    { width, segmentId: period.segmentId },
  );

  // The rows cover the accounts of either year, so that the prior amounts add up as well.
  const accounts = new Map<string, ReportAccount>();
  for (const row of currentValues) accounts.set(row.account.id, row.account);
  for (const row of prior.values()) {
    if (!ops.isZero(row.value)) accounts.set(row.account.id, row.account);
  }
  const layout = layoutIncomeStatement(
    [...accounts.values()].map((account) => ({
      account,
      value: current.get(account.id)?.value ?? ops.zero(),
    })),
    ops,
  );
  const priorLayout = layoutIncomeStatement(
    [...accounts.values()].map((account) => ({
      account,
      value: prior.get(account.id)?.value ?? ops.zero(),
    })),
    ops,
  );
  const priorByKey = new Map(priorLayout.rows.map((row) => [row.key, row.value]));
  const anyPrior = priorRanges.some((range) => range !== null);
  const masked = (values: readonly Money[]): (Money | null)[] =>
    values.map((value, i) =>
      i < columns.length ? (priorRanges[i] ? value : null) : anyPrior ? value : null,
    );

  return {
    period,
    columns,
    rows: layout.rows.map((row) => ({
      ...row,
      prior: masked(priorByKey.get(row.key) ?? ops.zero()),
    })),
    subtotals: layout.subtotals,
    filteredBySegment: period.segmentId !== null,
    empty: currentValues.length === 0,
    hasPriorYear,
    comparing,
    priorRanges,
  };
}
