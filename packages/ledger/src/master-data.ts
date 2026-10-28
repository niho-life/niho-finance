import { SEGMENT_CODES, type SegmentCode } from "./chart-template";
import type { DepreciationMethod } from "./depreciation";
import type { TaxDirection } from "./tax-categories";
import type {
  AccountGroup,
  AccountingMethod,
  AccountKind,
  ConsumptionTaxMethod,
  EntryKind,
  EntryStatus,
  FiscalYearStatus,
  SourceKind,
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

// ---------------------------------------------------------------------------
// Journal entries and the audit log (11-transactions §3, §5, §8)
// ---------------------------------------------------------------------------

export const ENTRY_KIND_LABELS: Readonly<Record<EntryKind, string>> = {
  opening: "開始",
  normal: "通常",
  transfer: "振替",
  adjusting: "決算整理",
  closing: "決算振替",
  reversal: "反対仕訳",
};

/** 生成元 of an entry. `system` entries are the setup's opening entries. */
export const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  manual: "手入力",
  system: "初期設定",
  wallet_txn: "明細",
  stripe: "Stripe",
  invoice: "請求書",
  fixed_asset: "固定資産",
  recurring: "定期取引",
  import: "取込",
  payroll: "給与",
  year_end: "決算",
  expense: "立替精算",
};

export const ENTRY_STATUS_LABELS: Readonly<Record<EntryStatus, string>> = {
  posted: "登録済み",
  voided: "取消済み",
};

/** Actions with a label of their own (`<entity>.<verb>`). */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  "journal_entry.post": "仕訳の登録",
  "journal_entry.void": "仕訳の取消",
  "journal_entry.correct": "仕訳の訂正",
  "fiscal_year.close": "締め",
  "fiscal_year.reopen": "締めを戻す",
  "fiscal_year.start_adjusting": "決算整理を始める",
  "fiscal_year.cancel_adjusting": "決算整理をやめる",
  "fiscal_year.close_year": "期末の締め",
  "fiscal_year.reopen_year": "期末の締めを戻す",
  "fiscal_year.check": "決算の確認",
  "fixed_asset.void": "固定資産の登録の取消",
  "fixed_asset.dispose": "固定資産の除却・売却",
  "setup.skip": "初期設定を後回し",
  "standard_data.bootstrap": "標準データの投入",
  "document.create": "証憑の保存",
  "document.update": "証憑の変更",
  "document.link": "証憑の紐づけ",
  "document.unlink": "証憑の紐づけを外す",
  "document.void": "証憑の無効化",
  "document.export": "索引簿の書き出し",
  "records_policy.save": "証憑の規程の保存",
  // 請求 (18-invoicing §1)
  "invoice.create": "書類の作成",
  "invoice.update": "書類の変更",
  "invoice.discard": "下書きの破棄",
  "invoice.issue": "書類の発行",
  "invoice.send": "書類の送付",
  "invoice.pay": "入金の登録",
  "invoice.cancel_payment": "入金の取消",
  "invoice.void": "書類の無効",
  "invoice.attach_pdf": "PDF の保存",
  "import_batch.import": "明細の取込",
  "import_batch.sync": "明細の同期",
  "wallet.update_importer": "取込形式の変更",
  // 銀行 API (19-bank-api §6.3)
  "wallet.authorize_bank": "銀行 API の認可",
  "wallet.connect_bank": "銀行 API の接続",
  "wallet.disconnect_bank": "銀行 API の接続を外す",
  "wallet.require_bank_reauth": "銀行 API の再接続が必要",
  "stripe_account_link.create": "Stripe の接続",
  "stripe_account_link.update": "Stripe の接続の変更",
  "stripe_account_link.delete": "Stripe の接続を外す",
  "wallet_transaction.register": "明細の登録",
  "wallet_transaction.transfer": "明細の振替",
  "wallet_transaction.ignore": "明細の無視",
  "wallet_transaction.reopen": "明細を未処理に戻す",
  "wallet_transaction.update": "明細のメモ",
  "rule.apply": "ルールの適用",
  "employee.create": "従業員の追加",
  "employee.update": "従業員の変更",
  "payroll_run.confirm": "支給の確定",
  "payroll_payment.post": "納付の登録",
  "calendar_item.complete": "完了にする",
  // 期限 (24-calendar §2)
  "calendar_item.reopen": "未完了に戻す",
  "calendar_item.notify": "期限の通知",
  "calendar_item.delete": "期限の削除",
  // 利用者 (23 §4): 追加 / 変更 come from the shared verbs.
  "user.deactivate": "無効にする",
  "user.reactivate": "有効にする",
  // 立替精算 (23 §5.2)
  "expense_claim.submit": "提出",
  "expense_claim.pay": "支払",
  "expense_claim.unpay": "支払の取消",
  "expense_claim.void": "取消",
};

/** Verbs shared by every entity: `account.create` → 追加, `wallet.deactivate` → 無効化. */
const AUDIT_VERB_LABELS: Readonly<Record<string, string>> = {
  create: "追加",
  update: "変更",
  activate: "有効化",
  deactivate: "無効化",
  enable: "有効化",
  disable: "無効化",
};

/** The owner-facing label of an audit action, or `null` when there is none (shown as is, muted). */
export function auditActionLabel(action: string): string | null {
  const own = AUDIT_ACTION_LABELS[action];
  if (own) return own;
  const verb = action.slice(action.lastIndexOf(".") + 1);
  return action.includes(".") ? (AUDIT_VERB_LABELS[verb] ?? null) : null;
}

/**
 * The targets the audit log can be narrowed to (11 §8), in the order of the filter. `setup` has no
 * rows of its own: the setup's choices are recorded on the company with `setup.*` actions.
 */
export const AUDIT_ENTITIES = [
  "journal_entry",
  "fiscal_year",
  "fixed_asset",
  "company",
  "account",
  "sub_account",
  "tax_rate_rule",
  "wallet",
  "partner",
  "document",
  "segment",
  "memo_tag",
  "recurring_item",
  "standard_data",
  "setup",
  "invoice",
  "import_batch",
  "stripe_account_link",
  "wallet_transaction",
  "rule",
  "employee",
  "payroll_run",
  "calendar_item",
  "user",
  "expense_claim",
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

export const AUDIT_ENTITY_LABELS: Readonly<Record<AuditEntity, string>> = {
  journal_entry: "仕訳",
  fiscal_year: "会計期間",
  fixed_asset: "固定資産",
  company: "事業所",
  account: "勘定科目",
  sub_account: "補助科目",
  tax_rate_rule: "税率規則",
  wallet: "口座",
  partner: "取引先",
  document: "証憑",
  segment: "セグメント",
  memo_tag: "タグ",
  recurring_item: "定期取引",
  standard_data: "標準データ",
  setup: "初期設定",
  invoice: "請求",
  import_batch: "取込",
  stripe_account_link: "Stripe の接続",
  wallet_transaction: "明細",
  rule: "ルール",
  employee: "従業員",
  payroll_run: "給与の支給",
  calendar_item: "期限",
  user: "利用者",
  expense_claim: "立替精算",
};

export function isAuditEntity(value: unknown): value is AuditEntity {
  return typeof value === "string" && (AUDIT_ENTITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 決算 (16-year-end §4.1)
// ---------------------------------------------------------------------------

export const DEPRECIATION_METHOD_LABELS: Readonly<Record<DepreciationMethod, string>> = {
  straight_line: "定額法",
  declining_balance: "定率法",
  immediate: "即時償却",
  lump_sum_3y: "一括償却（3 年）",
};
