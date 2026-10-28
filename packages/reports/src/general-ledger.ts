/**
 * 総勘定元帳 (14-reports §8): one account (optionally one sub-account) over `from`..`to`, one row
 * per line with the counter account and the running balance, with the opening and the totals.
 */
import { normalSide, type CalendarDate, type EntryStatus, type Money } from "@niho-finance/ledger";
import { slashDate } from "./format";
import { entryStateLabel } from "./labels";
import type { ReportPeriod } from "./period";
import {
  compareAccounts,
  compareSubAccounts,
  indexSource,
  type ReportAccount,
  type ReportEntry,
  type ReportLine,
  type ReportSource,
  type ReportSubAccount,
  type SourceIndex,
} from "./source";

export const COUNTERPART_SUNDRY = "諸口";

export interface LedgerRow {
  entryId: string;
  no: number;
  entryDate: CalendarDate;
  description: string;
  /** The line's own 摘要, if any. */
  lineDescription: string | null;
  /** 相手科目: the account on the other side (「科目 / 補助」), or 諸口 when there are several. */
  counterpart: string;
  debit: Money;
  credit: Money;
  /** Running balance on the account's normal side, after this row. */
  balance: Money;
  status: EntryStatus;
  stateLabel: string | null;
  segmentName: string | null;
  partnerName: string | null;
}

export interface GeneralLedgerReport {
  period: ReportPeriod;
  account: ReportAccount;
  subAccount: ReportSubAccount | null;
  /** Sub-accounts of the account that have lines through `to` (the chips). */
  subAccounts: ReportSubAccount[];
  /** Balance before `from` on the normal side (P&L accounts: since the start of the year). */
  opening: Money;
  rows: LedgerRow[];
  debitTotal: Money;
  creditTotal: Money;
  /** opening + debit − credit on the normal side (= the trial balance's balance). */
  closing: Money;
  empty: boolean;
}

export interface LedgerAccountChoices {
  /** Accounts with a line in the period or an opening balance, by code. */
  active: ReportAccount[];
  /** The remaining active accounts, by code. */
  others: ReportAccount[];
}

function isProfitAndLoss(account: ReportAccount): boolean {
  return account.kind === "revenue" || account.kind === "expense" || account.kind === "internal";
}

function counterpartOf(entry: ReportEntry, line: ReportLine, index: SourceIndex): string {
  const others = new Set<string>();
  for (const other of entry.lines) {
    if (other.side === line.side) continue;
    const account = index.accountsById.get(other.accountId);
    if (!account) throw new Error(`reports: account ${other.accountId} is not in the source`);
    const sub = other.subAccountId ? index.subAccountsById.get(other.subAccountId) : undefined;
    others.add(sub ? `${account.name} / ${sub.name}` : account.name);
  }
  if (others.size === 1) return [...others][0] ?? COUNTERPART_SUNDRY;
  return COUNTERPART_SUNDRY;
}

export function buildGeneralLedger(
  source: ReportSource,
  period: ReportPeriod,
  target: { accountId: string; subAccountId?: string | null },
): GeneralLedgerReport {
  const index = indexSource(source);
  const account = index.accountsById.get(target.accountId);
  if (!account) throw new Error(`reports: account ${target.accountId} is not in the source`);
  const subAccountId = target.subAccountId ?? null;
  const subAccount = subAccountId ? (index.subAccountsById.get(subAccountId) ?? null) : null;
  const sign = normalSide(account.kind) === "debit" ? 1n : -1n;
  const since = isProfitAndLoss(account) ? period.fiscalYear.startDate : undefined;

  const usedSubs = new Set<string>();
  let openingNet: Money = 0n;
  const rows: LedgerRow[] = [];
  let debitTotal: Money = 0n;
  let creditTotal: Money = 0n;
  let running: Money = 0n;

  const accepted = (line: ReportLine): boolean => {
    if (line.accountId !== account.id) return false;
    if (subAccountId !== null && line.subAccountId !== subAccountId) return false;
    if (period.segmentId && line.segmentId !== period.segmentId) return false;
    return true;
  };

  // Opening first (the entries are in date order, so one pass works, but keep it explicit).
  for (const entry of index.entries) {
    if (entry.entryDate >= period.from) break;
    if (since !== undefined && entry.entryDate < since) continue;
    for (const line of entry.lines) {
      if (line.accountId === account.id && line.subAccountId) usedSubs.add(line.subAccountId);
      if (!accepted(line)) continue;
      openingNet += line.side === "debit" ? line.amount : -line.amount;
    }
  }
  running = openingNet;
  for (const entry of index.entries) {
    if (entry.entryDate < period.from || entry.entryDate > period.to) continue;
    for (const line of entry.lines) {
      if (line.accountId === account.id && line.subAccountId) usedSubs.add(line.subAccountId);
      if (!accepted(line)) continue;
      const debit = line.side === "debit" ? line.amount : 0n;
      const credit = line.side === "credit" ? line.amount : 0n;
      debitTotal += debit;
      creditTotal += credit;
      running += debit - credit;
      const segment = line.segmentId ? index.segmentsById.get(line.segmentId) : undefined;
      const partner = line.partnerId ? index.partnersById.get(line.partnerId) : undefined;
      rows.push({
        entryId: entry.id,
        no: entry.no,
        entryDate: entry.entryDate,
        description: entry.description,
        lineDescription: line.description,
        counterpart: counterpartOf(entry, line, index),
        debit,
        credit,
        balance: sign * running,
        status: entry.status,
        stateLabel: entryStateLabel(entry, index),
        segmentName: segment?.name ?? null,
        partnerName: partner?.name ?? null,
      });
    }
  }

  const subAccounts = source.subAccounts
    .filter((sub) => sub.accountId === account.id && usedSubs.has(sub.id))
    .sort(compareSubAccounts);

  return {
    period,
    account,
    subAccount,
    subAccounts,
    opening: sign * openingNet,
    rows,
    debitTotal,
    creditTotal,
    closing: sign * running,
    empty: rows.length === 0 && openingNet === 0n,
  };
}

/** The accounts to choose from (14-reports §8): used ones first. */
export function ledgerAccountChoices(
  source: ReportSource,
  period: ReportPeriod,
): LedgerAccountChoices {
  const index = indexSource(source);
  const used = new Set<string>();
  for (const entry of index.entries) {
    if (entry.entryDate > period.to) continue;
    for (const line of entry.lines) {
      const account = index.accountsById.get(line.accountId);
      if (!account) continue;
      if (isProfitAndLoss(account) && entry.entryDate < period.fiscalYear.startDate) continue;
      used.add(line.accountId);
    }
  }
  const sorted = [...source.accounts].sort(compareAccounts);
  return {
    active: sorted.filter((account) => used.has(account.id)),
    others: sorted.filter((account) => !used.has(account.id) && account.isActive),
  };
}

export const LEDGER_CSV_HEADER = [
  "日付",
  "No.",
  "摘要",
  "相手科目",
  "借方",
  "貸方",
  "残高",
] as const;

export function ledgerCsvRows(report: GeneralLedgerReport): (string | bigint | number)[][] {
  const rows: (string | bigint | number)[][] = [[...LEDGER_CSV_HEADER]];
  rows.push([slashDate(report.period.from), "", "繰越", "", "", "", report.opening]);
  for (const row of report.rows) {
    rows.push([
      slashDate(row.entryDate),
      row.no,
      row.lineDescription ? `${row.description}（${row.lineDescription}）` : row.description,
      row.counterpart,
      row.debit,
      row.credit,
      row.balance,
    ]);
  }
  rows.push([
    slashDate(report.period.to),
    "",
    "合計",
    "",
    report.debitTotal,
    report.creditTotal,
    report.closing,
  ]);
  return rows;
}
