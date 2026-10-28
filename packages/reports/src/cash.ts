/**
 * 現預金 (14-reports §6): cash on `to` by wallet, the daily balances of the period, the month-end
 * balances, and the difference to the statement balance (`balanceAfter`) of each wallet.
 */
import {
  addDays,
  daysBetween,
  normalSide,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";
import { monthsBetween, type MonthRange, type ReportPeriod } from "./period";
import {
  indexSource,
  type ReportAccount,
  type ReportSource,
  type ReportWallet,
  type SourceIndex,
} from "./source";

/** What the database knows about a wallet beyond the journal (`loadWalletStatus`). */
export interface WalletStatus {
  walletId: string;
  /** Statement lines still to handle (S4 / S5). */
  pendingCount: number;
  /** Last Stripe or bank API sync (the later of the two). */
  lastSyncedAt: Date | null;
  /** Last CSV / API import. */
  lastImportedAt: Date | null;
  /**
   * The last statement line on or before `through` that carries a balance, or the bank's own
   * balance (bank API) when it is dated on or before `through` and not before that line.
   */
  lastStatement: { date: CalendarDate; balanceAfter: Money } | null;
  /** The bank API connection (19-bank-api §4); `null` when the wallet has none. */
  bankApiStatus: "authorized" | "connected" | "reauth_required" | null;
}

export interface StatementDifference {
  date: CalendarDate;
  balanceAfter: Money;
  /** The wallet's book balance on `date`. */
  bookBalance: Money;
  /** balanceAfter − bookBalance (0 = 一致). */
  difference: Money;
}

export interface CashWalletRow {
  walletId: string;
  name: string;
  kind: ReportWallet["kind"];
  accountId: string;
  accountName: string;
  subAccountId: string | null;
  subAccountName: string | null;
  isCashLike: boolean;
  /** On the account's normal side: money held for cash accounts, money owed for card / owner. */
  balance: Money;
  pendingCount: number;
  lastActivityAt: Date | null;
  /** Only for cash-like wallets with a statement balance. */
  statement: StatementDifference | null;
  /** The bank API connection: 「再接続が必要」 on the wallet's card. */
  bankApiStatus: WalletStatus["bankApiStatus"];
}

export interface CashSeriesLine {
  key: string;
  label: string;
  balances: Money[];
}

export interface CashSeries {
  dates: CalendarDate[];
  wallets: CashSeriesLine[];
  /** All cash-like accounts (equals the report's total on the last date). */
  total: Money[];
}

export interface CashMonthEnds {
  columns: MonthRange[];
  rows: CashSeriesLine[];
  total: Money[];
}

export interface UnassignedCash {
  accountId: string;
  accountName: string;
  subAccountId: string | null;
  subAccountName: string | null;
  balance: Money;
}

export interface CashReport {
  period: ReportPeriod;
  asOf: CalendarDate;
  /** 現預金: every cash-like account through `to` (the same number as the trial balance). */
  total: Money;
  /** Active wallets on cash-like accounts. */
  wallets: CashWalletRow[];
  /** Active wallets on other accounts (cards, the officer's advances). */
  otherWallets: CashWalletRow[];
  /** Cash-like balances that no active wallet owns (lines without a sub-account, inactive wallets). */
  unassigned: UnassignedCash[];
  series: CashSeries;
  monthEnds: CashMonthEnds;
  empty: boolean;
}

function key(accountId: string, subAccountId: string | null): string {
  return `${accountId}\u0000${subAccountId ?? ""}`;
}

interface Bucket {
  account: ReportAccount;
  subAccountId: string | null;
  /** debit − credit before `from`. */
  opening: Money;
  /** debit − credit per date index of the period. */
  deltas: Map<number, Money>;
  /** debit − credit through `to` (= opening + all deltas). */
  closing: Money;
}

function collect(
  index: SourceIndex,
  period: ReportPeriod,
  accept: (account: ReportAccount) => boolean,
): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  for (const entry of index.entries) {
    if (entry.entryDate > period.to) continue;
    for (const line of entry.lines) {
      const account = index.accountsById.get(line.accountId);
      if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
      if (!accept(account)) continue;
      const k = key(account.id, line.subAccountId);
      let bucket = buckets.get(k);
      if (!bucket) {
        bucket = {
          account,
          subAccountId: line.subAccountId,
          opening: 0n,
          deltas: new Map(),
          closing: 0n,
        };
        buckets.set(k, bucket);
      }
      const net = line.side === "debit" ? line.amount : -line.amount;
      bucket.closing += net;
      if (entry.entryDate < period.from) bucket.opening += net;
      else {
        const day = daysBetween(period.from, entry.entryDate);
        bucket.deltas.set(day, (bucket.deltas.get(day) ?? 0n) + net);
      }
    }
  }
  return buckets;
}

function dailyBalances(bucket: Bucket | undefined, days: number, sign: bigint): Money[] {
  const balances: Money[] = [];
  let running = bucket?.opening ?? 0n;
  for (let day = 0; day < days; day += 1) {
    running += bucket?.deltas.get(day) ?? 0n;
    balances.push(sign * running);
  }
  return balances;
}

function sumSeries(lines: readonly Money[][], length: number): Money[] {
  const total = Array.from({ length }, () => 0n);
  for (const line of lines) line.forEach((value, i) => (total[i] = (total[i] ?? 0n) + value));
  return total;
}

/** The book balance of (account, sub-account) on `asOf`, debit − credit. */
function netOn(
  index: SourceIndex,
  accountId: string,
  subAccountId: string | null,
  asOf: CalendarDate,
): Money {
  let net: Money = 0n;
  for (const entry of index.entries) {
    if (entry.entryDate > asOf) continue;
    for (const line of entry.lines) {
      if (line.accountId !== accountId || (line.subAccountId ?? null) !== subAccountId) continue;
      net += line.side === "debit" ? line.amount : -line.amount;
    }
  }
  return net;
}

export function buildCashReport(
  source: ReportSource,
  period: ReportPeriod,
  status: readonly WalletStatus[] = [],
): CashReport {
  const index = indexSource(source);
  const statusById = new Map(status.map((row) => [row.walletId, row]));
  const walletAccounts = new Set(source.wallets.map((wallet) => wallet.accountId));
  const buckets = collect(
    index,
    period,
    (account) => account.isCashLike || walletAccounts.has(account.id),
  );
  const days = daysBetween(period.from, period.to) + 1;
  const dates: CalendarDate[] = Array.from({ length: days }, (_, i) => addDays(period.from, i));

  const owned = new Set<string>();
  const rowOf = (wallet: ReportWallet): CashWalletRow => {
    const account = index.accountsById.get(wallet.accountId);
    if (!account) throw new Error(`reports: account ${wallet.accountId} is not in the source`);
    const sign = normalSide(account.kind) === "debit" ? 1n : -1n;
    const bucket = buckets.get(key(wallet.accountId, wallet.subAccountId));
    owned.add(key(wallet.accountId, wallet.subAccountId));
    const walletStatus = statusById.get(wallet.id);
    const sub = wallet.subAccountId ? index.subAccountsById.get(wallet.subAccountId) : undefined;
    let statement: StatementDifference | null = null;
    if (account.isCashLike && walletStatus?.lastStatement) {
      const { date, balanceAfter } = walletStatus.lastStatement;
      const bookBalance = sign * netOn(index, wallet.accountId, wallet.subAccountId, date);
      statement = { date, balanceAfter, bookBalance, difference: balanceAfter - bookBalance };
    }
    const times = [walletStatus?.lastSyncedAt, walletStatus?.lastImportedAt].filter(
      (time): time is Date => time instanceof Date,
    );
    return {
      walletId: wallet.id,
      name: wallet.name,
      kind: wallet.kind,
      accountId: wallet.accountId,
      accountName: account.name,
      subAccountId: wallet.subAccountId,
      subAccountName: sub?.name ?? null,
      isCashLike: account.isCashLike,
      balance: sign * (bucket?.closing ?? 0n),
      pendingCount: walletStatus?.pendingCount ?? 0,
      lastActivityAt:
        times.length > 0 ? new Date(Math.max(...times.map((time) => time.getTime()))) : null,
      statement,
      bankApiStatus: walletStatus?.bankApiStatus ?? null,
    };
  };

  const activeWallets = source.wallets.filter((wallet) => wallet.isActive);
  const rows = activeWallets.map(rowOf);
  const wallets = rows.filter((row) => row.isCashLike);
  const otherWallets = rows.filter((row) => !row.isCashLike);

  let total: Money = 0n;
  const unassigned: UnassignedCash[] = [];
  for (const [k, bucket] of buckets) {
    if (!bucket.account.isCashLike) continue;
    total += bucket.closing;
    if (owned.has(k) || bucket.closing === 0n) continue;
    const sub = bucket.subAccountId ? index.subAccountsById.get(bucket.subAccountId) : undefined;
    unassigned.push({
      accountId: bucket.account.id,
      accountName: bucket.account.name,
      subAccountId: bucket.subAccountId,
      subAccountName: sub?.name ?? null,
      balance: bucket.closing,
    });
  }

  const subOrder = (id: string | null) => {
    const sub = id ? index.subAccountsById.get(id) : undefined;
    return sub ? { sortOrder: sub.sortOrder, name: sub.name } : { sortOrder: -1, name: "" };
  };
  unassigned.sort((a, b) => {
    const codeA = index.accountsById.get(a.accountId)?.code ?? "";
    const codeB = index.accountsById.get(b.accountId)?.code ?? "";
    if (codeA !== codeB) return codeA < codeB ? -1 : 1;
    const subA = subOrder(a.subAccountId);
    const subB = subOrder(b.subAccountId);
    return subA.sortOrder - subB.sortOrder || subA.name.localeCompare(subB.name, "ja");
  });

  const walletSeries: CashSeriesLine[] = wallets.map((row) => ({
    key: row.walletId,
    label: row.name,
    balances: dailyBalances(buckets.get(key(row.accountId, row.subAccountId)), days, 1n),
  }));
  const cashBuckets = [...buckets.values()].filter((bucket) => bucket.account.isCashLike);
  const totalSeries = sumSeries(
    cashBuckets.map((bucket) => dailyBalances(bucket, days, 1n)),
    days,
  );

  const columns = monthsBetween(period.from, period.to);
  const at = (line: Money[], date: CalendarDate) => line[daysBetween(period.from, date)] ?? 0n;
  const monthEnds: CashMonthEnds = {
    columns,
    rows: walletSeries.map((line) => ({
      key: line.key,
      label: line.label,
      balances: columns.map((column) => at(line.balances, column.to)),
    })),
    total: columns.map((column) => at(totalSeries, column.to)),
  };

  return {
    period,
    asOf: period.to,
    total,
    wallets,
    otherWallets,
    unassigned,
    series: { dates, wallets: walletSeries, total: totalSeries },
    monthEnds,
    empty: buckets.size === 0,
  };
}
