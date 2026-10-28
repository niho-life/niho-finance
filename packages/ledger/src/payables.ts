import { addDays, dateParts, lastDayOfMonth, type CalendarDate } from "./date";
import { LedgerValidationError, type LedgerError } from "./errors";
import { SUGGESTED_FEE_LIMIT } from "./invoice-math";
import { formatYen, type Money } from "./money";
import {
  INPUT_TAX_ACCOUNT_CODE,
  isReservedAccount,
  splitTaxInclusive,
  TRANSFER_FEE_ACCOUNT_CODE,
  walletAccountIdsOf,
  type EntryAccount,
  type SimpleEntryContext,
  type TaxSplit,
} from "./simple-entry";
import { descriptionKey, partnerNameKey } from "./suggest";
import { getTaxCategory } from "./tax-categories";
import type {
  EntryKind,
  EntryStatus,
  JournalEntryInput,
  JournalLineInput,
  Side,
  SourceKind,
} from "./types";

/**
 * 支払 (docs/design/25-payables.md): received invoices kept unpaid until they are paid. Pure functions
 * shared by the repository and the screens: the due date from a partner's payment terms, the entries
 * of 計上 (費用 / 未払金) and of a payment (未払金 / 口座, with the transfer fee), and the amounts and
 * the state derived from the ledger (nothing about a payable's rest is stored, 25 §1).
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** 未払金: credited (without a sub-account, with the partner) when a received invoice is booked. */
export const PAYABLE_ACCOUNT_CODE = "2100";
/** 外注費: the expense account of a payable when the partner has no default (25 §4.1). */
export const PAYABLE_DEFAULT_EXPENSE_ACCOUNT_CODE = "5100";
/** 支払手数料: what a payment pays above the rest (the transfer fee borne by the company). */
export const PAYABLE_FEE_ACCOUNT_CODE = TRANSFER_FEE_ACCOUNT_CODE;
/** A payment may exceed the rest by up to this (the transfer fee); more is refused (25 §4.2). */
export const PAYABLE_FEE_LIMIT: Money = SUGGESTED_FEE_LIMIT;
/** 「7 日以内に支払う」 (25 §6, the home's やること). */
export const PAYABLE_DUE_SOON_DAYS = 7;

export const PAYABLE_STATES = ["unpaid", "partial", "paid", "cancelled"] as const;
/** Derived from the ledger (25 §2); never stored. */
export type PayableState = (typeof PAYABLE_STATES)[number];

export const PAYABLE_STATE_LABELS: Readonly<Record<PayableState, string>> = {
  unpaid: "未払",
  partial: "一部支払",
  paid: "支払済み",
  cancelled: "取消",
};

/** The states the default list (未払) shows: 未払 and 一部支払. */
export function isOpenPayableState(state: PayableState): boolean {
  return state === "unpaid" || state === "partial";
}

export const PAYABLE_AUDIT_ACTIONS = [
  "payable.register",
  "payable.update",
  "payable.pay",
  "payable.cancel_payment",
  "payable.cancel",
] as const;
export type PayableAuditAction = (typeof PAYABLE_AUDIT_ACTIONS)[number];

/** The audit log of a payable (entity `payable`, the document's ID). */
export const PAYABLE_AUDIT_ACTION_LABELS: Readonly<Record<PayableAuditAction, string>> = {
  "payable.register": "未払の登録",
  "payable.update": "期日・支払元の変更",
  "payable.pay": "支払の登録",
  "payable.cancel_payment": "支払の取消",
  "payable.cancel": "登録の取消",
};

export const PAYABLE_HISTORY_VIAS = ["statement", "entries"] as const;
/**
 * Where an entry of the payable was voided outside the payables screen: 明細の画面の「未処理に戻す」
 * or the transaction screen. The history shows those voids too (the rest moved with them).
 */
export type PayableHistoryVia = (typeof PAYABLE_HISTORY_VIAS)[number];

export const PAYABLE_HISTORY_VIA_LABELS: Readonly<Record<PayableHistoryVia, string>> = {
  statement: "明細を未処理に戻す",
  entries: "取引の画面",
};

/** A row of the payable's history: 「支払の取消」, 「支払の取消（明細を未処理に戻す）」 … */
export function payableHistoryLabel(row: {
  action: string;
  via: PayableHistoryVia | null;
}): string {
  const base = (PAYABLE_AUDIT_ACTION_LABELS as Readonly<Record<string, string>>)[row.action];
  const label = base ?? "その他";
  return row.via ? `${label}（${PAYABLE_HISTORY_VIA_LABELS[row.via]}）` : label;
}

// ---------------------------------------------------------------------------
// Payment terms and the due date (25 §3)
// ---------------------------------------------------------------------------

/** 31 means the last day of the month (末日) in both `closingDay` and `dueDay`. */
export const PAYMENT_TERMS_END_OF_MONTH = 31;

/** A partner's payment terms: 締め日, 何か月後 (0–3) and 支払日. */
export interface PaymentTerms {
  /** 1–31 (31 = 末日). */
  closingDay: number;
  /** 0 (当月) – 3. */
  dueMonths: number;
  /** 1–31 (31 = 末日). */
  dueDay: number;
}

/** Why terms are not valid (owner-facing), `null` when they are. */
export function paymentTermsProblem(terms: PaymentTerms): string | null {
  const day = (value: number) => Number.isInteger(value) && value >= 1 && value <= 31;
  if (!day(terms.closingDay)) return "締め日は 1〜31 にしてください（31 は末日）";
  if (!Number.isInteger(terms.dueMonths) || terms.dueMonths < 0 || terms.dueMonths > 3) {
    return "何か月後は 0〜3 にしてください";
  }
  if (!day(terms.dueDay)) return "支払日は 1〜31 にしてください（31 は末日）";
  if (terms.dueMonths === 0 && terms.dueDay < terms.closingDay) {
    return "当月払いの支払日は締め日以後にしてください";
  }
  return null;
}

/** The day `day` of a month, or its last day when the month is shorter (2 月の 30 日 → 末日). */
function dayInMonth(year: number, month: number, day: number): CalendarDate {
  const last = lastDayOfMonth(year, month);
  if (day >= dateParts(last).day) return last;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CalendarDate;
}

/** `months` (0 or more) after the month: whole-number month arithmetic. */
function addMonths(year: number, month: number, months: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + months;
  const monthIndex = index % 12;
  return { year: (index - monthIndex) / 12, month: monthIndex + 1 };
}

/**
 * 支払期日の既定 (25 §3): the closing date is the first day on or after the invoice date whose day
 * is the closing day (the month's last day when the month has no such day); the due date is the
 * payment day of the month `dueMonths` after the closing date's (its last day when shorter). Without
 * terms: the end of the month after the invoice date.
 */
export function defaultPayableDueDate(
  invoiceDate: CalendarDate,
  terms: PaymentTerms | null,
): CalendarDate {
  const { year, month, day } = dateParts(invoiceDate);
  if (!terms) {
    const next = addMonths(year, month, 1);
    return lastDayOfMonth(next.year, next.month);
  }
  const closingThisMonth = dateParts(dayInMonth(year, month, terms.closingDay)).day;
  const closing = day <= closingThisMonth ? { year, month } : addMonths(year, month, 1);
  const due = addMonths(closing.year, closing.month, terms.dueMonths);
  return dayInMonth(due.year, due.month, terms.dueDay);
}

const DUE_MONTH_WORDS = ["当月", "翌月", "翌々月"] as const;

/** 「末締め翌月末払い」「20 日締め翌月 10 日払い」 (25 §3). */
export function describePaymentTerms(terms: PaymentTerms): string {
  const closing =
    terms.closingDay >= PAYMENT_TERMS_END_OF_MONTH ? "末締め" : `${terms.closingDay} 日締め`;
  const months = DUE_MONTH_WORDS[terms.dueMonths] ?? ` ${terms.dueMonths} か月後`;
  const due = terms.dueDay >= PAYMENT_TERMS_END_OF_MONTH ? "末払い" : ` ${terms.dueDay} 日払い`;
  return `${closing}${months}${due}`.replace(/\s+/g, " ");
}

/** 「支払期日は請求書の日付以後」: a due date before the invoice date is a typo. */
export function payableDueDateProblem(
  invoiceDate: CalendarDate,
  dueDate: CalendarDate | null,
): string | null {
  return dueDate !== null && dueDate < invoiceDate
    ? "支払期日は請求書の日付以後にしてください"
    : null;
}

// ---------------------------------------------------------------------------
// Defaults of the form (25 §4.1)
// ---------------------------------------------------------------------------

const WITHOUT_INVOICE: Readonly<Record<string, string>> = {
  purchase_10: "purchase_10_ni",
  purchase_8r: "purchase_8r_ni",
};

/**
 * The tax category of a payable's line: without a qualified invoice (no registration number on the
 * partner or the document) 課税仕入 becomes 「インボイスなし」 (`purchase_10_ni` / `purchase_8r_ni`),
 * so that only the creditable share goes to 仮払消費税 (経過措置, 02 §3). Other categories stay.
 */
export function payableTaxCategoryCode(taxCategoryCode: string, qualifiedInvoice: boolean): string {
  if (qualifiedInvoice) return taxCategoryCode;
  return WITHOUT_INVOICE[taxCategoryCode] ?? taxCategoryCode;
}

/** The accounts a payable's line may book (25 §4.1): expenses and non-cash assets, no reserved ones. */
export function isPayableExpenseAccount(
  account: { id: string; code: string; kind: EntryAccount["kind"]; isCashLike?: boolean },
  walletAccountIds: ReadonlySet<string>,
): boolean {
  return (
    (account.kind === "expense" || account.kind === "asset") &&
    !isReservedAccount(account, walletAccountIds)
  );
}

export interface PayableDefaultsPartner {
  name: string;
  invoiceRegistrationNumber: string | null;
  defaultAccountId: string | null;
  defaultTaxCategoryCode: string | null;
  defaultSegmentId: string | null;
  paymentTerms: PaymentTerms | null;
}

export interface PayableDefaultsAccount {
  id: string;
  defaultTaxCategoryCode: string | null;
  defaultSegmentId: string | null;
}

export interface PayableDefaults {
  accountId: string | null;
  taxCategoryCode: string | null;
  segmentId: string | null;
  dueDate: CalendarDate | null;
  description: string;
}

/**
 * The first values of the registration (25 §4.1): the partner's account (else 外注費), the partner's
 * tax category (else the account's; never a sales one) moved to 「インボイスなし」 without a
 * registration number, the
 * partner's segment (else the account's, else 共通), the due date of the partner's terms and
 * 「請求書 <取引先>」.
 */
export function payableDefaults(input: {
  partner: PayableDefaultsPartner | null;
  /** The partner's default account when choosable, else 外注費 (the caller resolves it). */
  account: PayableDefaultsAccount | null;
  /** 共通 */
  fallbackSegmentId: string | null;
  /** The document's own registration number (適格請求書 even when the master has none). */
  documentRegistrationNumber: string | null;
  invoiceDate: CalendarDate | null;
}): PayableDefaults {
  const { partner, account } = input;
  const qualified = Boolean(partner?.invoiceRegistrationNumber || input.documentRegistrationNumber);
  // A sales category (a customer's default) is no default for a purchase.
  const tax =
    [partner?.defaultTaxCategoryCode, account?.defaultTaxCategoryCode].find(
      (code): code is string =>
        typeof code === "string" && getTaxCategory(code)?.direction !== "sales",
    ) ?? null;
  return {
    accountId: account?.id ?? null,
    taxCategoryCode: tax === null ? null : payableTaxCategoryCode(tax, qualified),
    segmentId:
      partner?.defaultSegmentId ?? account?.defaultSegmentId ?? input.fallbackSegmentId ?? null,
    dueDate:
      input.invoiceDate === null
        ? null
        : defaultPayableDueDate(input.invoiceDate, partner?.paymentTerms ?? null),
    description: payableDescription(partner?.name ?? null),
  };
}

/** 摘要 of 計上: 「請求書 <取引先>」. */
export function payableDescription(partnerName: string | null): string {
  return partnerName ? `請求書 ${partnerName}` : "請求書";
}

/** 摘要 of a payment: 「支払 <取引先> <証憑の件名か元のファイル名>」 (25 §4.2). */
export function payablePaymentDescription(partnerName: string, title: string | null): string {
  return ["支払", partnerName, title?.trim() ?? ""].filter((part) => part !== "").join(" ");
}

// ---------------------------------------------------------------------------
// Journal entries (25 §4.1, §4.2)
// ---------------------------------------------------------------------------

function findByCode(
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

function plain(
  side: Side,
  accountId: string,
  amount: Money,
  extra: Partial<JournalLineInput> = {},
): JournalLineInput {
  return {
    side,
    accountId,
    subAccountId: null,
    amount,
    taxCategoryCode: "na",
    taxAmount: 0n,
    segmentId: null,
    partnerId: null,
    description: null,
    ...extra,
  };
}

function collect<T>(errors: LedgerError[], fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof LedgerValidationError)) throw error;
    errors.push(...error.errors);
    return undefined;
  }
}

/** A line of 計上: one per expense account and tax category (税込). */
export interface PayableEntryLineInput {
  /** An expense or a non-cash asset account. */
  accountId: string;
  /** Tax-inclusive, 1 or more. */
  amount: Money;
  taxCategoryCode: string;
  segmentId: string | null;
}

export interface PayableEntryInput {
  /** 請求書の日付 (取引年月日): the entry's date. */
  invoiceDate: CalendarDate;
  partnerId: string;
  /** 適格請求書: without one, 課税仕入 is booked as 「インボイスなし」 (`payableTaxCategoryCode`). */
  qualifiedInvoice: boolean;
  /** 摘要 (「請求書 <取引先>」 by default). */
  description: string;
  lines: readonly PayableEntryLineInput[];
}

/**
 * 計上 of a received invoice (25 §4.1): 借方 費用（税込、税区分ごと）, in tax-exclusive years the
 * creditable tax as 仮払消費税 / 貸方 未払金 2100 without a sub-account, with the partner (so that it
 * never mixes with the cards' 未払金). `kind = normal`, `sourceKind = manual`: the entry can be voided
 * on the transaction screen, which cancels the payable. Throws `LedgerValidationError` with the
 * field (`accountId` …, or `lines.<n>.accountId` when there are several lines).
 */
export function buildPayableEntry(
  input: PayableEntryInput,
  context: SimpleEntryContext,
): JournalEntryInput {
  const errors: LedgerError[] = [];
  const single = input.lines.length === 1;
  const fieldOf = (index: number, field: string) => (single ? field : `lines.${index}.${field}`);
  if (input.lines.length === 0) {
    errors.push({ code: "TOO_FEW_LINES", message: "金額を入力してください", field: "amount" });
  }
  const walletAccountIds = walletAccountIdsOf(context.wallets.values());
  const payable = findByCode(PAYABLE_ACCOUNT_CODE, context, errors);
  const built = input.lines.map((line, index) => {
    if (line.amount <= 0n) {
      errors.push({
        code: "NON_POSITIVE_AMOUNT",
        message: "金額は 1 円以上にしてください",
        field: fieldOf(index, "amount"),
      });
    }
    const account = context.accounts.get(line.accountId);
    if (!account || !isPayableExpenseAccount(account, walletAccountIds)) {
      errors.push({
        code: account ? "ACCOUNT_NOT_ALLOWED" : "UNKNOWN_ACCOUNT",
        message: account
          ? `勘定科目「${account.code} ${account.name}」は請求書の計上には使えません。費用か資産の科目を選んでください`
          : "勘定科目が見つかりません。一覧から選んでください",
        field: fieldOf(index, "accountId"),
      });
    }
    const taxCategoryCode = payableTaxCategoryCode(line.taxCategoryCode, input.qualifiedInvoice);
    const split =
      line.amount > 0n
        ? collect(errors, () =>
            splitTaxInclusive(line.amount, taxCategoryCode, input.invoiceDate, {
              accountingMethod: context.accountingMethod,
              taxRules: context.taxRules,
              field: fieldOf(index, "taxCategoryCode"),
            }),
          )
        : undefined;
    return { line, taxCategoryCode, split };
  });
  const inputTax = built.reduce((total, item) => total + (item.split?.taxLineAmount ?? 0n), 0n);
  const inputTaxAccount =
    inputTax > 0n ? findByCode(INPUT_TAX_ACCOUNT_CODE, context, errors) : null;
  if (errors.length > 0) throw new LedgerValidationError(errors);
  if (!payable || inputTaxAccount === undefined) {
    throw new Error("buildPayableEntry: unreachable after the error check");
  }

  const lines: JournalLineInput[] = [];
  let total: Money = 0n;
  for (const { line, taxCategoryCode, split } of built) {
    if (!split) throw new Error("buildPayableEntry: unreachable without a split");
    total += line.amount;
    lines.push({
      side: "debit",
      accountId: line.accountId,
      subAccountId: null,
      amount: split.amount,
      taxCategoryCode,
      taxAmount: split.taxAmount,
      segmentId: line.segmentId,
      partnerId: input.partnerId,
      description: input.description,
    });
  }
  if (inputTaxAccount) lines.push(plain("debit", inputTaxAccount.id, inputTax));
  lines.push(plain("credit", payable.id, total, { partnerId: input.partnerId }));
  return {
    entryDate: input.invoiceDate,
    description: input.description,
    kind: "normal",
    sourceKind: "manual",
    lines,
  };
}

export interface PayablePaymentSplit {
  /** 充当額: what goes against the rest (min(出金額, 残り)). */
  applied: Money;
  /** 支払手数料: 出金額 − 充当額 (only when the payment exceeds the rest). */
  fee: Money;
  /** The rest after the payment. */
  remainingAfter: Money;
  /** Why the payment cannot be made (owner-facing), `null` when it can. */
  problem: string | null;
}

/**
 * The amounts of a payment (25 §4.2): 充当額 = min(出金額, 残り); above the rest the difference is the
 * transfer fee (up to `PAYABLE_FEE_LIMIT`; more is refused); below it the payment is partial.
 */
export function splitPayablePayment(amount: Money, remaining: Money): PayablePaymentSplit {
  if (remaining <= 0n) {
    return {
      applied: 0n,
      fee: 0n,
      remainingAfter: remaining,
      problem: "支払済みのため残りはありません",
    };
  }
  if (amount <= 0n) {
    return {
      applied: 0n,
      fee: 0n,
      remainingAfter: remaining,
      problem: "出金額は 1 円以上にしてください",
    };
  }
  const applied = amount < remaining ? amount : remaining;
  const fee = amount - applied;
  const problem =
    fee > PAYABLE_FEE_LIMIT
      ? `出金額が残り ${formatYen(remaining)} 円を ${formatYen(fee)} 円超えています。手数料にできるのは ${formatYen(PAYABLE_FEE_LIMIT)} 円までです`
      : null;
  return { applied, fee, remainingAfter: remaining - applied, problem };
}

export interface PayablePaymentEntryInput {
  /** 支払日 */
  paidOn: CalendarDate;
  /** The paying wallet (bank, cash, a card …): its account and sub-account are credited. */
  walletId: string;
  /** 出金額: what left the wallet. */
  amount: Money;
  /** 支払手数料 (tax-inclusive) within the amount; 充当額 = amount − fee. */
  fee: Money;
  /** The partner of the 未払金 line (the registration's). */
  partnerId: string | null;
  /** 摘要 (`payablePaymentDescription`). */
  description: string;
  /** The segment of the fee line (the expense's); `null` → 共通. */
  segmentId: string | null;
  /** The statement line paid from: `sourceKind = wallet_txn`, `sourceId` = the line. */
  walletTransactionId: string | null;
}

/**
 * A payment (25 §4.2): 借方 未払金 2100（補助科目なし・取引先）充当額（, 支払手数料 the fee, 仮払消費税 in
 * tax-exclusive years）/ 貸方 口座 出金額. From a statement line the entry is the line's
 * (`sourceKind = wallet_txn`, `sourceId` = the line) so that 「未処理に戻す」 on the statement screen
 * voids it; otherwise `manual`. Throws `LedgerValidationError` with the field.
 */
export function buildPayablePaymentEntry(
  input: PayablePaymentEntryInput,
  context: SimpleEntryContext,
): JournalEntryInput {
  const errors: LedgerError[] = [];
  if (input.amount <= 0n) {
    errors.push({
      code: "NON_POSITIVE_AMOUNT",
      message: "出金額は 1 円以上にしてください",
      field: "amount",
    });
  }
  if (input.fee < 0n || input.fee >= input.amount) {
    errors.push({
      code: "NON_POSITIVE_AMOUNT",
      message: "手数料は出金額より少なくしてください",
      field: "amount",
    });
  }
  const wallet = context.wallets.get(input.walletId);
  const walletAccount = wallet ? context.accounts.get(wallet.accountId) : undefined;
  if (
    !wallet ||
    !wallet.isActive ||
    (walletAccount?.kind !== "asset" && walletAccount?.kind !== "liability")
  ) {
    errors.push({
      code: "UNKNOWN_WALLET",
      message: wallet
        ? `口座「${wallet.name}」からは支払えません。有効な口座を選んでください`
        : "口座が見つかりません。一覧から選んでください",
      field: "walletId",
    });
  }
  const payable = findByCode(PAYABLE_ACCOUNT_CODE, context, errors);
  const fee = input.fee > 0n ? input.fee : 0n;
  const feeAccount =
    fee > 0n ? findByCode(PAYABLE_FEE_ACCOUNT_CODE, context, errors, "amount") : null;
  const feeTaxCode = feeAccount?.defaultTaxCategoryCode ?? "na";
  const feeSplit: TaxSplit | null | undefined = feeAccount
    ? collect(errors, () =>
        splitTaxInclusive(fee, feeTaxCode, input.paidOn, {
          accountingMethod: context.accountingMethod,
          taxRules: context.taxRules,
          field: "amount",
        }),
      )
    : null;
  const inputTax =
    feeSplit && feeSplit.taxLineAmount > 0n
      ? findByCode(INPUT_TAX_ACCOUNT_CODE, context, errors, "amount")
      : null;
  if (errors.length > 0) throw new LedgerValidationError(errors);
  if (!wallet || !payable || feeAccount === undefined || inputTax === undefined) {
    throw new Error("buildPayablePaymentEntry: unreachable after the error check");
  }

  const lines: JournalLineInput[] = [
    plain("debit", payable.id, input.amount - fee, { partnerId: input.partnerId }),
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
      partnerId: null,
      description: "振込手数料",
    });
    if (inputTax) lines.push(plain("debit", inputTax.id, feeSplit.taxLineAmount));
  }
  lines.push(
    plain("credit", wallet.accountId, input.amount, {
      subAccountId: wallet.subAccountId,
      segmentId: wallet.defaultSegmentId,
    }),
  );
  const fromLine = input.walletTransactionId !== null;
  const sourceKind: SourceKind = fromLine ? "wallet_txn" : "manual";
  return {
    entryDate: input.paidOn,
    description: input.description,
    kind: "normal",
    sourceKind,
    ...(fromLine ? { sourceId: input.walletTransactionId } : {}),
    lines,
  };
}

// ---------------------------------------------------------------------------
// The rest and the state, derived (25 §1, §2)
// ---------------------------------------------------------------------------

/**
 * A 未払金 line (2100 without a sub-account) of the registration or of an entry linked to the
 * document. The caller loads only those lines.
 */
export interface PayableLedgerLine {
  entryId: string;
  entryStatus: EntryStatus;
  entryKind: EntryKind;
  side: Side;
  amount: Money;
}

export interface PayableAmounts {
  /** 計上額: the registration's 未払金 credits. */
  registered: Money;
  /** 支払済み: the 未払金 debits of the other entries in force (no voided ones, no reversals). */
  paid: Money;
  /** 残り = 計上額 − 支払済み. */
  remaining: Money;
}

/**
 * 計上額・支払済み・残り (25 §1). The registration counts its credits whatever its status (a cancelled
 * payable keeps its amount; `payableState` says 取消); payments count only when posted and not a
 * reversal. Voiding a payment (取消, 未処理に戻す) brings the rest back by itself.
 */
export function payableAmounts(
  registrationEntryId: string,
  lines: Iterable<PayableLedgerLine>,
): PayableAmounts {
  let registered: Money = 0n;
  let paid: Money = 0n;
  for (const line of lines) {
    if (line.entryId === registrationEntryId) {
      if (line.side === "credit") registered += line.amount;
      continue;
    }
    if (line.entryStatus !== "posted" || line.entryKind === "reversal") continue;
    if (line.side === "debit") paid += line.amount;
  }
  return { registered, paid, remaining: registered - paid };
}

/** 未払 / 一部支払 / 支払済み / 取消 (25 §2). */
export function payableState(input: {
  registrationStatus: EntryStatus;
  registered: Money;
  remaining: Money;
}): PayableState {
  if (input.registrationStatus === "voided") return "cancelled";
  if (input.remaining <= 0n) return "paid";
  if (input.remaining < input.registered) return "partial";
  return "unpaid";
}

/** 期限超過: 未払・一部支払 past the due date (25 §2). */
export function isPayableOverdue(
  state: PayableState,
  dueDate: CalendarDate | null,
  today: CalendarDate,
): boolean {
  return isOpenPayableState(state) && dueDate !== null && dueDate < today;
}

/** 「7 日以内に支払う」: open, due from today up to `days` days on (overdue ones not included). */
export function isPayableDueSoon(
  state: PayableState,
  dueDate: CalendarDate | null,
  today: CalendarDate,
  days: number = PAYABLE_DUE_SOON_DAYS,
): boolean {
  return (
    isOpenPayableState(state) &&
    dueDate !== null &&
    dueDate >= today &&
    dueDate <= addDays(today, days)
  );
}

/**
 * Whether a statement line names the partner (its description or counterparty contains the
 * partner's name or kana without the legal form): 「同じ取引先を先に」 (25 §7.3).
 */
export function statementNamesPartner(
  line: { descriptionRaw: string; counterpartyRaw: string | null },
  partner: { name: string; nameKana: string | null },
): boolean {
  const texts = [line.descriptionRaw, line.counterpartyRaw ?? ""].map(descriptionKey);
  return [partner.name, partner.nameKana ?? ""].some((name) => {
    const key = partnerNameKey(name);
    return key.length >= 3 && texts.some((text) => text.includes(key));
  });
}
