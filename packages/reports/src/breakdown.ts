/**
 * 集計 (14-reports §15): revenue or expenses of the period by 取引先 / タグ / 科目 / セグメント and by
 * month, with the top n and 「その他」, the share of each row, and the drill-down to the general
 * ledger. Also the partner of a line (§15.1, shared with the general ledger) and the partner
 * summary of 取引先の詳細 (§15.5).
 */
import { normalSide, type CalendarDate, type Money } from "@niho-finance/ledger";
import type { CsvCell } from "./csv";
import { segmentLabels, TOTAL_LABEL, UNASSIGNED_SEGMENT_LABEL } from "./labels";
import { monthlyColumns } from "./monthly";
import { fiscalYearOn, type MonthRange, type ReportPeriod } from "./period";
import {
  compareSegments,
  indexSource,
  withoutClosingOf,
  type ReportAccount,
  type ReportEntry,
  type ReportFiscalYear,
  type ReportLine,
  type ReportPartner,
  type ReportSegment,
  type ReportSource,
  type SourceIndex,
} from "./source";

export const BREAKDOWN_AXES = ["partner", "tag", "account", "segment"] as const;
export type BreakdownAxis = (typeof BREAKDOWN_AXES)[number];

export const BREAKDOWN_AXIS_LABELS: Readonly<Record<BreakdownAxis, string>> = {
  partner: "取引先",
  tag: "タグ",
  account: "科目",
  segment: "セグメント",
};

export const BREAKDOWN_SIDES = ["revenue", "expense"] as const;
export type BreakdownSide = (typeof BREAKDOWN_SIDES)[number];

export const BREAKDOWN_SIDE_LABELS: Readonly<Record<BreakdownSide, string>> = {
  revenue: "収益",
  expense: "費用",
};

export const BREAKDOWN_TOPS = ["10", "20", "50", "all"] as const;
export type BreakdownTop = (typeof BREAKDOWN_TOPS)[number];

export const BREAKDOWN_TOP_LABELS: Readonly<Record<BreakdownTop, string>> = {
  "10": "上位 10 件",
  "20": "上位 20 件",
  "50": "上位 50 件",
  all: "すべて",
};

export const BREAKDOWN_SORTS = ["amount", "name"] as const;
export type BreakdownSort = (typeof BREAKDOWN_SORTS)[number];

export const BREAKDOWN_SORT_LABELS: Readonly<Record<BreakdownSort, string>> = {
  amount: "金額の大きい順",
  name: "名前順",
};

function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): value is T =>
    typeof value === "string" && (values as readonly string[]).includes(value);
}

export const isBreakdownAxis = oneOf(BREAKDOWN_AXES);
export const isBreakdownSide = oneOf(BREAKDOWN_SIDES);
export const isBreakdownTop = oneOf(BREAKDOWN_TOPS);
export const isBreakdownSort = oneOf(BREAKDOWN_SORTS);

/** The filter value (and row key) of 取引先なし / タグなし / 未設定 (`partner=none`, `tag=none`). */
export const NONE_KEY = "none";
export const OTHER_KEY = "other";
export const TOTAL_KEY = "total";

export const NO_PARTNER_LABEL = "取引先なし";
export const NO_TAG_LABEL = "タグなし";
const UNKNOWN_PARTNER_LABEL = "（削除された取引先）";
const UNKNOWN_TAG_LABEL = "（削除されたタグ）";

/** 「その他（3 件）」 */
export function otherRowLabel(count: number): string {
  return `その他（${count} 件）`;
}

/** 「集計（取引先別・収益）」: the PDF title (§15.4). */
export function breakdownTitle(axis: BreakdownAxis, side: BreakdownSide): string {
  return `集計（${BREAKDOWN_AXIS_LABELS[axis]}別・${BREAKDOWN_SIDE_LABELS[side]}）`;
}

// ---------------------------------------------------------------------------
// The partner of a line (§15.1)
// ---------------------------------------------------------------------------

/** The line's own partner, else the partner of its sub-account. */
function partnerOfLineItself(line: ReportLine, index: SourceIndex): string | null {
  if (line.partnerId) return line.partnerId;
  if (!line.subAccountId) return null;
  return index.subAccountsById.get(line.subAccountId)?.partnerId ?? null;
}

/**
 * The partner a line counts for (14-reports §15.1): the line's partner → the partner of its
 * sub-account → (only with `fromOtherLines`, used for revenue / expense lines) the one partner the
 * entry's other lines have, when they name exactly one. `null` = 取引先なし.
 *
 * Balance-sheet lines never take a partner from other lines: a card's 未払金 is owed to the card
 * company, not to the shop on the expense line (§15.5).
 */
export function partnerOfLine(
  entry: ReportEntry,
  line: ReportLine,
  index: SourceIndex,
  options: { fromOtherLines: boolean },
): string | null {
  const own = partnerOfLineItself(line, index);
  if (own !== null || !options.fromOtherLines) return own;
  let found: string | null = null;
  for (const other of entry.lines) {
    if (other === line || other.lineNo === line.lineNo) continue;
    const partner = partnerOfLineItself(other, index);
    if (partner === null) continue;
    if (found !== null && found !== partner) return null;
    found = partner;
  }
  return found;
}

/** Revenue and expense lines take a partner from the other lines; nothing else does. */
export function isIncomeAccount(account: ReportAccount): boolean {
  return account.kind === "revenue" || account.kind === "expense";
}

/** Whether a line passes a `partner` filter (an id, or `none` for 取引先なし). */
export function matchesPartnerFilter(
  entry: ReportEntry,
  line: ReportLine,
  account: ReportAccount,
  index: SourceIndex,
  partnerFilter: string,
): boolean {
  const partner = partnerOfLine(entry, line, index, { fromOtherLines: isIncomeAccount(account) });
  return partnerFilter === NONE_KEY ? partner === null : partner === partnerFilter;
}

/** Whether a line passes a `tag` filter: the line has the tag (`none`: the line has no tag). */
export function matchesTagFilter(line: ReportLine, tagFilter: string): boolean {
  return tagFilter === NONE_KEY
    ? line.memoTagIds.length === 0
    : line.memoTagIds.includes(tagFilter);
}

/** The chip of a filter: 「取引先: 架空クラウド株式会社」. */
export interface BreakdownFilterLabel {
  /** The URL value (an id or `none`). */
  value: string;
  /** 「取引先」 / 「タグ」 */
  name: string;
  /** The partner's or tag's name, or 取引先なし / タグなし. */
  label: string;
}

export function partnerFilterLabel(source: ReportSource, value: string): BreakdownFilterLabel {
  const label =
    value === NONE_KEY
      ? NO_PARTNER_LABEL
      : (source.partners.find((partner) => partner.id === value)?.name ?? UNKNOWN_PARTNER_LABEL);
  return { value, name: "取引先", label };
}

export function tagFilterLabel(source: ReportSource, value: string): BreakdownFilterLabel {
  const label =
    value === NONE_KEY
      ? NO_TAG_LABEL
      : (source.memoTags.find((tag) => tag.id === value)?.name ?? UNKNOWN_TAG_LABEL);
  return { value, name: "タグ", label };
}

// ---------------------------------------------------------------------------
// 構成比
// ---------------------------------------------------------------------------

/** a / b rounded to the nearest integer, halves away from zero (b > 0). */
function roundedDivision(a: bigint, b: bigint): bigint {
  const negative = a < 0n;
  const abs = negative ? -a : a;
  const q = (abs * 2n + b) / (b * 2n);
  return negative ? -q : q;
}

/**
 * 構成比 (§15): `value / total` as a percentage with one decimal (「12.3%」), computed in integers;
 * 「—」 when the total is 0 or below.
 */
export function shareText(value: Money, total: Money): string {
  if (total <= 0n) return "—";
  const permille = roundedDivision(value * 1000n, total);
  const negative = permille < 0n;
  const abs = negative ? -permille : permille;
  return `${negative ? "-" : ""}${abs / 10n}.${abs % 10n}%`;
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

export interface BreakdownOptions {
  axis: BreakdownAxis;
  side: BreakdownSide;
  top: BreakdownTop;
  sort: BreakdownSort;
  /** Only lines of this partner (`none`: lines without one). */
  partnerId?: string | null;
  /** Only lines with this tag (`none`: lines without a tag). */
  tagId?: string | null;
}

/** Where a row leads (§15.3): the general ledger (account axis) or the account axis, filtered. */
export interface BreakdownDrill {
  axis: BreakdownAxis;
  accountId?: string;
  partnerId?: string;
  tagId?: string;
  segmentId?: string;
}

export type BreakdownRowKind = "item" | "none" | "other" | "total";

export interface BreakdownRow {
  key: string;
  label: string;
  /** 科目コード (account axis). */
  code?: string;
  kind: BreakdownRowKind;
  /** One per month column, then the total. */
  values: Money[];
  /** 構成比 of the total column (「12.3%」 / 「—」). */
  share: string;
  /** `null`: no link (未設定, その他, 合計). */
  drill: BreakdownDrill | null;
}

export interface BreakdownReport {
  period: ReportPeriod;
  axis: BreakdownAxis;
  side: BreakdownSide;
  top: BreakdownTop;
  sort: BreakdownSort;
  /** The months (the same columns as 月次推移). */
  columns: MonthRange[];
  /** Items (top n), 取引先なし / タグなし / 未設定, その他, then 合計. */
  rows: BreakdownRow[];
  /** Per column then the total; every line once (= the income statement's revenue or expenses). */
  totals: Money[];
  /**
   * Tag axis: the amount counted more than once (lines with 2 or more tags), per column then the
   * total. Zeros on the other axes.
   */
  overlap: Money[];
  hasOverlap: boolean;
  /** The segment the lines were narrowed to (`null`: the whole company; always on the segment axis). */
  segmentId: string | null;
  partnerFilter: BreakdownFilterLabel | null;
  tagFilter: BreakdownFilterLabel | null;
  /** 「集計（取引先別・収益）」 */
  title: string;
  empty: boolean;
}

interface Bucket {
  key: string;
  label: string;
  code?: string;
  /** Name-order position (segments: sortOrder). */
  order: number;
  kind: "item" | "none";
  values: Money[];
  drill: BreakdownDrill | null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function addAt(values: Money[], column: number, total: number, amount: Money): void {
  values[column] = (values[column] ?? 0n) + amount;
  values[total] = (values[total] ?? 0n) + amount;
}

export function buildBreakdown(
  source: ReportSource,
  period: ReportPeriod,
  options: BreakdownOptions,
): BreakdownReport {
  const { axis, side, top, sort } = options;
  // Without the year's 決算振替 (14 §1), like 月次推移 and the trial balance.
  const index = indexSource(withoutClosingOf(source, period.fiscalYear.id));
  const columns = monthlyColumns(period);
  const width = columns.length + 1;
  const totalAt = columns.length;
  const zero = () => Array.from({ length: width }, () => 0n);
  const from = columns[0]?.from ?? period.from;
  const to = columns[columns.length - 1]?.to ?? period.to;
  const columnIndex = new Map(columns.map((column, i) => [column.key, i]));
  // The segment axis compares the segments, so the segment switch does not narrow it (§15.1).
  const segmentId = axis === "segment" ? null : period.segmentId;
  const partnerFilter = options.partnerId ?? null;
  const tagFilter = options.tagId ?? null;

  const segments = [...source.segments].sort(compareSegments);
  const activeSegmentLabels = segmentLabels(segments.filter((segment) => segment.isActive));
  const segmentOrder = new Map(segments.map((segment, i) => [segment.id, i]));

  const buckets = new Map<string, Bucket>();
  const bucketOf = (key: string, make: () => Omit<Bucket, "values">): Bucket => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { ...make(), values: zero() };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  const noneBucket = (label: string, drill: BreakdownDrill | null) =>
    bucketOf(NONE_KEY, () => ({ key: NONE_KEY, label, order: 0, kind: "none", drill }));

  const totals = zero();
  for (const entry of index.entries) {
    if (entry.entryDate < from || entry.entryDate > to) continue;
    const column = columnIndex.get(entry.entryDate.slice(0, 7));
    if (column === undefined) continue;
    for (const line of entry.lines) {
      const account = index.accountsById.get(line.accountId);
      if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
      if (account.kind !== side) continue;
      if (segmentId && line.segmentId !== segmentId) continue;
      if (partnerFilter && !matchesPartnerFilter(entry, line, account, index, partnerFilter)) {
        continue;
      }
      if (tagFilter && !matchesTagFilter(line, tagFilter)) continue;
      const signed = (normalSide(account.kind) === line.side ? 1n : -1n) * line.amount;
      addAt(totals, column, totalAt, signed);

      switch (axis) {
        case "partner": {
          const partnerId = partnerOfLine(entry, line, index, { fromOtherLines: true });
          const bucket =
            partnerId === null
              ? noneBucket(NO_PARTNER_LABEL, { axis: "account", partnerId: NONE_KEY })
              : bucketOf(partnerId, () => ({
                  key: partnerId,
                  label: index.partnersById.get(partnerId)?.name ?? UNKNOWN_PARTNER_LABEL,
                  order: 0,
                  kind: "item",
                  drill: { axis: "account", partnerId },
                }));
          addAt(bucket.values, column, totalAt, signed);
          break;
        }
        case "tag": {
          const tags = [...new Set(line.memoTagIds)];
          if (tags.length === 0) {
            const bucket = noneBucket(NO_TAG_LABEL, { axis: "account", tagId: NONE_KEY });
            addAt(bucket.values, column, totalAt, signed);
          }
          for (const tagId of tags) {
            const bucket = bucketOf(tagId, () => ({
              key: tagId,
              label: index.memoTagsById.get(tagId)?.name ?? UNKNOWN_TAG_LABEL,
              order: 0,
              kind: "item",
              drill: { axis: "account", tagId },
            }));
            addAt(bucket.values, column, totalAt, signed);
          }
          break;
        }
        case "account": {
          const bucket = bucketOf(account.id, () => ({
            key: account.id,
            label: account.name,
            code: account.code,
            order: 0,
            kind: "item",
            drill: { axis: "account", accountId: account.id },
          }));
          addAt(bucket.values, column, totalAt, signed);
          break;
        }
        case "segment": {
          const id = line.segmentId;
          const bucket =
            id === null
              ? noneBucket(UNASSIGNED_SEGMENT_LABEL, null)
              : bucketOf(id, () => {
                  const segment: ReportSegment | undefined = index.segmentsById.get(id);
                  return {
                    key: id,
                    label: activeSegmentLabels.get(id) ?? segment?.name ?? UNASSIGNED_SEGMENT_LABEL,
                    order: segmentOrder.get(id) ?? Number.MAX_SAFE_INTEGER,
                    kind: "item",
                    drill: { axis: "account", segmentId: id },
                  };
                });
          addAt(bucket.values, column, totalAt, signed);
          break;
        }
      }
    }
  }

  const nonZero = (bucket: Bucket) => bucket.values.some((value) => value !== 0n);
  const items = [...buckets.values()].filter((bucket) => bucket.kind === "item" && nonZero(bucket));
  const none = buckets.get(NONE_KEY);
  const byName = (a: Bucket, b: Bucket): number => {
    if (axis === "account") return compareText(a.code ?? "", b.code ?? "");
    if (axis === "segment") return a.order - b.order || compareText(a.key, b.key);
    return compareText(a.label, b.label) || compareText(a.key, b.key);
  };
  items.sort(
    sort === "amount"
      ? (a, b) => {
          const x = a.values[totalAt] ?? 0n;
          const y = b.values[totalAt] ?? 0n;
          return x === y ? byName(a, b) : x > y ? -1 : 1;
        }
      : byName,
  );

  const total = totals[totalAt] ?? 0n;
  const toRow = (bucket: Bucket): BreakdownRow => ({
    key: bucket.key,
    label: bucket.label,
    ...(bucket.code === undefined ? {} : { code: bucket.code }),
    kind: bucket.kind,
    values: bucket.values,
    share: shareText(bucket.values[totalAt] ?? 0n, total),
    drill: bucket.drill,
  });

  const limit = top === "all" ? items.length : Number(top);
  const shown = items.slice(0, limit);
  const rest = items.slice(limit);
  const rows: BreakdownRow[] = shown.map(toRow);
  if (none && nonZero(none)) rows.push(toRow(none));
  if (rest.length > 0) {
    const values = rest.reduce(
      (sum, bucket) => sum.map((value, i) => value + (bucket.values[i] ?? 0n)),
      zero(),
    );
    rows.push({
      key: OTHER_KEY,
      label: otherRowLabel(rest.length),
      kind: "other",
      values,
      share: shareText(values[totalAt] ?? 0n, total),
      drill: null,
    });
  }

  // Tag axis: what the rows count beyond the lines (a line with 2 tags is in 2 rows).
  const counted = [...items, ...(none ? [none] : [])].reduce(
    (sum, bucket) => sum.map((value, i) => value + (bucket.values[i] ?? 0n)),
    zero(),
  );
  const overlap = counted.map((value, i) => value - (totals[i] ?? 0n));
  const empty = items.length === 0 && !(none && nonZero(none));

  rows.push({
    key: TOTAL_KEY,
    label: TOTAL_LABEL,
    kind: "total",
    values: totals,
    share: shareText(total, total),
    drill: null,
  });

  return {
    period,
    axis,
    side,
    top,
    sort,
    columns,
    rows,
    totals,
    overlap,
    hasOverlap: overlap.some((value) => value !== 0n),
    segmentId,
    partnerFilter: partnerFilter ? partnerFilterLabel(source, partnerFilter) : null,
    tagFilter: tagFilter ? tagFilterLabel(source, tagFilter) : null,
    title: breakdownTitle(axis, side),
    empty,
  };
}

/**
 * CSV (§15.4): 軸の名前 ・ 科目コード（科目の軸だけ）・ 各月 ・ 合計 ・ 構成比, with 「なし」「その他」
 * and 合計.
 */
export function breakdownCsvRows(report: BreakdownReport): CsvCell[][] {
  const withCode = report.axis === "account";
  const header: CsvCell[] = [
    BREAKDOWN_AXIS_LABELS[report.axis],
    ...(withCode ? ["科目コード"] : []),
    ...report.columns.map((column) => column.label),
    TOTAL_LABEL,
    "構成比",
  ];
  const rows: CsvCell[][] = [header];
  for (const row of report.rows) {
    rows.push([row.label, ...(withCode ? [row.code ?? ""] : []), ...row.values, row.share]);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 取引先の詳細 (§15.5)
// ---------------------------------------------------------------------------

/** 売掛金・未収入金 (debit-positive) and 買掛金・未払金・未払費用 (credit-positive). */
export const PARTNER_RECEIVABLE_CODES = ["1200", "1250"] as const;
export const PARTNER_PAYABLE_CODES = ["2000", "2100", "2110"] as const;

export interface PartnerBalanceRow {
  account: ReportAccount;
  /** On the account's normal side. */
  balance: Money;
}

export interface PartnerBalances {
  total: Money;
  /** Accounts with a non-zero balance, by code. */
  rows: PartnerBalanceRow[];
}

export interface PartnerSummary {
  partner: ReportPartner | null;
  /** The year containing `today` (the first one before the books start). */
  fiscalYear: ReportFiscalYear | null;
  /** The balances are as of this day. */
  asOf: CalendarDate;
  /** The whole fiscal year (entries dated after today included), without its 決算振替. */
  revenue: Money;
  expense: Money;
  /** 未入金: 売掛金・未収入金 of the partner. */
  receivables: PartnerBalances;
  /** 未払: 買掛金・未払金・未払費用 of the partner. */
  payables: PartnerBalances;
}

function balancesOf(
  index: SourceIndex,
  partnerId: string,
  codes: readonly string[],
  asOf: CalendarDate,
): PartnerBalances {
  const accounts = [...index.accountsById.values()]
    .filter((account) => codes.includes(account.code))
    .sort((a, b) => compareText(a.code, b.code));
  const ids = new Set(accounts.map((account) => account.id));
  const net = new Map<string, Money>();
  for (const entry of index.entries) {
    if (entry.entryDate > asOf) break;
    for (const line of entry.lines) {
      if (!ids.has(line.accountId)) continue;
      // Only the line's own partner or its sub-account's: never from other lines (§15.5).
      if (partnerOfLine(entry, line, index, { fromOtherLines: false }) !== partnerId) continue;
      const signed = line.side === "debit" ? line.amount : -line.amount;
      net.set(line.accountId, (net.get(line.accountId) ?? 0n) + signed);
    }
  }
  const rows: PartnerBalanceRow[] = [];
  for (const account of accounts) {
    const value = net.get(account.id) ?? 0n;
    const balance = normalSide(account.kind) === "debit" ? value : -value;
    if (balance !== 0n) rows.push({ account, balance });
  }
  return { total: rows.reduce((sum, row) => sum + row.balance, 0n), rows };
}

export function buildPartnerSummary(
  source: ReportSource,
  partnerId: string,
  options: { today: CalendarDate },
): PartnerSummary {
  const partner = source.partners.find((candidate) => candidate.id === partnerId) ?? null;
  const fiscalYear = fiscalYearOn(source.fiscalYears, options.today);
  const balanceIndex = indexSource(source);
  let revenue: Money = 0n;
  let expense: Money = 0n;
  if (fiscalYear) {
    const index = indexSource(withoutClosingOf(source, fiscalYear.id));
    for (const entry of index.entries) {
      if (entry.entryDate < fiscalYear.startDate || entry.entryDate > fiscalYear.endDate) continue;
      for (const line of entry.lines) {
        const account = index.accountsById.get(line.accountId);
        if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
        if (!isIncomeAccount(account)) continue;
        if (partnerOfLine(entry, line, index, { fromOtherLines: true }) !== partnerId) continue;
        const signed = (normalSide(account.kind) === line.side ? 1n : -1n) * line.amount;
        if (account.kind === "revenue") revenue += signed;
        else expense += signed;
      }
    }
  }
  return {
    partner,
    fiscalYear,
    asOf: options.today,
    revenue,
    expense,
    receivables: balancesOf(balanceIndex, partnerId, PARTNER_RECEIVABLE_CODES, options.today),
    payables: balancesOf(balanceIndex, partnerId, PARTNER_PAYABLE_CODES, options.today),
  };
}
