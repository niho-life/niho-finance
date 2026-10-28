/**
 * The input of every report (14-reports §13): the master data and the posted entries, loaded by
 * `@niho-finance/db` (`loadReportSource`) or built by a test fixture. Everything is derived from
 * this at request time; nothing is stored (00-overview §5 "derive, don't sync").
 */
import type {
  AccountGroup,
  AccountingMethod,
  AccountKind,
  CalendarDate,
  ConsumptionTaxMethod,
  EntryKind,
  EntryStatus,
  FiscalYearStatus,
  Money,
  Side,
  SourceKind,
  WalletKind,
} from "@niho-finance/ledger";

export interface ReportCompany {
  name: string;
  /** 設立日: the books start here (beancount `open` directives). */
  foundedOn: CalendarDate;
}

export interface ReportFiscalYear {
  id: string;
  /** 第 n 期 */
  no: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
  lockedThrough: CalendarDate | null;
  status: FiscalYearStatus;
  consumptionTax: ConsumptionTaxMethod;
  accountingMethod: AccountingMethod;
}

export interface ReportAccount {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  group: AccountGroup;
  isCashLike: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface ReportSubAccount {
  id: string;
  accountId: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

export interface ReportSegment {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

export interface ReportPartner {
  id: string;
  name: string;
}

export interface ReportTaxCategory {
  code: string;
  name: string;
}

export interface ReportMemoTag {
  id: string;
  name: string;
}

export interface ReportWallet {
  id: string;
  name: string;
  kind: WalletKind;
  accountId: string;
  subAccountId: string | null;
  isActive: boolean;
}

export interface ReportLine {
  lineNo: number;
  side: Side;
  accountId: string;
  subAccountId: string | null;
  amount: Money;
  taxCategoryCode: string;
  taxAmount: Money;
  segmentId: string | null;
  partnerId: string | null;
  description: string | null;
  memoTagIds: readonly string[];
}

/** A posted entry with everything the reports show. Compatible with the ledger's `LedgerEntry`. */
export interface ReportEntry {
  id: string;
  fiscalYearId: string;
  no: number;
  entryDate: CalendarDate;
  description: string;
  kind: EntryKind;
  sourceKind: SourceKind;
  status: EntryStatus;
  reversalOfId: string | null;
  replacedById: string | null;
  voidReason: string | null;
  lines: readonly ReportLine[];
}

export interface ReportSource {
  company: ReportCompany;
  /** In order of `no`. */
  fiscalYears: readonly ReportFiscalYear[];
  accounts: readonly ReportAccount[];
  subAccounts: readonly ReportSubAccount[];
  segments: readonly ReportSegment[];
  partners: readonly ReportPartner[];
  taxCategories: readonly ReportTaxCategory[];
  memoTags: readonly ReportMemoTag[];
  wallets: readonly ReportWallet[];
  /** Every entry of the book (all fiscal years, voided ones and reversals included), any order. */
  entries: readonly ReportEntry[];
}

/**
 * The 決算振替 of one fiscal year (`kind = closing`, made by the year-end close, #14) and their
 * reversals (a close taken back): the pair nets to 0, but keeping only the reversal would move the
 * year's P&L twice.
 */
export function closingEntryIdsOf(
  entries: readonly ReportEntry[],
  fiscalYearId: string,
): Set<string> {
  const closing = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "closing" && entry.fiscalYearId === fiscalYearId) closing.add(entry.id);
  }
  const ids = new Set(closing);
  for (const entry of entries) {
    if (entry.kind === "reversal" && entry.reversalOfId && closing.has(entry.reversalOfId)) {
      ids.add(entry.id);
    }
  }
  return ids;
}

/**
 * The source without the 決算振替 of `fiscalYearId` (14-reports §1): the P&L of the year is shown as
 * earned, not moved to 繰越利益剰余金 by the close. Earlier years' closing entries stay (they open
 * the year's 繰越利益剰余金).
 */
export function withoutClosingOf<S extends ReportSource>(source: S, fiscalYearId: string): S {
  const ids = closingEntryIdsOf(source.entries, fiscalYearId);
  return ids.size === 0
    ? source
    : { ...source, entries: source.entries.filter((entry) => !ids.has(entry.id)) };
}

/** Lookups over a source. Built once per request with `indexSource`. */
export interface SourceIndex {
  accountsById: ReadonlyMap<string, ReportAccount>;
  subAccountsById: ReadonlyMap<string, ReportSubAccount>;
  segmentsById: ReadonlyMap<string, ReportSegment>;
  partnersById: ReadonlyMap<string, ReportPartner>;
  taxCategoriesByCode: ReadonlyMap<string, ReportTaxCategory>;
  memoTagsById: ReadonlyMap<string, ReportMemoTag>;
  fiscalYearsById: ReadonlyMap<string, ReportFiscalYear>;
  entriesById: ReadonlyMap<string, ReportEntry>;
  /** By date, then by number (numbers restart per fiscal year; years do not overlap). */
  entries: readonly ReportEntry[];
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

export function compareEntries(a: ReportEntry, b: ReportEntry): number {
  if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
  if (a.no !== b.no) return a.no - b.no;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortedEntries(entries: Iterable<ReportEntry>): ReportEntry[] {
  return [...entries].sort(compareEntries);
}

export function indexSource(source: ReportSource): SourceIndex {
  return {
    accountsById: byId(source.accounts),
    subAccountsById: byId(source.subAccounts),
    segmentsById: byId(source.segments),
    partnersById: byId(source.partners),
    taxCategoriesByCode: new Map(source.taxCategories.map((tax) => [tax.code, tax])),
    memoTagsById: byId(source.memoTags),
    fiscalYearsById: byId(source.fiscalYears),
    entriesById: byId(source.entries),
    entries: sortedEntries(source.entries),
  };
}

export function requireAccount(index: SourceIndex, accountId: string): ReportAccount {
  const account = index.accountsById.get(accountId);
  if (!account) throw new Error(`reports: account ${accountId} is not in the source`);
  return account;
}

/** 「科目 / 補助科目」 */
export function accountLabel(index: SourceIndex, accountId: string, subAccountId: string | null) {
  const account = requireAccount(index, accountId);
  const sub = subAccountId ? index.subAccountsById.get(subAccountId) : undefined;
  return sub ? `${account.name} / ${sub.name}` : account.name;
}

export function compareAccounts(a: ReportAccount, b: ReportAccount): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

export function compareSubAccounts(a: ReportSubAccount, b: ReportSubAccount): number {
  return a.sortOrder - b.sortOrder || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function compareSegments(a: ReportSegment, b: ReportSegment): number {
  return a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
}
