/**
 * Input schemas of the settings and setup repository (Zod). The repository parses every write with
 * them; Server Actions pass form values (strings) or typed values straight through, and turn a
 * `ZodError` into field errors. Messages are owner-facing Japanese.
 */
import {
  ACCOUNT_CODE_PATTERN,
  ACCOUNT_GROUPS,
  ACCOUNT_KINDS,
  ACCOUNTING_METHODS,
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
  WALLET_KINDS,
  type CalendarDate,
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
