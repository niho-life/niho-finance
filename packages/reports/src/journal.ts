/**
 * 仕訳帳 (14-reports §7): the entries of `from`..`to` with their lines, paged for the screen and
 * flat for CSV. Voided entries and reversals stay (the book shows everything) unless `posted`.
 */
import type {
  CalendarDate,
  EntryKind,
  EntryStatus,
  Money,
  Side,
  SourceKind,
} from "@niho-finance/ledger";
import { slashDate } from "./format";
import { entryStateLabel, REPORT_ENTRY_KIND_LABELS, REPORT_SOURCE_KIND_LABELS } from "./labels";
import type { ReportPeriod } from "./period";
import { indexSource, type ReportEntry, type ReportSource, type SourceIndex } from "./source";

export const JOURNAL_PAGE_SIZE = 50;

export const JOURNAL_STATUS_FILTERS = ["all", "posted"] as const;
export type JournalStatusFilter = (typeof JOURNAL_STATUS_FILTERS)[number];

export interface JournalLineRow {
  lineNo: number;
  side: Side;
  accountId: string;
  accountCode: string;
  accountName: string;
  subAccountId: string | null;
  subAccountName: string | null;
  amount: Money;
  taxCategoryCode: string;
  taxName: string;
  taxAmount: Money;
  segmentId: string | null;
  segmentName: string | null;
  partnerId: string | null;
  partnerName: string | null;
  description: string | null;
  memoTagNames: string[];
}

export interface JournalEntryRow {
  id: string;
  no: number;
  entryDate: CalendarDate;
  description: string;
  kind: EntryKind;
  kindLabel: string;
  sourceKind: SourceKind;
  sourceLabel: string;
  status: EntryStatus;
  /** 取消済み / 反対仕訳（…）/ 訂正済み（…）, `null` for an ordinary entry. */
  stateLabel: string | null;
  voidReason: string | null;
  reversalOfId: string | null;
  replacedById: string | null;
  /** Debit total (= credit total). */
  amount: Money;
  lines: JournalLineRow[];
}

export interface JournalReport {
  period: ReportPeriod;
  status: JournalStatusFilter;
  /** The entries of this page. */
  entries: JournalEntryRow[];
  page: number;
  pageCount: number;
  /** Entries matching the period and the filters (all pages). */
  total: number;
  /** Over all pages. */
  debitTotal: Money;
  creditTotal: Money;
  empty: boolean;
}

export function isJournalStatusFilter(value: unknown): value is JournalStatusFilter {
  return typeof value === "string" && (JOURNAL_STATUS_FILTERS as readonly string[]).includes(value);
}

export function toJournalEntryRow(entry: ReportEntry, index: SourceIndex): JournalEntryRow {
  const lines: JournalLineRow[] = entry.lines.map((line) => {
    const account = index.accountsById.get(line.accountId);
    if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
    const sub = line.subAccountId ? index.subAccountsById.get(line.subAccountId) : undefined;
    const segment = line.segmentId ? index.segmentsById.get(line.segmentId) : undefined;
    const partner = line.partnerId ? index.partnersById.get(line.partnerId) : undefined;
    return {
      lineNo: line.lineNo,
      side: line.side,
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      subAccountId: line.subAccountId,
      subAccountName: sub?.name ?? null,
      amount: line.amount,
      taxCategoryCode: line.taxCategoryCode,
      taxName: index.taxCategoriesByCode.get(line.taxCategoryCode)?.name ?? line.taxCategoryCode,
      taxAmount: line.taxAmount,
      segmentId: line.segmentId,
      segmentName: segment?.name ?? null,
      partnerId: line.partnerId,
      partnerName: partner?.name ?? null,
      description: line.description,
      memoTagNames: line.memoTagIds
        .map((id) => index.memoTagsById.get(id)?.name)
        .filter((name): name is string => typeof name === "string"),
    };
  });
  let amount: Money = 0n;
  for (const line of lines) if (line.side === "debit") amount += line.amount;
  return {
    id: entry.id,
    no: entry.no,
    entryDate: entry.entryDate,
    description: entry.description,
    kind: entry.kind,
    kindLabel: REPORT_ENTRY_KIND_LABELS[entry.kind],
    sourceKind: entry.sourceKind,
    sourceLabel: REPORT_SOURCE_KIND_LABELS[entry.sourceKind],
    status: entry.status,
    stateLabel: entryStateLabel(entry, index),
    voidReason: entry.voidReason,
    reversalOfId: entry.reversalOfId,
    replacedById: entry.replacedById,
    amount,
    lines,
  };
}

function matches(entry: ReportEntry, period: ReportPeriod, status: JournalStatusFilter): boolean {
  if (entry.entryDate < period.from || entry.entryDate > period.to) return false;
  if (status === "posted" && (entry.status === "voided" || entry.kind === "reversal")) return false;
  if (period.segmentId && !entry.lines.some((line) => line.segmentId === period.segmentId))
    return false;
  return true;
}

/** Every entry of the journal (for CSV and PDF), in date and number order. */
export function journalEntries(
  source: ReportSource,
  period: ReportPeriod,
  status: JournalStatusFilter = "all",
): JournalEntryRow[] {
  const index = indexSource(source);
  return index.entries
    .filter((entry) => matches(entry, period, status))
    .map((entry) => toJournalEntryRow(entry, index));
}

export function buildJournal(
  source: ReportSource,
  period: ReportPeriod,
  options: { status?: JournalStatusFilter; page?: number; pageSize?: number } = {},
): JournalReport {
  const status = options.status ?? "all";
  const pageSize = options.pageSize ?? JOURNAL_PAGE_SIZE;
  const all = journalEntries(source, period, status);
  const pageCount = Math.max(1, Math.ceil(all.length / pageSize));
  const page = Math.min(Math.max(1, options.page ?? 1), pageCount);
  let debitTotal: Money = 0n;
  let creditTotal: Money = 0n;
  for (const entry of all) {
    for (const line of entry.lines) {
      if (line.side === "debit") debitTotal += line.amount;
      else creditTotal += line.amount;
    }
  }
  return {
    period,
    status,
    entries: all.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageCount,
    total: all.length,
    debitTotal,
    creditTotal,
    empty: all.length === 0,
  };
}

export const JOURNAL_CSV_HEADER = [
  "日付",
  "No.",
  "摘要",
  "種類",
  "状態",
  "行",
  "貸借",
  "科目コード",
  "科目",
  "補助科目",
  "金額",
  "税区分",
  "税額",
  "セグメント",
  "取引先",
  "行の摘要",
] as const;

/** One CSV row per line (14-reports §7). */
export function journalCsvRows(
  entries: readonly JournalEntryRow[],
): (string | bigint | number)[][] {
  const rows: (string | bigint | number)[][] = [[...JOURNAL_CSV_HEADER]];
  for (const entry of entries) {
    for (const line of entry.lines) {
      rows.push([
        slashDate(entry.entryDate),
        entry.no,
        entry.description,
        entry.kindLabel,
        entry.stateLabel ?? "",
        line.lineNo,
        line.side === "debit" ? "借方" : "貸方",
        line.accountCode,
        line.accountName,
        line.subAccountName ?? "",
        line.amount,
        line.taxName,
        line.taxAmount,
        line.segmentName ?? "",
        line.partnerName ?? "",
        line.description ?? "",
      ]);
    }
  }
  return rows;
}
