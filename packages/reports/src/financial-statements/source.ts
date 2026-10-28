/**
 * The input of 決算書と申告用データ (17-financial-statements §11): the report source of S7 plus what
 * only the statements need — each account's e-Tax code override, the partners' addresses, the
 * partner of a sub-account, the company's address / representative / invoice registration date,
 * each fiscal year's statement settings and the tax rate rules. Every type extends the S7 one, so a
 * `FinancialStatementsSource` is also a `ReportSource` (the trial balance runs on it unchanged).
 */
import type { CalendarDate, TaxRateRule } from "@niho-finance/ledger";
import type {
  ReportAccount,
  ReportCompany,
  ReportEntry,
  ReportFiscalYear,
  ReportPartner,
  ReportSource,
  ReportSubAccount,
} from "../source";
import { normalizeStatementSettings, type StatementSettings } from "./settings";

export interface FinancialStatementsCompany extends ReportCompany {
  /** 本店所在地 (決算公告). */
  address: string | null;
  /** 代表取締役の氏名 (事業報告・決算公告). */
  representative: string | null;
  /** インボイス登録日: lines before it are left out of the consumption tax summary (02 §3). */
  invoiceRegisteredOn: CalendarDate | null;
}

export interface FinancialStatementsFiscalYear extends ReportFiscalYear {
  /** 決算書の設定 (17 §3.1). `null` until saved once: every item takes its default. */
  statementSettings: StatementSettings | null;
}

export interface FinancialStatementsAccount extends ReportAccount {
  /** 勘定科目コードの上書き (設定 › 勘定科目). `null` = the edition's default mapping. */
  eTaxCode: string | null;
}

export interface FinancialStatementsSubAccount extends ReportSubAccount {
  /** The partner of the sub-account (勘定科目内訳の元データ when a line has none). */
  partnerId: string | null;
}

export interface FinancialStatementsPartner extends ReportPartner {
  address: string | null;
}

export interface FinancialStatementsSource extends ReportSource {
  company: FinancialStatementsCompany;
  fiscalYears: readonly FinancialStatementsFiscalYear[];
  accounts: readonly FinancialStatementsAccount[];
  subAccounts: readonly FinancialStatementsSubAccount[];
  partners: readonly FinancialStatementsPartner[];
  /** The tax rate rules (経過措置の控除割合 by date, 17 §8.2). */
  taxRules: readonly TaxRateRule[];
}

/** What the db layer reads on top of `loadReportSource` (keys are ids). */
export interface FinancialStatementsExtras {
  company: Pick<FinancialStatementsCompany, "address" | "representative" | "invoiceRegisteredOn">;
  /** `Account.eTaxCode` by account id (missing = no override). */
  accountETaxCodes?: Readonly<Record<string, string | null>>;
  /** `Partner.address` by partner id. */
  partnerAddresses?: Readonly<Record<string, string | null>>;
  /** `SubAccount.partnerId` by sub-account id. */
  subAccountPartners?: Readonly<Record<string, string | null>>;
  /** `FiscalYear.statementSettings` (the stored JSON) by fiscal year id; normalized here. */
  statementSettings?: Readonly<Record<string, unknown>>;
  taxRules: readonly TaxRateRule[];
}

function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === "" ? null : value;
}

/** Builds the source from S7's `ReportSource` and the extra columns, so the loader stays thin. */
export function toFinancialStatementsSource(
  base: ReportSource,
  extras: FinancialStatementsExtras,
): FinancialStatementsSource {
  const settings = extras.statementSettings ?? {};
  return {
    ...base,
    company: {
      ...base.company,
      address: blankToNull(extras.company.address),
      representative: blankToNull(extras.company.representative),
      invoiceRegisteredOn: extras.company.invoiceRegisteredOn,
    },
    fiscalYears: base.fiscalYears.map((fiscalYear) => {
      const stored = settings[fiscalYear.id];
      return {
        ...fiscalYear,
        statementSettings:
          stored === null || stored === undefined ? null : normalizeStatementSettings(stored),
      };
    }),
    accounts: base.accounts.map((account) => ({
      ...account,
      eTaxCode: blankToNull(extras.accountETaxCodes?.[account.id]),
    })),
    subAccounts: base.subAccounts.map((subAccount) => ({
      ...subAccount,
      partnerId: extras.subAccountPartners?.[subAccount.id] ?? null,
    })),
    partners: base.partners.map((partner) => ({
      ...partner,
      address: blankToNull(extras.partnerAddresses?.[partner.id]),
    })),
    taxRules: extras.taxRules,
  };
}

export function requireFiscalYear(
  source: FinancialStatementsSource,
  fiscalYearId: string,
): FinancialStatementsFiscalYear {
  const fiscalYear = source.fiscalYears.find((year) => year.id === fiscalYearId);
  if (!fiscalYear) throw new Error(`reports: fiscal year ${fiscalYearId} is not in the source`);
  return fiscalYear;
}

/** The year before (`no - 1`), or `null` for the first one. */
export function previousFiscalYear(
  source: FinancialStatementsSource,
  fiscalYear: FinancialStatementsFiscalYear,
): FinancialStatementsFiscalYear | null {
  return source.fiscalYears.find((year) => year.no === fiscalYear.no - 1) ?? null;
}

/** The entries of one fiscal year split the way the statements need them (17 §1). */
export interface YearEntries {
  /** Dated within the year, without the year's own closing entries (決算振替). */
  year: ReportEntry[];
  /** Dated before the year: earlier years' closing entries included (当期首残高). */
  before: ReportEntry[];
  /**
   * 成立の日の仕訳: in the first year of the book, the opening entries on its start date with their
   * reversals and replacements. Empty in later years.
   */
  opening: ReportEntry[];
  /** `year` without `opening` (the movements of the year). */
  during: ReportEntry[];
  /** How many closing entries of the year were left out. */
  excludedClosing: number;
}

/** Whether `fiscalYear` is the first of the book (the smallest `no`). */
export function isFirstFiscalYear(
  source: FinancialStatementsSource,
  fiscalYear: FinancialStatementsFiscalYear,
): boolean {
  return source.fiscalYears.every((year) => year.no >= fiscalYear.no);
}

/**
 * The year's 決算振替 and their reversals (a close taken back, #14). Both are left out: the pair
 * nets to 0, but keeping only the reversal would move the year's P&L twice.
 */
export function yearClosingEntryIds(
  source: FinancialStatementsSource,
  fiscalYear: FinancialStatementsFiscalYear,
): Set<string> {
  const closing = new Set<string>();
  for (const entry of source.entries) {
    if (entry.kind === "closing" && entry.fiscalYearId === fiscalYear.id) closing.add(entry.id);
  }
  const ids = new Set(closing);
  for (const entry of source.entries) {
    if (entry.kind === "reversal" && entry.reversalOfId && closing.has(entry.reversalOfId)) {
      ids.add(entry.id);
    }
  }
  return ids;
}

export function yearEntries(
  source: FinancialStatementsSource,
  fiscalYear: FinancialStatementsFiscalYear,
): YearEntries {
  const closingIds = yearClosingEntryIds(source, fiscalYear);
  const isClosing = (entry: ReportEntry) => closingIds.has(entry.id);

  const year: ReportEntry[] = [];
  const before: ReportEntry[] = [];
  let excludedClosing = 0;
  for (const entry of source.entries) {
    if (entry.entryDate < fiscalYear.startDate) {
      before.push(entry);
    } else if (entry.entryDate <= fiscalYear.endDate) {
      if (isClosing(entry)) {
        excludedClosing += 1;
        continue;
      }
      year.push(entry);
    }
  }

  const openingIds = new Set<string>();
  if (isFirstFiscalYear(source, fiscalYear)) {
    for (const entry of year) {
      if (entry.kind === "opening" && entry.entryDate === fiscalYear.startDate) {
        openingIds.add(entry.id);
      }
    }
    // Reversals and replacements of those entries belong to them (a corrected 成立の日 entry).
    let grew = openingIds.size > 0;
    while (grew) {
      grew = false;
      for (const entry of year) {
        if (openingIds.has(entry.id)) {
          if (entry.replacedById && !openingIds.has(entry.replacedById)) {
            if (year.some((candidate) => candidate.id === entry.replacedById)) {
              openingIds.add(entry.replacedById);
              grew = true;
            }
          }
          continue;
        }
        if (entry.kind === "reversal" && entry.reversalOfId && openingIds.has(entry.reversalOfId)) {
          openingIds.add(entry.id);
          grew = true;
        }
      }
    }
  }
  const opening = year.filter((entry) => openingIds.has(entry.id));
  const during = year.filter((entry) => !openingIds.has(entry.id));
  return { year, before, opening, during, excludedClosing };
}

/** debit − credit per account over `entries`. */
export function netByAccount(entries: Iterable<ReportEntry>): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const signed = line.side === "debit" ? line.amount : -line.amount;
      net.set(line.accountId, (net.get(line.accountId) ?? 0n) + signed);
    }
  }
  return net;
}

/** Debit and credit totals per account over `entries`. */
export function sidesByAccount(
  entries: Iterable<ReportEntry>,
): Map<string, { debit: bigint; credit: bigint }> {
  const sides = new Map<string, { debit: bigint; credit: bigint }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const current = sides.get(line.accountId) ?? { debit: 0n, credit: 0n };
      if (line.side === "debit") current.debit += line.amount;
      else current.credit += line.amount;
      sides.set(line.accountId, current);
    }
  }
  return sides;
}
