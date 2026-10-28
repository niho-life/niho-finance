import { findTemplateAccount } from "./chart-template";
import { displayDate, type CalendarDate } from "./date";
import { LedgerValidationError, type LedgerError } from "./errors";
import type { Money } from "./money";
import { exclusiveTaxAmount, inclusiveTaxAmount, resolveTaxRule, type TaxRateRule } from "./tax";
import { getTaxCategory } from "./tax-categories";
import type {
  AccountingMethod,
  AccountKind,
  EntryKind,
  JournalEntryInput,
  JournalLineInput,
  Side,
} from "./types";

/**
 * Entries of the transaction forms (11-transactions §1, §4). 収入 / 支出 / 振替 take a tax-inclusive
 * amount and become a journal entry with the consumption tax split by the fiscal year's method;
 * 伝票 rows only get their tax computed. Pure: the repository loads the context and posts the
 * result through `postJournalEntry`, which validates it against the ledger rules.
 */

/** 仮受消費税: added to income in tax-exclusive years (02 §2, §3). */
export const OUTPUT_TAX_ACCOUNT_CODE = "2310";
/** 仮払消費税: added to expenses in tax-exclusive years. */
export const INPUT_TAX_ACCOUNT_CODE = "1400";
/** 支払手数料: the fee of a transfer (11 §4.3). */
export const TRANSFER_FEE_ACCOUNT_CODE = "5400";

// ---------------------------------------------------------------------------
// Consumption tax of a line
// ---------------------------------------------------------------------------

/**
 * The rate of a tax category on a date: 0 for categories outside the tax (非課税・不課税・対象外 …),
 * `null` when a taxable category has no enabled rule on the date.
 */
export function lineTaxRate(
  taxCategoryCode: string,
  date: CalendarDate,
  rules: Iterable<TaxRateRule>,
): number | null {
  const category = getTaxCategory(taxCategoryCode);
  if (!category || category.kind !== "taxable") return 0;
  return resolveTaxRule(taxCategoryCode, date, rules)?.ratePercent ?? null;
}

function missingRule(taxCategoryCode: string, date: CalendarDate, field?: string): LedgerError {
  const name = getTaxCategory(taxCategoryCode)?.name ?? taxCategoryCode;
  return {
    code: "TAX_RULE_MISSING",
    message: `税区分「${name}」の税率が ${displayDate(date)} に設定されていません。設定 › 税区分 で足してください`,
    ...(field ? { field } : {}),
  };
}

/** The tax a form shows under a tax-inclusive amount (「うち消費税」); `null` without a rule. */
export function containedTaxAmount(
  amountInclusive: Money,
  taxCategoryCode: string,
  date: CalendarDate,
  rules: Iterable<TaxRateRule>,
): Money | null {
  const rate = lineTaxRate(taxCategoryCode, date, rules);
  return rate === null ? null : inclusiveTaxAmount(amountInclusive, rate);
}

/**
 * The tax of a 伝票 row (11 §4.4): rows are tax-exclusive in tax-exclusive years (amount × rate ÷ 100)
 * and tax-inclusive otherwise (amount × rate ÷ (100 + rate)), truncated. `null` without a rule.
 */
export function voucherLineTaxAmount(
  amount: Money,
  taxCategoryCode: string,
  date: CalendarDate,
  accountingMethod: AccountingMethod,
  rules: Iterable<TaxRateRule>,
): Money | null {
  const rate = lineTaxRate(taxCategoryCode, date, rules);
  if (rate === null) return null;
  return accountingMethod === "tax_exclusive"
    ? exclusiveTaxAmount(amount, rate)
    : inclusiveTaxAmount(amount, rate);
}

export interface TaxSplit {
  /** The line's amount: tax-inclusive in tax-inclusive years, without the tax in tax-exclusive years. */
  amount: Money;
  /** The consumption tax contained in the tax-inclusive amount (kept on the line, 01 §3). */
  taxAmount: Money;
  /** The 仮受消費税 / 仮払消費税 line to add: the tax in tax-exclusive years, 0 otherwise. */
  taxLineAmount: Money;
}

export interface SplitTaxOptions {
  accountingMethod: AccountingMethod;
  taxRules: Iterable<TaxRateRule>;
  /** The form field a missing rule is reported on. */
  field?: string;
}

/**
 * Splits a tax-inclusive amount (what the forms take, 11 §1). Tax-inclusive years (exempt ones too)
 * keep the amount and only record the contained tax; tax-exclusive years book the amount without the
 * tax and the tax on a line of its own. Throws `TAX_RULE_MISSING` for a taxable category without a rule.
 */
export function splitTaxInclusive(
  amountInclusive: Money,
  taxCategoryCode: string,
  date: CalendarDate,
  options: SplitTaxOptions,
): TaxSplit {
  const category = getTaxCategory(taxCategoryCode);
  const rule =
    category?.kind === "taxable" ? resolveTaxRule(taxCategoryCode, date, options.taxRules) : null;
  if (rule === undefined) {
    throw new LedgerValidationError([missingRule(taxCategoryCode, date, options.field)]);
  }
  const taxAmount = rule ? inclusiveTaxAmount(amountInclusive, rule.ratePercent) : 0n;
  if (options.accountingMethod === "tax_exclusive") {
    // 経過措置 (02 §3): without a qualified invoice only the creditable share of the tax goes to
    // 仮払消費税; the rest stays in the cost. `deductiblePercent` is null for sales and 100% purchases.
    const percent = rule?.deductiblePercent ?? 100;
    const taxLineAmount = percent === 100 ? taxAmount : (taxAmount * BigInt(percent)) / 100n;
    return { amount: amountInclusive - taxLineAmount, taxAmount, taxLineAmount };
  }
  return { amount: amountInclusive, taxAmount, taxLineAmount: 0n };
}

// ---------------------------------------------------------------------------
// 収入 / 支出 / 振替
// ---------------------------------------------------------------------------

export interface EntryAccount {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  defaultTaxCategoryCode: string | null;
}

export interface EntryWallet {
  id: string;
  name: string;
  accountId: string;
  subAccountId: string | null;
  defaultSegmentId: string | null;
  isActive: boolean;
}

export interface SimpleEntryContext {
  accountingMethod: AccountingMethod;
  taxRules: readonly TaxRateRule[];
  /** Accounts by id, inactive ones included (the ledger rejects those with ACCOUNT_INACTIVE). */
  accounts: ReadonlyMap<string, EntryAccount>;
  wallets: ReadonlyMap<string, EntryWallet>;
  /** 共通: the segment of a transfer fee when the paying wallet has no default segment. */
  corporateSegmentId: string | null;
}

/** 入金先 / 支払元: a wallet (its account and sub-account), or an account (e.g. 売掛金・未払金). */
export type EntryCounterpart =
  { kind: "wallet"; walletId: string } | { kind: "account"; accountId: string };

interface SimpleEntryBase {
  entryDate: CalendarDate;
  description: string;
  /** Put on every line of the entry. */
  memoTagIds?: readonly string[];
}

export interface IncomeEntryInput extends SimpleEntryBase {
  type: "income";
  /** 入金先: a wallet, or an asset or liability account. */
  counterpart: EntryCounterpart;
  /** A revenue account. */
  accountId: string;
  /** Tax-inclusive. */
  amount: Money;
  taxCategoryCode: string;
  segmentId: string | null;
  partnerId: string | null;
}

export interface ExpenseEntryInput extends SimpleEntryBase {
  type: "expense";
  /** 支払元: a wallet, or a liability account. */
  counterpart: EntryCounterpart;
  /** An expense account, or a non-cash asset or a liability (前払費用・固定資産・役員借入金の返済). */
  accountId: string;
  /** Tax-inclusive. */
  amount: Money;
  taxCategoryCode: string;
  segmentId: string | null;
  partnerId: string | null;
}

export interface TransferEntryInput extends SimpleEntryBase {
  type: "transfer";
  fromWalletId: string;
  toWalletId: string;
  amount: Money;
  /** 手数料 (tax-inclusive), paid from the paying wallet on top of the amount. */
  fee: Money | null;
}

export type SimpleEntryInput = IncomeEntryInput | ExpenseEntryInput | TransferEntryInput;
export type SimpleEntryType = SimpleEntryInput["type"];

/** The account kinds each form accepts (11 §4.1, §4.2). */
const ALLOWED_KINDS = {
  income: { account: ["revenue"], counterpart: ["asset", "liability"] },
  expense: { account: ["expense", "asset", "liability"], counterpart: ["liability"] },
} as const satisfies Record<
  "income" | "expense",
  { account: readonly AccountKind[]; counterpart: readonly AccountKind[] }
>;

/** Collects the builder's problems so that one request reports all of them. */
class Problems {
  readonly errors: LedgerError[] = [];

  add(error: LedgerError): undefined {
    this.errors.push(error);
    return undefined;
  }

  /** Runs `fn`; a `LedgerValidationError` is collected instead of thrown. */
  catch<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof LedgerValidationError)) throw error;
      this.errors.push(...error.errors);
      return undefined;
    }
  }

  throwIfAny(): void {
    if (this.errors.length > 0) throw new LedgerValidationError(this.errors);
  }
}

function findAccount(
  accountId: string,
  field: string,
  allowed: readonly AccountKind[],
  context: SimpleEntryContext,
  problems: Problems,
): EntryAccount | undefined {
  const account = context.accounts.get(accountId);
  if (!account) {
    return problems.add({
      code: "UNKNOWN_ACCOUNT",
      message: "勘定科目が見つかりません。一覧から選んでください",
      field,
    });
  }
  if (!allowed.includes(account.kind)) {
    return problems.add({
      code: "ACCOUNT_NOT_ALLOWED",
      message: `勘定科目「${account.code} ${account.name}」はここでは選べません。一覧から選んでください`,
      field,
    });
  }
  return account;
}

function findWallet(
  walletId: string,
  field: string,
  context: SimpleEntryContext,
  problems: Problems,
): EntryWallet | undefined {
  const wallet = context.wallets.get(walletId);
  if (!wallet) {
    return problems.add({
      code: "UNKNOWN_WALLET",
      message: "口座が見つかりません。一覧から選んでください",
      field,
    });
  }
  if (!wallet.isActive) {
    return problems.add({
      code: "UNKNOWN_WALLET",
      message: `口座「${wallet.name}」は無効です。別の口座を選んでください`,
      field,
    });
  }
  return wallet;
}

/** 仮受消費税 / 仮払消費税 / 支払手数料, found by code in the context. */
function standardAccount(
  code: string,
  context: SimpleEntryContext,
  problems: Problems,
  field?: string,
): EntryAccount | undefined {
  for (const account of context.accounts.values()) if (account.code === code) return account;
  const name = findTemplateAccount(code)?.name ?? "";
  return problems.add({
    code: "STANDARD_ACCOUNT_MISSING",
    message: `勘定科目 ${code}（${name}）がありません。設定 › 勘定科目 で足してください`,
    ...(field ? { field } : {}),
  });
}

interface LineTarget {
  accountId: string;
  subAccountId: string | null;
  segmentId: string | null;
  partnerId: string | null;
}

function counterpartTarget(
  counterpart: EntryCounterpart,
  allowed: readonly AccountKind[],
  partnerId: string | null,
  context: SimpleEntryContext,
  problems: Problems,
): LineTarget | undefined {
  if (counterpart.kind === "wallet") {
    const wallet = findWallet(counterpart.walletId, "counterpart", context, problems);
    return wallet
      ? {
          accountId: wallet.accountId,
          subAccountId: wallet.subAccountId,
          segmentId: wallet.defaultSegmentId,
          partnerId: null,
        }
      : undefined;
  }
  const account = findAccount(counterpart.accountId, "counterpart", allowed, context, problems);
  // A receivable or payable is followed per partner, so the partner goes on that line too.
  return account
    ? { accountId: account.id, subAccountId: null, segmentId: null, partnerId }
    : undefined;
}

function plainLine(
  side: Side,
  target: LineTarget,
  amount: Money,
  memoTagIds: string[],
  description: string | null = null,
): JournalLineInput {
  return {
    side,
    accountId: target.accountId,
    subAccountId: target.subAccountId,
    amount,
    taxCategoryCode: "na",
    taxAmount: 0n,
    segmentId: target.segmentId,
    partnerId: target.partnerId,
    description,
    memoTagIds,
  };
}

function buildIncomeOrExpense(
  input: IncomeEntryInput | ExpenseEntryInput,
  context: SimpleEntryContext,
): JournalEntryInput {
  const problems = new Problems();
  const allowed = ALLOWED_KINDS[input.type];
  const tags = [...(input.memoTagIds ?? [])];
  const account = findAccount(input.accountId, "accountId", allowed.account, context, problems);
  const counterpart = counterpartTarget(
    input.counterpart,
    allowed.counterpart,
    input.partnerId,
    context,
    problems,
  );
  const split = problems.catch(() =>
    splitTaxInclusive(input.amount, input.taxCategoryCode, input.entryDate, {
      accountingMethod: context.accountingMethod,
      taxRules: context.taxRules,
      field: "taxCategoryCode",
    }),
  );
  const taxAccount =
    split && split.taxLineAmount > 0n
      ? standardAccount(
          input.type === "income" ? OUTPUT_TAX_ACCOUNT_CODE : INPUT_TAX_ACCOUNT_CODE,
          context,
          problems,
        )
      : null;
  problems.throwIfAny();
  if (!account || !counterpart || !split || taxAccount === undefined) {
    throw new Error("buildSimpleEntry: unreachable after the problems check");
  }

  // 収入: 借方 入金先 / 貸方 収益. 支出: 借方 科目 / 貸方 支払元 (11 §4.1, §4.2).
  const mainSide: Side = input.type === "income" ? "credit" : "debit";
  const counterSide: Side = input.type === "income" ? "debit" : "credit";
  const main: JournalLineInput = {
    side: mainSide,
    accountId: account.id,
    subAccountId: null,
    amount: split.amount,
    taxCategoryCode: input.taxCategoryCode,
    taxAmount: split.taxAmount,
    segmentId: input.segmentId,
    partnerId: input.partnerId,
    description: input.description,
    memoTagIds: tags,
  };
  const taxLine = taxAccount
    ? [
        plainLine(
          mainSide,
          { accountId: taxAccount.id, subAccountId: null, segmentId: null, partnerId: null },
          split.taxLineAmount,
          tags,
        ),
      ]
    : [];
  const counterLine = plainLine(counterSide, counterpart, input.amount, tags);
  return {
    entryDate: input.entryDate,
    description: input.description,
    kind: "normal",
    sourceKind: "manual",
    lines:
      input.type === "income" ? [counterLine, main, ...taxLine] : [main, ...taxLine, counterLine],
  };
}

function buildTransfer(input: TransferEntryInput, context: SimpleEntryContext): JournalEntryInput {
  const problems = new Problems();
  const tags = [...(input.memoTagIds ?? [])];
  const from = findWallet(input.fromWalletId, "fromWalletId", context, problems);
  const to = findWallet(input.toWalletId, "toWalletId", context, problems);
  if (input.fromWalletId === input.toWalletId) {
    problems.add({
      code: "SAME_WALLET",
      message: "出金元と入金先が同じ口座です。別の口座を選んでください",
      field: "toWalletId",
    });
  }
  const fee = input.fee !== null && input.fee > 0n ? input.fee : 0n;
  const feeAccount =
    fee > 0n ? standardAccount(TRANSFER_FEE_ACCOUNT_CODE, context, problems, "fee") : null;
  const feeTaxCode = feeAccount?.defaultTaxCategoryCode ?? "na";
  const feeSplit = feeAccount
    ? problems.catch(() =>
        splitTaxInclusive(fee, feeTaxCode, input.entryDate, {
          accountingMethod: context.accountingMethod,
          taxRules: context.taxRules,
          field: "fee",
        }),
      )
    : null;
  const inputTax =
    feeSplit && feeSplit.taxLineAmount > 0n
      ? standardAccount(INPUT_TAX_ACCOUNT_CODE, context, problems, "fee")
      : null;
  problems.throwIfAny();
  if (
    !from ||
    !to ||
    feeAccount === undefined ||
    feeSplit === undefined ||
    inputTax === undefined
  ) {
    throw new Error("buildSimpleEntry: unreachable after the problems check");
  }

  const walletTarget = (wallet: EntryWallet): LineTarget => ({
    accountId: wallet.accountId,
    subAccountId: wallet.subAccountId,
    segmentId: wallet.defaultSegmentId,
    partnerId: null,
  });
  const lines: JournalLineInput[] = [plainLine("debit", walletTarget(to), input.amount, tags)];
  if (feeAccount && feeSplit) {
    lines.push({
      side: "debit",
      accountId: feeAccount.id,
      subAccountId: null,
      amount: feeSplit.amount,
      taxCategoryCode: feeTaxCode,
      taxAmount: feeSplit.taxAmount,
      segmentId: from.defaultSegmentId ?? context.corporateSegmentId,
      partnerId: null,
      description: "手数料",
      memoTagIds: tags,
    });
    if (inputTax) {
      lines.push(
        plainLine(
          "debit",
          { accountId: inputTax.id, subAccountId: null, segmentId: null, partnerId: null },
          feeSplit.taxLineAmount,
          tags,
        ),
      );
    }
  }
  lines.push(plainLine("credit", walletTarget(from), input.amount + fee, tags));
  return {
    entryDate: input.entryDate,
    description: input.description,
    kind: "transfer",
    sourceKind: "manual",
    lines,
  };
}

/**
 * 収入 / 支出 / 振替 → a journal entry (`sourceKind = manual`). Throws `LedgerValidationError` with
 * the form field of each problem (unknown wallet or account, the same wallet twice, a taxable
 * category without a rule). The ledger rules (segments, the close) are checked when it is posted.
 */
export function buildSimpleEntry(
  input: SimpleEntryInput,
  context: SimpleEntryContext,
): JournalEntryInput {
  switch (input.type) {
    case "income":
    case "expense":
      return buildIncomeOrExpense(input, context);
    case "transfer":
      return buildTransfer(input, context);
  }
}

// ---------------------------------------------------------------------------
// 伝票
// ---------------------------------------------------------------------------

export interface VoucherLineInput {
  side: Side;
  accountId: string;
  subAccountId: string | null;
  /** Tax-exclusive in tax-exclusive years, tax-inclusive otherwise (11 §4.4). */
  amount: Money;
  taxCategoryCode: string;
  segmentId: string | null;
  /** Blank → the entry's partner. */
  partnerId: string | null;
  description: string | null;
}

export interface VoucherEntryInput {
  entryDate: CalendarDate;
  description: string;
  kind: EntryKind;
  /** The partner of the rows left blank. */
  partnerId: string | null;
  /** Put on every line of the entry. */
  memoTagIds?: readonly string[];
  lines: readonly VoucherLineInput[];
}

export interface VoucherEntryContext {
  accountingMethod: AccountingMethod;
  taxRules: readonly TaxRateRule[];
}

/**
 * 伝票 → a journal entry: each row's tax is computed (no lines are added; in tax-exclusive years the
 * 仮受・仮払 rows are written by hand). Throws `TAX_RULE_MISSING` naming the row (`lines.<n>.taxCategoryCode`).
 */
export function buildVoucherEntry(
  input: VoucherEntryInput,
  context: VoucherEntryContext,
): JournalEntryInput {
  const problems = new Problems();
  const tags = [...(input.memoTagIds ?? [])];
  const lines = input.lines.map((line, index): JournalLineInput => {
    const taxAmount = voucherLineTaxAmount(
      line.amount,
      line.taxCategoryCode,
      input.entryDate,
      context.accountingMethod,
      context.taxRules,
    );
    if (taxAmount === null) {
      problems.add({
        ...missingRule(line.taxCategoryCode, input.entryDate, `lines.${index}.taxCategoryCode`),
        lineIndex: index,
      });
    }
    return {
      side: line.side,
      accountId: line.accountId,
      subAccountId: line.subAccountId,
      amount: line.amount,
      taxCategoryCode: line.taxCategoryCode,
      taxAmount: taxAmount ?? 0n,
      segmentId: line.segmentId,
      partnerId: line.partnerId ?? input.partnerId,
      description: line.description,
      memoTagIds: tags,
    };
  });
  problems.throwIfAny();
  return {
    entryDate: input.entryDate,
    description: input.description,
    kind: input.kind,
    sourceKind: "manual",
    lines,
  };
}
