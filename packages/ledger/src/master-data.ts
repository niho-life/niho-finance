import { SEGMENT_CODES, type SegmentCode } from "./chart-template";
import type { TaxDirection } from "./tax-categories";
import type {
  AccountGroup,
  AccountingMethod,
  AccountKind,
  ConsumptionTaxMethod,
  FiscalYearStatus,
} from "./types";

/**
 * Settings vocabulary shared by the repository and the screens: owner-facing labels of the
 * enum values (never shown raw, 05-ui-ux §4) and the rules that tie them together.
 */

export const ACCOUNT_KIND_LABELS: Readonly<Record<AccountKind, string>> = {
  asset: "資産",
  liability: "負債",
  equity: "純資産",
  revenue: "収益",
  expense: "費用",
  internal: "内部",
};

/** Statement groups an account of each kind may be shown under (決算書の表示区分). */
export const ACCOUNT_GROUPS_BY_KIND: Readonly<Record<AccountKind, readonly AccountGroup[]>> = {
  asset: ["current_assets", "fixed_assets", "deferred_assets"],
  liability: ["current_liabilities", "fixed_liabilities"],
  equity: ["shareholders_equity"],
  revenue: ["sales", "non_operating_income", "extraordinary_income"],
  expense: [
    "cost_of_sales",
    "sga",
    "non_operating_expenses",
    "extraordinary_losses",
    "income_taxes",
  ],
  internal: ["internal"],
};

export function isAccountGroupOf(kind: AccountKind, group: AccountGroup): boolean {
  return ACCOUNT_GROUPS_BY_KIND[kind].includes(group);
}

/** Account codes are 4 digits; the first digit tells the kind (01-domain-model §1). */
export const ACCOUNT_CODE_PATTERN = /^\d{4}$/;

/** 1xxx 資産 / 2xxx 負債 / 3xxx 純資産 / 4xxx 収益 / 5xxx–8xxx 費用 / 9xxx 内部. `null` for 0xxx. */
export function accountKindForCode(code: string): AccountKind | null {
  if (!ACCOUNT_CODE_PATTERN.test(code)) return null;
  switch (code.charAt(0)) {
    case "1":
      return "asset";
    case "2":
      return "liability";
    case "3":
      return "equity";
    case "4":
      return "revenue";
    case "5":
    case "6":
    case "7":
    case "8":
      return "expense";
    case "9":
      return "internal";
    default:
      return null;
  }
}

export const WALLET_KINDS = ["bank", "card", "cash", "stripe", "owner", "other"] as const;
/** `owner` is the officer's advances and loans to the company (役員立替). */
export type WalletKind = (typeof WALLET_KINDS)[number];

export const WALLET_KIND_LABELS: Readonly<Record<WalletKind, string>> = {
  bank: "銀行",
  card: "カード",
  cash: "現金",
  stripe: "Stripe",
  owner: "役員立替",
  other: "その他",
};

/** Account a new wallet posts to (02-accounting-rules §2). `other` has no default: it is chosen. */
export const WALLET_DEFAULT_ACCOUNT_CODES: Readonly<Record<WalletKind, string | null>> = {
  bank: "1100",
  card: "2100",
  cash: "1000",
  stripe: "1150",
  owner: "2400",
  other: null,
};

export function isWalletKind(value: unknown): value is WalletKind {
  return typeof value === "string" && (WALLET_KINDS as readonly string[]).includes(value);
}

export const PARTNER_KINDS = ["customer", "vendor", "both", "other"] as const;
export type PartnerKind = (typeof PARTNER_KINDS)[number];

export const PARTNER_KIND_LABELS: Readonly<Record<PartnerKind, string>> = {
  customer: "顧客",
  vendor: "仕入先",
  both: "両方",
  other: "その他",
};

export const CONSUMPTION_TAX_METHOD_LABELS: Readonly<Record<ConsumptionTaxMethod, string>> = {
  exempt: "免税",
  general: "本則課税",
  simplified: "簡易課税",
};

export const ACCOUNTING_METHOD_LABELS: Readonly<Record<AccountingMethod, string>> = {
  tax_inclusive: "税込経理",
  tax_exclusive: "税抜経理",
};

/** Exempt years are always tax-inclusive; taxable years default to tax-exclusive (02 §3). */
export function defaultAccountingMethod(consumptionTax: ConsumptionTaxMethod): AccountingMethod {
  return consumptionTax === "exempt" ? "tax_inclusive" : "tax_exclusive";
}

export const FISCAL_YEAR_STATUS_LABELS: Readonly<Record<FiscalYearStatus, string>> = {
  open: "進行中",
  closing: "決算中",
  closed: "締め済み",
};

export const TAX_DIRECTION_LABELS: Readonly<Record<TaxDirection, string>> = {
  sales: "売上",
  purchase: "仕入",
  none: "対象外",
};

/** The 4 standard segments cannot be deactivated or recoded: the chart and the setup use them. */
export function isStandardSegmentCode(code: string): code is SegmentCode {
  return (SEGMENT_CODES as readonly string[]).includes(code);
}

/** Segment of the company as a whole (共通): opening entries and company-wide costs. */
export const CORPORATE_SEGMENT_CODE: SegmentCode = "corporate";
