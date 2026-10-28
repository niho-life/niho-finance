import type { CalendarDate } from "./date";
import type { DepreciationMethod } from "./depreciation";
import { LedgerInvariantError, LedgerValidationError } from "./errors";
import { formatYen, type Money } from "./money";
import type {
  AccountingMethod,
  AccountKind,
  JournalEntryInput,
  JournalLineInput,
  Side,
} from "./types";

/**
 * 決算整理・決算振替の仕訳の組み立て (docs/design/16-year-end.md §4.3, §5.3, §6–§10). Every builder
 * returns a `JournalEntryInput` for `postJournalEntry`, which validates it against the ledger rules.
 * Lines are 対象外 (`na`, no tax) unless stated; segments go on revenue and expense lines only.
 */

// ---------------------------------------------------------------------------
// 科目 (02 §2)
// ---------------------------------------------------------------------------

/** 減価償却費. */
export const DEPRECIATION_EXPENSE_CODE = "5460";
/** 減価償却累計額 (間接法). */
export const ACCUMULATED_DEPRECIATION_CODE = "1590";
/** 繰越利益剰余金: the closing entry carries the net income here. */
export const RETAINED_EARNINGS_CODE = "3200";
/** 法人税、住民税及び事業税. */
export const CORPORATE_TAX_EXPENSE_CODE = "8000";
/** 未払法人税等. */
export const CORPORATE_TAX_PAYABLE_CODE = "2120";
/** 前払費用. */
export const PREPAID_EXPENSE_CODE = "1300";
/** 未払費用. */
export const ACCRUED_EXPENSE_CODE = "2110";
/** 前受金. */
export const DEFERRED_REVENUE_CODE = "2200";
/** 貯蔵品 is not in the standard chart: it is the 流動資産 account with this name (§7). */
export const SUPPLIES_ACCOUNT_NAME = "貯蔵品";
/** 未払消費税等. */
export const CONSUMPTION_TAX_PAYABLE_CODE = "2130";
/** 未収入金 (a consumption tax refund). */
export const OTHER_RECEIVABLE_CODE = "1250";
/** 雑収入. */
export const MISC_INCOME_CODE = "4510";
/** 雑損失. */
export const MISC_LOSS_CODE = "5600";
/** 租税公課. */
export const TAXES_AND_DUES_CODE = "5440";

// ---------------------------------------------------------------------------
// sourceId of generated entries
// ---------------------------------------------------------------------------

export const YEAR_END_SOURCE_PURPOSES = [
  "deferred",
  "accrual",
  "consumption_tax",
  "corporate_tax",
  "closing",
] as const;
export type YearEndSourcePurpose = (typeof YEAR_END_SOURCE_PURPOSES)[number];

const SOURCE_PREFIX = "year_end";
const ACCRUAL_REVERSAL = "accrual_reversal";

/** `year_end:<purpose>:<fiscalYearId>[:<detail>]`, e.g. `year_end:deferred:<fy>:<accountId>`. */
export function yearEndSourceId(
  purpose: YearEndSourcePurpose,
  fiscalYearId: string,
  detail?: string,
): string {
  const base = `${SOURCE_PREFIX}:${purpose}:${fiscalYearId}`;
  return detail === undefined || detail === "" ? base : `${base}:${detail}`;
}

/** `year_end:accrual_reversal:<originalEntryId>`: the next year's reversal of an accrual. */
export function accrualReversalSourceId(originalEntryId: string): string {
  return `${SOURCE_PREFIX}:${ACCRUAL_REVERSAL}:${originalEntryId}`;
}

export type ParsedYearEndSourceId =
  | { purpose: YearEndSourcePurpose; fiscalYearId: string; detail: string | null }
  | { purpose: "accrual_reversal"; originalEntryId: string };

/** Reads a sourceId made by `yearEndSourceId` / `accrualReversalSourceId`; `null` for others. */
export function parseYearEndSourceId(
  sourceId: string | null | undefined,
): ParsedYearEndSourceId | null {
  if (typeof sourceId !== "string") return null;
  const [prefix, purpose, id, ...rest] = sourceId.split(":");
  if (prefix !== SOURCE_PREFIX || purpose === undefined || id === undefined || id === "") {
    return null;
  }
  if (purpose === ACCRUAL_REVERSAL) {
    return rest.length === 0 ? { purpose: ACCRUAL_REVERSAL, originalEntryId: id } : null;
  }
  if (!(YEAR_END_SOURCE_PURPOSES as readonly string[]).includes(purpose)) return null;
  const detail = rest.join(":");
  return {
    purpose: purpose as YearEndSourcePurpose,
    fiscalYearId: id,
    detail: detail === "" ? null : detail,
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function naLine(
  side: Side,
  accountId: string,
  amount: Money,
  segmentId: string | null = null,
  subAccountId: string | null = null,
): JournalLineInput {
  return {
    side,
    accountId,
    subAccountId,
    amount,
    taxCategoryCode: "na",
    taxAmount: 0n,
    segmentId,
  };
}

function requirePositive(amount: Money, field = "amount"): void {
  if (typeof amount !== "bigint" || amount <= 0n) {
    throw new LedgerValidationError([
      { code: "NON_POSITIVE_AMOUNT", message: "金額は 1 円以上にしてください", field },
    ]);
  }
}

// ---------------------------------------------------------------------------
// 減価償却・繰延資産 (§4.3, §6)
// ---------------------------------------------------------------------------

/**
 * 減価償却費 of one asset for one year (§4.3): 借方 減価償却費 (the asset's segment) / 貸方
 * 減価償却累計額 for 定額・定率 (間接法) or the asset's account for 即時・一括 (直接法).
 */
export function buildDepreciationEntry(input: {
  date: CalendarDate;
  assetId: string;
  assetName: string;
  amount: Money;
  expenseAccountId: string;
  /** 減価償却累計額 for 定額・定率, the asset's account for 即時・一括. */
  creditAccountId: string;
  segmentId: string;
}): JournalEntryInput {
  requirePositive(input.amount);
  return {
    entryDate: input.date,
    description: `減価償却費 ${input.assetName}`,
    kind: "adjusting",
    sourceKind: "fixed_asset",
    sourceId: input.assetId,
    lines: [
      naLine("debit", input.expenseAccountId, input.amount, input.segmentId),
      naLine("credit", input.creditAccountId, input.amount),
    ],
  };
}

/** 創立費・開業費の償却 (§6): 借方 創立費償却 / 開業費償却 / 貸方 創立費 / 開業費. */
export function buildDeferredAmortizationEntry(input: {
  date: CalendarDate;
  fiscalYearId: string;
  deferredAccountId: string;
  deferredAccountName: string;
  expenseAccountId: string;
  amount: Money;
  segmentId: string;
}): JournalEntryInput {
  requirePositive(input.amount);
  return {
    entryDate: input.date,
    description: `${input.deferredAccountName}の償却`,
    kind: "adjusting",
    sourceKind: "year_end",
    sourceId: yearEndSourceId("deferred", input.fiscalYearId, input.deferredAccountId),
    lines: [
      naLine("debit", input.expenseAccountId, input.amount, input.segmentId),
      naLine("credit", input.deferredAccountId, input.amount),
    ],
  };
}

// ---------------------------------------------------------------------------
// 前払・未払・前受・貯蔵品 (§7)
// ---------------------------------------------------------------------------

export const ACCRUAL_TYPES = [
  "prepaid_expense",
  "accrued_expense",
  "deferred_revenue",
  "supplies",
] as const;
export type AccrualType = (typeof ACCRUAL_TYPES)[number];

export const ACCRUAL_TYPE_LABELS: Readonly<Record<AccrualType, string>> = {
  prepaid_expense: "前払費用",
  accrued_expense: "未払費用",
  deferred_revenue: "前受金",
  supplies: "貯蔵品",
};

/** The side of the balance-sheet line (the P/L line takes the other side). */
export const ACCRUAL_BALANCE_SIDES: Readonly<Record<AccrualType, Side>> = {
  prepaid_expense: "debit",
  accrued_expense: "credit",
  deferred_revenue: "credit",
  supplies: "debit",
};

/** The balance-sheet account by code; 貯蔵品 is found by `SUPPLIES_ACCOUNT_NAME` instead. */
export const ACCRUAL_BALANCE_ACCOUNT_CODES: Readonly<Record<AccrualType, string | null>> = {
  prepaid_expense: PREPAID_EXPENSE_CODE,
  accrued_expense: ACCRUED_EXPENSE_CODE,
  deferred_revenue: DEFERRED_REVENUE_CODE,
  supplies: null,
};

/** The kind of account the P/L line may use (科目の候補). */
export const ACCRUAL_PL_ACCOUNT_KINDS: Readonly<Record<AccrualType, AccountKind>> = {
  prepaid_expense: "expense",
  accrued_expense: "expense",
  deferred_revenue: "revenue",
  supplies: "expense",
};

/** 決算整理仕訳 of an accrual (§7 table). The description defaults to the type's label. */
export function buildAccrualEntry(input: {
  date: CalendarDate;
  fiscalYearId: string;
  type: AccrualType;
  balanceAccountId: string;
  plAccountId: string;
  amount: Money;
  segmentId: string;
  description: string;
}): JournalEntryInput {
  requirePositive(input.amount);
  const balanceSide = ACCRUAL_BALANCE_SIDES[input.type];
  const plSide: Side = balanceSide === "debit" ? "credit" : "debit";
  const balanceLine = naLine(balanceSide, input.balanceAccountId, input.amount);
  const plLine = naLine(plSide, input.plAccountId, input.amount, input.segmentId);
  const description = input.description.trim();
  return {
    entryDate: input.date,
    description: description === "" ? ACCRUAL_TYPE_LABELS[input.type] : description,
    kind: "adjusting",
    sourceKind: "year_end",
    sourceId: yearEndSourceId("accrual", input.fiscalYearId),
    lines: balanceSide === "debit" ? [balanceLine, plLine] : [plLine, balanceLine],
  };
}

/** The next year's reversal of an accrual: the same lines with the sides swapped (§7). */
export function buildAccrualReversal(
  entry: JournalEntryInput,
  options: { date: CalendarDate; originalEntryId: string },
): JournalEntryInput {
  return {
    entryDate: options.date,
    description: `振り戻し: ${entry.description}`,
    kind: "adjusting",
    sourceKind: "year_end",
    sourceId: accrualReversalSourceId(options.originalEntryId),
    reversalOfId: null,
    lines: entry.lines.map((line) => ({
      ...line,
      side: line.side === "debit" ? "credit" : "debit",
    })),
  };
}

// ---------------------------------------------------------------------------
// 消費税 (§8)
// ---------------------------------------------------------------------------

/**
 * 消費税の精算 (§8). Tax-exclusive years clear 仮受消費税 and 仮払消費税, book `payable` to 未払消費税等
 * (a negative `payable`, a refund, to 未収入金) and the rounding difference to 雑収入 / 雑損失.
 * Tax-inclusive years book 租税公課 / 未払消費税等 (a refund: 未収入金 / 雑収入). `null` when there is
 * nothing to post.
 */
export function buildConsumptionTaxSettlement(input: {
  date: CalendarDate;
  fiscalYearId: string;
  accountingMethod: AccountingMethod;
  /** 仮受消費税 (2310) balance, credit positive. */
  outputTaxBalance: Money;
  /** 仮払消費税 (1400) balance, debit positive. */
  inputTaxBalance: Money;
  /** 納付税額 (negative for a refund). */
  payable: Money;
  accounts: {
    outputTax: string;
    inputTax: string;
    payable: string;
    receivable: string;
    miscIncome: string;
    miscLoss: string;
    taxesAndDues: string;
  };
  segmentId: string;
}): JournalEntryInput | null {
  const { accounts, payable, segmentId } = input;
  const lines: JournalLineInput[] = [];
  /** Clears a balance: `side` for a normal (positive) balance, the other side for a negative one. */
  const settle = (side: Side, accountId: string, amount: Money): void => {
    if (amount > 0n) lines.push(naLine(side, accountId, amount));
    else if (amount < 0n)
      lines.push(naLine(side === "debit" ? "credit" : "debit", accountId, -amount));
  };

  if (input.accountingMethod === "tax_exclusive") {
    settle("debit", accounts.outputTax, input.outputTaxBalance);
    settle("credit", accounts.inputTax, input.inputTaxBalance);
    if (payable > 0n) lines.push(naLine("credit", accounts.payable, payable));
    else if (payable < 0n) lines.push(naLine("debit", accounts.receivable, -payable));
    const difference = input.outputTaxBalance - input.inputTaxBalance - payable;
    if (difference > 0n) lines.push(naLine("credit", accounts.miscIncome, difference, segmentId));
    else if (difference < 0n) {
      lines.push(naLine("debit", accounts.miscLoss, -difference, segmentId));
    }
  } else if (payable > 0n) {
    lines.push(naLine("debit", accounts.taxesAndDues, payable, segmentId));
    lines.push(naLine("credit", accounts.payable, payable));
  } else if (payable < 0n) {
    lines.push(naLine("debit", accounts.receivable, -payable));
    lines.push(naLine("credit", accounts.miscIncome, -payable, segmentId));
  }

  if (lines.length === 0) return null;
  return {
    entryDate: input.date,
    description: "消費税の精算",
    kind: "adjusting",
    sourceKind: "year_end",
    sourceId: yearEndSourceId("consumption_tax", input.fiscalYearId),
    lines,
  };
}

// ---------------------------------------------------------------------------
// 法人税等 (§9)
// ---------------------------------------------------------------------------

/** 借方 法人税、住民税及び事業税 / 貸方 未払法人税等 (§9). */
export function buildCorporateTaxEntry(input: {
  date: CalendarDate;
  fiscalYearId: string;
  amount: Money;
  expenseAccountId: string;
  payableAccountId: string;
  segmentId: string;
}): JournalEntryInput {
  requirePositive(input.amount);
  return {
    entryDate: input.date,
    description: "法人税、住民税及び事業税",
    kind: "adjusting",
    sourceKind: "year_end",
    sourceId: yearEndSourceId("corporate_tax", input.fiscalYearId),
    lines: [
      naLine("debit", input.expenseAccountId, input.amount, input.segmentId),
      naLine("credit", input.payableAccountId, input.amount),
    ],
  };
}

// ---------------------------------------------------------------------------
// 除却・売却 (§5.3)
// ---------------------------------------------------------------------------

export interface DisposalEntryInput {
  date: CalendarDate;
  assetId: string;
  assetName: string;
  method: DepreciationMethod;
  cost: Money;
  /** The asset's depreciation posted so far (台帳の償却の実績). */
  accumulated: Money;
  /**
   * The balance of the asset's account. The disposal never credits more than this (a guard against
   * removing an asset whose acquisition entry was voided).
   */
  assetAccountBalance: Money;
  assetAccountId: string;
  accumulatedAccountId: string;
  /** 売却額 (tax-inclusive). 0 for 除却. */
  proceeds: Money;
  /** The account the proceeds are paid into (the wallet's account). Required when proceeds > 0. */
  proceedsCounterpart: { accountId: string; subAccountId: string | null } | null;
  /** `splitTaxInclusive(proceeds, "sales_10", …)`; `null` books the proceeds without tax. */
  proceedsSplit: { amount: Money; taxAmount: Money; taxLineAmount: Money } | null;
  /** 仮受消費税: required when `proceedsSplit.taxLineAmount` > 0 (tax-exclusive years). */
  outputTaxAccountId: string | null;
  miscIncomeAccountId: string;
  miscLossAccountId: string;
  segmentId: string;
  description: string;
}

/**
 * The disposal or sale of an asset (§5.3). The book value (cost − depreciation posted) is removed:
 * 定額・定率 take off 減価償却累計額 and the cost; 即時 has only what is left on the asset's account
 * (nothing once expensed); 一括 keeps the asset and goes on being depreciated (令133の2), so its book
 * value here is 0. The proceeds go to 雑収入 when they are at least the book value (a 売却益), to
 * 雑損失 otherwise, with the proceeds line `sales_10` and the book-value line `na` on the same
 * account; without proceeds the book value is a 除却損. `entry` is `null` when there are no lines.
 */
export function buildDisposalEntry(input: DisposalEntryInput): {
  entry: JournalEntryInput | null;
  bookValue: Money;
} {
  const { method, cost, accumulated, proceeds, segmentId } = input;
  if (cost <= 0n) throw new RangeError("buildDisposalEntry: the cost must be positive");
  if (accumulated < 0n || accumulated > cost) {
    throw new RangeError("buildDisposalEntry: the depreciation posted must be within the cost");
  }
  if (proceeds < 0n) throw new RangeError("buildDisposalEntry: the proceeds must not be negative");

  const indirect = method === "straight_line" || method === "declining_balance";
  const bookValue = method === "lump_sum_3y" ? 0n : cost - accumulated;
  const assetCredit = indirect ? cost : method === "immediate" ? bookValue : 0n;
  if (assetCredit > input.assetAccountBalance) {
    throw new RangeError(
      `buildDisposalEntry: the asset account holds ${formatYen(input.assetAccountBalance)}, less than ${formatYen(assetCredit)} to remove`,
    );
  }

  const debits: JournalLineInput[] = [];
  const credits: JournalLineInput[] = [];
  if (indirect && accumulated > 0n) {
    debits.push(naLine("debit", input.accumulatedAccountId, accumulated));
  }
  if (assetCredit > 0n) credits.push(naLine("credit", input.assetAccountId, assetCredit));

  if (proceeds > 0n) {
    const counterpart = input.proceedsCounterpart;
    if (!counterpart) throw new RangeError("buildDisposalEntry: proceeds need a counterpart");
    const split = input.proceedsSplit ?? { amount: proceeds, taxAmount: 0n, taxLineAmount: 0n };
    if (split.amount + split.taxLineAmount !== proceeds) {
      throw new RangeError("buildDisposalEntry: the tax split does not add up to the proceeds");
    }
    debits.push(
      naLine("debit", counterpart.accountId, proceeds, null, counterpart.subAccountId ?? null),
    );
    // 売却益 or 売却損 by the proceeds as booked (without the tax in tax-exclusive years).
    const gainOrLossAccountId =
      split.amount >= bookValue ? input.miscIncomeAccountId : input.miscLossAccountId;
    if (bookValue > 0n) debits.push(naLine("debit", gainOrLossAccountId, bookValue, segmentId));
    credits.push({
      ...naLine("credit", gainOrLossAccountId, split.amount, segmentId),
      taxCategoryCode: "sales_10",
      taxAmount: split.taxAmount,
    });
    if (split.taxLineAmount > 0n) {
      if (!input.outputTaxAccountId) {
        throw new RangeError("buildDisposalEntry: a tax line needs the output tax account");
      }
      credits.push(naLine("credit", input.outputTaxAccountId, split.taxLineAmount));
    }
  } else if (bookValue > 0n) {
    debits.push(naLine("debit", input.miscLossAccountId, bookValue, segmentId));
  }

  const lines = [...debits, ...credits];
  if (lines.length === 0) return { entry: null, bookValue };
  const description = input.description.trim();
  return {
    entry: {
      entryDate: input.date,
      description:
        description !== "" ? description : `${proceeds > 0n ? "売却" : "除却"} ${input.assetName}`,
      kind: "normal",
      sourceKind: "fixed_asset",
      sourceId: input.assetId,
      lines,
    },
    bookValue,
  };
}

// ---------------------------------------------------------------------------
// 決算振替 (§10)
// ---------------------------------------------------------------------------

export interface ClosingRow {
  accountId: string;
  /** `revenue`, `expense` or `internal`; other kinds are rejected. */
  kind: AccountKind;
  segmentId: string | null;
  /** debit − credit of the account in the segment over the year's entries. */
  net: Money;
}

const CLOSING_KINDS: ReadonlySet<AccountKind> = new Set(["revenue", "expense", "internal"]);

/**
 * 決算振替 (§10): a line bringing each revenue, expense and internal account × segment to 0, and the
 * difference on 繰越利益剰余金 (貸方 for a net income, 借方 for a net loss). `netIncome` is
 * −Σ net of the revenue and expense rows. `entry` is `null` when every row is 0.
 */
export function buildClosingEntry(input: {
  date: CalendarDate;
  fiscalYearId: string;
  fiscalYearNo: number;
  rows: readonly ClosingRow[];
  retainedEarningsAccountId: string;
}): { entry: JournalEntryInput | null; netIncome: Money } {
  const merged = new Map<string, ClosingRow>();
  for (const row of input.rows) {
    if (!CLOSING_KINDS.has(row.kind)) {
      throw new RangeError(`buildClosingEntry: ${row.kind} accounts are not closed`);
    }
    const key = `${row.accountId}\u0000${row.segmentId ?? ""}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, net: existing.net + row.net } : { ...row });
  }

  const lines: JournalLineInput[] = [];
  let netIncome = 0n;
  let internalNet = 0n;
  for (const row of merged.values()) {
    if (row.kind === "internal") internalNet += row.net;
    else netIncome -= row.net;
    if (row.net > 0n) lines.push(naLine("credit", row.accountId, row.net, row.segmentId));
    else if (row.net < 0n) lines.push(naLine("debit", row.accountId, -row.net, row.segmentId));
  }
  if (internalNet !== 0n) {
    throw new LedgerInvariantError(
      "INTERNAL_NONZERO",
      `internal accounts net to ${formatYen(internalNet)} instead of 0`,
    );
  }
  if (lines.length === 0) return { entry: null, netIncome };
  if (netIncome > 0n) lines.push(naLine("credit", input.retainedEarningsAccountId, netIncome));
  else if (netIncome < 0n) {
    lines.push(naLine("debit", input.retainedEarningsAccountId, -netIncome));
  }
  return {
    entry: {
      entryDate: input.date,
      description: `決算振替 第 ${input.fiscalYearNo} 期`,
      kind: "closing",
      sourceKind: "year_end",
      sourceId: yearEndSourceId("closing", input.fiscalYearId),
      lines,
    },
    netIncome,
  };
}
