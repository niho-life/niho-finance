/**
 * 勘定科目内訳明細書の元データ (17-financial-statements §7): what the tax accountant needs to fill in
 * the 内訳書 (the forms themselves are not made here). One CSV, aggregated per account × sub-account
 * × partner (the line's partner, else the sub-account's). Balance-sheet accounts carry the opening
 * balance, the year's debits and credits and the closing balance; P&L accounts the year's amount.
 * The accounts of each 内訳書 are looked up by the standard chart code.
 */
import { normalSide, type Money } from "@niho-finance/ledger";
import { csvText, encodeCsv } from "../csv";
import { reportFileName } from "../format";
import {
  requireFiscalYear,
  yearEntries,
  type FinancialStatementsAccount,
  type FinancialStatementsFiscalYear,
  type FinancialStatementsSource,
} from "./source";

export interface AccountDetailSchedule {
  key: string;
  /** 内訳書の名前 */
  name: string;
  /** Standard chart codes, in the order to show. */
  accountCodes: readonly string[];
}

export const ACCOUNT_DETAIL_SCHEDULES: readonly AccountDetailSchedule[] = [
  { key: "deposits", name: "預貯金等の内訳書", accountCodes: ["1000", "1100", "1150"] },
  { key: "receivables", name: "売掛金（未収入金）の内訳書", accountCodes: ["1200", "1250"] },
  { key: "advances", name: "仮払金（前渡金）の内訳書", accountCodes: ["1310", "1360"] },
  {
    key: "payables",
    name: "買掛金（未払金・未払費用）の内訳書",
    accountCodes: ["2000", "2100", "2110"],
  },
  { key: "receipts", name: "仮受金（前受金・預り金）の内訳書", accountCodes: ["2200", "2300"] },
  {
    key: "borrowings",
    name: "借入金及び支払利子の内訳書",
    accountCodes: ["2400", "2500", "2600", "5500"],
  },
  {
    key: "officers",
    name: "役員報酬手当等及び人件費の内訳書",
    accountCodes: ["5200", "5210", "5220"],
  },
  { key: "rent", name: "地代家賃等の内訳書", accountCodes: ["5300"] },
  { key: "miscellaneous", name: "雑益、雑損失等の内訳書", accountCodes: ["4510", "5600"] },
];

export interface AccountDetailRow {
  /** 内訳書の名前 */
  schedule: string;
  /** The 合計 row of a 内訳書. */
  total: boolean;
  accountId: string | null;
  accountCode: string;
  accountName: string;
  subAccountName: string | null;
  /** 「合計」 on the total row. */
  partnerName: string | null;
  partnerAddress: string | null;
  /** Balance-sheet accounts (normal side); `null` for P&L accounts. */
  opening: Money | null;
  debit: Money | null;
  credit: Money | null;
  closing: Money | null;
  /** P&L accounts: the year's amount (normal side); `null` for balance-sheet accounts. */
  periodAmount: Money | null;
  /** Lines of the year aggregated. */
  lineCount: number;
}

export interface AccountDetails {
  fiscalYear: FinancialStatementsFiscalYear;
  rows: AccountDetailRow[];
}

export const ACCOUNT_DETAILS_CSV_HEADER = [
  "内訳書",
  "科目コード",
  "科目",
  "補助科目",
  "取引先",
  "取引先の所在地",
  "期首残高",
  "期中の借方",
  "期中の貸方",
  "期末残高",
  "期中の金額",
  "件数",
] as const;

export const ACCOUNT_DETAILS_TOTAL_LABEL = "合計";

interface Cell {
  account: FinancialStatementsAccount;
  subAccountId: string | null;
  partnerId: string | null;
  openingNet: Money;
  debit: Money;
  credit: Money;
  lineCount: number;
}

function isBalanceSheet(account: FinancialStatementsAccount): boolean {
  return account.kind === "asset" || account.kind === "liability" || account.kind === "equity";
}

export function buildAccountDetails(
  source: FinancialStatementsSource,
  fiscalYearId: string,
): AccountDetails {
  const fiscalYear = requireFiscalYear(source, fiscalYearId);
  const parts = yearEntries(source, fiscalYear);
  const accountsByCode = new Map<string, FinancialStatementsAccount>();
  for (const account of source.accounts) accountsByCode.set(account.code, account);
  const scheduleOf = new Map<string, AccountDetailSchedule>();
  for (const schedule of ACCOUNT_DETAIL_SCHEDULES) {
    for (const code of schedule.accountCodes) {
      const account = accountsByCode.get(code);
      if (account) scheduleOf.set(account.id, schedule);
    }
  }
  const subAccounts = new Map(source.subAccounts.map((sub) => [sub.id, sub]));
  const partners = new Map(source.partners.map((partner) => [partner.id, partner]));
  const accountsById = new Map(source.accounts.map((account) => [account.id, account]));

  const cells = new Map<string, Cell>();
  const add = (entries: typeof parts.year, inYear: boolean) => {
    for (const entry of entries) {
      for (const line of entry.lines) {
        if (!scheduleOf.has(line.accountId)) continue;
        const account = accountsById.get(line.accountId);
        if (!account) continue;
        // Balance-sheet accounts open with the earlier lines; P&L accounts count the year only.
        if (!inYear && !isBalanceSheet(account)) continue;
        const subAccountId = line.subAccountId ?? null;
        const partnerId =
          line.partnerId ??
          (subAccountId ? (subAccounts.get(subAccountId)?.partnerId ?? null) : null);
        const key = `${account.id}|${subAccountId ?? ""}|${partnerId ?? ""}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = {
            account,
            subAccountId,
            partnerId,
            openingNet: 0n,
            debit: 0n,
            credit: 0n,
            lineCount: 0,
          };
          cells.set(key, cell);
        }
        const net = line.side === "debit" ? line.amount : -line.amount;
        if (!inYear) {
          cell.openingNet += net;
          continue;
        }
        if (line.side === "debit") cell.debit += line.amount;
        else cell.credit += line.amount;
        cell.lineCount += 1;
      }
    }
  };
  add(parts.before, false);
  add(parts.year, true);

  const detail = (cell: Cell): AccountDetailRow => {
    const sign = normalSide(cell.account.kind) === "debit" ? 1n : -1n;
    const movement = sign * (cell.debit - cell.credit);
    const sub = cell.subAccountId ? subAccounts.get(cell.subAccountId) : undefined;
    const partner = cell.partnerId ? partners.get(cell.partnerId) : undefined;
    const balanceSheet = isBalanceSheet(cell.account);
    const opening = sign * cell.openingNet;
    return {
      schedule: scheduleOf.get(cell.account.id)!.name,
      total: false,
      accountId: cell.account.id,
      accountCode: cell.account.code,
      accountName: cell.account.name,
      subAccountName: sub?.name ?? null,
      partnerName: partner?.name ?? null,
      partnerAddress: partner?.address ?? null,
      opening: balanceSheet ? opening : null,
      debit: balanceSheet ? cell.debit : null,
      credit: balanceSheet ? cell.credit : null,
      closing: balanceSheet ? opening + movement : null,
      periodAmount: balanceSheet ? null : movement,
      lineCount: cell.lineCount,
    };
  };

  const rows: AccountDetailRow[] = [];
  for (const schedule of ACCOUNT_DETAIL_SCHEDULES) {
    const list = [...cells.values()]
      .filter((cell) => scheduleOf.get(cell.account.id) === schedule)
      .map(detail)
      .filter((row) => (row.closing ?? 0n) !== 0n || (row.periodAmount ?? 0n) !== 0n);
    if (list.length === 0) continue;
    const order = new Map(schedule.accountCodes.map((code, i) => [code, i]));
    list.sort((a, b) => {
      const byAccount = (order.get(a.accountCode) ?? 0) - (order.get(b.accountCode) ?? 0);
      if (byAccount !== 0) return byAccount;
      const av = a.closing ?? a.periodAmount ?? 0n;
      const bv = b.closing ?? b.periodAmount ?? 0n;
      if (av !== bv) return av > bv ? -1 : 1;
      const an = `${a.subAccountName ?? ""}|${a.partnerName ?? ""}`;
      const bn = `${b.subAccountName ?? ""}|${b.partnerName ?? ""}`;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const sum = (pick: (row: AccountDetailRow) => Money | null): Money | null => {
      const values = list.map(pick).filter((value): value is Money => value !== null);
      return values.length === 0 ? null : values.reduce((a, b) => a + b, 0n);
    };
    rows.push(...list, {
      schedule: schedule.name,
      total: true,
      accountId: null,
      accountCode: "",
      accountName: "",
      subAccountName: null,
      partnerName: ACCOUNT_DETAILS_TOTAL_LABEL,
      partnerAddress: null,
      opening: sum((row) => row.opening),
      debit: sum((row) => row.debit),
      credit: sum((row) => row.credit),
      closing: sum((row) => row.closing),
      periodAmount: sum((row) => row.periodAmount),
      lineCount: list.reduce((total, row) => total + row.lineCount, 0),
    });
  }
  return { fiscalYear, rows };
}

export function accountDetailsCsvRows(details: AccountDetails): (string | bigint | number)[][] {
  const rows: (string | bigint | number)[][] = [[...ACCOUNT_DETAILS_CSV_HEADER]];
  for (const row of details.rows) {
    rows.push([
      row.schedule,
      row.accountCode,
      row.accountName,
      row.subAccountName ?? "",
      row.partnerName ?? "",
      row.partnerAddress ?? "",
      row.opening ?? "",
      row.debit ?? "",
      row.credit ?? "",
      row.closing ?? "",
      row.periodAmount ?? "",
      row.lineCount,
    ]);
  }
  return rows;
}

/** The text of `account-details_<from>-<to>.csv` (CRLF; `accountDetailsCsv` adds the BOM). */
export function accountDetailsCsvText(details: AccountDetails): string {
  return csvText(accountDetailsCsvRows(details));
}

/** `account-details_<from>-<to>.csv`, UTF-8 with a BOM (14 §1). */
export function accountDetailsCsv(details: AccountDetails): {
  fileName: string;
  bytes: Uint8Array;
} {
  return {
    fileName: reportFileName(
      "account-details",
      details.fiscalYear.startDate,
      details.fiscalYear.endDate,
      "csv",
    ),
    bytes: encodeCsv(accountDetailsCsvText(details), "utf8"),
  };
}
