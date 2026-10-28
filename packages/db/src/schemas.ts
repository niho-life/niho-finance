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
  CONSUMPTION_TAX_METHODS,
  corporateNumberProblem,
  defaultAccountingMethod,
  invoiceRegistrationNumberProblem,
  isAccountGroupOf,
  isCalendarDate,
  isTaxCategoryCode,
  normalizeCorporateNumber,
  normalizeInvoiceRegistrationNumber,
  parseYenInput,
  PARTNER_KINDS,
  SIDES,
  WALLET_KINDS,
  type CalendarDate,
  type EntryCounterpart,
  type Money,
} from "@niho-finance/ledger";
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
