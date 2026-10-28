import type { CalendarDate } from "./date";
import type { Money } from "./money";

export const SIDES = ["debit", "credit"] as const;
export type Side = (typeof SIDES)[number];

export const ACCOUNT_KINDS = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
  "internal",
] as const;
/** `internal` is for transactions between segments and always nets to 0 for the company. */
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Presentation groups of the financial statements (決算書の表示区分). */
export const ACCOUNT_GROUPS = [
  "current_assets",
  "fixed_assets",
  "deferred_assets",
  "current_liabilities",
  "fixed_liabilities",
  "shareholders_equity",
  "sales",
  "cost_of_sales",
  "sga",
  "non_operating_income",
  "non_operating_expenses",
  "extraordinary_income",
  "extraordinary_losses",
  "income_taxes",
  "internal",
] as const;
export type AccountGroup = (typeof ACCOUNT_GROUPS)[number];

export const ACCOUNT_GROUP_LABELS: Readonly<Record<AccountGroup, string>> = {
  current_assets: "流動資産",
  fixed_assets: "固定資産",
  deferred_assets: "繰延資産",
  current_liabilities: "流動負債",
  fixed_liabilities: "固定負債",
  shareholders_equity: "株主資本",
  sales: "売上高",
  cost_of_sales: "売上原価",
  sga: "販売費及び一般管理費",
  non_operating_income: "営業外収益",
  non_operating_expenses: "営業外費用",
  extraordinary_income: "特別利益",
  extraordinary_losses: "特別損失",
  income_taxes: "法人税等",
  internal: "内部取引",
};

export const ENTRY_KINDS = [
  "opening",
  "normal",
  "transfer",
  "adjusting",
  "closing",
  "reversal",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const SOURCE_KINDS = [
  "manual",
  "wallet_txn",
  "stripe",
  "invoice",
  "fixed_asset",
  "recurring",
  "import",
  "system",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const ENTRY_STATUSES = ["posted", "voided"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const FISCAL_YEAR_STATUSES = ["open", "closing", "closed"] as const;
/** `closing`: year-end adjustments only. `closed`: nothing can be posted. */
export type FiscalYearStatus = (typeof FISCAL_YEAR_STATUSES)[number];

export const CONSUMPTION_TAX_METHODS = ["exempt", "general", "simplified"] as const;
export type ConsumptionTaxMethod = (typeof CONSUMPTION_TAX_METHODS)[number];

export const ACCOUNTING_METHODS = ["tax_inclusive", "tax_exclusive"] as const;
export type AccountingMethod = (typeof ACCOUNTING_METHODS)[number];

/** The minimum the ledger needs to know about an account. */
export interface AccountRef {
  id: string;
  code: string;
  kind: AccountKind;
  /** `false` blocks new postings (reversals are still allowed). Defaults to active. */
  isActive?: boolean;
}

export interface JournalLineInput {
  side: Side;
  accountId: string;
  subAccountId?: string | null;
  /** Always positive. Tax-inclusive or tax-exclusive depending on the fiscal year's method. */
  amount: Money;
  /** Required on every line; use `na` when out of scope. */
  taxCategoryCode: string;
  /** Consumption tax contained in the line (kept even in tax-inclusive years for reporting). */
  taxAmount: Money;
  /** Required for revenue, expense and internal accounts. Optional for balance-sheet accounts. */
  segmentId?: string | null;
  partnerId?: string | null;
  description?: string | null;
  memoTagIds?: readonly string[];
}

export interface JournalEntryInput {
  entryDate: CalendarDate;
  description: string;
  kind: EntryKind;
  sourceKind: SourceKind;
  sourceId?: string | null;
  /** Set only on `reversal` entries: the entry being cancelled. */
  reversalOfId?: string | null;
  lines: readonly JournalLineInput[];
}

/** A journal entry as recorded in the ledger. */
export interface RecordedJournalEntry extends JournalEntryInput {
  id: string;
  no: number;
  status: EntryStatus;
}

export interface FiscalYearContext {
  startDate: CalendarDate;
  endDate: CalendarDate;
  /** Monthly close: nothing can be posted or voided on or before this date. */
  lockedThrough: CalendarDate | null;
  status: FiscalYearStatus;
  consumptionTax: ConsumptionTaxMethod;
  accountingMethod: AccountingMethod;
}

/** The side on which an account's balance is normally carried. */
export function normalSide(kind: AccountKind): Side {
  switch (kind) {
    case "asset":
    case "expense":
    case "internal":
      return "debit";
    case "liability":
    case "equity":
    case "revenue":
      return "credit";
  }
}

export function oppositeSide(side: Side): Side {
  return side === "debit" ? "credit" : "debit";
}
