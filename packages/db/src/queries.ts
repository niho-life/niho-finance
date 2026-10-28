import {
  computeBalances,
  trialBalance,
  type AccountRef,
  type CalendarDate,
  type FiscalYearContext,
  type LedgerEntry,
  type Money,
  type TrialBalance,
  type WalletKind,
} from "@niho-finance/ledger";
import type { FiscalYear } from "@prisma/client";
import type { Db } from "./audit";
import { fromDbDate, toDbDate } from "./dates";

export function toFiscalYearContext(row: FiscalYear): FiscalYearContext {
  return {
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
    lockedThrough: row.lockedThrough ? fromDbDate(row.lockedThrough) : null,
    status: row.status,
    consumptionTax: row.consumptionTax,
    accountingMethod: row.accountingMethod,
  };
}

export interface CurrentFiscalYear extends FiscalYearContext {
  id: string;
  /** 第 n 期 */
  no: number;
}

/**
 * The fiscal year shown as 「第 n 期」 on `today`: the one containing it, the first one before the
 * company's first year starts, or the latest one after the last year ends. `null` without years.
 */
export async function loadCurrentFiscalYear(
  db: Db,
  today: CalendarDate,
): Promise<CurrentFiscalYear | null> {
  const years = await db.fiscalYear.findMany({ orderBy: { no: "asc" } });
  const first = years[0];
  if (!first) return null;
  const day = toDbDate(today);
  const current =
    years.find((year) => year.startDate <= day && year.endDate >= day) ??
    (day < first.startDate ? first : years[years.length - 1]) ??
    first;
  return { id: current.id, no: current.no, ...toFiscalYearContext(current) };
}

export interface WalletBalance {
  id: string;
  name: string;
  kind: WalletKind;
  /** The wallet's journal lines (its sub-account) through `asOf`. */
  balance: Money;
}

export interface CashPosition {
  asOf: CalendarDate;
  /** 現預金: cash-like accounts (cash, deposits, Stripe balance) from the posted entries. */
  total: Money;
  /** Active wallets on cash-like accounts. */
  wallets: WalletBalance[];
}

/**
 * Cash and deposits on `asOf` (home, 10 §1): derived from the journal only, never stored, so the
 * home agrees with the trial balance. A wallet's `openingBalance` is the statement balance used to
 * reconcile imported lines (S4); it is not money outside the books and is not added here.
 */
export async function loadCashPosition(db: Db, asOf: CalendarDate): Promise<CashPosition> {
  const cashAccounts = await db.account.findMany({
    where: { isCashLike: true },
    select: { id: true },
  });
  const cashAccountIds = new Set(cashAccounts.map((account) => account.id));
  const wallets = await db.wallet.findMany({
    where: { isActive: true, accountId: { in: [...cashAccountIds] } },
    orderBy: { id: "asc" },
  });
  const rows = computeBalances(await loadLedgerEntries(db, { through: asOf }), {
    groupBy: "subAccount",
  });
  let total = 0n;
  for (const row of rows) if (cashAccountIds.has(row.accountId)) total += row.net;

  return {
    asOf,
    total,
    wallets: wallets.map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
      kind: wallet.kind,
      balance: rows
        .filter(
          (row) =>
            row.accountId === wallet.accountId &&
            wallet.subAccountId !== null &&
            row.subAccountId === wallet.subAccountId,
        )
        .reduce((sum, row) => sum + row.net, 0n),
    })),
  };
}

export async function loadAccountRefs(db: Db): Promise<AccountRef[]> {
  return db.account.findMany({
    select: { id: true, code: true, kind: true, isActive: true },
    orderBy: { code: "asc" },
  });
}

/** Every posted line dated on or before `through`, grouped by entry (voided entries included). */
export async function loadLedgerEntries(
  db: Db,
  options: { through: CalendarDate },
): Promise<LedgerEntry[]> {
  const lines = await db.journalLine.findMany({
    where: { journalEntry: { entryDate: { lte: toDbDate(options.through) } } },
    select: {
      journalEntryId: true,
      side: true,
      accountId: true,
      subAccountId: true,
      segmentId: true,
      amount: true,
      journalEntry: { select: { entryDate: true } },
    },
    orderBy: [{ journalEntryId: "asc" }, { lineNo: "asc" }],
  });
  const entries = new Map<
    string,
    { entryDate: CalendarDate; lines: LedgerEntry["lines"][number][] }
  >();
  for (const line of lines) {
    let entry = entries.get(line.journalEntryId);
    if (!entry) {
      entry = { entryDate: fromDbDate(line.journalEntry.entryDate), lines: [] };
      entries.set(line.journalEntryId, entry);
    }
    entry.lines.push({
      side: line.side,
      accountId: line.accountId,
      subAccountId: line.subAccountId,
      segmentId: line.segmentId,
      amount: line.amount,
    });
  }
  return [...entries.values()];
}

/** Trial balance of a fiscal year from the stored entries (`ledger.trialBalance`). */
export async function loadTrialBalance(
  db: Db,
  fiscalYearId: string,
  options: { asOf?: CalendarDate } = {},
): Promise<TrialBalance> {
  const fiscalYear = toFiscalYearContext(
    await db.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } }),
  );
  const asOf = options.asOf ?? fiscalYear.endDate;
  const [entries, accounts] = [
    await loadLedgerEntries(db, { through: asOf }),
    await loadAccountRefs(db),
  ];
  return trialBalance(entries, accounts, fiscalYear, { asOf });
}
