import { ACCOUNT_GROUP_LABELS, type Money } from "@niho-finance/ledger";
import {
  buildTrialBalance,
  type ReportPeriod,
  type ReportSource,
  type StatementRow,
  type StatementRowKind,
  type TrialBalanceCell,
  type TrialBalanceReport,
} from "@niho-finance/reports";

/**
 * One row of 試算表 as shown on screen, in CSV and in PDF (14-reports §3). Accounts and groups
 * carry 期首・借方・貸方・残高; subtotals and totals carry 「期間」 (残高 − 期首) instead of
 * 借方・貸方 (`debit` / `credit` are `null`); section headings carry no amount.
 */
export interface TrialBalanceLine {
  kind: StatementRowKind;
  key: string;
  label: string;
  level: number;
  code: string | null;
  accountId: string | null;
  subAccountId: string | null;
  /** 流動資産 … (the 区分 column of the CSV); the section for headings. */
  groupLabel: string | null;
  /** For sub-account rows: the account's name (「普通預金 / 架空銀行 普通」 in CSV and PDF). */
  parentLabel: string | null;
  opening: Money | null;
  debit: Money | null;
  credit: Money | null;
  period: Money | null;
  balance: Money | null;
}

export interface TrialBalanceView {
  report: TrialBalanceReport;
  balanceSheet: TrialBalanceLine[];
  incomeStatement: TrialBalanceLine[];
}

function line(
  row: StatementRow<TrialBalanceCell>,
  parentLabel: string | null,
  amounts: Pick<TrialBalanceLine, "opening" | "debit" | "credit" | "period" | "balance">,
  groupLabel: string | null,
): TrialBalanceLine {
  return {
    kind: row.kind,
    key: row.key,
    label: row.label,
    level: row.level,
    code: row.code ?? null,
    accountId: row.accountId ?? null,
    subAccountId: row.subAccountId ?? null,
    groupLabel,
    parentLabel,
    ...amounts,
  };
}

function full(cell: TrialBalanceCell) {
  return {
    opening: cell.opening,
    debit: cell.debit,
    credit: cell.credit,
    period: cell.period,
    balance: cell.balance,
  };
}

function net(opening: Money, balance: Money) {
  return { opening, debit: null, credit: null, period: balance - opening, balance };
}

const NO_AMOUNTS = { opening: null, debit: null, credit: null, period: null, balance: null };

function toLines(
  rows: readonly StatementRow<TrialBalanceCell>[],
  netRow: (row: StatementRow<TrialBalanceCell>) => ReturnType<typeof net>,
): TrialBalanceLine[] {
  const lines: TrialBalanceLine[] = [];
  let section: string | null = null;
  let account: string | null = null;
  for (const row of rows) {
    const groupLabel = row.group ? ACCOUNT_GROUP_LABELS[row.group] : section;
    switch (row.kind) {
      case "section":
        section = row.label;
        lines.push(line(row, null, NO_AMOUNTS, row.label));
        break;
      case "group":
        lines.push(line(row, null, full(row.value), groupLabel));
        break;
      case "account":
        account = row.label;
        lines.push(line(row, null, full(row.value), groupLabel));
        break;
      case "subAccount":
        lines.push(line(row, account, full(row.value), groupLabel));
        break;
      case "subtotal":
      case "total":
        lines.push(line(row, null, netRow(row), null));
        break;
    }
  }
  return lines;
}

/**
 * The view of a trial balance. Every subtotal and total (including the balance sheet's 当期純利益,
 * whose 期首 the package fills from the profit before `from`) shows 期首・期間・残高.
 */
export function trialBalanceView(report: TrialBalanceReport): TrialBalanceView {
  const netRow = (row: StatementRow<TrialBalanceCell>) => net(row.value.opening, row.value.balance);
  return {
    report,
    balanceSheet: toLines(report.balanceSheet.rows, netRow),
    incomeStatement: toLines(report.incomeStatement.rows, netRow),
  };
}

export function buildTrialBalanceView(
  source: ReportSource,
  period: ReportPeriod,
): TrialBalanceView {
  return trialBalanceView(buildTrialBalance(source, period));
}
