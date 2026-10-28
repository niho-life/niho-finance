/**
 * 附属明細書 (17-financial-statements §4.7, 会社計算規則 117 条): 有形固定資産及び無形固定資産の明細
 * (from the fixed asset register of #14, passed in as `FixedAssetScheduleRow[]`; `null` until it is
 * connected), 引当金の明細 (the accounts under the provision titles of the code table) and 販売費及び
 * 一般管理費の明細 (whose total equals the income statement's).
 */
import type { Money } from "@niho-finance/ledger";
import type { EtaxEdition } from "./etax/editions";
import type { AccountEtaxCode } from "./etax/mapping";
import { normalAmount } from "./statements";
import type { FinancialStatementsAccount } from "./source";
import type { ReportEntry } from "../source";

/** One kind of asset of 有形固定資産及び無形固定資産の明細 (filled from #14's `FixedAsset`). */
export interface FixedAssetScheduleRow {
  /** 資産の種類 (工具、器具及び備品 / ソフトウエア …) */
  assetType: string;
  kind: "tangible" | "intangible";
  /** 期首帳簿価額 */
  openingBookValue: Money;
  /** 当期増加額 */
  increase: Money;
  /** 当期減少額 */
  decrease: Money;
  /** 当期償却額 */
  depreciation: Money;
  /** 期末帳簿価額 */
  closingBookValue: Money;
  /** 減価償却累計額 */
  accumulatedDepreciation: Money;
  /** 期末取得原価 */
  closingAcquisitionCost: Money;
}

export type FixedAssetScheduleTotals = Omit<FixedAssetScheduleRow, "assetType" | "kind">;

export interface FixedAssetSchedule {
  rows: readonly FixedAssetScheduleRow[];
  tangible: FixedAssetScheduleTotals;
  intangible: FixedAssetScheduleTotals;
  /** 「固定資産台帳の反映後に出ます」 until the register is connected. */
  message: string | null;
  /** Rows whose 期末帳簿価額 ≠ 期首 + 増加 − 減少 − 償却, or 期末取得原価 ≠ 帳簿価額 + 累計額. */
  inconsistentRows: string[];
}

export interface ProvisionScheduleRow {
  accountId: string;
  label: string;
  /** 期首残高 */
  opening: Money;
  /** 当期増加額 */
  increase: Money;
  /** 当期減少額（目的使用） */
  usedForPurpose: Money;
  /** 当期減少額（その他）: reversals into income (戻入). */
  otherDecrease: Money;
  /** 期末残高 */
  closing: Money;
}

export interface ProvisionSchedule {
  rows: ProvisionScheduleRow[];
  /** 「該当がありません」 when there is none. */
  message: string | null;
}

export interface SgaScheduleRow {
  accountId: string;
  code: string;
  label: string;
  amount: Money;
}

export interface SgaSchedule {
  rows: SgaScheduleRow[];
  total: Money;
  /** The total equals 販売費及び一般管理費 of the income statement. */
  matchesIncomeStatement: boolean;
}

export interface SupplementarySchedules {
  fixedAssets: FixedAssetSchedule;
  provisions: ProvisionSchedule;
  sga: SgaSchedule;
}

export const FIXED_ASSETS_PENDING_MESSAGE = "固定資産台帳の反映後に出ます";
export const NOTHING_TO_SHOW_MESSAGE = "該当がありません";

function zeroTotals(): FixedAssetScheduleTotals {
  return {
    openingBookValue: 0n,
    increase: 0n,
    decrease: 0n,
    depreciation: 0n,
    closingBookValue: 0n,
    accumulatedDepreciation: 0n,
    closingAcquisitionCost: 0n,
  };
}

function addRow(totals: FixedAssetScheduleTotals, row: FixedAssetScheduleRow) {
  totals.openingBookValue += row.openingBookValue;
  totals.increase += row.increase;
  totals.decrease += row.decrease;
  totals.depreciation += row.depreciation;
  totals.closingBookValue += row.closingBookValue;
  totals.accumulatedDepreciation += row.accumulatedDepreciation;
  totals.closingAcquisitionCost += row.closingAcquisitionCost;
}

export function buildFixedAssetSchedule(
  rows: readonly FixedAssetScheduleRow[] | null,
): FixedAssetSchedule {
  const tangible = zeroTotals();
  const intangible = zeroTotals();
  if (rows === null) {
    return {
      rows: [],
      tangible,
      intangible,
      message: FIXED_ASSETS_PENDING_MESSAGE,
      inconsistentRows: [],
    };
  }
  const inconsistentRows: string[] = [];
  for (const row of rows) {
    addRow(row.kind === "tangible" ? tangible : intangible, row);
    const bookValue = row.openingBookValue + row.increase - row.decrease - row.depreciation;
    const cost = row.closingBookValue + row.accumulatedDepreciation;
    if (bookValue !== row.closingBookValue || cost !== row.closingAcquisitionCost) {
      inconsistentRows.push(row.assetType);
    }
  }
  return {
    rows,
    tangible,
    intangible,
    message: rows.length === 0 ? NOTHING_TO_SHOW_MESSAGE : null,
    inconsistentRows,
  };
}

export interface ProvisionScheduleInput {
  edition: EtaxEdition;
  accounts: readonly FinancialStatementsAccount[];
  codes: ReadonlyMap<string, AccountEtaxCode>;
  /** debit − credit per account before the year (当期首残高). */
  openingNet: ReadonlyMap<string, Money>;
  /** The movements of the year (closing entries left out). */
  entries: readonly ReportEntry[];
}

/** 引当金の明細: the accounts whose code lies under a provision title of the BS table. */
export function buildProvisionSchedule(input: ProvisionScheduleInput): ProvisionSchedule {
  const table = input.edition.tables.BS;
  const ranges = input.edition.layout.provisionTitles.map((code) => {
    const start = table.positions.get(code) ?? -1;
    return { start, end: start === -1 ? -1 : (table.subtreeEnds[start] ?? start + 1) };
  });
  const provisionAccounts = input.accounts.filter((account) => {
    const code = input.codes.get(account.id);
    if (!code || code.statement !== "BS") return false;
    const position = table.positions.get(code.code);
    if (position === undefined) return false;
    return ranges.some(({ start, end }) => start !== -1 && position >= start && position < end);
  });

  const rows: ProvisionScheduleRow[] = [];
  for (const account of provisionAccounts) {
    let increase: Money = 0n;
    let usedForPurpose: Money = 0n;
    let otherDecrease: Money = 0n;
    for (const entry of input.entries) {
      const reversedIntoIncome = entry.lines.some(
        (line) =>
          line.side === "credit" &&
          line.accountId !== account.id &&
          isRevenue(input.accounts, line.accountId),
      );
      for (const line of entry.lines) {
        if (line.accountId !== account.id) continue;
        if (line.side === "credit") increase += line.amount;
        else if (reversedIntoIncome) otherDecrease += line.amount;
        else usedForPurpose += line.amount;
      }
    }
    const opening = normalAmount(account, input.openingNet.get(account.id) ?? 0n);
    const closing = opening + increase - usedForPurpose - otherDecrease;
    if (opening === 0n && increase === 0n && usedForPurpose === 0n && otherDecrease === 0n)
      continue;
    rows.push({
      accountId: account.id,
      label: account.name,
      opening,
      increase,
      usedForPurpose,
      otherDecrease,
      closing,
    });
  }
  return { rows, message: rows.length === 0 ? NOTHING_TO_SHOW_MESSAGE : null };
}

function isRevenue(accounts: readonly FinancialStatementsAccount[], accountId: string): boolean {
  return accounts.some((account) => account.id === accountId && account.kind === "revenue");
}

/** 販売費及び一般管理費の明細: each `sga` account with an amount, by code. */
export function buildSgaSchedule(
  accounts: readonly FinancialStatementsAccount[],
  yearNet: ReadonlyMap<string, Money>,
  /** 販売費及び一般管理費合計 of the income statement. */
  incomeStatementTotal: Money,
): SgaSchedule {
  const rows: SgaScheduleRow[] = [];
  const sorted = [...accounts].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  for (const account of sorted) {
    if (account.group !== "sga" || account.kind !== "expense") continue;
    const amount = normalAmount(account, yearNet.get(account.id) ?? 0n);
    if (amount === 0n) continue;
    rows.push({ accountId: account.id, code: account.code, label: account.name, amount });
  }
  const total = rows.reduce((sum, row) => sum + row.amount, 0n);
  return { rows, total, matchesIncomeStatement: total === incomeStatementTotal };
}
