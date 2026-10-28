import {
  addDays,
  dateParts,
  daysBetween,
  displayDate,
  lastDayOfMonth,
  type CalendarDate,
} from "./date";
import { LedgerValidationError, type LedgerError } from "./errors";
import { formatYen, type Money } from "./money";
import {
  INPUT_TAX_ACCOUNT_CODE,
  OUTPUT_TAX_ACCOUNT_CODE,
  splitTaxInclusive,
  TRANSFER_FEE_ACCOUNT_CODE,
  type EntryAccount,
  type SimpleEntryContext,
} from "./simple-entry";
import { exclusiveTaxAmount, inclusiveTaxAmount, resolveTaxRule, type TaxRateRule } from "./tax";
import { getTaxCategory } from "./tax-categories";
import type { JournalEntryInput, JournalLineInput } from "./types";

/**
 * 請求 (docs/design/18-invoicing.md): quotes, delivery notes and invoices. Pure functions shared by
 * the repository and the screens (they run in the browser too): the line amounts, the totals per tax
 * rate with one rounding per rate (03 §2.3), the checklist of the qualified-invoice items, the
 * numbers, and the journal entries of issuing an invoice and of a payment against it (02 §4.4).
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const INVOICE_DOC_TYPES = ["quote", "delivery", "invoice"] as const;
export type InvoiceDocType = (typeof INVOICE_DOC_TYPES)[number];

export const INVOICE_DOC_TYPE_LABELS: Readonly<Record<InvoiceDocType, string>> = {
  quote: "見積書",
  delivery: "納品書",
  invoice: "請求書",
};

export function isInvoiceDocType(value: unknown): value is InvoiceDocType {
  return typeof value === "string" && (INVOICE_DOC_TYPES as readonly string[]).includes(value);
}

export const INVOICE_STATUSES = ["draft", "issued", "sent", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_LABELS: Readonly<Record<InvoiceStatus, string>> = {
  draft: "下書き",
  issued: "発行済み",
  sent: "送付済み",
  paid: "入金済み",
  void: "無効",
};

/** The prefix of a number per type (18 §2): `INV-2026-0001`. */
export const INVOICE_NUMBER_PREFIXES: Readonly<Record<InvoiceDocType, string>> = {
  quote: "QT",
  delivery: "DN",
  invoice: "INV",
};

/** The name of the due date on each type (`null`: a delivery note has none). */
export const INVOICE_DUE_DATE_LABELS: Readonly<Record<InvoiceDocType, string | null>> = {
  quote: "有効期限",
  delivery: null,
  invoice: "支払期限",
};

/** Conversions (18 §8): 見積書 → 納品書 / 請求書, 納品書 → 請求書. */
export const INVOICE_CONVERSIONS: Readonly<Record<InvoiceDocType, readonly InvoiceDocType[]>> = {
  quote: ["delivery", "invoice"],
  delivery: ["invoice"],
  invoice: [],
};

export function canConvertInvoice(from: InvoiceDocType, to: InvoiceDocType): boolean {
  return INVOICE_CONVERSIONS[from].includes(to);
}

/** The tax categories an invoice line may have: the sales categories, in the order of the totals. */
export const SALES_TAX_CATEGORY_CODES = [
  "sales_10",
  "sales_8r",
  "sales_exempt",
  "sales_out",
  "sales_export",
] as const;
export type SalesTaxCategoryCode = (typeof SALES_TAX_CATEGORY_CODES)[number];

export function isSalesTaxCategoryCode(value: unknown): value is SalesTaxCategoryCode {
  return (
    typeof value === "string" && (SALES_TAX_CATEGORY_CODES as readonly string[]).includes(value)
  );
}

/** 軽減税率: marked ※ on the document (03 §2.3). */
export const REDUCED_TAX_CATEGORY_CODES: readonly SalesTaxCategoryCode[] = ["sales_8r"];

/** The short names of the categories outside the tax, on the documents. */
const NON_TAXABLE_LABELS: Readonly<Record<string, string>> = {
  sales_exempt: "非課税",
  sales_out: "不課税",
  sales_export: "輸出免税",
};

/** 売掛金: debited when an invoice is issued, credited by its payments (02 §4.4). */
export const RECEIVABLE_ACCOUNT_CODE = "1200";
/** 売上高 受託開発: the default revenue account of an invoice. */
export const CONTRACT_REVENUE_ACCOUNT_CODE = "4040";
/** 受託: the default segment of an invoice. */
export const CONTRACT_SEGMENT_CODE = "contract";
/** 支払手数料: the transfer fee a customer deducted from a payment (02 §4.4). */
export const PAYMENT_FEE_ACCOUNT_CODE = TRANSFER_FEE_ACCOUNT_CODE;
/** A shortfall up to this is offered as the transfer fee by default (18 §9.4). */
export const SUGGESTED_FEE_LIMIT: Money = 1_100n;

export const BANK_ACCOUNT_TYPES = ["ordinary", "checking", "savings"] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

export const BANK_ACCOUNT_TYPE_LABELS: Readonly<Record<BankAccountType, string>> = {
  ordinary: "普通",
  checking: "当座",
  savings: "貯蓄",
};

// ---------------------------------------------------------------------------
// Quantities and line amounts (18 §3.1)
// ---------------------------------------------------------------------------

/** Quantities are held as hundredths (`1.5` → `150n`): never floating point. */
export const QUANTITY_SCALE = 100n;

const QUANTITY_PATTERN = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

function toHalfWidth(text: string): string {
  return text
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, ".")
    .replace(/[,，、]/g, "");
}

/**
 * A quantity typed by the owner → hundredths: `1`, `1.5`, `0.25`, `1,000`, full-width digits.
 * At most 2 decimals and 9 integer digits. `null` when it is not such a number or not above 0.
 */
export function parseQuantity(text: string): bigint | null {
  const match = QUANTITY_PATTERN.exec(toHalfWidth(text.trim()));
  if (!match?.[1]) return null;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const value = BigInt(match[1]) * QUANTITY_SCALE + BigInt(fraction);
  return value > 0n ? value : null;
}

/** Hundredths → the shortest decimal text: `150n` → `"1.5"`, `105n` → `"1.05"`, `300n` → `"3"`. */
export function formatQuantity(hundredths: bigint): string {
  const negative = hundredths < 0n;
  const value = negative ? -hundredths : hundredths;
  const whole = (value / QUANTITY_SCALE).toString();
  const fraction = (value % QUANTITY_SCALE).toString().padStart(2, "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${text}` : text;
}

/** 数量 × 単価, fractions of a yen truncated toward 0 (a negative unit price is a discount). */
export function lineAmount(quantityHundredths: bigint, unitPrice: Money): Money {
  return (quantityHundredths * unitPrice) / QUANTITY_SCALE;
}

// ---------------------------------------------------------------------------
// Totals per tax rate (18 §3.2): one rounding per rate, never per line
// ---------------------------------------------------------------------------

export interface InvoiceLineAmountInput {
  /** Hundredths (`parseQuantity`). */
  quantity: bigint;
  unitPrice: Money;
  taxCategoryCode: string;
}

export interface InvoiceRateTotal {
  taxCategoryCode: SalesTaxCategoryCode;
  /** The rate on the issue date (0 for the categories outside the tax). */
  ratePercent: number;
  /** 軽減税率 (marked ※). */
  reduced: boolean;
  /** 課税 (a rate applies); `false` for 非課税・不課税・輸出免税. */
  taxable: boolean;
  lineCount: number;
  /** Σ line amounts as written: tax-exclusive or tax-inclusive per `pricesIncludeTax`. */
  subtotal: Money;
  /** 対価の額 without the tax. */
  amountExclusive: Money;
  /** 消費税額 of the rate, rounded down once on the rate's total. */
  taxAmount: Money;
  /** 対価の額 with the tax. */
  amountInclusive: Money;
}

export interface InvoiceTotals {
  pricesIncludeTax: boolean;
  /** The amount of each line, in the order of the lines. */
  lineAmounts: Money[];
  /** One row per tax category used, in the order of `SALES_TAX_CATEGORY_CODES`. */
  rates: InvoiceRateTotal[];
  amountExclusive: Money;
  taxTotal: Money;
  /** 合計 (tax-inclusive). */
  total: Money;
}

export interface InvoiceTotalsOptions {
  /** Unit prices include the tax (税込) instead of excluding it (税抜, the default). */
  pricesIncludeTax: boolean;
  /** The rates are the ones in force on the issue date. */
  issueDate: CalendarDate;
  taxRules: Iterable<TaxRateRule>;
}

/** 「10%」「8%（軽減）」「非課税」: how a rate is named on the documents and the screens. */
export function invoiceRateLabel(
  rate: Pick<InvoiceRateTotal, "taxCategoryCode" | "ratePercent" | "reduced" | "taxable">,
): string {
  if (!rate.taxable) return NON_TAXABLE_LABELS[rate.taxCategoryCode] ?? rate.taxCategoryCode;
  return `${rate.ratePercent}%${rate.reduced ? "（軽減）" : ""}`;
}

/**
 * The totals of a document (18 §3.2, 03 §2.3): the line amounts are summed per tax category and the
 * tax is computed once on each sum (truncated), so that the tax of the document is never the sum of
 * per-line taxes. Throws `LedgerValidationError` naming the line (`lines.<n>.taxCategoryCode`) for a
 * category that is not a sales category or a taxable one without a rule on the issue date.
 */
export function computeInvoiceTotals(
  lines: readonly InvoiceLineAmountInput[],
  options: InvoiceTotalsOptions,
): InvoiceTotals {
  const rules = [...options.taxRules];
  const errors: LedgerError[] = [];
  const sums = new Map<SalesTaxCategoryCode, { amount: Money; lineCount: number; rate: number }>();
  const lineAmounts = lines.map((line, index) => {
    const amount = lineAmount(line.quantity, line.unitPrice);
    const field = `lines.${index}.taxCategoryCode`;
    const code = line.taxCategoryCode;
    if (!isSalesTaxCategoryCode(code)) {
      errors.push({
        code: "UNKNOWN_TAX_CATEGORY",
        message: `${index + 1} 行目の税区分は売上の税区分から選んでください`,
        field,
        lineIndex: index,
      });
      return amount;
    }
    const category = getTaxCategory(code);
    let rate = 0;
    if (category?.kind === "taxable") {
      const rule = resolveTaxRule(code, options.issueDate, rules);
      if (!rule) {
        errors.push({
          code: "TAX_RULE_MISSING",
          message: `税区分「${category.name}」の税率が ${displayDate(options.issueDate)} に設定されていません。設定 › 税区分 で足してください`,
          field,
          lineIndex: index,
        });
        return amount;
      }
      rate = rule.ratePercent;
    }
    const current = sums.get(code) ?? { amount: 0n, lineCount: 0, rate };
    current.amount += amount;
    current.lineCount += 1;
    sums.set(code, current);
    return amount;
  });
  if (errors.length > 0) throw new LedgerValidationError(errors);

  const rates: InvoiceRateTotal[] = [];
  for (const code of SALES_TAX_CATEGORY_CODES) {
    const sum = sums.get(code);
    if (!sum) continue;
    const taxable = getTaxCategory(code)?.kind === "taxable";
    const taxAmount = options.pricesIncludeTax
      ? inclusiveTaxAmount(sum.amount, sum.rate)
      : exclusiveTaxAmount(sum.amount, sum.rate);
    const amountExclusive = options.pricesIncludeTax ? sum.amount - taxAmount : sum.amount;
    rates.push({
      taxCategoryCode: code,
      ratePercent: sum.rate,
      reduced: REDUCED_TAX_CATEGORY_CODES.includes(code),
      taxable,
      lineCount: sum.lineCount,
      subtotal: sum.amount,
      amountExclusive,
      taxAmount,
      amountInclusive: amountExclusive + taxAmount,
    });
  }
  let amountExclusive = 0n;
  let taxTotal = 0n;
  for (const rate of rates) {
    amountExclusive += rate.amountExclusive;
    taxTotal += rate.taxAmount;
  }
  return {
    pricesIncludeTax: options.pricesIncludeTax,
    lineAmounts,
    rates,
    amountExclusive,
    taxTotal,
    total: amountExclusive + taxTotal,
  };
}

/**
 * What keeps a document from being issued because of its amounts (18 §3.2): a rate whose total is
 * negative (a discount larger than the rate's amount) or a total of 0 yen or less.
 */
export function invoiceAmountProblems(totals: Pick<InvoiceTotals, "rates" | "total">): string[] {
  const problems: string[] = [];
  for (const rate of totals.rates) {
    if (rate.amountInclusive < 0n) {
      problems.push(`値引きが ${invoiceRateLabel(rate)} の対価の額を超えています`);
    }
  }
  if (totals.total <= 0n) problems.push("合計が 0 円以下です。行の金額を確かめてください");
  return problems;
}

// ---------------------------------------------------------------------------
// 適格請求書 / 区分記載請求書 and the checklist (18 §4)
// ---------------------------------------------------------------------------

export interface InvoiceIssuer {
  /** 商号 */
  name: string | null;
  invoiceRegistrationNumber: string | null;
  invoiceRegisteredOn: CalendarDate | null;
}

/**
 * 適格請求書 when the company has a registration number registered on or before the issue date;
 * 区分記載請求書 otherwise (D1 = C: the registration comes when a customer asks for it).
 */
export function isQualifiedInvoice(
  issuer: Pick<InvoiceIssuer, "invoiceRegistrationNumber" | "invoiceRegisteredOn"> | null,
  issueDate: CalendarDate,
): boolean {
  return Boolean(
    issuer?.invoiceRegistrationNumber &&
    issuer.invoiceRegisteredOn !== null &&
    issuer.invoiceRegisteredOn <= issueDate,
  );
}

export type InvoiceChecklistState = "ok" | "info" | "error";

export type InvoiceChecklistKey =
  "issuer" | "registration" | "recipient" | "date" | "content" | "amounts" | "tax";

export interface InvoiceChecklistItem {
  key: InvoiceChecklistKey;
  label: string;
  /** `error` keeps the document from being issued; `info` is said, not required. */
  state: InvoiceChecklistState;
  detail: string;
}

export interface InvoiceChecklistInput {
  issuer: InvoiceIssuer | null;
  issueDate: CalendarDate;
  /** The partner's name (宛名); `null` when no partner is chosen. */
  recipientName: string | null;
  lines: readonly { name: string; date: CalendarDate | null; taxCategoryCode: string }[];
  /** `null` when the totals cannot be computed (a category without a rule). */
  totals: InvoiceTotals | null;
}

export interface InvoiceChecklist {
  qualified: boolean;
  items: InvoiceChecklistItem[];
  /** No item is an error: the document can be issued. */
  ready: boolean;
}

function ratesText(
  totals: InvoiceTotals,
  value: (rate: InvoiceRateTotal) => Money,
  suffix = "",
): string {
  return totals.rates
    .map((rate) => `${invoiceRateLabel(rate)} ${formatYen(value(rate))} 円${suffix}`)
    .join(" · ");
}

/**
 * 記載事項の確認行 (18 §4, 03 §2.3): what a qualified invoice (or a 区分記載請求書) must carry, each
 * with its state. The screens show it; the repository refuses to issue while an item is an error.
 */
export function invoiceChecklist(input: InvoiceChecklistInput): InvoiceChecklist {
  const qualified = isQualifiedInvoice(input.issuer, input.issueDate);
  const items: InvoiceChecklistItem[] = [];
  const issuerName = input.issuer?.name?.trim() ?? "";
  items.push({
    key: "issuer",
    label: "発行者の名称",
    state: issuerName ? "ok" : "error",
    detail: issuerName || "設定 › 事業所 で商号を入れてください",
  });

  const number = input.issuer?.invoiceRegistrationNumber ?? null;
  const registeredOn = input.issuer?.invoiceRegisteredOn ?? null;
  let registration: string;
  if (qualified && number && registeredOn) {
    registration = `${number}（${displayDate(registeredOn)} 登録）。適格請求書として発行します`;
  } else if (!number) {
    registration = "登録番号なし。区分記載請求書として発行します";
  } else if (!registeredOn) {
    registration =
      "登録日が未入力のため、区分記載請求書として発行します。設定 › 事業所 で登録日を入れてください";
  } else {
    registration = `発行日が登録日 ${displayDate(registeredOn)} より前のため、区分記載請求書として発行します`;
  }
  items.push({
    key: "registration",
    label: "登録番号",
    state: qualified ? "ok" : "info",
    detail: registration,
  });

  const recipient = input.recipientName?.trim() ?? "";
  items.push({
    key: "recipient",
    label: "宛名",
    state: recipient ? "ok" : "error",
    detail: recipient ? `${recipient} 御中` : "取引先を選んでください",
  });

  const datedLines = input.lines.filter((line) => line.date !== null).length;
  items.push({
    key: "date",
    label: "取引年月日",
    state: "ok",
    detail:
      datedLines === 0
        ? `発行日 ${displayDate(input.issueDate)} を取引年月日とします`
        : `行ごとの日付（${datedLines} 行）。日付のない行は発行日 ${displayDate(input.issueDate)}`,
  });

  const unnamed = input.lines.findIndex((line) => line.name.trim() === "");
  const reducedLines = input.lines.filter((line) =>
    (REDUCED_TAX_CATEGORY_CODES as readonly string[]).includes(line.taxCategoryCode),
  ).length;
  items.push({
    key: "content",
    label: "取引内容",
    state: input.lines.length > 0 && unnamed < 0 ? "ok" : "error",
    detail:
      input.lines.length === 0
        ? "行を 1 行以上入れてください"
        : unnamed >= 0
          ? `${unnamed + 1} 行目の品名を入れてください`
          : `${input.lines.length} 行${reducedLines > 0 ? `。軽減税率の ${reducedLines} 行に ※ を付けます` : ""}`,
  });

  const totals = input.totals;
  if (!totals) {
    items.push({
      key: "amounts",
      label: "税率ごとの対価の額",
      state: "error",
      detail: "税率の規則がない税区分があります。行の税区分か 設定 › 税区分 を確かめてください",
    });
    items.push({ key: "tax", label: "税率ごとの消費税額", state: "info", detail: "—" });
  } else {
    const problems = invoiceAmountProblems(totals);
    items.push({
      key: "amounts",
      label: "税率ごとの対価の額",
      state: problems.length > 0 ? "error" : "ok",
      detail:
        problems.length > 0
          ? problems.join(" / ")
          : qualified
            ? ratesText(
                totals,
                (rate) => (totals.pricesIncludeTax ? rate.amountInclusive : rate.amountExclusive),
                totals.pricesIncludeTax ? "（税込）" : "（税抜）",
              )
            : ratesText(totals, (rate) => rate.amountInclusive, "（税込）"),
    });
    const taxText = ratesText(totals, (rate) => rate.taxAmount);
    items.push({
      key: "tax",
      label: "税率ごとの消費税額",
      state: qualified ? "ok" : "info",
      detail: qualified ? taxText : `区分記載請求書では任意です（${taxText}）`,
    });
  }
  return { qualified, items, ready: items.every((item) => item.state !== "error") };
}

// ---------------------------------------------------------------------------
// Numbers (18 §2)
// ---------------------------------------------------------------------------

/** `INV-2026-`: the prefix of the numbers of a type in the fiscal year starting on the date. */
export function invoiceNumberPrefix(
  docType: InvoiceDocType,
  fiscalYearStartDate: CalendarDate,
): string {
  return `${INVOICE_NUMBER_PREFIXES[docType]}-${dateParts(fiscalYearStartDate).year}-`;
}

/** `INV-2026-0001`: 4 digits, more when the sequence passes 9,999. */
export function formatInvoiceNumber(
  docType: InvoiceDocType,
  fiscalYearStartDate: CalendarDate,
  sequence: number,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError(`formatInvoiceNumber: ${sequence} is not a valid sequence`);
  }
  return `${invoiceNumberPrefix(docType, fiscalYearStartDate)}${String(sequence).padStart(4, "0")}`;
}

/** The sequence of a number with the prefix, or `null` for another prefix or a draft. */
export function parseInvoiceSequence(number: string, prefix: string): number | null {
  if (!number.startsWith(prefix)) return null;
  const digits = number.slice(prefix.length);
  if (!/^\d{4,}$/.test(digits)) return null;
  const sequence = Number(digits);
  return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
}

/** The next sequence after the numbers already given with the prefix (void ones included: no gaps). */
export function nextInvoiceSequence(numbers: Iterable<string>, prefix: string): number {
  let last = 0;
  for (const number of numbers) {
    const sequence = parseInvoiceSequence(number, prefix);
    if (sequence !== null && sequence > last) last = sequence;
  }
  return last + 1;
}

/** The placeholder a draft stores in the NOT NULL column until it is issued; never shown. */
export function draftInvoiceNumber(docType: InvoiceDocType, id: string): string {
  return `${INVOICE_NUMBER_PREFIXES[docType]}-draft-${id}`;
}

export function isDraftInvoiceNumber(number: string): boolean {
  return /^[A-Z]+-draft-/.test(number);
}

/** The number as owners see it: 「下書き」 for a draft's placeholder. */
export function invoiceNumberLabel(number: string): string {
  return isDraftInvoiceNumber(number) ? "下書き" : number;
}

// ---------------------------------------------------------------------------
// Dates and states
// ---------------------------------------------------------------------------

/** The default due date (18 §8): an invoice the end of the next month, a quote 30 days on. */
export function defaultDueDate(
  docType: InvoiceDocType,
  issueDate: CalendarDate,
): CalendarDate | null {
  switch (docType) {
    case "invoice": {
      const { year, month } = dateParts(issueDate);
      return month === 12 ? lastDayOfMonth(year + 1, 1) : lastDayOfMonth(year, month + 1);
    }
    case "quote":
      return addDays(issueDate, 30);
    case "delivery":
      return null;
  }
}

/** An issued (or sent) invoice still open after its due date (18 §1). */
export function isInvoiceOverdue(
  invoice: { docType: InvoiceDocType; status: InvoiceStatus; dueDate: CalendarDate | null },
  today: CalendarDate,
): boolean {
  return (
    invoice.docType === "invoice" &&
    (invoice.status === "issued" || invoice.status === "sent") &&
    invoice.dueDate !== null &&
    invoice.dueDate < today
  );
}

/** Days past the due date (0 when not past). */
export function overdueDays(dueDate: CalendarDate, today: CalendarDate): number {
  return Math.max(0, daysBetween(dueDate, today));
}

/** A payment as the balance needs it: cancelled payments do not count. */
export interface InvoicePaymentAmounts {
  amount: Money;
  fee: Money;
  cancelled: boolean;
}

/** 残高 = 合計 − Σ (入金額 + 振込手数料) of the payments in force (18 §1). */
export function invoiceBalance(total: Money, payments: Iterable<InvoicePaymentAmounts>): Money {
  let balance = total;
  for (const payment of payments) {
    if (!payment.cancelled) balance -= payment.amount + payment.fee;
  }
  return balance;
}

// ---------------------------------------------------------------------------
// Journal entries (18 §5, 02 §4.4)
// ---------------------------------------------------------------------------

function standardAccount(
  code: string,
  context: SimpleEntryContext,
  errors: LedgerError[],
  field?: string,
): EntryAccount | undefined {
  for (const account of context.accounts.values()) if (account.code === code) return account;
  errors.push({
    code: "STANDARD_ACCOUNT_MISSING",
    message: `勘定科目 ${code} がありません。設定 › 勘定科目 で足してください`,
    ...(field ? { field } : {}),
  });
  return undefined;
}

export interface InvoiceIssueEntryInput {
  invoiceId: string;
  /** The number given on issue (`INV-2026-0001`). */
  number: string;
  issueDate: CalendarDate;
  partnerId: string;
  partnerName: string;
  /** 件名: the description of the revenue lines (the number when empty). */
  title: string | null;
  /** A revenue account (default 4040 売上高 受託開発). */
  revenueAccountId: string;
  segmentId: string | null;
  totals: Pick<InvoiceTotals, "rates" | "total">;
}

/**
 * 発行 of an invoice (18 §5.1): 借方 売掛金（取引先）合計 / 貸方 売上 one line per tax category, and
 * in tax-exclusive years 仮受消費税 for the tax. The amounts and taxes are the document's (computed
 * once per rate), never recomputed per line, so the book and the document agree.
 * `sourceKind = invoice`, `sourceId` = the invoice. Throws `LedgerValidationError` with the field.
 */
export function buildInvoiceIssueEntry(
  input: InvoiceIssueEntryInput,
  context: SimpleEntryContext,
): JournalEntryInput {
  const errors: LedgerError[] = [];
  const receivable = standardAccount(RECEIVABLE_ACCOUNT_CODE, context, errors);
  const revenue = context.accounts.get(input.revenueAccountId);
  if (!revenue || revenue.kind !== "revenue") {
    errors.push({
      code: "ACCOUNT_NOT_ALLOWED",
      message: "売上の科目は収益の科目から選んでください",
      field: "revenueAccountId",
    });
  }
  for (const problem of invoiceAmountProblems(input.totals)) {
    errors.push({ code: "NON_POSITIVE_AMOUNT", message: problem, field: "lines" });
  }
  const exclusive = context.accountingMethod === "tax_exclusive";
  const rates = input.totals.rates.filter((rate) => rate.amountInclusive > 0n);
  const outputTax = exclusive ? rates.reduce((total, rate) => total + rate.taxAmount, 0n) : 0n;
  const outputTaxAccount =
    outputTax > 0n ? standardAccount(OUTPUT_TAX_ACCOUNT_CODE, context, errors) : null;
  if (errors.length > 0) throw new LedgerValidationError(errors);
  if (!receivable || !revenue || outputTaxAccount === undefined) {
    throw new Error("buildInvoiceIssueEntry: unreachable after the error check");
  }

  const lines: JournalLineInput[] = [
    {
      side: "debit",
      accountId: receivable.id,
      subAccountId: null,
      amount: input.totals.total,
      taxCategoryCode: "na",
      taxAmount: 0n,
      segmentId: null,
      partnerId: input.partnerId,
      description: null,
    },
  ];
  for (const rate of rates) {
    lines.push({
      side: "credit",
      accountId: revenue.id,
      subAccountId: null,
      amount: exclusive ? rate.amountExclusive : rate.amountInclusive,
      taxCategoryCode: rate.taxCategoryCode,
      taxAmount: rate.taxAmount,
      segmentId: input.segmentId,
      partnerId: input.partnerId,
      description: input.title?.trim() || input.number,
    });
  }
  if (outputTaxAccount) {
    lines.push({
      side: "credit",
      accountId: outputTaxAccount.id,
      subAccountId: null,
      amount: outputTax,
      taxCategoryCode: "na",
      taxAmount: 0n,
      segmentId: null,
      partnerId: null,
      description: null,
    });
  }
  return {
    entryDate: input.issueDate,
    description: `${INVOICE_DOC_TYPE_LABELS.invoice} ${input.number} ${input.partnerName}`,
    kind: "normal",
    sourceKind: "invoice",
    sourceId: input.invoiceId,
    lines,
  };
}

export interface InvoicePaymentEntryInput {
  invoiceId: string;
  number: string;
  partnerId: string;
  partnerName: string;
  /** 入金日 */
  paidOn: CalendarDate;
  /** The wallet the money came into (an asset: bank, cash …). */
  walletId: string;
  /** 入金額: what came into the wallet. */
  amount: Money;
  /** 振込手数料 the customer deducted (tax-inclusive); 0 when none. */
  fee: Money;
  /** The segment of the fee line: the invoice's; `null` → 共通. */
  segmentId: string | null;
}

/**
 * 入金 against an invoice (18 §5.2): 借方 口座 入金額（, 支払手数料 振込手数料, 仮払消費税 in
 * tax-exclusive years）/ 貸方 売掛金（取引先）入金額 + 振込手数料. `sourceKind = invoice`.
 */
export function buildInvoicePaymentEntry(
  input: InvoicePaymentEntryInput,
  context: SimpleEntryContext,
): JournalEntryInput {
  const errors: LedgerError[] = [];
  if (input.amount <= 0n) {
    errors.push({
      code: "NON_POSITIVE_AMOUNT",
      message: "入金額は 1 円以上にしてください",
      field: "amount",
    });
  }
  if (input.fee < 0n) {
    errors.push({
      code: "NON_POSITIVE_AMOUNT",
      message: "振込手数料は 0 円以上にしてください",
      field: "fee",
    });
  }
  const wallet = context.wallets.get(input.walletId);
  const walletAccount = wallet ? context.accounts.get(wallet.accountId) : undefined;
  if (!wallet || !wallet.isActive || walletAccount?.kind !== "asset") {
    errors.push({
      code: "UNKNOWN_WALLET",
      message: wallet
        ? `口座「${wallet.name}」には入金できません。銀行などの有効な口座を選んでください`
        : "口座が見つかりません。一覧から選んでください",
      field: "walletId",
    });
  }
  const receivable = standardAccount(RECEIVABLE_ACCOUNT_CODE, context, errors);
  const fee = input.fee > 0n ? input.fee : 0n;
  const feeAccount =
    fee > 0n ? standardAccount(PAYMENT_FEE_ACCOUNT_CODE, context, errors, "fee") : null;
  const feeTaxCode = feeAccount?.defaultTaxCategoryCode ?? "na";
  let feeSplit: ReturnType<typeof splitTaxInclusive> | null = null;
  if (feeAccount) {
    try {
      feeSplit = splitTaxInclusive(fee, feeTaxCode, input.paidOn, {
        accountingMethod: context.accountingMethod,
        taxRules: context.taxRules,
        field: "fee",
      });
    } catch (error) {
      if (!(error instanceof LedgerValidationError)) throw error;
      errors.push(...error.errors);
    }
  }
  const inputTax =
    feeSplit && feeSplit.taxLineAmount > 0n
      ? standardAccount(INPUT_TAX_ACCOUNT_CODE, context, errors, "fee")
      : null;
  if (errors.length > 0) throw new LedgerValidationError(errors);
  if (!wallet || !receivable || feeAccount === undefined || inputTax === undefined) {
    throw new Error("buildInvoicePaymentEntry: unreachable after the error check");
  }

  const lines: JournalLineInput[] = [
    {
      side: "debit",
      accountId: wallet.accountId,
      subAccountId: wallet.subAccountId,
      amount: input.amount,
      taxCategoryCode: "na",
      taxAmount: 0n,
      segmentId: wallet.defaultSegmentId,
      partnerId: null,
      description: null,
    },
  ];
  if (feeAccount && feeSplit) {
    lines.push({
      side: "debit",
      accountId: feeAccount.id,
      subAccountId: null,
      amount: feeSplit.amount,
      taxCategoryCode: feeTaxCode,
      taxAmount: feeSplit.taxAmount,
      segmentId: input.segmentId ?? context.corporateSegmentId,
      partnerId: input.partnerId,
      description: "振込手数料",
    });
    if (inputTax) {
      lines.push({
        side: "debit",
        accountId: inputTax.id,
        subAccountId: null,
        amount: feeSplit.taxLineAmount,
        taxCategoryCode: "na",
        taxAmount: 0n,
        segmentId: null,
        partnerId: null,
        description: null,
      });
    }
  }
  lines.push({
    side: "credit",
    accountId: receivable.id,
    subAccountId: null,
    amount: input.amount + fee,
    taxCategoryCode: "na",
    taxAmount: 0n,
    segmentId: null,
    partnerId: input.partnerId,
    description: null,
  });
  return {
    entryDate: input.paidOn,
    description: `入金 ${input.number} ${input.partnerName}`,
    kind: "normal",
    sourceKind: "invoice",
    sourceId: input.invoiceId,
    lines,
  };
}
