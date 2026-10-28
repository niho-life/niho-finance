/**
 * 試算表 (14-reports §3): the balance sheet on `to` and the income statement of `from`..`to`, as a
 * 合計残高試算表 (opening, debit, credit, balance per account), checked against the ledger's
 * trial balance identity.
 */
import {
  assertTrialBalanceIdentity,
  LedgerInvariantError,
  normalSide,
  trialBalance,
  type AccountKind,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";
import type { ReportPeriod } from "./period";
import {
  compareAccounts,
  compareSubAccounts,
  indexSource,
  withoutClosingOf,
  type ReportAccount,
  type ReportSource,
  type ReportSubAccount,
  type SourceIndex,
} from "./source";
import {
  layoutBalanceSheet,
  layoutIncomeStatement,
  type AccountValue,
  type BalanceSheetTotals,
  type IncomeSubtotals,
  type StatementRow,
  type VectorOps,
} from "./statements";

/** One account (or sub-account) of a 合計残高試算表. */
export interface TrialBalanceCell {
  /** Balance before `from` on the normal side (P&L accounts: since the start of the year). */
  opening: Money;
  debit: Money;
  credit: Money;
  /** debit − credit of `from`..`to` on the normal side (= balance − opening). */
  period: Money;
  /** opening + debit − credit on the normal side (cumulative). */
  balance: Money;
}

export const TRIAL_BALANCE_OPS: VectorOps<TrialBalanceCell> = {
  zero: () => ({ opening: 0n, debit: 0n, credit: 0n, period: 0n, balance: 0n }),
  add: (a, b) => ({
    opening: a.opening + b.opening,
    debit: a.debit + b.debit,
    credit: a.credit + b.credit,
    period: a.period + b.period,
    balance: a.balance + b.balance,
  }),
  sub: (a, b) => ({
    opening: a.opening - b.opening,
    debit: a.debit - b.debit,
    credit: a.credit - b.credit,
    period: a.period - b.period,
    balance: a.balance - b.balance,
  }),
  isZero: (a) => a.opening === 0n && a.debit === 0n && a.credit === 0n && a.balance === 0n,
};

export interface TrialBalanceCheck {
  ok: boolean;
  /** All lines through `to`. */
  debit: Money;
  credit: Money;
  /** debit − credit of internal accounts (must be 0). */
  internal: Money;
  /** assets − (liabilities + equity + net income). */
  difference: Money;
  /** Owner-facing explanations when `ok` is false. */
  messages: string[];
}

export interface TrialBalanceReport {
  period: ReportPeriod;
  balanceSheet: {
    rows: StatementRow<TrialBalanceCell>[];
    totals: BalanceSheetTotals<TrialBalanceCell>;
    /** Revenue − expenses from the start of the year through `to` (the whole company). */
    netIncome: Money;
    /** P&L of earlier years not transferred to retained earnings yet. */
    priorPeriodsProfit: Money;
  };
  incomeStatement: {
    rows: StatementRow<TrialBalanceCell>[];
    subtotals: IncomeSubtotals<TrialBalanceCell>;
    /** Revenue − expenses within `from`..`to` (the selected segment, if any). */
    netIncome: Money;
    /** Revenue − expenses from the start of the year through `to` (the selected segment). */
    netIncomeToDate: Money;
    filteredBySegment: boolean;
  };
  check: TrialBalanceCheck;
  /** No row at all: nothing posted through `to`. */
  empty: boolean;
}

interface NetCell {
  /** debit − credit before `from`. */
  openingNet: Money;
  debit: Money;
  credit: Money;
}

interface AccountCells {
  account: ReportAccount;
  total: NetCell;
  /** By sub-account id (`""` for lines without one). */
  subs: Map<string, NetCell>;
}

interface Aggregation {
  cells: Map<string, AccountCells>;
  /** credit − debit of P&L lines dated before the fiscal year, through `to`. */
  priorPeriodsProfit: Money;
}

function isProfitAndLoss(kind: AccountKind): boolean {
  return kind === "revenue" || kind === "expense" || kind === "internal";
}

function newNetCell(): NetCell {
  return { openingNet: 0n, debit: 0n, credit: 0n };
}

function addLine(cell: NetCell, side: "debit" | "credit", amount: Money, opening: boolean) {
  if (opening) cell.openingNet += side === "debit" ? amount : -amount;
  else if (side === "debit") cell.debit += amount;
  else cell.credit += amount;
}

/**
 * Sums the lines through `to` per account and sub-account. Balance-sheet lines before `from` go to
 * the opening; P&L lines before the fiscal year go to `priorPeriodsProfit`, between the year's
 * start and `from` to the opening. The segment filter applies to P&L (and internal) lines only.
 */
function aggregate(
  index: SourceIndex,
  period: Pick<ReportPeriod, "from" | "to" | "fiscalYear">,
  segmentId: string | null,
): Aggregation {
  const cells = new Map<string, AccountCells>();
  let priorPeriodsProfit: Money = 0n;
  const yearStart = period.fiscalYear.startDate;

  for (const entry of index.entries) {
    if (entry.entryDate > period.to) continue;
    const date = entry.entryDate;
    for (const line of entry.lines) {
      const account = index.accountsById.get(line.accountId);
      if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
      const profitAndLoss = isProfitAndLoss(account.kind);
      if (profitAndLoss) {
        if (segmentId !== null && line.segmentId !== segmentId) continue;
        if (date < yearStart) {
          priorPeriodsProfit += line.side === "credit" ? line.amount : -line.amount;
          continue;
        }
      }
      const opening = date < period.from;
      let accountCells = cells.get(account.id);
      if (!accountCells) {
        accountCells = { account, total: newNetCell(), subs: new Map() };
        cells.set(account.id, accountCells);
      }
      addLine(accountCells.total, line.side, line.amount, opening);
      const subKey = line.subAccountId ?? "";
      let sub = accountCells.subs.get(subKey);
      if (!sub) {
        sub = newNetCell();
        accountCells.subs.set(subKey, sub);
      }
      addLine(sub, line.side, line.amount, opening);
    }
  }
  return { cells, priorPeriodsProfit };
}

function toCell(kind: AccountKind, net: NetCell): TrialBalanceCell {
  const sign = normalSide(kind) === "debit" ? 1n : -1n;
  const closingNet = net.openingNet + net.debit - net.credit;
  return {
    opening: sign * net.openingNet,
    debit: net.debit,
    credit: net.credit,
    period: sign * (net.debit - net.credit),
    balance: sign * closingNet,
  };
}

function isEmptyCell(cell: TrialBalanceCell): boolean {
  return TRIAL_BALANCE_OPS.isZero(cell);
}

function accountValues(
  aggregation: Aggregation,
  index: SourceIndex,
  kinds: readonly AccountKind[],
): AccountValue<TrialBalanceCell>[] {
  const values: AccountValue<TrialBalanceCell>[] = [];
  const sortedCells = [...aggregation.cells.values()].sort((a, b) =>
    compareAccounts(a.account, b.account),
  );
  for (const { account, total, subs } of sortedCells) {
    if (!kinds.includes(account.kind)) continue;
    const value = toCell(account.kind, total);
    if (isEmptyCell(value)) continue;
    const subAccounts: { subAccount: ReportSubAccount | null; value: TrialBalanceCell }[] = [];
    if (subs.size > 1 || (subs.size === 1 && !subs.has(""))) {
      const list = [...subs.entries()].map(([subId, net]) => ({
        subAccount: subId ? (index.subAccountsById.get(subId) ?? null) : null,
        value: toCell(account.kind, net),
      }));
      list.sort((a, b) => {
        if (a.subAccount && b.subAccount) return compareSubAccounts(a.subAccount, b.subAccount);
        return a.subAccount ? -1 : b.subAccount ? 1 : 0;
      });
      subAccounts.push(...list.filter((sub) => !isEmptyCell(sub.value)));
    }
    values.push(subAccounts.length > 0 ? { account, value, subAccounts } : { account, value });
  }
  return values;
}

/** Net income (revenue − expenses) through the closing balances of P&L accounts. */
function netIncomeOf(values: readonly AccountValue<TrialBalanceCell>[]): Money {
  let total: Money = 0n;
  for (const { account, value } of values) {
    if (account.kind === "revenue") total += value.balance;
    else if (account.kind === "expense") total -= value.balance;
  }
  return total;
}

function runLedgerCheck(
  source: ReportSource,
  index: SourceIndex,
  period: ReportPeriod,
  computed: { assets: Money; liabilities: Money; equity: Money; netIncome: Money; prior: Money },
): TrialBalanceCheck {
  const messages: string[] = [];
  let tb;
  try {
    tb = trialBalance(index.entries, source.accounts, period.fiscalYear, { asOf: period.to });
    assertTrialBalanceIdentity(tb);
  } catch (error) {
    if (error instanceof LedgerInvariantError) messages.push(error.message);
    else throw error;
  }
  const debit = tb?.totals.debit ?? 0n;
  const credit = tb?.totals.credit ?? 0n;
  const internal = tb?.totals.internal ?? 0n;
  // `computed.equity` already holds the prior periods' profit and the net income.
  const difference = computed.assets - (computed.liabilities + computed.equity);
  if (difference !== 0n) {
    messages.push(
      `資産と負債・純資産の合計が ${difference.toString()} 円合いません。監査ログを確かめてください`,
    );
  }
  if (tb) {
    const equityWithPrior = computed.equity - computed.netIncome;
    if (
      tb.totals.assets !== computed.assets ||
      tb.totals.liabilities !== computed.liabilities ||
      tb.totals.equity !== equityWithPrior ||
      tb.totals.netIncome !== computed.netIncome ||
      tb.totals.priorPeriodsProfit !== computed.prior
    ) {
      messages.push("試算表の集計が台帳の計算と合いません。監査ログを確かめてください");
    }
  }
  return { ok: messages.length === 0, debit, credit, internal, difference, messages };
}

const BALANCE_SHEET_KINDS: readonly AccountKind[] = ["asset", "liability", "equity"];
const INCOME_KINDS: readonly AccountKind[] = ["revenue", "expense"];

export function buildTrialBalance(
  reportSource: ReportSource,
  period: ReportPeriod,
): TrialBalanceReport {
  // The year's 決算振替 would zero its P&L (14 §1); the ledger check sees the same entries.
  const source = withoutClosingOf(reportSource, period.fiscalYear.id);
  const index = indexSource(source);
  const all = aggregate(index, period, null);
  const filtered = period.segmentId ? aggregate(index, period, period.segmentId) : all;

  const bsValues = accountValues(all, index, BALANCE_SHEET_KINDS);
  const plAllValues = accountValues(all, index, INCOME_KINDS);
  const netIncome = netIncomeOf(plAllValues);
  const priorPeriodsProfit = all.priorPeriodsProfit;
  const companyIncome = layoutIncomeStatement(plAllValues, TRIAL_BALANCE_OPS);
  const companyNetIncome = companyIncome.subtotals.netIncome;
  // 当期純利益 on the balance sheet opens with the profit before `from` (from the start of the
  // year) and moves by the period's profit, so 純資産 and 負債・純資産 合計 open with the same
  // amount as 資産 合計. Earlier years' profit does not move within the year.
  const balanceSheet = layoutBalanceSheet(bsValues, TRIAL_BALANCE_OPS, {
    netIncome: {
      opening: companyNetIncome.opening,
      debit: 0n,
      credit: 0n,
      period: companyNetIncome.period,
      balance: netIncome,
    },
    priorPeriodsProfit: {
      opening: priorPeriodsProfit,
      debit: 0n,
      credit: 0n,
      period: 0n,
      balance: priorPeriodsProfit,
    },
  });

  const incomeStatement = period.segmentId
    ? layoutIncomeStatement(accountValues(filtered, index, INCOME_KINDS), TRIAL_BALANCE_OPS)
    : companyIncome;

  const check = runLedgerCheck(source, index, period, {
    assets: balanceSheet.totals.assets.balance,
    liabilities: balanceSheet.totals.liabilities.balance,
    equity: balanceSheet.totals.equity.balance,
    netIncome,
    prior: priorPeriodsProfit,
  });

  return {
    period,
    balanceSheet: {
      rows: balanceSheet.rows,
      totals: balanceSheet.totals,
      netIncome,
      priorPeriodsProfit,
    },
    incomeStatement: {
      rows: incomeStatement.rows,
      subtotals: incomeStatement.subtotals,
      netIncome: incomeStatement.subtotals.netIncome.period,
      netIncomeToDate: incomeStatement.subtotals.netIncome.balance,
      filteredBySegment: period.segmentId !== null,
    },
    check,
    empty: bsValues.length === 0 && plAllValues.length === 0,
  };
}

/** The balance of one account (optionally one sub-account) on `asOf`, on its normal side. */
export function balanceOn(
  index: SourceIndex,
  accountId: string,
  subAccountId: string | null | undefined,
  asOf: CalendarDate,
  options: { segmentId?: string | null; since?: CalendarDate } = {},
): Money {
  const account = index.accountsById.get(accountId);
  if (!account) throw new Error(`reports: account ${accountId} is not in the source`);
  const sign = normalSide(account.kind) === "debit" ? 1n : -1n;
  let net: Money = 0n;
  for (const entry of index.entries) {
    if (entry.entryDate > asOf) continue;
    if (options.since !== undefined && entry.entryDate < options.since) continue;
    for (const line of entry.lines) {
      if (line.accountId !== accountId) continue;
      if (subAccountId !== undefined && (line.subAccountId ?? null) !== subAccountId) continue;
      if (options.segmentId && line.segmentId !== options.segmentId) continue;
      net += line.side === "debit" ? line.amount : -line.amount;
    }
  }
  return sign * net;
}
