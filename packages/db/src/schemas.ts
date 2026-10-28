/**
 * Input schemas of the settings and setup repository (Zod). The repository parses every write with
 * them; Server Actions pass form values (strings) or typed values straight through, and turn a
 * `ZodError` into field errors. Messages are owner-facing Japanese.
 */
import { CSV_FORMAT_KEYS, type GenericCsvConfig } from "@niho-finance/importers";
import {
  ACCOUNT_CODE_PATTERN,
  ACCOUNT_GROUPS,
  ACCOUNT_KINDS,
  ACCOUNTING_METHODS,
  AUDIT_ENTITIES,
  BANK_ACCOUNT_TYPES,
  CONSUMPTION_TAX_METHODS,
  corporateNumberProblem,
  DEFERRED_AMORTIZATION_MODES,
  DEPRECIATION_METHODS,
  defaultAccountingMethod,
  DOCUMENT_KINDS,
  DOCUMENT_LINK_KINDS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_SOURCES,
  DOCUMENT_TABS,
  INVOICE_DOC_TYPES,
  invoiceRegistrationNumberProblem,
  isAcceptedDocumentMime,
  isAccountGroupOf,
  isCalendarDate,
  isSalesTaxCategoryCode,
  isTaxCategoryCode,
  isValidRuleRegex,
  normalizeCorporateNumber,
  normalizeInvoiceRegistrationNumber,
  parseQuantity,
  parseYenInput,
  PARTNER_KINDS,
  paymentTermsProblem,
  RULE_MODES,
  RULE_REGEX_MAX_LENGTH,
  ACCRUAL_TYPES,
  SIDES,
  WALLET_KINDS,
  type BankAccountType,
  type CalendarDate,
  type DocumentMime,
  type EntryCounterpart,
  type Money,
  type PaymentTerms,
  type RuleAction,
  type RuleMatch,
  type RuleSign,
  type SalesTaxCategoryCode,
} from "@niho-finance/ledger";
import { isYearMonth, PREMIUM_TIMINGS, type YearMonth } from "@niho-finance/payroll";
import {
  SIMPLIFIED_TAX_CLASSES,
  STATEMENT_OTHER_NOTES_MAX,
  STATEMENT_TEXT_MAX_LENGTH,
  type SimplifiedTaxClass,
} from "@niho-finance/reports";
import { z } from "zod";

type Conversion<T> = { ok: true; value: T } | { ok: false; message: string };

/** Strings are trimmed; `null` / `undefined` (a missing form field) become "". */
function asText(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value === null || value === undefined) return "";
  return value;
}

/** A form field converted from its text; the conversion reports the owner-facing problem. */
function fromText<T>(label: string, convert: (text: string) => Conversion<T>) {
  return z
    .preprocess(asText, z.string({ error: `${label}の形式が正しくありません` }))
    .transform((text, ctx): T => {
      const result = convert(text);
      if (result.ok) return result.value;
      ctx.addIssue({ code: "custom", message: result.message });
      return z.NEVER;
    });
}

const ok = <T>(value: T): Conversion<T> => ({ ok: true, value });

/**
 * An optional field: a missing key, `null` or "" all become `null`, and the key is optional in the
 * input type. In update schemas add `.optional()` again so that a missing key leaves the column as is.
 */
function orNull<T>(schema: z.ZodType<T | null>) {
  return schema.optional().transform((value): T | null => value ?? null);
}
const problem = (message: string): Conversion<never> => ({ ok: false, message });

export function requiredText(label: string, max = 200) {
  return fromText(label, (text) => {
    if (text === "") return problem(`${label}を入力してください`);
    if (text.length > max) return problem(`${label}は ${max} 文字以内にしてください`);
    return ok(text);
  });
}

/** Empty → `null`. */
export function optionalText(label: string, max = 500) {
  return orNull(
    fromText(label, (text): Conversion<string | null> => {
      if (text.length > max) return problem(`${label}は ${max} 文字以内にしてください`);
      return ok(text === "" ? null : text);
    }),
  );
}

export function requiredDate(label: string) {
  return fromText(label, (text): Conversion<CalendarDate> => {
    if (text === "") return problem(`${label}を入力してください`);
    if (!isCalendarDate(text)) return problem(`${label}は 2026-11-02 の形の日付にしてください`);
    return ok(text);
  });
}

/** Empty → `null`. */
export function optionalDate(label: string) {
  return orNull(
    fromText(label, (text): Conversion<CalendarDate | null> => {
      if (text === "") return ok(null);
      if (!isCalendarDate(text)) return problem(`${label}は 2026-11-02 の形の日付にしてください`);
      return ok(text);
    }),
  );
}

/** Whole yen, 1 or more. Accepts `50000`, `50,000`, full-width digits and bigint. */
export function positiveYen(label: string) {
  return fromText(label, (text): Conversion<Money> => {
    if (text === "") return problem(`${label}を入力してください`);
    const amount = parseYenInput(text);
    if (amount === null) return problem(`${label}は円の整数で入力してください`);
    if (amount <= 0n) return problem(`${label}は 1 円以上にしてください`);
    return ok(amount);
  });
}

/** Whole yen, negative allowed; empty → `null`. */
export function optionalSignedYen(label: string) {
  return orNull(
    fromText(label, (text): Conversion<Money | null> => {
      if (text === "") return ok(null);
      const amount = parseYenInput(text, { allowNegative: true });
      if (amount === null) return problem(`${label}は円の整数で入力してください`);
      return ok(amount);
    }),
  );
}

function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}

function convertInteger(label: string, text: string, min: number, max: number): Conversion<number> {
  const normalized = toHalfWidthDigits(text);
  if (!/^\d+$/.test(normalized)) return problem(`${label}は整数で入力してください`);
  const value = Number(normalized);
  if (value < min || value > max) return problem(`${label}は ${min}〜${max} にしてください`);
  return ok(value);
}

export function integerInRange(label: string, min: number, max: number) {
  return fromText(label, (text) => {
    if (text === "") return problem(`${label}を入力してください`);
    return convertInteger(label, text, min, max);
  });
}

/** Empty → `null`. */
export function optionalIntegerInRange(label: string, min: number, max: number) {
  return orNull(
    fromText(label, (text): Conversion<number | null> =>
      text === "" ? ok(null) : convertInteger(label, text, min, max),
    ),
  );
}

export function idField(label: string) {
  return fromText(label, (text) => {
    if (text === "") return problem(`${label}を選んでください`);
    if (text.length > 64) return problem(`${label}が正しくありません`);
    return ok(text);
  });
}

/** Empty → `null` (e.g. 「なし」 in a select). */
export function optionalIdField(label: string) {
  return orNull(
    fromText(label, (text): Conversion<string | null> => {
      if (text.length > 64) return problem(`${label}が正しくありません`);
      return ok(text === "" ? null : text);
    }),
  );
}

/** `true` / `false`, a checkbox's `on`, or the strings `"true"` / `"false"`. */
export function booleanField(label: string) {
  return z.preprocess(
    (value) => {
      if (typeof value === "boolean") return value;
      if (value === "on" || value === "true") return true;
      if (value === "" || value === "false" || value === null || value === undefined) return false;
      return value;
    },
    z.boolean({ error: `${label}の形式が正しくありません` }),
  );
}

export function enumField<const T extends readonly [string, ...string[]]>(
  label: string,
  values: T,
) {
  return z.preprocess(asText, z.enum(values, { error: `${label}を選んでください` }));
}

export function taxCategoryCodeField(label = "税区分") {
  return fromText(label, (text) => {
    if (text === "") return problem(`${label}を選んでください`);
    if (!isTaxCategoryCode(text)) return problem(`${label}が正しくありません`);
    return ok(text);
  });
}

/** Empty → `null`. */
export function optionalTaxCategoryCodeField(label = "税区分") {
  return orNull(
    fromText(label, (text): Conversion<string | null> => {
      if (text === "") return ok(null);
      if (!isTaxCategoryCode(text)) return problem(`${label}が正しくありません`);
      return ok(text);
    }),
  );
}

/** 法人番号: normalized (full-width digits, hyphens) and check-digit verified. Empty → `null`. */
export const optionalCorporateNumber = orNull(
  fromText("法人番号", (text): Conversion<string | null> => {
    const value = normalizeCorporateNumber(text);
    if (value === "") return ok(null);
    const reason = corporateNumberProblem(value);
    return reason ? problem(reason) : ok(value);
  }),
);

/** 登録番号: `T` + 13 digits with a valid check digit. Empty → `null`. */
export const optionalInvoiceRegistrationNumber = orNull(
  fromText("登録番号", (text): Conversion<string | null> => {
    const value = normalizeInvoiceRegistrationNumber(text);
    if (value === "") return ok(null);
    const reason = invoiceRegistrationNumberProblem(value);
    return reason ? problem(reason) : ok(value);
  }),
);

export const fiscalYearEndMonthField = integerInRange("決算月", 1, 12);

// ---------------------------------------------------------------------------
// Company (事業所)
// ---------------------------------------------------------------------------

export const companyInputSchema = z
  .object({
    name: requiredText("商号", 200),
    nameKana: optionalText("カナ", 200),
    representative: optionalText("代表者", 200),
    address: optionalText("住所", 500),
    foundedOn: requiredDate("設立日"),
    fiscalYearEndMonth: fiscalYearEndMonthField,
    corporateNumber: optionalCorporateNumber,
    invoiceRegistrationNumber: optionalInvoiceRegistrationNumber,
    invoiceRegisteredOn: optionalDate("登録日"),
  })
  .superRefine((value, ctx) => {
    if (
      value.corporateNumber &&
      value.invoiceRegistrationNumber &&
      value.invoiceRegistrationNumber !== `T${value.corporateNumber}`
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["invoiceRegistrationNumber"],
        message: "登録番号は T と法人番号の 13 桁です。法人番号と合っているか確かめてください",
      });
    }
    if (value.invoiceRegisteredOn && !value.invoiceRegistrationNumber) {
      ctx.addIssue({
        code: "custom",
        path: ["invoiceRegisteredOn"],
        message: "登録日は登録番号と一緒に入力してください",
      });
    }
  });
export type CompanyInput = z.input<typeof companyInputSchema>;

// ---------------------------------------------------------------------------
// Fiscal years (会計期間)
// ---------------------------------------------------------------------------

/** Exempt years are tax-inclusive whatever was sent; taxable years default to tax-exclusive. */
function withAccountingMethod<
  T extends { consumptionTax: (typeof CONSUMPTION_TAX_METHODS)[number]; accountingMethod: unknown },
>(value: T) {
  const accountingMethod =
    value.consumptionTax === "exempt"
      ? ("tax_inclusive" as const)
      : ((value.accountingMethod as (typeof ACCOUNTING_METHODS)[number] | null) ??
        defaultAccountingMethod(value.consumptionTax));
  return { ...value, accountingMethod };
}

/** Ignored for exempt years; defaults to tax-exclusive for taxable years. */
const accountingMethodField = orNull(
  z.preprocess(
    (value) => (value === "" || value === undefined ? null : asText(value)),
    z.enum(ACCOUNTING_METHODS, { error: "経理方式を選んでください" }).nullable(),
  ),
);

export const firstFiscalYearSchema = z
  .object({
    endDate: requiredDate("終了日"),
    consumptionTax: enumField("消費税の区分", CONSUMPTION_TAX_METHODS),
    accountingMethod: accountingMethodField,
  })
  .transform(withAccountingMethod);
export type FirstFiscalYearInput = z.input<typeof firstFiscalYearSchema>;

export const nextFiscalYearSchema = z
  .object({
    /** Defaults to 12 months after the previous year (`deriveNextFiscalYear`). */
    endDate: optionalDate("終了日"),
    consumptionTax: enumField("消費税の区分", CONSUMPTION_TAX_METHODS),
    accountingMethod: accountingMethodField,
  })
  .transform(withAccountingMethod);
export type NextFiscalYearInput = z.input<typeof nextFiscalYearSchema>;

export const fiscalYearUpdateSchema = z
  .object({
    id: idField("会計期間"),
    consumptionTax: enumField("消費税の区分", CONSUMPTION_TAX_METHODS),
    accountingMethod: accountingMethodField,
  })
  .transform(withAccountingMethod);
export type FiscalYearUpdateInput = z.input<typeof fiscalYearUpdateSchema>;

// ---------------------------------------------------------------------------
// Accounts and sub-accounts (勘定科目・補助科目)
// ---------------------------------------------------------------------------

const accountCodeField = fromText("コード", (text) => {
  const code = toHalfWidthDigits(text);
  if (code === "") return problem("コードを入力してください");
  if (!ACCOUNT_CODE_PATTERN.test(code)) return problem("コードは 4 桁の数字です");
  return ok(code);
});

export const accountCreateSchema = z
  .object({
    code: accountCodeField,
    name: requiredText("名前", 100),
    kind: enumField("種類", ACCOUNT_KINDS),
    group: enumField("決算書の区分", ACCOUNT_GROUPS),
  })
  .superRefine((value, ctx) => {
    if (!isAccountGroupOf(value.kind, value.group)) {
      ctx.addIssue({
        code: "custom",
        path: ["group"],
        message: "決算書の区分が種類に合いません。種類に合う区分を選んでください",
      });
    }
  });
export type AccountCreateInput = z.input<typeof accountCreateSchema>;

/** The columns edited in the list (10 §4.3). Omitted keys are left as they are. */
export const accountUpdateSchema = z.object({
  id: idField("勘定科目"),
  name: requiredText("名前", 100).optional(),
  group: enumField("決算書の区分", ACCOUNT_GROUPS).optional(),
  defaultTaxCategoryCode: optionalTaxCategoryCodeField("既定の税区分").optional(),
  isCashLike: booleanField("現預金").optional(),
  /** 勘定科目コードの上書き (17-financial-statements §6.4). Empty = back to the standard code. */
  eTaxCode: optionalText("勘定科目コード", 30).optional(),
});
export type AccountUpdateInput = z.input<typeof accountUpdateSchema>;

export const subAccountCreateSchema = z.object({
  accountId: idField("勘定科目"),
  name: requiredText("名前", 100),
});
export type SubAccountCreateInput = z.input<typeof subAccountCreateSchema>;

export const subAccountUpdateSchema = z.object({
  id: idField("補助科目"),
  name: requiredText("名前", 100),
});
export type SubAccountUpdateInput = z.input<typeof subAccountUpdateSchema>;

/** 無効にする / 有効にする. */
export const activeToggleSchema = z.object({
  id: idField("対象"),
  isActive: booleanField("状態"),
});
export type ActiveToggleInput = z.input<typeof activeToggleSchema>;

// ---------------------------------------------------------------------------
// Tax rate rules (税率規則)
// ---------------------------------------------------------------------------

export const taxRateRuleCreateSchema = z
  .object({
    taxCategoryCode: taxCategoryCodeField(),
    effectiveFrom: requiredDate("適用の開始日"),
    effectiveTo: optionalDate("適用の終了日"),
    ratePercent: integerInRange("税率", 0, 100),
    deductiblePercent: optionalIntegerInRange("控除割合", 0, 100),
    note: optionalText("メモ", 200),
  })
  .superRefine((value, ctx) => {
    if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) {
      ctx.addIssue({
        code: "custom",
        path: ["effectiveTo"],
        message: "適用の終了日は開始日より後にしてください",
      });
    }
  });
export type TaxRateRuleCreateInput = z.input<typeof taxRateRuleCreateSchema>;

export const taxRateRuleToggleSchema = z.object({
  id: idField("税率規則"),
  enabled: booleanField("有効"),
});
export type TaxRateRuleToggleInput = z.input<typeof taxRateRuleToggleSchema>;

// ---------------------------------------------------------------------------
// Wallets (口座)
// ---------------------------------------------------------------------------

const walletFields = {
  name: requiredText("名前", 100),
  kind: enumField("種類", WALLET_KINDS),
  /** Defaults to the account of the kind (bank → 1100, …). */
  accountId: optionalIdField("紐づく科目"),
  defaultSegmentId: optionalIdField("既定セグメント"),
  /** Statement balance on `openingBalanceDate` for reconciling imports (S4); not posted. */
  openingBalanceDate: optionalDate("明細の残高の日付"),
  openingBalance: optionalSignedYen("明細の残高"),
  note: optionalText("メモ", 500),
};

export const walletCreateSchema = z.object(walletFields);
export type WalletCreateInput = z.input<typeof walletCreateSchema>;

export const walletUpdateSchema = z.object({
  id: idField("口座"),
  name: walletFields.name.optional(),
  kind: walletFields.kind.optional(),
  accountId: walletFields.accountId.optional(),
  defaultSegmentId: walletFields.defaultSegmentId.optional(),
  openingBalanceDate: walletFields.openingBalanceDate.optional(),
  openingBalance: walletFields.openingBalance.optional(),
  note: walletFields.note.optional(),
});
export type WalletUpdateInput = z.input<typeof walletUpdateSchema>;

// ---------------------------------------------------------------------------
// Partners (取引先)
// ---------------------------------------------------------------------------

export const partnerCreateSchema = z.object({
  name: requiredText("名前", 200),
  nameKana: optionalText("カナ", 200),
  kind: enumField("区分", PARTNER_KINDS),
  invoiceRegistrationNumber: optionalInvoiceRegistrationNumber,
  defaultAccountId: optionalIdField("既定の科目"),
  defaultSegmentId: optionalIdField("既定のセグメント"),
  defaultTaxCategoryCode: optionalTaxCategoryCodeField("既定の税区分"),
});
export type PartnerCreateInput = z.input<typeof partnerCreateSchema>;

export const partnerUpdateSchema = z.object({
  id: idField("取引先"),
  name: requiredText("名前", 200).optional(),
  nameKana: optionalText("カナ", 200).optional(),
  kind: enumField("区分", PARTNER_KINDS).optional(),
  invoiceRegistrationNumber: optionalInvoiceRegistrationNumber.optional(),
  defaultAccountId: optionalIdField("既定の科目").optional(),
  defaultSegmentId: optionalIdField("既定のセグメント").optional(),
  defaultTaxCategoryCode: optionalTaxCategoryCodeField("既定の税区分").optional(),
});
export type PartnerUpdateInput = z.input<typeof partnerUpdateSchema>;

// ---------------------------------------------------------------------------
// Segments and memo tags (セグメント・タグ)
// ---------------------------------------------------------------------------

const segmentCodeField = fromText("コード", (text) => {
  if (text === "") return problem("コードを入力してください");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(text)) {
    return problem("コードは半角の英小文字・数字・_ ・- で 32 文字以内にしてください");
  }
  return ok(text);
});

export const segmentCreateSchema = z.object({
  code: segmentCodeField,
  name: requiredText("名前", 100),
});
export type SegmentCreateInput = z.input<typeof segmentCreateSchema>;

export const segmentUpdateSchema = z.object({
  id: idField("セグメント"),
  code: segmentCodeField.optional(),
  name: requiredText("名前", 100).optional(),
});
export type SegmentUpdateInput = z.input<typeof segmentUpdateSchema>;

export const memoTagCreateSchema = z.object({ name: requiredText("名前", 50) });
export type MemoTagCreateInput = z.input<typeof memoTagCreateSchema>;

export const memoTagUpdateSchema = z.object({
  id: idField("タグ"),
  name: requiredText("名前", 50),
});
export type MemoTagUpdateInput = z.input<typeof memoTagUpdateSchema>;

// ---------------------------------------------------------------------------
// Opening entries (開始仕訳, 10 §3 Step 5)
// ---------------------------------------------------------------------------

export const openingCostLineSchema = z.object({
  /** 名目, e.g. 登録免許税 */
  description: requiredText("名目", 100),
  amount: positiveYen("金額"),
  date: requiredDate("日付"),
  /** A wallet (役員立替 or a bank); empty → 役員借入金 without a wallet. */
  paidFromWalletId: optionalIdField("支払元"),
  taxCategoryCode: taxCategoryCodeField(),
});
export type OpeningCostLineInput = z.input<typeof openingCostLineSchema>;

export const openingInputSchema = z.object({
  capital: z.object({
    date: requiredDate("払込の日付"),
    amount: positiveYen("資本金"),
    walletId: idField("入金先の口座"),
  }),
  /** 創立費: costs of the incorporation itself. */
  formationCosts: z.array(openingCostLineSchema).max(50, { error: "創立費は 50 行までです" }),
  /** 開業費: costs between the incorporation and the opening. */
  startupCosts: z.array(openingCostLineSchema).max(50, { error: "開業費は 50 行までです" }),
});
export type OpeningInput = z.input<typeof openingInputSchema>;
export type ParsedOpeningInput = z.output<typeof openingInputSchema>;

// ---------------------------------------------------------------------------
// Journal entries (取引, 11-transactions §4–§6)
// ---------------------------------------------------------------------------

/** Whole yen, 1 or more; empty or 0 → `null` (an optional amount such as a transfer fee). */
export function optionalPositiveYen(label: string) {
  return orNull(
    fromText(label, (text): Conversion<Money | null> => {
      if (text === "") return ok(null);
      const amount = parseYenInput(text);
      if (amount === null) return problem(`${label}は円の整数で入力してください`);
      return ok(amount === 0n ? null : amount);
    }),
  );
}

/** 入金先 / 支払元: `wallet:<id>` or `account:<id>` (one select with two optgroups, 11 §4.1). */
function counterpartField(label: string) {
  return fromText(label, (text): Conversion<EntryCounterpart> => {
    if (text === "") return problem(`${label}を選んでください`);
    const match = /^(wallet|account):(\S{1,64})$/.exec(text);
    const id = match?.[2];
    if (!match || !id) return problem(`${label}が正しくありません`);
    return ok(
      match[1] === "wallet" ? { kind: "wallet", walletId: id } : { kind: "account", accountId: id },
    );
  });
}

/** Tag ids (a row of checkboxes): an array, one id or nothing. Duplicates are dropped. */
const memoTagIdsField = z
  .preprocess(
    (value): unknown[] => {
      if (value === undefined || value === null || value === "") return [];
      if (!Array.isArray(value)) return [value];
      const list: unknown[] = value;
      return list;
    },
    z
      .array(z.string({ error: "タグが正しくありません" }).min(1).max(64), {
        error: "タグが正しくありません",
      })
      .max(30, { error: "タグは 30 個までにしてください" }),
  )
  .optional()
  .transform((ids) => [...new Set(ids ?? [])]);

const entryDateField = requiredDate("日付");
const entryDescriptionField = requiredText("摘要", 200);

/** 収入 (11 §4.1). The amount is tax-inclusive. */
export const incomeEntrySchema = z.object({
  type: z.literal("income"),
  entryDate: entryDateField,
  description: entryDescriptionField,
  counterpart: counterpartField("入金先"),
  accountId: idField("科目"),
  amount: positiveYen("金額"),
  taxCategoryCode: taxCategoryCodeField(),
  segmentId: optionalIdField("セグメント"),
  partnerId: optionalIdField("取引先"),
  memoTagIds: memoTagIdsField,
});

/** 支出 (11 §4.2). */
export const expenseEntrySchema = incomeEntrySchema.extend({
  type: z.literal("expense"),
  counterpart: counterpartField("支払元"),
});

/** 振替 (11 §4.3): between two wallets, with an optional fee. */
export const transferEntrySchema = z.object({
  type: z.literal("transfer"),
  entryDate: entryDateField,
  description: entryDescriptionField,
  fromWalletId: idField("出金元の口座"),
  toWalletId: idField("入金先の口座"),
  amount: positiveYen("金額"),
  fee: optionalPositiveYen("手数料"),
  memoTagIds: memoTagIdsField,
});

/** 収入 / 支出 / 振替, told apart by `type`. */
export const simpleEntrySchema = z.discriminatedUnion(
  "type",
  [incomeEntrySchema, expenseEntrySchema, transferEntrySchema],
  { error: "取引の種類が正しくありません。画面を読み込み直してください" },
);
export type SimpleEntryFormInput = z.input<typeof simpleEntrySchema>;
export type ParsedSimpleEntry = z.output<typeof simpleEntrySchema>;

/** The kinds a new 伝票 can have (11 §4.4). */
export const VOUCHER_KINDS = ["normal", "adjusting"] as const;
/** A correction keeps the original's kind (振替・開始) or becomes 通常 / 決算整理 (11 §1). */
export const CORRECTION_KINDS = ["normal", "adjusting", "transfer", "opening"] as const;

export const voucherLineSchema = z.object({
  side: enumField("貸借", SIDES),
  accountId: idField("科目"),
  subAccountId: optionalIdField("補助科目"),
  amount: positiveYen("金額"),
  taxCategoryCode: taxCategoryCodeField(),
  segmentId: optionalIdField("セグメント"),
  partnerId: optionalIdField("取引先"),
  description: optionalText("摘要", 200),
});
export type VoucherLineFormInput = z.input<typeof voucherLineSchema>;

function voucherSchema<const K extends readonly [string, ...string[]]>(kinds: K) {
  return z.object({
    kind: enumField("種類", kinds),
    entryDate: entryDateField,
    description: entryDescriptionField,
    /** The partner of the rows left blank. */
    partnerId: optionalIdField("取引先"),
    memoTagIds: memoTagIdsField,
    lines: z
      .array(voucherLineSchema, { error: "行の形式が正しくありません" })
      .min(2, { error: "行は 2 行以上にしてください" })
      .max(100, { error: "行は 100 行までにしてください" }),
  });
}

/** 伝票 (11 §4.4). */
export const voucherEntrySchema = voucherSchema(VOUCHER_KINDS);
export type VoucherEntryFormInput = z.input<typeof voucherEntrySchema>;
export type ParsedVoucherEntry = z.output<typeof voucherEntrySchema>;

/** 取消 (11 §1, §5): the reason is stored on the entry and in the audit log. */
export const voidEntrySchema = z.object({ reason: requiredText("理由", 500) });
export type VoidEntryInput = z.input<typeof voidEntrySchema>;

/** 訂正 (11 §1, §6): 取消 with the reason, then the replacement written as a 伝票. */
export const correctEntrySchema = z.object({
  reason: requiredText("理由", 500),
  replacement: voucherSchema(CORRECTION_KINDS),
});
export type CorrectEntryInput = z.input<typeof correctEntrySchema>;

// ---------------------------------------------------------------------------
// 締め (11 §7)
// ---------------------------------------------------------------------------

/** Empty → 締めない. The reason is required when the close moves back (checked by `closeFiscalYearThrough`). */
export const closeFiscalYearSchema = z.object({
  lockedThrough: optionalDate("締め日"),
  reason: optionalText("理由", 500),
});
export type CloseFiscalYearInput = z.input<typeof closeFiscalYearSchema>;

// ---------------------------------------------------------------------------
// Filters of the lists (URL search parameters, 11 §3, §8)
// ---------------------------------------------------------------------------

/** A search parameter may repeat; the first value counts. */
function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? (value as unknown[])[0] : value;
}

/** URL parameters are typed by hand: anything unexpected falls back to the default, never an error. */
function lenient<T>(schema: z.ZodType<T>, fallback: T) {
  return z.preprocess(firstValue, schema).catch(fallback);
}

const filterDate = lenient<CalendarDate | null>(z.string().refine(isCalendarDate), null);
const filterId = lenient<string | null>(z.string().trim().min(1).max(64), null);
const filterPage = lenient(z.coerce.number().int().min(1).max(100_000), 1);

/**
 * 状態 of the journal list: 登録済み (default: the entries in force, reversals left out) /
 * 取消済み (the voided entries and their reversals) / すべて.
 */
export const ENTRY_STATUS_FILTERS = ["posted", "voided", "all"] as const;
export type EntryStatusFilter = (typeof ENTRY_STATUS_FILTERS)[number];

/** `/entries?from&to&account&partner&segment&tag&status&q&page` (11 §3). */
export const entriesFilterSchema = z.object({
  from: filterDate,
  to: filterDate,
  account: filterId,
  partner: filterId,
  segment: filterId,
  tag: filterId,
  status: lenient<EntryStatusFilter>(z.enum(ENTRY_STATUS_FILTERS), "posted"),
  /** 摘要 and the lines' 摘要, partial match. */
  q: lenient<string | null>(z.string().trim().min(1).max(100), null),
  page: filterPage,
});
export type EntriesFilter = z.output<typeof entriesFilterSchema>;

/** `/settings/audit-log?entity&from&to&page` (11 §8). */
export const auditLogFilterSchema = z.object({
  entity: lenient<(typeof AUDIT_ENTITIES)[number] | null>(z.enum(AUDIT_ENTITIES), null),
  from: filterDate,
  to: filterDate,
  page: filterPage,
});
export type AuditLogFilter = z.output<typeof auditLogFilterSchema>;

// ---------------------------------------------------------------------------
// 請求 (18-invoicing §3, §8–§10, §12)
// ---------------------------------------------------------------------------

/** Whole yen, negative allowed (a discount), 0 allowed; required. */
function signedYen(label: string) {
  return fromText(label, (text): Conversion<Money> => {
    if (text === "") return problem(`${label}を入力してください`);
    const amount = parseYenInput(text, { allowNegative: true });
    if (amount === null) return problem(`${label}は円の整数で入力してください`);
    return ok(amount);
  });
}

/** 数量: above 0 with at most 2 decimals → hundredths (`1.5` → `150n`), never floating point. */
const invoiceQuantityField = fromText("数量", (text): Conversion<bigint> => {
  const value = parseQuantity(text);
  return value === null
    ? problem("数量は 0 より大きい数（小数 2 桁まで）にしてください")
    : ok(value);
});

/** 税区分 of a line: one of the sales categories (課税売上 10% / 8% 軽減 / 非課税 / 不課税 / 輸出免税). */
const salesTaxCategoryField = fromText("税区分", (text): Conversion<SalesTaxCategoryCode> =>
  isSalesTaxCategoryCode(text) ? ok(text) : problem("税区分は売上の税区分から選んでください"),
);

/** A line of a document (18 §3.1). The amount is computed by the repository, never sent. */
export const invoiceLineSchema = z.object({
  /** 取引年月日; empty → the issue date. */
  date: optionalDate("日付"),
  name: requiredText("品名", 200),
  quantity: invoiceQuantityField,
  unit: optionalText("単位", 20),
  /** Negative for a discount. */
  unitPrice: signedYen("単価"),
  taxCategoryCode: salesTaxCategoryField,
});
export type InvoiceLineFormInput = z.input<typeof invoiceLineSchema>;
export type ParsedInvoiceLine = z.output<typeof invoiceLineSchema>;

/** The body of a draft, shared by the new and the edit forms (18 §8). */
const invoiceDraftFields = {
  partnerId: idField("取引先"),
  title: optionalText("件名", 200),
  issueDate: requiredDate("発行日"),
  /** 支払期限 (請求書) / 有効期限 (見積書); a delivery note has none. */
  dueDate: optionalDate("期限"),
  /** Unit prices include the tax (税込) instead of excluding it (税抜). */
  pricesIncludeTax: booleanField("単価の税"),
  note: optionalText("備考", 1000),
  /** 請求書 only; empty → the default (4040 売上高 受託開発). */
  revenueAccountId: optionalIdField("売上の科目"),
  /** 請求書 only; empty → the account's, then the partner's default, then 受託. */
  segmentId: optionalIdField("セグメント"),
  lines: z
    .array(invoiceLineSchema, { error: "行の形式が正しくありません" })
    .min(1, { error: "行は 1 行以上にしてください" })
    .max(100, { error: "行は 100 行までにしてください" }),
};

function checkDueDate(
  value: { issueDate: CalendarDate; dueDate: CalendarDate | null },
  ctx: z.RefinementCtx,
): void {
  if (value.dueDate !== null && value.dueDate < value.issueDate) {
    ctx.addIssue({ code: "custom", path: ["dueDate"], message: "期限は発行日以後にしてください" });
  }
}

/** 新規 / 変換 / 複製 (18 §8). `sourceInvoiceId` is set by a conversion (`from`) only. */
export const invoiceDraftSchema = z
  .object({
    docType: enumField("種別", INVOICE_DOC_TYPES),
    ...invoiceDraftFields,
    sourceInvoiceId: optionalIdField("変換元"),
  })
  .superRefine(checkDueDate);
export type InvoiceDraftInput = z.input<typeof invoiceDraftSchema>;
export type ParsedInvoiceDraft = z.output<typeof invoiceDraftSchema>;

/** 編集 of a draft: the type and the conversion source never change (extra keys are ignored). */
export const invoiceDraftUpdateSchema = z.object(invoiceDraftFields).superRefine(checkDueDate);
export type InvoiceDraftUpdateInput = z.input<typeof invoiceDraftUpdateSchema>;
export type ParsedInvoiceDraftUpdate = z.output<typeof invoiceDraftUpdateSchema>;

/** 送付済みにする (18 §9.3): where it was sent (an email address or a note), optional. */
export const invoiceSendSchema = z.object({
  sentTo: optionalText("宛先", 200),
  /** Set when the document went out by mail (18 §11): a paid one may then be sent again. */
  mailSubject: optionalText("件名", 200),
});
export type InvoiceSendInput = z.input<typeof invoiceSendSchema>;

/** A mail address as the mail form takes it (no display names, no lists inside). */
const MAIL_ADDRESS_PATTERN = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** 宛先 of a mail: addresses separated by commas or spaces, 1 to 5, duplicates dropped. */
const mailRecipientsField = fromText("宛先", (text): Conversion<string[]> => {
  const list = [...new Set(text.split(/[\s,、;]+/).filter((item) => item !== ""))];
  if (list.length === 0) return problem("宛先のメールアドレスを入れてください");
  if (list.length > 5) return problem("宛先は 5 件までにしてください");
  const bad = list.find((item) => item.length > 254 || !MAIL_ADDRESS_PATTERN.test(item));
  if (bad) return problem(`「${bad}」はメールアドレスの形ではありません。確かめてください`);
  return ok(list);
});

/** メールで送付 (18 §11): the recipients, the subject and the plain-text body; the PDF is attached. */
export const invoiceMailSchema = z.object({
  to: mailRecipientsField,
  subject: requiredText("件名", 200),
  text: requiredText("本文", 5000),
});
export type InvoiceMailInput = z.input<typeof invoiceMailSchema>;

/** 無効にする (18 §9.3): the reason is stored on the document and on the reversal. */
export const invoiceVoidSchema = z.object({ reason: requiredText("理由", 500) });
export type InvoiceVoidInput = z.input<typeof invoiceVoidSchema>;

/**
 * 入金の登録 (18 §5.2, §9.4). With a statement line (`walletTransactionId`) the date, the wallet and
 * the amount are the line's. `fee` is the transfer fee the customer deducted (empty or 0 → 0).
 */
export const invoicePaymentSchema = z.object({
  paidOn: requiredDate("入金日"),
  walletId: idField("口座"),
  amount: positiveYen("入金額"),
  fee: optionalPositiveYen("振込手数料").transform((fee): Money => fee ?? 0n),
  walletTransactionId: optionalIdField("明細"),
});
export type InvoicePaymentInput = z.input<typeof invoicePaymentSchema>;
export type ParsedInvoicePayment = z.output<typeof invoicePaymentSchema>;

/** 入金の取消 (18 §9.4). */
export const cancelInvoicePaymentSchema = z.object({
  paymentId: idField("入金"),
  reason: requiredText("理由", 500),
});
export type CancelInvoicePaymentInput = z.input<typeof cancelInvoicePaymentSchema>;

const bankAccountTypeField = orNull(
  z.preprocess(
    (value) => (value === "" || value === undefined || value === null ? null : asText(value)),
    z.enum(BANK_ACCOUNT_TYPES, { error: "種別を選んでください" }).nullable(),
  ),
);

/** 口座番号: digits only after full-width digits are made half-width; empty → `null`. */
const bankAccountNumberField = orNull(
  fromText("口座番号", (text): Conversion<string | null> => {
    const digits = toHalfWidthDigits(text);
    if (digits === "") return ok(null);
    return /^\d{1,20}$/.test(digits) ? ok(digits) : problem("口座番号は数字にしてください");
  }),
);

/** 振込先 printed on invoices (`Company.bankAccountForInvoice`, 18 §10). Every item is optional. */
export interface InvoiceBankAccount {
  bankName: string | null;
  branchName: string | null;
  accountType: BankAccountType | null;
  accountNumber: string | null;
  /** 口座名義 (カナ) */
  accountHolder: string | null;
  /** 補足, e.g. 振込手数料は貴社にてご負担ください */
  note: string | null;
}

/** 請求の設定 (18 §10). All items empty → no bank account (`null`). */
export const invoiceSettingsSchema = z
  .object({
    bankName: optionalText("銀行名", 100),
    branchName: optionalText("支店名", 100),
    accountType: bankAccountTypeField,
    accountNumber: bankAccountNumberField,
    accountHolder: optionalText("口座名義", 100),
    note: optionalText("補足", 200),
  })
  .transform((value): InvoiceBankAccount | null =>
    Object.values(value).every((item) => item === null) ? null : value,
  );
export type InvoiceSettingsInput = z.input<typeof invoiceSettingsSchema>;

/** 種別 of the list: 請求書 (default) / 見積書 / 納品書 / すべて. */
export const INVOICE_TYPE_FILTERS = ["invoice", "quote", "delivery", "all"] as const;
export type InvoiceTypeFilter = (typeof INVOICE_TYPE_FILTERS)[number];

/**
 * 状態 of the list: 未完了 (default: 下書き・発行済み・送付済み) / 下書き / 発行済み (送付済みを含む) /
 * 入金済み / 無効 / すべて.
 */
export const INVOICE_STATUS_FILTERS = ["open", "draft", "issued", "paid", "void", "all"] as const;
export type InvoiceStatusFilter = (typeof INVOICE_STATUS_FILTERS)[number];

/** `/invoices?type&status&partner&q&page` (18 §7). */
export const invoicesFilterSchema = z.object({
  type: lenient<InvoiceTypeFilter>(z.enum(INVOICE_TYPE_FILTERS), "invoice"),
  status: lenient<InvoiceStatusFilter>(z.enum(INVOICE_STATUS_FILTERS), "open"),
  partner: filterId,
  /** 番号 and 件名, partial match. */
  q: lenient<string | null>(z.string().trim().min(1).max(100), null),
  page: filterPage,
});
export type InvoicesFilter = z.output<typeof invoicesFilterSchema>;

// ---------------------------------------------------------------------------
// 支払 (25-payables §3, §4, §6, §7)
// ---------------------------------------------------------------------------

/**
 * 未払として登録 (25 §4.1, §7.1). One expense line: the amount is tax-inclusive. Empty 支払期日 →
 * the default of the partner's payment terms; empty セグメント → the partner's, else the account's
 * default, else 共通; empty 摘要 → 「請求書 <取引先>」.
 */
export const payableRegisterSchema = z.object({
  documentId: idField("証憑"),
  partnerId: idField("取引先"),
  invoiceDate: requiredDate("請求書の日付"),
  dueDate: optionalDate("支払期日"),
  amount: positiveYen("金額"),
  accountId: idField("科目"),
  taxCategoryCode: taxCategoryCodeField("税区分"),
  segmentId: optionalIdField("セグメント"),
  description: optionalText("摘要", 200),
  /** 支払元の予定 */
  walletId: optionalIdField("支払元の予定"),
});
export type PayableRegisterInput = z.input<typeof payableRegisterSchema>;

/** 期日・支払元を変える (25 §4.3). A missing key is left as it is; empty clears it. */
export const payableUpdateSchema = z.object({
  dueDate: optionalDate("支払期日").optional(),
  walletId: optionalIdField("支払元の予定").optional(),
});
export type PayableUpdateInput = z.input<typeof payableUpdateSchema>;

/**
 * 支払の登録 (25 §4.2). With a statement line (`walletTransactionId`, a pending outflow of the chosen
 * wallet) the date, the wallet and the amount are the line's.
 */
export const payablePaymentSchema = z.object({
  paidOn: requiredDate("支払日"),
  walletId: idField("口座"),
  amount: positiveYen("出金額"),
  walletTransactionId: optionalIdField("明細"),
});
export type PayablePaymentInput = z.input<typeof payablePaymentSchema>;

/** 支払の取消 (25 §4.3): the payment's entry and the reason. */
export const cancelPayablePaymentSchema = z.object({
  entryId: idField("支払"),
  reason: requiredText("理由", 500),
});
export type CancelPayablePaymentInput = z.input<typeof cancelPayablePaymentSchema>;

/** 登録の取消 (25 §4.3). */
export const cancelPayableSchema = z.object({ reason: requiredText("理由", 500) });
export type CancelPayableInput = z.input<typeof cancelPayableSchema>;

const PAYMENT_TERM_FIELDS = ["closingDay", "dueMonths", "dueDay"] as const;

/**
 * 支払条件 of a partner (25 §3): 締め日・何か月後・支払日 (31 = 末日), all three or none (none clears
 * them). Parsed into `terms` (`null` = no terms).
 */
export const partnerPaymentTermsSchema = z
  .object({
    partnerId: idField("取引先"),
    closingDay: optionalIntegerInRange("締め日", 1, 31),
    dueMonths: optionalIntegerInRange("何か月後", 0, 3),
    dueDay: optionalIntegerInRange("支払日", 1, 31),
  })
  .superRefine((value, ctx) => {
    const missing = PAYMENT_TERM_FIELDS.filter((field) => value[field] === null);
    if (missing.length === PAYMENT_TERM_FIELDS.length) return;
    const [first] = missing;
    if (first) {
      ctx.addIssue({
        code: "custom",
        message:
          "締め日・何か月後・支払日の 3 つを入力してください（支払条件をなくすときは 3 つとも空にします）",
        path: [first],
      });
      return;
    }
    const problem = paymentTermsProblem({
      closingDay: value.closingDay ?? 0,
      dueMonths: value.dueMonths ?? 0,
      dueDay: value.dueDay ?? 0,
    });
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["dueDay"] });
  })
  .transform((value): { partnerId: string; terms: PaymentTerms | null } => ({
    partnerId: value.partnerId,
    terms:
      value.closingDay === null || value.dueMonths === null || value.dueDay === null
        ? null
        : { closingDay: value.closingDay, dueMonths: value.dueMonths, dueDay: value.dueDay },
  }));
export type PartnerPaymentTermsInput = z.input<typeof partnerPaymentTermsSchema>;

/** 状態 of the list: 未払 (default: 未払・一部支払) / 支払済み / すべて (取消 too; never void documents). */
export const PAYABLE_STATUS_FILTERS = ["open", "paid", "all"] as const;
export type PayableStatusFilter = (typeof PAYABLE_STATUS_FILTERS)[number];

/** 並び: 期日順 (default) / 取引先別. */
export const PAYABLE_VIEWS = ["due", "partner"] as const;
export type PayableView = (typeof PAYABLE_VIEWS)[number];

/** `/payables?status&partner&view&q&page` (25 §6). */
export const payablesFilterSchema = z.object({
  status: lenient<PayableStatusFilter>(z.enum(PAYABLE_STATUS_FILTERS), "open"),
  partner: filterId,
  view: lenient<PayableView>(z.enum(PAYABLE_VIEWS), "due"),
  /** 取引先名・ファイル名・メモ, partial match. */
  q: lenient<string | null>(z.string().trim().min(1).max(100), null),
  page: filterPage,
});
export type PayablesFilter = z.output<typeof payablesFilterSchema>;

// Imports (取込, 12-imports)
// ---------------------------------------------------------------------------

/** Largest CSV file accepted (12-imports §1.2). The Server Actions' body limit matches it. */
export const MAX_CSV_FILE_BYTES = 10 * 1024 * 1024;

/** Highest 0-based column a mapping may name (statement CSVs have a handful of columns). */
const MAX_CSV_COLUMN = 199;

const CSV_ORDERS = ["asc", "desc", "auto"] as const;

const OPTIONAL_CSV_COLUMNS = [
  "amount",
  "deposit",
  "withdrawal",
  "balance",
  "counterparty",
] as const;

/** A 0-based column chosen in a select: a number, or its text (form values). */
function csvColumnField(label: string) {
  return fromText(label, (text) => {
    if (text === "") return problem(`${label}を選んでください`);
    return convertInteger(label, text, 0, MAX_CSV_COLUMN);
  });
}

/** Empty (「なし」) or `null` → `null`: the column is not mapped. */
function optionalCsvColumnField(label: string) {
  return orNull(
    fromText(label, (text): Conversion<number | null> =>
      text === "" ? ok(null) : convertInteger(label, text, 0, MAX_CSV_COLUMN),
    ),
  );
}

/** A CSV format key from a select; empty or `null` → `null` (自動判別). */
function optionalCsvFormatField(label: string) {
  return orNull(
    z.preprocess(
      (value) => (value === "" || value === null || value === undefined ? null : asText(value)),
      z.enum(CSV_FORMAT_KEYS, { error: `${label}を選んでください` }).nullable(),
    ),
  );
}

/**
 * Column mapping of the generic format (`GenericCsvConfig`, 12-imports §1.2): the date and the
 * description, and either the signed amount or the withdrawal / deposit columns. The output is a
 * `GenericCsvConfig` without the columns that are not mapped, so it can be saved on the wallet.
 */
export const genericCsvConfigSchema = z
  .object(
    {
      headerRows: fromText("ヘッダ行の数", (text) =>
        text === "" ? ok(1) : convertInteger("ヘッダ行の数", text, 0, 50),
      ).default(1),
      columns: z.object(
        {
          date: csvColumnField("日付の列"),
          description: csvColumnField("摘要の列"),
          amount: optionalCsvColumnField("金額（符号付き）の列"),
          deposit: optionalCsvColumnField("入金の列"),
          withdrawal: optionalCsvColumnField("出金の列"),
          balance: optionalCsvColumnField("残高の列"),
          counterparty: optionalCsvColumnField("相手の列"),
        },
        { error: "列の対応を指定してください" },
      ),
      /** 「金額の正を出金として扱う」 (a card's 利用金額). */
      invertSign: booleanField("金額の正を出金として扱う").default(false),
      order: z
        .preprocess(
          (value) => (value === "" || value === null ? "auto" : asText(value)),
          z.enum(CSV_ORDERS, { error: "並びは 自動・古い順・新しい順 のどれかを選んでください" }),
        )
        .default("auto"),
    },
    { error: "列の対応を指定してください" },
  )
  .superRefine((value, ctx) => {
    const { amount, deposit, withdrawal } = value.columns;
    const split = deposit !== null || withdrawal !== null;
    if (amount !== null && split) {
      ctx.addIssue({
        code: "custom",
        path: ["columns", "amount"],
        message: "金額（符号付き）と出金・入金は、どちらか一方だけを選んでください",
      });
    } else if (amount === null && !split) {
      ctx.addIssue({
        code: "custom",
        path: ["columns", "amount"],
        message: "金額（符号付き）か、出金・入金の列を選んでください",
      });
    }
    const seen = new Set<number>();
    for (const [key, column] of Object.entries(value.columns)) {
      if (column === null) continue;
      if (seen.has(column)) {
        ctx.addIssue({
          code: "custom",
          path: ["columns", key],
          message: "同じ列を 2 つの項目に選んでいます。列の対応を確かめてください",
        });
      }
      seen.add(column);
    }
  })
  .transform((value): GenericCsvConfig => {
    const columns: GenericCsvConfig["columns"] = {
      date: value.columns.date,
      description: value.columns.description,
    };
    for (const key of OPTIONAL_CSV_COLUMNS) {
      const column = value.columns[key];
      if (column !== null) columns[key] = column;
    }
    return {
      headerRows: value.headerRows,
      columns,
      invertSign: value.invertSign,
      order: value.order,
    };
  });
export type GenericCsvConfigInput = z.input<typeof genericCsvConfigSchema>;

/** 取込の設定 of a bank / card / other wallet: the format (`null` = 自動判別) and, for 汎用, the mapping. */
export const walletImporterInputSchema = z.object({
  walletId: idField("口座"),
  importer: optionalCsvFormatField("取込形式"),
  importerConfig: orNull(genericCsvConfigSchema.nullable()),
});
export type WalletImporterInput = z.input<typeof walletImporterInputSchema>;
export type ParsedWalletImporterInput = z.output<typeof walletImporterInputSchema>;

const STRIPE_ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]{8,64}$/;
/**
 * The environment variables a Stripe key may be read from (12-imports §4.1): only names under
 * `NIHO_FINANCE_STRIPE_`, so a connection can never send another secret (`DATABASE_URL`, …) to
 * Stripe as its API key.
 */
export const STRIPE_KEY_NAME_PATTERN = /^NIHO_FINANCE_STRIPE_[A-Z0-9_]{1,44}$/;
const STRIPE_KEY_PATTERN = /^(?:rk|sk)_/i;

/** Stripe の接続: the account ID and the name of the environment variable holding its key (§4.1). */
export const stripeAccountLinkInputSchema = z.object({
  walletId: idField("口座"),
  stripeAccountId: fromText("アカウント ID", (text) => {
    if (text === "") return problem("アカウント ID を入力してください");
    if (!STRIPE_ACCOUNT_ID_PATTERN.test(text)) {
      return problem("アカウント ID は acct_ で始まる Stripe のアカウント ID です");
    }
    return ok(text);
  }),
  secretName: fromText("鍵の名前", (text) => {
    if (text === "") return problem("鍵の名前を入力してください");
    if (STRIPE_KEY_PATTERN.test(text)) {
      return problem("鍵そのものは入力しません。鍵を置いた環境変数の名前を入力してください");
    }
    if (!STRIPE_KEY_NAME_PATTERN.test(text)) {
      return problem(
        "鍵の名前は NIHO_FINANCE_STRIPE_ で始まる環境変数の名前にします（大文字の英数字と _。例 NIHO_FINANCE_STRIPE_KEY_PLATFORM）",
      );
    }
    return ok(text);
  }),
});
export type StripeAccountLinkInput = z.input<typeof stripeAccountLinkInputSchema>;

/**
 * A CSV file to preview or import (12-imports §1.2). `format` and `config` override what the wallet
 * has saved; `rememberFormat` (「この形式と列対応を口座に保存し、次回から使う」) only matters to the import.
 */
export const csvImportInputSchema = z.object({
  walletId: idField("口座"),
  fileName: requiredText("ファイル名", 255),
  /** Any `Uint8Array` (a Node `Buffer` too), whatever buffer backs it. */
  bytes: z
    .custom<Uint8Array>((value) => value instanceof Uint8Array, {
      error: "ファイルを選んでください",
    })
    .refine((bytes) => bytes.byteLength > 0, { error: "ファイルが空です" })
    .refine((bytes) => bytes.byteLength <= MAX_CSV_FILE_BYTES, {
      error: "ファイルが大きすぎます（10 MB まで）",
    }),
  format: optionalCsvFormatField("取込形式"),
  config: orNull(genericCsvConfigSchema.nullable()),
  rememberFormat: booleanField("取込形式の保存").default(true),
});
export type CsvImportInput = z.input<typeof csvImportInputSchema>;
export type ParsedCsvImportInput = z.output<typeof csvImportInputSchema>;

// ---------------------------------------------------------------------------
// 明細 (15-statements)
// ---------------------------------------------------------------------------

/** 状態 of the statement list (15 §3): 未処理 (default) / 登録済み / 振替 / 無視. */
export const STATEMENT_STATUS_FILTERS = ["pending", "registered", "transfer", "ignored"] as const;
export type StatementStatusFilter = (typeof STATEMENT_STATUS_FILTERS)[number];

/** `/statements?wallet&status&q&by&page` (15 §3). */
export const statementsFilterSchema = z.object({
  wallet: filterId,
  status: lenient<StatementStatusFilter>(z.enum(STATEMENT_STATUS_FILTERS), "pending"),
  /** 摘要・振込人, partial match; digits and separators only → the amount (|金額|). */
  q: lenient<string | null>(z.string().trim().min(1).max(100), null),
  /** `rule`: settled by a rule without the owner (the settled tabs only). */
  by: lenient<"rule" | null>(z.literal("rule"), null),
  page: filterPage,
});
export type StatementsFilter = z.output<typeof statementsFilterSchema>;

/** A line of 登録 (one, or several for 分割, 15 §9). The amount is tax-inclusive. */
export const statementLineSchema = z.object({
  accountId: idField("科目"),
  /** Empty → the whole amount of the statement line (only with one line). */
  amount: optionalPositiveYen("金額"),
  taxCategoryCode: taxCategoryCodeField(),
  segmentId: optionalIdField("セグメント"),
  /** Empty → the entry's partner. */
  partnerId: optionalIdField("取引先"),
  description: optionalText("摘要", 200),
});
export type StatementLineFormInput = z.input<typeof statementLineSchema>;

/** 登録 of a statement line (15 §1, §5, §9). */
export const registerStatementSchema = z.object({
  /** Empty → the line's own description (cut to 200 characters). */
  description: optionalText("摘要", 200),
  partnerId: optionalIdField("取引先"),
  /** The rule whose suggestion is being registered (its hit count goes up). */
  ruleId: optionalIdField("ルール"),
  lines: z
    .array(statementLineSchema, { error: "行の形式が正しくありません" })
    .min(1, { error: "行を 1 行以上入れてください" })
    .max(30, { error: "行は 30 行までにしてください" }),
});
export type RegisterStatementInput = z.input<typeof registerStatementSchema>;
export type ParsedRegisterStatement = z.output<typeof registerStatementSchema>;

/** The other side of a 振替 (15 §8): a pending line, a posted transfer entry, or just a wallet. */
export interface StatementCounterpart {
  kind: "txn" | "entry" | "wallet";
  id: string;
}

/** 振替 of a statement line: `txn:<id>` / `entry:<id>` / `wallet:<id>` (15 §1, §8). */
export const transferStatementSchema = z.object({
  counterpart: fromText("相手", (text): Conversion<StatementCounterpart> => {
    if (text === "") return problem("相手を選んでください");
    const match = /^(txn|entry|wallet):(\S{1,64})$/.exec(text);
    const kind = match?.[1];
    const id = match?.[2];
    if (!id || (kind !== "txn" && kind !== "entry" && kind !== "wallet")) {
      return problem("相手が正しくありません");
    }
    return ok({ kind, id });
  }),
  /** Only with `wallet:` (paid by the paying wallet, 11 §4.3). */
  fee: optionalPositiveYen("手数料"),
  /** Empty → 「振替 <出金側> → <入金側>」. */
  description: optionalText("摘要", 200),
  ruleId: optionalIdField("ルール"),
});
export type TransferStatementInput = z.input<typeof transferStatementSchema>;
export type ParsedTransferStatement = z.output<typeof transferStatementSchema>;

/** 無視 (15 §1): the reason is optional. */
export const ignoreStatementSchema = z.object({
  reason: optionalText("理由", 200),
  ruleId: optionalIdField("ルール"),
});
export type IgnoreStatementInput = z.input<typeof ignoreStatementSchema>;

/** 未処理に戻す: the reason is required when an entry is voided (checked by the repository). */
export const reopenStatementSchema = z.object({ reason: optionalText("理由", 500) });
export type ReopenStatementInput = z.input<typeof reopenStatementSchema>;

/** メモ of a statement line (any state; never written to the entry). */
export const statementNoteSchema = z.object({ note: optionalText("メモ", 500) });
export type StatementNoteInput = z.input<typeof statementNoteSchema>;

// ---------------------------------------------------------------------------
// ルール (15 §10)
// ---------------------------------------------------------------------------

const ruleSignField = orNull(
  fromText("符号", (text): Conversion<RuleSign | null> => {
    if (text === "" || text === "both") return ok(null);
    if (text === "in" || text === "out") return ok(text);
    return problem("符号が正しくありません");
  }),
);

const ruleRegexField = orNull(
  fromText("正規表現", (text): Conversion<string | null> => {
    if (text === "") return ok(null);
    if (text.length > RULE_REGEX_MAX_LENGTH) {
      return problem(`正規表現は ${RULE_REGEX_MAX_LENGTH} 文字以内にしてください`);
    }
    if (!isValidRuleRegex(text)) return problem("正規表現が正しくありません");
    return ok(text);
  }),
);

/** 条件 of a rule: at least one, all AND. Amounts are |金額| in whole yen. */
export const ruleMatchSchema = z
  .object({
    descriptionContains: optionalText("摘要に含む", 100),
    descriptionRegex: ruleRegexField,
    counterpartyContains: optionalText("振込人に含む", 100),
    amountMin: optionalPositiveYen("金額の下限"),
    amountMax: optionalPositiveYen("金額の上限"),
    sign: ruleSignField,
  })
  .superRefine((match, ctx) => {
    if (match.amountMin !== null && match.amountMax !== null && match.amountMin > match.amountMax) {
      ctx.addIssue({
        code: "custom",
        path: ["amountMax"],
        message: "金額の上限は下限以上にしてください",
      });
    }
    const conditions = [
      match.descriptionContains,
      match.descriptionRegex,
      match.counterpartyContains,
      match.amountMin,
      match.amountMax,
      match.sign,
    ];
    if (conditions.every((value) => value === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["descriptionContains"],
        message: "条件を 1 つ以上入れてください",
      });
    }
  })
  .transform((match): RuleMatch => match);
export type RuleMatchInput = z.input<typeof ruleMatchSchema>;

/** 動作 of a rule; the fields another mode does not use are dropped. */
export const ruleActionSchema = z
  .object({
    mode: enumField("動作", RULE_MODES),
    accountId: optionalIdField("科目"),
    taxCategoryCode: optionalTaxCategoryCodeField(),
    partnerId: optionalIdField("取引先"),
    segmentId: optionalIdField("セグメント"),
    descriptionTemplate: optionalText("摘要の雛形", 200),
    transferToWalletId: optionalIdField("相手口座"),
    ignoredReason: optionalText("理由", 200),
  })
  .superRefine((action, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    switch (action.mode) {
      case "register":
        if (!action.accountId) issue("accountId", "科目を選んでください");
        if (!action.taxCategoryCode) issue("taxCategoryCode", "税区分を選んでください");
        return;
      case "suggest":
        if (
          !action.accountId &&
          !action.taxCategoryCode &&
          !action.partnerId &&
          !action.segmentId
        ) {
          issue("accountId", "科目・税区分・取引先・セグメントのどれかを入れてください");
        }
        return;
      case "transfer":
        if (!action.transferToWalletId) issue("transferToWalletId", "相手口座を選んでください");
        return;
      case "ignore":
        return;
    }
  })
  .transform((action): RuleAction => {
    const fields = action.mode === "register" || action.mode === "suggest";
    return {
      mode: action.mode,
      accountId: fields ? action.accountId : null,
      taxCategoryCode: fields ? action.taxCategoryCode : null,
      partnerId: fields ? action.partnerId : null,
      segmentId: fields ? action.segmentId : null,
      descriptionTemplate: fields ? action.descriptionTemplate : null,
      transferToWalletId: action.mode === "transfer" ? action.transferToWalletId : null,
      ignoredReason: action.mode === "ignore" ? action.ignoredReason : null,
    };
  });
export type RuleActionInput = z.input<typeof ruleActionSchema>;

/** 優先度: an integer from −100 to 100; empty → 0. */
const rulePriorityField = fromText("優先度", (text): Conversion<number> => {
  if (text === "") return ok(0);
  const normalized = toHalfWidthDigits(text).replace(/^[−－]/, "-");
  if (!/^[-+]?\d+$/.test(normalized)) return problem("優先度は整数で入力してください");
  const value = Number(normalized);
  if (value < -100 || value > 100) return problem("優先度は -100〜100 にしてください");
  return ok(value);
});

const ruleFields = {
  /** Empty → the match summary is the display name. */
  name: optionalText("名前", 50),
  /** Empty → every wallet. */
  walletId: optionalIdField("口座"),
  match: ruleMatchSchema,
  action: ruleActionSchema,
  /** Left out → off. */
  autoPost: booleanField("自動登録").optional(),
  /** Left out → 0. */
  priority: rulePriorityField.optional(),
};

/** ルールを追加 (15 §10). A 候補 rule never posts by itself (`autoPost` is forced off). */
export const ruleCreateSchema = z.object(ruleFields).transform((rule) => ({
  ...rule,
  autoPost: rule.action.mode === "suggest" ? false : rule.autoPost === true,
  priority: rule.priority ?? 0,
}));
export type RuleCreateInput = z.input<typeof ruleCreateSchema>;
export type ParsedRuleCreate = z.output<typeof ruleCreateSchema>;

/** ルールの編集: only the given keys change (`match` / `action` are replaced as a whole). */
export const ruleUpdateSchema = z.object({
  name: ruleFields.name.optional(),
  walletId: ruleFields.walletId.optional(),
  match: ruleMatchSchema.optional(),
  action: ruleActionSchema.optional(),
  autoPost: ruleFields.autoPost,
  priority: ruleFields.priority,
});
export type RuleUpdateInput = z.input<typeof ruleUpdateSchema>;
export type ParsedRuleUpdate = z.output<typeof ruleUpdateSchema>;

// ---------------------------------------------------------------------------
// Documents (証憑, 13-documents §8.3)
// ---------------------------------------------------------------------------

/** Whole yen, 0 or more; empty → `null`. Accepts `3980`, `3,980`, full-width digits and bigint. */
export function optionalNonNegativeYen(label: string) {
  return orNull(
    fromText(label, (text): Conversion<Money | null> => {
      if (text === "") return ok(null);
      const amount = parseYenInput(text);
      if (amount === null) return problem(`${label}は 0 以上の円の整数で入力してください`);
      return ok(amount);
    }),
  );
}

/** One of `values`; empty → `null` (e.g. 「すべて」 in a select). */
export function optionalEnumField<const T extends readonly [string, ...string[]]>(
  label: string,
  values: T,
) {
  return orNull(
    fromText(label, (text): Conversion<T[number] | null> => {
      if (text === "") return ok(null);
      if (!(values as readonly string[]).includes(text)) return problem(`${label}を選んでください`);
      return ok(text as T[number]);
    }),
  );
}

/** One of `values`; a missing key, `null` or "" → `fallback`. */
function enumWithDefault<const T extends readonly [string, ...string[]]>(
  label: string,
  values: T,
  fallback: T[number],
) {
  return fromText(label, (text): Conversion<T[number]> => {
    if (text === "") return ok(fallback);
    if (!(values as readonly string[]).includes(text)) return problem(`${label}を選んでください`);
    return ok(text as T[number]);
  })
    .optional()
    .transform((value): T[number] => value ?? fallback);
}

/** SHA-256 of the file: 64 hex digits, normalized to lower case. */
const sha256Field = fromText("SHA-256", (text) => {
  const value = text.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return problem("ファイルの SHA-256 が正しくありません。ファイルを選び直してください");
  }
  return ok(value);
});

/** An accepted MIME type (`normalizeDocumentMime` turns the browser's type into one). */
const documentMimeField = fromText("形式", (text): Conversion<DocumentMime> => {
  if (!isAcceptedDocumentMime(text)) {
    return problem(
      "この形式のファイルは保存できません。画像（JPEG・PNG・WebP・HEIC）・PDF・CSV を選んでください",
    );
  }
  return ok(text);
});

const documentByteSizeField = fromText("大きさ", (text): Conversion<number> => {
  if (!/^\d+$/.test(text)) {
    return problem("ファイルの大きさが正しくありません。ファイルを選び直してください");
  }
  const size = Number(text);
  if (size === 0)
    return problem("空のファイルは保存できません。中身のあるファイルを選んでください");
  if (size > DOCUMENT_MAX_BYTES) {
    return problem("ファイルは 20 MB までです。小さくしてから選び直してください");
  }
  return ok(size);
});

/** The stored file as the browser describes it (checked again against the bytes on completion). */
export const documentFileSchema = z.object({
  sha256: sha256Field,
  mime: documentMimeField,
  byteSize: documentByteSizeField,
  originalName: optionalText("ファイル名", 200),
  source: enumField("保存の方法", DOCUMENT_SOURCES),
});
export type DocumentFileInput = z.input<typeof documentFileSchema>;

/** Where the file is stored (`documents/<yyyy>/<mm>/<ulid>.<ext>`). */
const storageKeyField = requiredText("保存先", 500);

/** The search items required by 電子帳簿保存法 (date, amount, partner) and the rest of the form. */
const documentItemFields = {
  txnDate: optionalDate("取引年月日"),
  amount: optionalNonNegativeYen("金額"),
  /** A partner of the master; when set, the free-text name is cleared. */
  partnerId: optionalIdField("取引先"),
  /** Free-text name (「その他」) when the partner is not in the master. */
  partnerName: optionalText("取引先名", 200),
  invoiceRegistrationNumber: optionalInvoiceRegistrationNumber,
  note: optionalText("メモ", 1000),
};

/** Omitted keys are left as they are (update) or inherited (replacement). */
const documentItemPatchFields = {
  kind: enumField("種別", DOCUMENT_KINDS).optional(),
  txnDate: documentItemFields.txnDate.optional(),
  amount: documentItemFields.amount.optional(),
  partnerId: documentItemFields.partnerId.optional(),
  partnerName: documentItemFields.partnerName.optional(),
  invoiceRegistrationNumber: documentItemFields.invoiceRegistrationNumber.optional(),
  note: documentItemFields.note.optional(),
};

export const documentRegisterSchema = documentFileSchema.extend({
  storageKey: storageKeyField,
  /** Defaults to 領収書. */
  kind: enumWithDefault("種別", DOCUMENT_KINDS, "receipt"),
  ...documentItemFields,
});
export type DocumentRegisterInput = z.input<typeof documentRegisterSchema>;

/** The items edited on the detail screen (13 §4). Omitted keys are left as they are. */
export const documentUpdateSchema = z.object({
  id: idField("証憑"),
  ...documentItemPatchFields,
});
export type DocumentUpdateInput = z.input<typeof documentUpdateSchema>;

export const documentVoidSchema = z.object({
  id: idField("証憑"),
  reason: requiredText("理由", 200),
});
export type DocumentVoidInput = z.input<typeof documentVoidSchema>;

/** A new file for a document; items given in `replacement` win over the inherited ones. */
export const documentReplaceSchema = z.object({
  id: idField("差し替える証憑"),
  reason: requiredText("理由", 200),
  replacement: documentFileSchema.extend({
    storageKey: storageKeyField,
    ...documentItemPatchFields,
  }),
});
export type DocumentReplaceInput = z.input<typeof documentReplaceSchema>;

export const documentLinkSchema = z.object({
  kind: enumField("紐づける先", DOCUMENT_LINK_KINDS),
  id: idField("紐づける先"),
  documentId: idField("証憑"),
});
export type DocumentLinkInput = z.input<typeof documentLinkSchema>;

/**
 * The list's search form (13 §3.2; URL search parameters are the source). Conditions are ANDed.
 * `tab` stays `null` when not given: the list defaults to the inbox, the index CSV to all.
 */
export const documentSearchSchema = z
  .object({
    tab: optionalEnumField("タブ", DOCUMENT_TABS),
    from: optionalDate("取引年月日の始まり"),
    to: optionalDate("取引年月日の終わり"),
    amountMin: optionalNonNegativeYen("金額の下限"),
    amountMax: optionalNonNegativeYen("金額の上限"),
    /** Part of the partner's name (the master's or the free-text one). */
    partner: optionalText("取引先", 200),
    kind: optionalEnumField("種別", DOCUMENT_KINDS),
    /** Part of the file name, the note or the partner's name. */
    q: optionalText("キーワード", 200),
    page: optionalIntegerInRange("ページ", 1, 100_000).transform((value) => value ?? 1),
  })
  .superRefine((value, ctx) => {
    if (value.from !== null && value.to !== null && value.from > value.to) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "取引年月日の終わりは始まりと同じ日か、それより後にしてください",
      });
    }
    if (value.amountMin !== null && value.amountMax !== null && value.amountMin > value.amountMax) {
      ctx.addIssue({
        code: "custom",
        path: ["amountMax"],
        message: "金額の上限は下限と同じか、それより大きくしてください",
      });
    }
  });
export type DocumentSearchInput = z.input<typeof documentSearchSchema>;
export type DocumentSearchFilters = z.output<typeof documentSearchSchema>;

/** 設定 › 証憑の規程 (13 §5). Empty 管理責任者 → 代表者, empty 処理責任者 → 管理責任者. */
export const recordsPolicySchema = z.object({
  effectiveOn: requiredDate("施行日"),
  manager: optionalText("管理責任者", 100),
  operator: optionalText("処理責任者", 100),
  /** `POLICY_VERSION` of the text that is put in force. */
  version: requiredText("版", 50),
});
export type RecordsPolicyInput = z.input<typeof recordsPolicySchema>;

// ---------------------------------------------------------------------------
// 給与 (22-payroll §5.6・§6)
// ---------------------------------------------------------------------------

/** Whole yen, 0 or more. Empty → `emptyAs` when given, otherwise 「…を入力してください」. */
export function nonNegativeYen(label: string, options: { emptyAs?: Money } = {}) {
  return fromText(label, (text): Conversion<Money> => {
    if (text === "") {
      return options.emptyAs === undefined
        ? problem(`${label}を入力してください`)
        : ok(options.emptyAs);
    }
    const amount = parseYenInput(text);
    if (amount === null) return problem(`${label}は 0 円以上の円の整数で入力してください`);
    return ok(amount);
  });
}

/** Whole yen, negative allowed (a correction); empty → 0. */
export function signedYenOrZero(label: string) {
  return fromText(label, (text): Conversion<Money> => {
    if (text === "") return ok(0n);
    const amount = parseYenInput(text, { allowNegative: true });
    if (amount === null)
      return problem(`${label}は円の整数で入力してください（マイナスも入れられます）`);
    return ok(amount);
  });
}

/** A month as `YYYY-MM`. */
export function yearMonthField(label: string) {
  return fromText(label, (text): Conversion<YearMonth> => {
    if (text === "") return problem(`${label}を入力してください`);
    if (!isYearMonth(text)) return problem(`${label}は 2026-12 の形にしてください`);
    return ok(text);
  });
}

export const EMPLOYEE_KINDS = ["officer", "employee"] as const;
export const EMPLOYEE_TAX_COLUMNS = ["kou", "otsu"] as const;

const employeeFields = {
  name: requiredText("名前", 100),
  kind: enumField("区分", EMPLOYEE_KINDS),
  birthDate: requiredDate("生年月日"),
  basePay: nonNegativeYen("課税支給"),
  commuteAllowance: nonNegativeYen("通勤手当", { emptyAs: 0n }),
  socialInsured: booleanField("社会保険"),
  insuredFrom: optionalDate("資格取得日"),
  healthSmr: optionalPositiveYen("標準報酬月額（健康保険）"),
  pensionSmr: optionalPositiveYen("標準報酬月額（厚生年金）"),
  employmentInsured: booleanField("雇用保険"),
  taxColumn: enumField("源泉徴収の区分", EMPLOYEE_TAX_COLUMNS),
  dependents: optionalIntegerInRange("扶養親族等の数", 0, 99),
  residentTax: nonNegativeYen("住民税", { emptyAs: 0n }),
};

type EmployeeFieldsOutput = z.output<z.ZodObject<typeof employeeFields>>;

/** 役員は雇用保険なし; 社会保険ありなら資格取得日と標準報酬月額 2 つが要る (22-payroll §5.1). */
function refineEmployee(value: EmployeeFieldsOutput, ctx: z.RefinementCtx): void {
  if (value.kind === "officer" && value.employmentInsured) {
    ctx.addIssue({
      code: "custom",
      path: ["employmentInsured"],
      message: "役員は雇用保険の被保険者になりません。雇用保険を「なし」にしてください",
    });
  }
  if (!value.socialInsured) return;
  const required = [
    ["insuredFrom", value.insuredFrom, "資格取得日"],
    ["healthSmr", value.healthSmr, "標準報酬月額（健康保険）"],
    ["pensionSmr", value.pensionSmr, "標準報酬月額（厚生年金）"],
  ] as const;
  for (const [path, field, label] of required) {
    if (field === null) {
      ctx.addIssue({
        code: "custom",
        path: [path],
        message: `社会保険ありのときは${label}を入力してください`,
      });
    }
  }
}

/** Without social insurance the 資格取得日 and 標準報酬月額 are not kept. */
function normalizeEmployee<T extends EmployeeFieldsOutput>(value: T) {
  return {
    ...value,
    insuredFrom: value.socialInsured ? value.insuredFrom : null,
    healthSmr: value.socialInsured ? value.healthSmr : null,
    pensionSmr: value.socialInsured ? value.pensionSmr : null,
    dependents: value.dependents ?? 0,
  };
}

/** 従業員の追加 (22-payroll §6.2). */
export const employeeCreateSchema = z
  .object(employeeFields)
  .superRefine(refineEmployee)
  .transform(normalizeEmployee);
export type EmployeeCreateInput = z.input<typeof employeeCreateSchema>;
export type ParsedEmployeeInput = z.output<typeof employeeCreateSchema>;

/** 従業員の変更: every field is sent again (the Sheet edits the whole row). */
export const employeeUpdateSchema = z
  .object({ id: idField("従業員"), ...employeeFields })
  .superRefine(refineEmployee)
  .transform(normalizeEmployee);
export type EmployeeUpdateInput = z.input<typeof employeeUpdateSchema>;

/** One person of a pay run: what the screen lets change (master data comes from the database). */
export const payrollRunItemSchema = z
  .object({
    employeeId: idField("従業員"),
    taxablePay: nonNegativeYen("課税支給"),
    commuteAllowance: nonNegativeYen("通勤手当", { emptyAs: 0n }),
    residentTax: nonNegativeYen("住民税", { emptyAs: 0n }),
    incomeTaxAdjustment: signedYenOrZero("源泉所得税の調整"),
    socialInsuranceAdjustment: signedYenOrZero("社会保険料の調整"),
    adjustmentNote: optionalText("調整のメモ", 200),
  })
  .superRefine((value, ctx) => {
    const adjusted = value.incomeTaxAdjustment !== 0n || value.socialInsuranceAdjustment !== 0n;
    if (adjusted && value.adjustmentNote === null) {
      ctx.addIssue({
        code: "custom",
        path: ["adjustmentNote"],
        message: "調整したときは、何を直したかをメモに書いてください",
      });
    }
  })
  .transform((value) => ({
    ...value,
    adjustmentNote:
      value.incomeTaxAdjustment !== 0n || value.socialInsuranceAdjustment !== 0n
        ? value.adjustmentNote
        : null,
  }));
export type PayrollRunItemFormInput = z.input<typeof payrollRunItemSchema>;

const tableIdText = z.string().trim().min(1).max(100);

/** The table versions the preview used: the confirmation then computes with the same ones. */
export const payrollTableIdsSchema = z.object({
  withholding: tableIdText,
  kenpo: tableIdText,
  pension: tableIdText,
  employment: tableIdText.nullable(),
});

/** The totals the owner confirmed (the preview's): the confirmation is refused when they differ. */
export const payrollExpectedSchema = z.object({
  grossPay: signedYenOrZero("総支給の合計"),
  netPay: signedYenOrZero("差引支給の合計"),
  employerTotal: signedYenOrZero("会社負担の合計"),
});

/** 支給の計算 → 確定 (22-payroll §6.3). */
export const payrollRunSchema = z.object({
  payMonth: yearMonthField("支給月"),
  paymentDate: requiredDate("支払日"),
  premiumTiming: enumField("社会保険料の控除", PREMIUM_TIMINGS),
  /** Empty → 未払金〔給与〕. */
  payFromWalletId: optionalIdField("支払元"),
  withholdingSpecialDue: booleanField("源泉所得税の納期の特例"),
  residentTaxSpecialDue: booleanField("住民税の納期の特例"),
  items: z
    .array(payrollRunItemSchema, { error: "従業員ごとの入力の形式が正しくありません" })
    .min(1, { error: "支給する従業員がいません。従業員を追加してください" })
    .max(100, { error: "従業員は 100 人までです" }),
  tableIds: payrollTableIdsSchema.nullish().transform((value) => value ?? null),
  expected: payrollExpectedSchema.nullish().transform((value) => value ?? null),
});
export type PayrollRunInput = z.input<typeof payrollRunSchema>;
export type ParsedPayrollRun = z.output<typeof payrollRunSchema>;

/** 納付を登録 (22-payroll §5.4・§6.6). `amount` empty → the scheduled amount. */
export const payrollPaymentSchema = z.object({
  calendarItemId: idField("納付予定"),
  walletId: idField("支払元の口座"),
  paymentDate: requiredDate("納付日"),
  amount: optionalPositiveYen("納付額"),
});
export type PayrollPaymentInput = z.input<typeof payrollPaymentSchema>;
export type ParsedPayrollPayment = z.output<typeof payrollPaymentSchema>;

// 決算 (16-year-end)
// ---------------------------------------------------------------------------

/** Whole yen, negative allowed (a refund), required. */
export function requiredSignedYen(label: string) {
  return fromText(label, (text): Conversion<Money> => {
    if (text === "") return problem(`${label}を入力してください`);
    const amount = parseYenInput(text, { allowNegative: true });
    if (amount === null) return problem(`${label}は円の整数で入力してください`);
    return ok(amount);
  });
}

/**
 * 決算整理を始める / やめる、締める / 締めを戻す (§1.1). The reason is required to cancel and to reopen
 * (checked by the transition, which names the field `reason`).
 */
export const yearEndTransitionSchema = z.object({ reason: optionalText("理由", 500) });
export type YearEndTransitionInput = z.input<typeof yearEndTransitionSchema>;

/** 「照合した」「確認した」 of the checklist (§3). */
export const YEAR_END_CHECK_KEYS = ["balances", "accruals"] as const;
export type YearEndCheckKey = (typeof YEAR_END_CHECK_KEYS)[number];

export const yearEndCheckSchema = z.object({
  key: enumField("確認の項目", YEAR_END_CHECK_KEYS),
  checked: booleanField("確認"),
});
export type YearEndCheckInput = z.input<typeof yearEndCheckSchema>;

/** 減価償却の計上: every asset with an amount for the year, or the given ones. */
export const postDepreciationSchema = z.object({
  assetIds: z
    .preprocess(
      (value): unknown =>
        value === undefined || value === null || value === "" ? undefined : value,
      z
        .array(z.string({ error: "固定資産が正しくありません" }).min(1).max(64), {
          error: "固定資産が正しくありません",
        })
        .max(500),
    )
    .optional(),
});
export type PostDepreciationInput = z.input<typeof postDepreciationSchema>;

/** 繰延資産の償却 (§6): 5 年 (default) or 全額. */
export const deferredAmortizationSchema = z.object({
  accountId: idField("科目"),
  mode: enumField("償却の額", DEFERRED_AMORTIZATION_MODES),
});
export type DeferredAmortizationInput = z.input<typeof deferredAmortizationSchema>;

/** 決算整理仕訳の登録 (§7). The reversal into the next year defaults to on. */
export const accrualEntrySchema = z.object({
  type: enumField("種類", ACCRUAL_TYPES),
  plAccountId: idField("科目"),
  amount: positiveYen("金額"),
  segmentId: optionalIdField("セグメント"),
  description: optionalText("摘要", 200),
  reverse: z
    .preprocess((value) => (value === undefined ? true : value), booleanField("翌期首に振り戻す"))
    .optional()
    .transform((value) => value ?? true),
});
export type AccrualEntryInput = z.input<typeof accrualEntrySchema>;

/** 消費税の精算 (§8): 納付税額, negative for a refund. */
export const consumptionTaxSettlementSchema = z.object({
  payable: requiredSignedYen("納付税額"),
});
export type ConsumptionTaxSettlementInput = z.input<typeof consumptionTaxSettlementSchema>;

/** 法人税等の計上 (§9). */
export const corporateTaxEntrySchema = z.object({ amount: positiveYen("計上額") });
export type CorporateTaxEntryInput = z.input<typeof corporateTaxEntrySchema>;

/** 決算整理仕訳の取消 (§1.2). */
export const yearEndVoidSchema = z.object({ reason: requiredText("理由", 500) });
export type YearEndVoidInput = z.input<typeof yearEndVoidSchema>;

const fixedAssetFields = {
  name: requiredText("名称", 100),
  method: enumField("償却方法", DEPRECIATION_METHODS),
  /** Checked against the method by `checkDepreciationChoice` (2–50 for 定額・定率). */
  usefulLifeYears: optionalIntegerInRange("耐用年数", 0, 999),
  segmentId: optionalIdField("セグメント"),
  note: optionalText("メモ", 500),
};

/** 取得の仕訳から (§5.1): a debit line of a posted entry on a depreciable account. */
export const fixedAssetFromEntrySchema = z.object({
  source: z.literal("entry"),
  entryId: idField("取得の仕訳"),
  accountId: idField("科目"),
  cost: positiveYen("取得価額"),
  ...fixedAssetFields,
});

/** 仕訳も一緒に登録 (§5.1): a 支出 (S3) on the asset's account, posted in the same transaction. */
export const fixedAssetPurchaseSchema = z.object({
  source: z.literal("purchase"),
  counterpart: counterpartField("支払元"),
  entryDate: requiredDate("日付"),
  amount: positiveYen("金額"),
  taxCategoryCode: taxCategoryCodeField(),
  accountId: idField("科目"),
  partnerId: optionalIdField("取引先"),
  ...fixedAssetFields,
});

export const fixedAssetRegisterSchema = z.discriminatedUnion(
  "source",
  [fixedAssetFromEntrySchema, fixedAssetPurchaseSchema],
  { error: "登録の方法が正しくありません。画面を読み込み直してください" },
);
export type FixedAssetRegisterInput = z.input<typeof fixedAssetRegisterSchema>;
export type ParsedFixedAssetRegister = z.output<typeof fixedAssetRegisterSchema>;

/**
 * 編集 (§5.2). Omitted keys are left as they are. 取得価額・取得日・科目・償却方法・耐用年数 change only
 * while the asset has no depreciation or disposal entry (checked by `updateFixedAsset`).
 */
export const fixedAssetUpdateSchema = z.object({
  name: fixedAssetFields.name.optional(),
  segmentId: fixedAssetFields.segmentId.optional(),
  note: fixedAssetFields.note.optional(),
  accountId: idField("科目").optional(),
  acquisitionDate: requiredDate("取得日").optional(),
  cost: positiveYen("取得価額").optional(),
  method: fixedAssetFields.method.optional(),
  usefulLifeYears: fixedAssetFields.usefulLifeYears.optional(),
});
export type FixedAssetUpdateInput = z.input<typeof fixedAssetUpdateSchema>;

/** 登録の取消 (§5.2). */
export const fixedAssetVoidSchema = z.object({ reason: requiredText("理由", 500) });
export type FixedAssetVoidInput = z.input<typeof fixedAssetVoidSchema>;

/** 除却・売却 (§5.3): 売却額 0 or empty is a 除却; a sale needs the wallet paid into. */
export const fixedAssetDisposeSchema = z.object({
  date: requiredDate("日付"),
  proceeds: optionalPositiveYen("売却額"),
  walletId: optionalIdField("入金先の口座"),
  description: optionalText("摘要", 200),
});
export type FixedAssetDisposeInput = z.input<typeof fixedAssetDisposeSchema>;

/** `/closing?year=n`: 第 n 期, or `null` for the default year. */
export const closingQuerySchema = z.object({
  year: lenient<number | null>(z.coerce.number().int().min(1).max(100_000), null),
});
export type ClosingQuery = z.output<typeof closingQuerySchema>;

// ---------------------------------------------------------------------------
// 決算書の設定 (17-financial-statements §3.1, §11)
// ---------------------------------------------------------------------------

/**
 * A text of the statements (注記・事業報告): line breaks become `\n`, the ends are trimmed, and an
 * empty string is kept (a deliberate blank: the item is left out). `null` puts the 雛形 back. A
 * missing key leaves the stored text as it is.
 */
function statementText(label: string, max = STATEMENT_TEXT_MAX_LENGTH) {
  return z
    .preprocess(
      (value) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : value),
      z
        .string({ error: `${label}の形式が正しくありません` })
        .max(max, { error: `${label}は ${max} 文字以内にしてください` })
        .nullable(),
    )
    .optional();
}

const issuedSharesField = fromText("発行済株式の総数", (text): Conversion<number | null> => {
  const normalized = toHalfWidthDigits(text).replace(/[,，]/g, "");
  if (normalized === "") return ok(null);
  if (!/^\d+$/.test(normalized)) {
    return problem("発行済株式の総数は株数の整数で入力してください");
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < 1) {
    return problem("発行済株式の総数は 1 株以上の整数にしてください");
  }
  return ok(value);
});

const announcementUrlField = fromText("決算公告の URL", (text): Conversion<string | null> => {
  if (text === "") return ok(null);
  if (text.length > 500) return problem("決算公告の URL は 500 文字以内にしてください");
  if (!/^https?:\/\/[^\s]+$/.test(text)) {
    return problem("決算公告の URL は https:// から始まる形で入力してください");
  }
  return ok(text);
});

const simplifiedTaxClassField = fromText(
  "簡易課税の事業区分",
  (text): Conversion<SimplifiedTaxClass | null> => {
    if (text === "") return ok(null);
    const value = Number(toHalfWidthDigits(text));
    return (SIMPLIFIED_TAX_CLASSES as readonly number[]).includes(value)
      ? ok(value as SimplifiedTaxClass)
      : problem("簡易課税の事業区分は第 1 種〜第 6 種から選んでください");
  },
);

const otherNoteSchema = z
  .object({
    title: statementText("その他の注記の項目名", 100),
    body: statementText("その他の注記の内容"),
  })
  .transform((note) => ({ title: note.title ?? "", body: note.body ?? "" }))
  .superRefine((note, ctx) => {
    if (note.title === "" && note.body !== "") {
      ctx.addIssue({
        code: "custom",
        path: ["title"],
        message: "その他の注記の項目名を入力してください",
      });
    }
    if (note.title !== "" && note.body === "") {
      ctx.addIssue({
        code: "custom",
        path: ["body"],
        message: "その他の注記の内容を入力してください",
      });
    }
  });

/**
 * 決算書の設定 of one fiscal year (`FiscalYear.statementSettings`): the shape of
 * `StatementSettings` of `@niho-finance/reports`. Every key is optional: a missing key leaves the
 * stored value as it is (the form sends every key). その他の注記 left blank are dropped. The checks
 * against the fiscal year and between the dates are `saveStatementSettings`'s.
 */
export const statementSettingsSchema = z.object({
  issuedShares: issuedSharesField.optional(),
  shareholdersMeetingOn: optionalDate("株主総会の日").optional(),
  announcementPublishedOn: optionalDate("決算公告の掲載日").optional(),
  announcementUrl: announcementUrlField.optional(),
  notes: z
    .object({
      depreciation: statementText("固定資産の減価償却の方法"),
      revenueRecognition: statementText("収益及び費用の計上基準"),
      otherSignificant: statementText("その他の重要な事項"),
      accountingPolicyChanges: statementText("会計方針の変更"),
      presentationChanges: statementText("表示方法の変更"),
      errorCorrections: statementText("誤謬の訂正"),
      otherNotes: z
        .array(otherNoteSchema)
        .transform((notes) => notes.filter((note) => note.title !== "" || note.body !== ""))
        .pipe(
          z
            .array(z.object({ title: z.string(), body: z.string() }))
            .max(STATEMENT_OTHER_NOTES_MAX, {
              error: `その他の注記は ${STATEMENT_OTHER_NOTES_MAX} 項目までにしてください`,
            }),
        )
        .optional(),
    })
    .optional(),
  businessReport: z
    .object({
      progress: statementText("事業の経過及びその成果"),
      issues: statementText("対処すべき課題"),
      otherMatters: statementText("事業報告のその他の重要な事項"),
    })
    .optional(),
  simplifiedTaxClass: simplifiedTaxClassField.optional(),
});
export type StatementSettingsInput = z.input<typeof statementSettingsSchema>;
export type StatementSettingsPatch = z.output<typeof statementSettingsSchema>;

/** A bank wallet whose bank API connection is read or changed (19-bank-api §6.3). */
export const bankWalletInputSchema = z.object({
  walletId: idField("口座"),
});
export type BankWalletInput = z.input<typeof bankWalletInputSchema>;

/** The bank's account ID: 12–29 letters and digits (GMO の `accountId`). */
const BANK_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9]{12,29}$/;

/**
 * 口座の選択 (19-bank-api §1.1): the account ID is the radio's value. Whether the bank lists it for
 * the wallet's tokens is checked by `connectBankAccount`, not here.
 */
export const bankAccountChoiceSchema = z.object({
  walletId: idField("口座"),
  accountId: fromText("銀行の口座", (text) => {
    if (text === "") return problem("接続する口座を選んでください");
    if (!BANK_ACCOUNT_ID_PATTERN.test(text)) {
      return problem(
        "選んだ口座が正しくありません。画面を読み込み直して、口座を選び直してください",
      );
    }
    return ok(text);
  }),
});
export type BankAccountChoiceInput = z.input<typeof bankAccountChoiceSchema>;

// ---------------------------------------------------------------------------
// Recurring items (定期取引, 21-cashflow §2)
// ---------------------------------------------------------------------------

/** 入金 / 出金: the screens take a positive amount; the row stores it signed (deposits positive). */
export const RECURRING_DIRECTIONS = ["deposit", "withdrawal"] as const;
export type RecurringDirection = (typeof RECURRING_DIRECTIONS)[number];

/** 毎月 / 毎年 */
export const RECURRING_FREQUENCIES = ["monthly", "yearly"] as const;
export type RecurringFrequencyValue = (typeof RECURRING_FREQUENCIES)[number];

/** 1〜999,999,999,999 円 (21 §2). */
export const RECURRING_AMOUNT_MAX: Money = 999_999_999_999n;

function recurringAmountField(label: string) {
  return fromText(label, (text): Conversion<Money> => {
    if (text === "") return problem(`${label}を入力してください`);
    const amount = parseYenInput(text);
    if (amount === null) return problem(`${label}は円の整数で入力してください`);
    if (amount <= 0n) return problem(`${label}は 1 円以上にしてください`);
    if (amount > RECURRING_AMOUNT_MAX) {
      return problem(`${label}は 999,999,999,999 円以下にしてください`);
    }
    return ok(amount);
  });
}

const recurringFields = {
  name: requiredText("名前", 60),
  direction: enumField("入出金", RECURRING_DIRECTIONS),
  /** Positive; the direction gives the sign. */
  amount: recurringAmountField("金額"),
  frequency: enumField("周期", RECURRING_FREQUENCIES),
  /** Required for yearly items (the repository checks the pair); dropped for monthly ones. */
  monthOfYear: optionalIntegerInRange("月", 1, 12),
  /** 31 = 末日. */
  dayOfMonth: integerInRange("日", 1, 31),
  startDate: requiredDate("開始日"),
  endDate: optionalDate("終了日"),
  walletId: idField("口座"),
  accountId: idField("科目"),
  partnerId: optionalIdField("取引先"),
  /** Defaults to the wallet's default segment when left out on create. */
  segmentId: optionalIdField("セグメント"),
  taxCategoryCode: optionalTaxCategoryCodeField("税区分"),
  note: optionalText("メモ", 500),
};

export const recurringItemCreateSchema = z.object(recurringFields);
export type RecurringItemCreateInput = z.input<typeof recurringItemCreateSchema>;

/** A partial update: a missing key leaves the column as is (無効にする / 有効にする included). */
export const recurringItemUpdateSchema = z.object({
  name: recurringFields.name.optional(),
  direction: recurringFields.direction.optional(),
  amount: recurringFields.amount.optional(),
  frequency: recurringFields.frequency.optional(),
  monthOfYear: recurringFields.monthOfYear.optional(),
  dayOfMonth: recurringFields.dayOfMonth.optional(),
  startDate: recurringFields.startDate.optional(),
  endDate: recurringFields.endDate.optional(),
  walletId: recurringFields.walletId.optional(),
  accountId: recurringFields.accountId.optional(),
  partnerId: recurringFields.partnerId.optional(),
  segmentId: recurringFields.segmentId.optional(),
  taxCategoryCode: recurringFields.taxCategoryCode.optional(),
  note: recurringFields.note.optional(),
  isActive: booleanField("状態").optional(),
});
export type RecurringItemUpdateInput = z.input<typeof recurringItemUpdateSchema>;
