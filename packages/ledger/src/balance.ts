import type { CalendarDate } from "./date";
import { LedgerInvariantError } from "./errors";
import { formatYen, type Money } from "./money";
import {
  normalSide,
  type AccountKind,
  type AccountRef,
  type FiscalYearContext,
  type Side,
} from "./types";

/** The part of a journal line that balances are computed from. */
export interface LedgerLine {
  side: Side;
  accountId: string;
  subAccountId?: string | null;
  segmentId?: string | null;
  amount: Money;
}

/** Any posted entry. Voided entries stay in the ledger: they net to 0 with their reversal. */
export interface LedgerEntry {
  entryDate: CalendarDate;
  lines: readonly LedgerLine[];
}

export type BalanceGroupBy = "account" | "subAccount" | "segment";

export interface BalanceRow {
  accountId: string;
  /** Set only when grouping by `subAccount`. */
  subAccountId: string | null;
  /** Set only when grouping by `segment`. */
  segmentId: string | null;
  debit: Money;
  credit: Money;
  /** debit − credit */
  net: Money;
}

export interface ComputeBalancesOptions {
  groupBy: BalanceGroupBy;
  /** Inclusive lower bound on the entry date. */
  from?: CalendarDate;
  /** Inclusive upper bound on the entry date. */
  asOf?: CalendarDate;
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/** Debit/credit totals per account (optionally per sub-account or per segment). */
export function computeBalances(
  entries: Iterable<LedgerEntry>,
  options: ComputeBalancesOptions,
): BalanceRow[] {
  const rows = new Map<string, BalanceRow>();
  for (const entry of entries) {
    if (options.asOf !== undefined && entry.entryDate > options.asOf) continue;
    if (options.from !== undefined && entry.entryDate < options.from) continue;
    for (const line of entry.lines) {
      const subAccountId = options.groupBy === "subAccount" ? (line.subAccountId ?? null) : null;
      const segmentId = options.groupBy === "segment" ? (line.segmentId ?? null) : null;
      const key = JSON.stringify([line.accountId, subAccountId, segmentId]);
      let row = rows.get(key);
      if (!row) {
        row = {
          accountId: line.accountId,
          subAccountId,
          segmentId,
          debit: 0n,
          credit: 0n,
          net: 0n,
        };
        rows.set(key, row);
      }
      if (line.side === "debit") row.debit += line.amount;
      else row.credit += line.amount;
      row.net = row.debit - row.credit;
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      compareNullable(a.accountId, b.accountId) ||
      compareNullable(a.subAccountId, b.subAccountId) ||
      compareNullable(a.segmentId, b.segmentId),
  );
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  kind: AccountKind;
  /** Balance-sheet accounts: cumulative through `asOf`. P&L accounts: within `from`..`asOf`. */
  debit: Money;
  credit: Money;
  /** Balance on the account's normal side (debit for assets/expenses, credit for the rest). */
  balance: Money;
}

export interface TrialBalanceTotals {
  /** All lines through `asOf` (cumulative). Equal when every entry is balanced. */
  debit: Money;
  credit: Money;
  assets: Money;
  liabilities: Money;
  /** Includes `priorPeriodsProfit`. */
  equity: Money;
  revenue: Money;
  expenses: Money;
  /** debit − credit of `internal` accounts. Always 0 for a sound ledger. */
  internal: Money;
  /** revenue − expenses within the period. */
  netIncome: Money;
  /** P&L before `from` that has not been closed into retained earnings yet (part of equity). */
  priorPeriodsProfit: Money;
}

export interface TrialBalance {
  from: CalendarDate;
  asOf: CalendarDate;
  rows: TrialBalanceRow[];
  totals: TrialBalanceTotals;
}

export interface TrialBalanceOptions {
  /** Defaults to the fiscal year's end date. */
  asOf?: CalendarDate;
}

/**
 * Trial balance of a fiscal year. Opening balances are derived from earlier entries
 * (no opening entries are created at the start of a year, 02-accounting-rules §5).
 */
export function trialBalance(
  entries: Iterable<LedgerEntry>,
  accounts: Iterable<AccountRef>,
  fiscalYear: Pick<FiscalYearContext, "startDate" | "endDate">,
  options: TrialBalanceOptions = {},
): TrialBalance {
  const from = fiscalYear.startDate;
  const asOf = options.asOf ?? fiscalYear.endDate;
  const accountsById = new Map<string, AccountRef>();
  for (const account of accounts) accountsById.set(account.id, account);

  const sums = new Map<string, { debit: Money; credit: Money }>();
  let totalDebit: Money = 0n;
  let totalCredit: Money = 0n;
  let priorPeriodsProfit: Money = 0n;

  for (const entry of entries) {
    if (entry.entryDate > asOf) continue;
    for (const line of entry.lines) {
      const account = accountsById.get(line.accountId);
      if (!account) {
        throw new LedgerInvariantError(
          "UNKNOWN_ACCOUNT",
          `account ${line.accountId} is not in the chart`,
        );
      }
      if (line.side === "debit") totalDebit += line.amount;
      else totalCredit += line.amount;

      const isProfitAndLoss = account.kind === "revenue" || account.kind === "expense";
      if (isProfitAndLoss && entry.entryDate < from) {
        priorPeriodsProfit += line.side === "credit" ? line.amount : -line.amount;
        continue;
      }
      const sum = sums.get(account.id) ?? { debit: 0n, credit: 0n };
      if (line.side === "debit") sum.debit += line.amount;
      else sum.credit += line.amount;
      sums.set(account.id, sum);
    }
  }

  const totals: TrialBalanceTotals = {
    debit: totalDebit,
    credit: totalCredit,
    assets: 0n,
    liabilities: 0n,
    equity: priorPeriodsProfit,
    revenue: 0n,
    expenses: 0n,
    internal: 0n,
    netIncome: 0n,
    priorPeriodsProfit,
  };
  const rows: TrialBalanceRow[] = [];
  for (const [accountId, { debit, credit }] of sums) {
    const account = accountsById.get(accountId);
    if (!account) continue;
    const balance = normalSide(account.kind) === "debit" ? debit - credit : credit - debit;
    rows.push({ accountId, code: account.code, kind: account.kind, debit, credit, balance });
    switch (account.kind) {
      case "asset":
        totals.assets += balance;
        break;
      case "liability":
        totals.liabilities += balance;
        break;
      case "equity":
        totals.equity += balance;
        break;
      case "revenue":
        totals.revenue += balance;
        break;
      case "expense":
        totals.expenses += balance;
        break;
      case "internal":
        totals.internal += balance;
        break;
    }
  }
  totals.netIncome = totals.revenue - totals.expenses;
  rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { from, asOf, rows, totals };
}

/** Assets = Liabilities + Net assets + Net income, with balanced debits/credits and internal = 0. */
export function assertTrialBalanceIdentity(tb: TrialBalance): void {
  const { totals } = tb;
  if (totals.debit !== totals.credit) {
    throw new LedgerInvariantError(
      "TRIAL_BALANCE_UNBALANCED",
      `debit ${formatYen(totals.debit)} ≠ credit ${formatYen(totals.credit)}`,
    );
  }
  if (totals.internal !== 0n) {
    throw new LedgerInvariantError(
      "INTERNAL_NONZERO",
      `internal accounts net to ${formatYen(totals.internal)}`,
    );
  }
  const rightSide = totals.liabilities + totals.equity + totals.netIncome;
  if (totals.assets !== rightSide) {
    throw new LedgerInvariantError(
      "TRIAL_BALANCE_IDENTITY",
      `assets ${formatYen(totals.assets)} ≠ liabilities ${formatYen(totals.liabilities)} + equity ${formatYen(totals.equity)} + net income ${formatYen(totals.netIncome)}`,
    );
  }
}
