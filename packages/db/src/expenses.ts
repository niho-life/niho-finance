/**
 * 立替精算 (23-users-and-expenses §5–§6): one claim = one receipt a user paid for the company.
 * Submitting posts the accrual (科目 / 未払金〔立替精算〕 on the day it was spent, built as 支出 is);
 * paying posts 未払金〔立替精算〕 / 口座 for one claimant's claims in one entry, optionally matched with
 * an unhandled withdrawal of the wallet. A claim is voided and a payment cancelled with a reversal
 * (`voidJournalEntryWithOpenDate`); nothing posted is ever rewritten and the rows are never deleted
 * (DB triggers). Locks: the claims (id order) → the payment → the statement line → the fiscal year.
 */
import {
  buildSimpleEntry,
  displayDate,
  formatYen,
  isLocked,
  isReservedAccount,
  LedgerValidationError,
  walletAccountIdsOf,
  type CalendarDate,
  type EntryStatus,
  type JournalEntryInput,
  type JournalLineInput,
  type LedgerError,
  type LedgerErrorCode,
  type Money,
  type SimpleEntryContext,
} from "@niho-finance/ledger";
import { Prisma, type ExpenseClaim, type ExpensePayment, type FiscalYear } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, toDbDate } from "./dates";
import { linkDocument, searchDocuments, type DocumentListRow } from "./documents";
import {
  loadEntryFormOptions,
  loadSimpleEntryContext,
  lockFiscalYearOn,
  voidJournalEntryWithOpenDate,
  type EntryFormAccount,
  type EntryFormOptions,
  type EntryFormWallet,
} from "./entries";
import { SettingsError } from "./errors";
import { newId } from "./ids";
import { postJournalEntryInTransaction, type ActorOptions } from "./journal";
import { toFiscalYearContext } from "./queries";
import {
  documentSearchSchema,
  expenseClaimSubmitSchema,
  expensePaymentSchema,
  expenseReasonSchema,
  type ExpenseClaimSubmitInput,
  type ExpensePaymentInput,
  type ExpenseReasonInput,
  type ParsedExpenseClaimSubmit,
} from "./schemas";
import { createSubAccount, setSubAccountActive } from "./settings";
import { lockSettings, runInTransaction, type Tx } from "./transaction";
import { userDisplayName } from "./users";

/** 未払金: the payable of a claim until it is paid (23 §5.1). */
export const EXPENSE_PAYABLE_ACCOUNT_CODE = "2100";
/** The one sub-account of 未払金 for every claimant (人ごとの残高は立替精算の画面で見る). */
export const EXPENSE_SUB_ACCOUNT_NAME = "立替精算";
/** 支払済み: the latest payments shown (23 §6), older ones behind 「さらに表示」. */
export const EXPENSE_PAYMENTS_LIMIT = 20;

const CANDIDATE_LIMIT = 20;
const INBOX_LIMIT = 50;
const CLAIM_NOT_FOUND = "立替精算が見つかりません。画面を読み込み直してください";
const PAYMENT_NOT_FOUND = "支払が見つかりません。画面を読み込み直してください";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type ExpenseClaimStatus = ExpenseClaim["status"];

export const EXPENSE_CLAIM_STATUS_LABELS: Readonly<Record<ExpenseClaimStatus, string>> = {
  submitted: "未払",
  paid: "支払済み",
  void: "取消済み",
};

/** An entry as a link target (「仕訳 #12」). */
export interface ExpenseEntryRef {
  id: string;
  no: number;
  status: EntryStatus;
}

export interface ExpenseClaimRecord {
  id: string;
  claimantId: string;
  spentOn: CalendarDate;
  amount: Money;
  accountId: string;
  taxCategoryCode: string;
  segmentId: string | null;
  partnerId: string | null;
  description: string;
  documentId: string | null;
  status: ExpenseClaimStatus;
  journalEntryId: string;
  paymentId: string | null;
  voidReason: string | null;
  voidedAt: Date | null;
  reversalEntryId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpensePaymentRecord {
  id: string;
  claimantId: string;
  paidOn: CalendarDate;
  walletId: string;
  walletTransactionId: string | null;
  amount: Money;
  journalEntryId: string;
  cancelledAt: Date | null;
  cancelReason: string | null;
  reversalEntryId: string | null;
  createdBy: string;
  createdAt: Date;
}

function toClaimRecord(row: ExpenseClaim): ExpenseClaimRecord {
  return {
    id: row.id,
    claimantId: row.claimantId,
    spentOn: fromDbDate(row.spentOn),
    amount: row.amount,
    accountId: row.accountId,
    taxCategoryCode: row.taxCategoryCode,
    segmentId: row.segmentId,
    partnerId: row.partnerId,
    description: row.description,
    documentId: row.documentId,
    status: row.status,
    journalEntryId: row.journalEntryId,
    paymentId: row.paymentId,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    reversalEntryId: row.reversalEntryId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPaymentRecord(row: ExpensePayment): ExpensePaymentRecord {
  return {
    id: row.id,
    claimantId: row.claimantId,
    paidOn: fromDbDate(row.paidOn),
    walletId: row.walletId,
    walletTransactionId: row.walletTransactionId,
    amount: row.amount,
    journalEntryId: row.journalEntryId,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    reversalEntryId: row.reversalEntryId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/** 立替えた人 as the screens name them. */
export interface ExpenseClaimant {
  id: string;
  email: string;
  name: string | null;
  /** The name, or the email without one. */
  displayName: string;
  isActive: boolean;
}

function toClaimant(row: {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
}): ExpenseClaimant {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    displayName: userDisplayName(row),
    isActive: row.isActive,
  };
}

function sum(amounts: Iterable<Money>): Money {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return total;
}

// ---------------------------------------------------------------------------
// Locks and shared checks
// ---------------------------------------------------------------------------

/** Locks the claims in id order (concurrent payments cannot deadlock), then reads them. */
async function lockClaims(tx: Tx, ids: readonly string[]): Promise<ExpenseClaim[]> {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length === 0) return [];
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "expense_claim" WHERE "id" IN (${Prisma.join(sorted)})
    ORDER BY "id" FOR UPDATE`;
  if (locked.length !== sorted.length) {
    throw new SettingsError(CLAIM_NOT_FOUND, { field: "claimIds" });
  }
  return tx.expenseClaim.findMany({ where: { id: { in: sorted } }, orderBy: { id: "asc" } });
}

async function lockClaim(tx: Tx, id: string): Promise<ExpenseClaim> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "expense_claim" WHERE "id" = ${id} FOR UPDATE`;
  if (locked.length === 0) throw new SettingsError(CLAIM_NOT_FOUND);
  return tx.expenseClaim.findUniqueOrThrow({ where: { id } });
}

async function lockPayment(tx: Tx, id: string): Promise<ExpensePayment> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "expense_payment" WHERE "id" = ${id} FOR UPDATE`;
  if (locked.length === 0) throw new SettingsError(PAYMENT_NOT_FOUND);
  return tx.expensePayment.findUniqueOrThrow({ where: { id } });
}

/** Locks a statement line (`wallet_transaction`) and reads it; `null` when there is none. */
async function lockWalletTransaction(tx: Tx, id: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "wallet_transaction" WHERE "id" = ${id} FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.walletTransaction.findUnique({ where: { id } });
}

/** The reversal of an entry that was already voided elsewhere (e.g. on the transaction screen). */
async function existingReversal(
  tx: Tx,
  entryId: string,
): Promise<{ voided: boolean; reversalId: string | null }> {
  const entry = await tx.journalEntry.findUnique({
    where: { id: entryId },
    select: { status: true, reversal: { select: { id: true } } },
  });
  return { voided: entry?.status === "voided", reversalId: entry?.reversal?.id ?? null };
}

/** Voids `entryId` unless the transaction screen did already; the reversal, when there is one. */
async function reverseUnlessVoided(
  tx: Tx,
  entryId: string,
  reason: string,
  options: ActorOptions,
): Promise<string | null> {
  const existing = await existingReversal(tx, entryId);
  if (existing.voided) return existing.reversalId;
  const { reversal } = await voidJournalEntryWithOpenDate(tx, entryId, { reason }, options);
  return reversal.id;
}

async function entryRef(tx: Tx, id: string | null): Promise<ExpenseEntryRef | null> {
  if (!id) return null;
  return tx.journalEntry.findUnique({
    where: { id },
    select: { id: true, no: true, status: true },
  });
}

async function requirePayableAccount(db: Db): Promise<{ id: string }> {
  const account = await db.account.findUnique({
    where: { code: EXPENSE_PAYABLE_ACCOUNT_CODE },
    select: { id: true },
  });
  if (!account) {
    throw new SettingsError(
      `勘定科目 ${EXPENSE_PAYABLE_ACCOUNT_CODE}（未払金）がありません。設定 › 勘定科目 で足してください`,
    );
  }
  return account;
}

/**
 * 未払金〔立替精算〕 (23 §5.1): made on the first submission, or turned back on when inactive, with
 * `sub_account.create` / `.activate` (as 給与 makes 〔給与〕). The `expenses` lock serializes the first
 * submissions; once it exists and is active no lock is taken.
 */
async function ensureExpenseSubAccount(
  tx: Tx,
  accountId: string,
  options: ActorOptions,
): Promise<string> {
  const find = () =>
    tx.subAccount.findUnique({
      where: { accountId_name: { accountId, name: EXPENSE_SUB_ACCOUNT_NAME } },
      select: { id: true, isActive: true },
    });
  const existing = await find();
  if (existing?.isActive) return existing.id;
  await lockSettings(tx, "expenses");
  const current = await find();
  if (!current) {
    const created = await createSubAccount(
      tx,
      { accountId, name: EXPENSE_SUB_ACCOUNT_NAME },
      options,
    );
    return created.id;
  }
  if (!current.isActive) {
    await setSubAccountActive(tx, { id: current.id, isActive: true }, options);
  }
  return current.id;
}

const DATE_CODES: ReadonlySet<LedgerErrorCode> = new Set([
  "INVALID_DATE",
  "OUT_OF_FISCAL_YEAR",
  "PERIOD_LOCKED",
  "FISCAL_YEAR_CLOSED",
  "FISCAL_YEAR_CLOSING",
]);

/** The input of the accrual's main line each line-level error is about. */
const MAIN_LINE_FIELDS: Partial<Record<LedgerErrorCode, string>> = {
  INVALID_AMOUNT: "amount",
  NON_POSITIVE_AMOUNT: "amount",
  INVALID_TAX_AMOUNT: "taxCategoryCode",
  TAX_AMOUNT_NOT_ALLOWED: "taxCategoryCode",
  TAX_CATEGORY_REQUIRED: "taxCategoryCode",
  UNKNOWN_TAX_CATEGORY: "taxCategoryCode",
  TAX_RULE_MISSING: "taxCategoryCode",
  UNKNOWN_ACCOUNT: "accountId",
  ACCOUNT_INACTIVE: "accountId",
  UNKNOWN_SUB_ACCOUNT: "accountId",
  SUB_ACCOUNT_MISMATCH: "accountId",
  SEGMENT_REQUIRED: "segmentId",
};

const PAYMENT_WALLET_CODES: ReadonlySet<LedgerErrorCode> = new Set([
  "UNKNOWN_ACCOUNT",
  "ACCOUNT_INACTIVE",
  "UNKNOWN_SUB_ACCOUNT",
  "SUB_ACCOUNT_MISMATCH",
]);

/** 「2 行目（4010）の」「1 行目の」: the ledger's way of naming a line, meaningless on these forms. */
const LINE_PREFIX = /^\d+ 行目(?:（[^）]*）)?の/;

/**
 * Re-throws the ledger's errors with the form field each belongs to; an error of a part the form
 * does not show (未払金, a tax line) loses its field and stays on the form.
 */
function withFormFields(
  error: LedgerValidationError,
  fieldOf: (item: LedgerError) => string | undefined,
): LedgerValidationError {
  return new LedgerValidationError(
    error.errors.map((item) => {
      const { field: original, ...rest } = item;
      const field = fieldOf(item);
      if (!field) return rest;
      const message = original === undefined ? item.message.replace(LINE_PREFIX, "") : item.message;
      return { ...rest, field, message };
    }),
  );
}

function claimField(error: LedgerError): string | undefined {
  if (DATE_CODES.has(error.code) || error.field === "entryDate") return "spentOn";
  if (error.field === "counterpart") return undefined;
  if (error.field) return error.field;
  if (error.code === "DESCRIPTION_REQUIRED") return "description";
  return error.lineIndex === 0 ? MAIN_LINE_FIELDS[error.code] : undefined;
}

function paymentField(lineCount: number) {
  return (error: LedgerError): string | undefined => {
    if (DATE_CODES.has(error.code) || error.field === "entryDate") return "paidOn";
    if (error.field) return error.field;
    if (error.lineIndex === lineCount - 1 && PAYMENT_WALLET_CODES.has(error.code))
      return "walletId";
    return undefined;
  };
}

/** The fiscal year containing the date, locked; its errors name `field`. */
async function lockFiscalYearFor(tx: Tx, date: CalendarDate, field: string): Promise<FiscalYear> {
  try {
    return await lockFiscalYearOn(tx, date);
  } catch (error) {
    if (error instanceof LedgerValidationError) throw withFormFields(error, () => field);
    throw error;
  }
}

/**
 * 締め (23 §5.2): a date in a closed month is refused before anything is built, with the way back
 * (「利用日を開いている日にするか、管理者に締めを戻してもらってください」).
 */
function assertOpenDate(
  fiscalYear: FiscalYear,
  date: CalendarDate,
  field: string,
  label: string,
): void {
  const period = toFiscalYearContext(fiscalYear);
  if (!period.lockedThrough || !isLocked(date, period)) return;
  throw new LedgerValidationError([
    {
      code: "PERIOD_LOCKED",
      message: `${displayDate(period.lockedThrough)} までは締めています。${label}を開いている日にするか、管理者に締めを戻してもらってください`,
      field,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Reads: the screen /expenses (23 §6)
// ---------------------------------------------------------------------------

export interface ExpenseClaimRow {
  id: string;
  claimant: ExpenseClaimant;
  spentOn: CalendarDate;
  description: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  amount: Money;
  taxCategoryCode: string;
  segmentId: string | null;
  partnerId: string | null;
  partnerName: string | null;
  /** The document chosen on submission. */
  documentId: string | null;
  /** 証憑: the accrual entry has a linked document (the one of the submission or a later one). */
  hasDocument: boolean;
  status: ExpenseClaimStatus;
  /** 計上の仕訳; `voided` when it was voided on the transaction screen (the claim cannot be paid). */
  entry: ExpenseEntryRef;
  voidReason: string | null;
  voidedAt: Date | null;
  reversalEntry: ExpenseEntryRef | null;
}

export interface ExpenseClaimantGroup {
  claimant: ExpenseClaimant;
  count: number;
  total: Money;
  claims: ExpenseClaimRow[];
}

export interface ExpensePaymentRow {
  id: string;
  paidOn: CalendarDate;
  claimant: ExpenseClaimant;
  /** The claims paid (the debit lines of the payment entry; kept after a cancellation). */
  count: number;
  total: Money;
  walletId: string;
  walletName: string;
  walletTransactionId: string | null;
  /** 支払の仕訳. */
  entry: ExpenseEntryRef;
  cancelled: boolean;
  cancelledAt: Date | null;
  cancelReason: string | null;
  reversalEntry: ExpenseEntryRef | null;
}

export interface ExpenseOverview {
  /** 未払, per claimant (by name), the claims by 利用日. */
  unpaid: { count: number; total: Money; groups: ExpenseClaimantGroup[] };
  /** 支払済み, newest first (cancelled ones too, marked). */
  payments: { rows: ExpensePaymentRow[]; total: number; hasMore: boolean };
  /** 取消済み, newest first. */
  voided: ExpenseClaimRow[];
}

const claimantSelect = { id: true, email: true, name: true, isActive: true } as const;
const entryRefSelect = { id: true, no: true, status: true } as const;

const claimRowInclude = {
  claimant: { select: claimantSelect },
  account: { select: { code: true, name: true } },
  partner: { select: { name: true } },
  journalEntry: { select: { ...entryRefSelect, _count: { select: { documentLinks: true } } } },
  reversalEntry: { select: entryRefSelect },
} as const satisfies Prisma.ExpenseClaimInclude;

type ClaimRowData = Prisma.ExpenseClaimGetPayload<{ include: typeof claimRowInclude }>;

function toClaimRow(row: ClaimRowData): ExpenseClaimRow {
  const { _count, ...entry } = row.journalEntry;
  return {
    id: row.id,
    claimant: toClaimant(row.claimant),
    spentOn: fromDbDate(row.spentOn),
    description: row.description,
    accountId: row.accountId,
    accountCode: row.account.code,
    accountName: row.account.name,
    amount: row.amount,
    taxCategoryCode: row.taxCategoryCode,
    segmentId: row.segmentId,
    partnerId: row.partnerId,
    partnerName: row.partner?.name ?? null,
    documentId: row.documentId,
    hasDocument: row.documentId !== null || _count.documentLinks > 0,
    status: row.status,
    entry,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    reversalEntry: row.reversalEntry,
  };
}

/**
 * The screen of 23 §6: 未払 per claimant, the latest `paymentsLimit` (20) payments and the voided
 * claims. Read only.
 */
export async function loadExpenseOverview(
  db: Db,
  options: { paymentsLimit?: number } = {},
): Promise<ExpenseOverview> {
  const paymentsLimit = Math.max(1, Math.trunc(options.paymentsLimit ?? EXPENSE_PAYMENTS_LIMIT));
  const unpaidRows = await db.expenseClaim.findMany({
    where: { status: "submitted" },
    orderBy: [{ spentOn: "asc" }, { id: "asc" }],
    include: claimRowInclude,
  });
  const groups = new Map<string, ExpenseClaimantGroup>();
  for (const row of unpaidRows.map(toClaimRow)) {
    const group = groups.get(row.claimant.id) ?? {
      claimant: row.claimant,
      count: 0,
      total: 0n,
      claims: [],
    };
    group.count += 1;
    group.total += row.amount;
    group.claims.push(row);
    groups.set(row.claimant.id, group);
  }
  const sortedGroups = [...groups.values()].sort((a, b) =>
    a.claimant.displayName.localeCompare(b.claimant.displayName, "ja"),
  );

  const paymentTotal = await db.expensePayment.count();
  const payments = await db.expensePayment.findMany({
    orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: paymentsLimit,
    include: {
      claimant: { select: claimantSelect },
      wallet: { select: { name: true } },
      journalEntry: {
        select: { ...entryRefSelect, _count: { select: { lines: { where: { side: "debit" } } } } },
      },
      reversalEntry: { select: entryRefSelect },
    },
  });

  const voided = await db.expenseClaim.findMany({
    where: { status: "void" },
    orderBy: [{ voidedAt: "desc" }, { id: "desc" }],
    include: claimRowInclude,
  });

  return {
    unpaid: {
      count: unpaidRows.length,
      total: sum(unpaidRows.map((row) => row.amount)),
      groups: sortedGroups,
    },
    payments: {
      rows: payments.map((row) => {
        const { _count, ...entry } = row.journalEntry;
        return {
          id: row.id,
          paidOn: fromDbDate(row.paidOn),
          claimant: toClaimant(row.claimant),
          count: _count.lines,
          total: row.amount,
          walletId: row.walletId,
          walletName: row.wallet.name,
          walletTransactionId: row.walletTransactionId,
          entry,
          cancelled: row.cancelledAt !== null,
          cancelledAt: row.cancelledAt,
          cancelReason: row.cancelReason,
          reversalEntry: row.reversalEntry,
        };
      }),
      total: paymentTotal,
      hasMore: paymentTotal > payments.length,
    },
    voided: voided.map(toClaimRow),
  };
}

export interface ExpenseFormOptions {
  /** 立替えた人: the active users (the screen defaults to the actor). */
  claimants: ExpenseClaimant[];
  /**
   * The choices of the 支出 form (accounts, tax categories, segments, partners, wallets, fiscal
   * years, tax rules), for the same parts as 取引 (11 §4.2).
   */
  entry: EntryFormOptions;
  /** 科目: what 支出 offers (expenses, then non-cash assets, then liabilities; reserved ones out). */
  expenseAccounts: EntryFormAccount[];
  /** 受信箱から選ぶ: the inbox, newest first (50). */
  inboxDocuments: DocumentListRow[];
  /** 支払元: the active bank and cash wallets. */
  payFromWallets: EntryFormWallet[];
}

/** The choices of `/expenses/new` and of the payment dialog (23 §6). Read only. */
export async function loadExpenseFormOptions(db: Db): Promise<ExpenseFormOptions> {
  const users = await db.user.findMany({ where: { isActive: true }, select: claimantSelect });
  const entry = await loadEntryFormOptions(db);
  const walletAccountIds = walletAccountIdsOf(entry.wallets);
  const usable = entry.accounts.filter(
    (account) => account.isActive && !isReservedAccount(account, walletAccountIds),
  );
  const { rows: inboxDocuments } = await searchDocuments(
    db,
    documentSearchSchema.parse({ tab: "inbox" }),
    { pageSize: INBOX_LIMIT },
  );
  return {
    claimants: users
      .map(toClaimant)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "ja")),
    entry,
    expenseAccounts: [
      ...usable.filter((account) => account.kind === "expense"),
      ...usable.filter((account) => account.kind === "asset"),
      ...usable.filter((account) => account.kind === "liability"),
    ],
    inboxDocuments,
    payFromWallets: entry.wallets.filter(
      (wallet) => wallet.isActive && (wallet.kind === "bank" || wallet.kind === "cash"),
    ),
  };
}

export interface ExpensePaymentCandidate {
  id: string;
  txnDate: CalendarDate;
  description: string;
  counterparty: string | null;
  /** Negative: a withdrawal of −amount. */
  amount: Money;
}

/**
 * 明細から選ぶ (23 §5.2): unhandled (`pending`) withdrawals of the wallet of exactly −`amount`,
 * dated on or after `notBefore` (the latest 利用日) when given, newest first (20).
 */
export async function loadExpensePaymentCandidates(
  db: Db,
  input: { walletId: string; amount: Money; notBefore?: CalendarDate | null },
): Promise<ExpensePaymentCandidate[]> {
  if (input.amount <= 0n) return [];
  const rows = await db.walletTransaction.findMany({
    where: {
      walletId: input.walletId,
      status: "pending",
      amount: -input.amount,
      ...(input.notBefore ? { txnDate: { gte: toDbDate(input.notBefore) } } : {}),
    },
    orderBy: [{ txnDate: "desc" }, { id: "desc" }],
    take: CANDIDATE_LIMIT,
  });
  return rows.map((row) => ({
    id: row.id,
    txnDate: fromDbDate(row.txnDate),
    description: row.descriptionRaw,
    counterparty: row.counterpartyRaw,
    amount: row.amount,
  }));
}

// ---------------------------------------------------------------------------
// Writes: 提出 (23 §5.2)
// ---------------------------------------------------------------------------

/**
 * The accrual entry: 支出 (`buildSimpleEntry`, 支払元 = the account 未払金) with 〔立替精算〕 on the
 * credit line. 未払金 is also the account of the card wallets, which 支出 keeps for them: here it is
 * the counterpart on purpose, so those wallets are left out of the build, and the chosen account is
 * checked against every wallet first (the same accounts as 支出). The partner is the shop's: it
 * stays on the expense line, not on the payable (owed to the claimant, not the shop).
 */
function buildAccrualEntry(
  data: ParsedExpenseClaimSubmit,
  refs: {
    claimId: string;
    claimantName: string;
    payableAccountId: string;
    subAccountId: string;
    context: SimpleEntryContext;
  },
): JournalEntryInput {
  const { context, payableAccountId } = refs;
  const problems: LedgerError[] = [];
  const account = context.accounts.get(data.accountId);
  const reserved =
    account !== undefined &&
    isReservedAccount(account, walletAccountIdsOf(context.wallets.values()));
  if (account && reserved) {
    problems.push({
      code: "ACCOUNT_NOT_ALLOWED",
      message: `勘定科目「${account.code} ${account.name}」はここでは選べません。一覧から選んでください`,
      field: "accountId",
    });
  }
  const wallets = new Map(
    [...context.wallets].filter(([, wallet]) => wallet.accountId !== payableAccountId),
  );
  const description = `立替精算 ${refs.claimantName} ${data.description}`;
  let built: JournalEntryInput | undefined;
  try {
    built = buildSimpleEntry(
      {
        type: "expense",
        entryDate: data.spentOn,
        description,
        counterpart: { kind: "account", accountId: payableAccountId },
        accountId: data.accountId,
        amount: data.amount,
        taxCategoryCode: data.taxCategoryCode,
        segmentId: data.segmentId,
        partnerId: data.partnerId,
      },
      { ...context, wallets },
    );
  } catch (error) {
    if (!(error instanceof LedgerValidationError)) throw error;
    problems.push(...error.errors.filter((item) => !(reserved && item.field === "accountId")));
  }
  if (problems.length > 0 || !built) throw new LedgerValidationError(problems);
  // The 支払元 line: 未払金 on the credit side (the chosen account is on the debit side).
  const isPayable = (line: (typeof built.lines)[number]) =>
    line.side === "credit" && line.accountId === payableAccountId;
  return {
    ...built,
    sourceKind: "expense",
    sourceId: refs.claimId,
    lines: built.lines.map((line) =>
      isPayable(line) ? { ...line, subAccountId: refs.subAccountId, partnerId: null } : line,
    ),
  };
}

export interface SubmitExpenseClaimResult {
  claim: ExpenseClaimRecord;
  /** 計上の仕訳 (「立替精算を提出しました（仕訳 #n）」). */
  entry: { id: string; no: number };
}

/**
 * 提出 (23 §5.2): in one transaction the claimant is checked (an active user), 未払金〔立替精算〕 is
 * made when missing, the accrual is posted on 利用日 (`sourceKind = expense`, `sourceId` = the claim),
 * the claim is saved, the chosen document is linked to the accrual entry, and `expense_claim.submit`
 * is written. The ledger's errors name the form field.
 */
export async function submitExpenseClaim(
  db: Db,
  input: ExpenseClaimSubmitInput,
  options: ActorOptions,
): Promise<SubmitExpenseClaimResult> {
  const data = expenseClaimSubmitSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const claimant = await tx.user.findUnique({ where: { id: data.claimantId } });
    if (!claimant?.isActive) {
      throw new SettingsError("立替えた人は有効な利用者から選んでください", {
        field: "claimantId",
      });
    }
    if (data.documentId) {
      const document = await tx.document.findUnique({
        where: { id: data.documentId },
        select: { status: true },
      });
      if (!document) {
        throw new SettingsError("証憑が見つかりません。画面を読み込み直してください", {
          field: "documentId",
        });
      }
      if (document.status === "voided") {
        throw new SettingsError("無効にした証憑は紐づけられません。有効な証憑を選んでください", {
          field: "documentId",
        });
      }
    }
    const payable = await requirePayableAccount(tx);
    const subAccountId = await ensureExpenseSubAccount(tx, payable.id, options);

    const claimId = newId();
    let posted: { id: string; no: number };
    try {
      const fiscalYear = await lockFiscalYearFor(tx, data.spentOn, "spentOn");
      assertOpenDate(fiscalYear, data.spentOn, "spentOn", "利用日");
      const entry = buildAccrualEntry(data, {
        claimId,
        claimantName: userDisplayName(claimant),
        payableAccountId: payable.id,
        subAccountId,
        context: await loadSimpleEntryContext(tx, fiscalYear),
      });
      posted = await postJournalEntryInTransaction(
        tx,
        { ...entry, fiscalYearId: fiscalYear.id },
        options,
      );
    } catch (error) {
      if (error instanceof LedgerValidationError) throw withFormFields(error, claimField);
      throw error;
    }

    const row = await tx.expenseClaim.create({
      data: {
        id: claimId,
        claimantId: claimant.id,
        spentOn: toDbDate(data.spentOn),
        amount: data.amount,
        accountId: data.accountId,
        taxCategoryCode: data.taxCategoryCode,
        segmentId: data.segmentId,
        partnerId: data.partnerId,
        description: data.description,
        documentId: data.documentId,
        status: "submitted",
        journalEntryId: posted.id,
        createdBy: options.actor,
      },
    });
    if (data.documentId) {
      await linkDocument(
        tx,
        { kind: "journal_entry", id: posted.id, documentId: data.documentId },
        options,
      );
    }
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "expense_claim.submit",
      entity: "expense_claim",
      entityId: row.id,
      after: row,
    });
    return { claim: toClaimRecord(row), entry: { id: posted.id, no: posted.no } };
  });
}

// ---------------------------------------------------------------------------
// Writes: 支払う / 支払の取消 (23 §5.2)
// ---------------------------------------------------------------------------

function voidedAccrualMessage(no: number): string {
  return `計上の仕訳 #${no} は取消済みです。この立替精算を取り消して出し直してください`;
}

/** 借方 未払金〔立替精算〕 one line per claim / 貸方 the wallet's account (and sub-account), 税区分 na. */
function buildPaymentEntry(input: {
  paymentId: string;
  paidOn: CalendarDate;
  claimantName: string;
  claims: readonly ExpenseClaim[];
  payableAccountId: string;
  subAccountId: string;
  wallet: { accountId: string; subAccountId: string | null; defaultSegmentId: string | null };
}): JournalEntryInput {
  const lines: JournalLineInput[] = input.claims.map((claim) => ({
    side: "debit",
    accountId: input.payableAccountId,
    subAccountId: input.subAccountId,
    amount: claim.amount,
    taxCategoryCode: "na",
    taxAmount: 0n,
    segmentId: null,
    partnerId: null,
    description: `${displayDate(fromDbDate(claim.spentOn))} ${claim.description}`,
  }));
  lines.push({
    side: "credit",
    accountId: input.wallet.accountId,
    subAccountId: input.wallet.subAccountId,
    amount: sum(input.claims.map((claim) => claim.amount)),
    taxCategoryCode: "na",
    taxAmount: 0n,
    segmentId: input.wallet.defaultSegmentId,
    partnerId: null,
    description: null,
  });
  return {
    entryDate: input.paidOn,
    description: `立替精算の支払 ${input.claimantName}（${input.claims.length} 件）`,
    kind: "normal",
    sourceKind: "expense",
    sourceId: input.paymentId,
    lines,
  };
}

export interface PayExpenseClaimsResult {
  payment: ExpensePaymentRecord;
  /** 支払の仕訳 (「<名前> に 12,340 円を支払いました（仕訳 #n）」). */
  entry: { id: string; no: number };
}

/**
 * 支払う (23 §5.2): one claimant's unpaid claims in one entry on the payment date, from an active
 * bank or cash wallet. A statement line (`walletTransactionId`: `pending`, a withdrawal of the wallet
 * of exactly the total) gives the date and becomes `registered` with the entry. A claim whose accrual
 * entry was voided on the transaction screen is refused. Each claim gets `expense_claim.pay`.
 */
export async function payExpenseClaims(
  db: Db,
  input: ExpensePaymentInput,
  options: ActorOptions,
): Promise<PayExpenseClaimsResult> {
  const data = expensePaymentSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const claims = await lockClaims(tx, data.claimIds);
    const field = "claimIds";
    if (claims.some((claim) => claim.claimantId !== data.claimantId)) {
      throw new SettingsError(
        "ほかの人の立替精算が含まれています。立替えた人ごとに支払ってください",
        { field },
      );
    }
    if (claims.some((claim) => claim.status === "paid")) {
      throw new SettingsError("支払済みの立替精算が含まれています。画面を読み込み直してください", {
        field,
      });
    }
    if (claims.some((claim) => claim.status === "void")) {
      throw new SettingsError("取消済みの立替精算が含まれています。画面を読み込み直してください", {
        field,
      });
    }
    const accruals = await tx.journalEntry.findMany({
      where: { id: { in: claims.map((claim) => claim.journalEntryId) } },
      select: { no: true, status: true },
      orderBy: { no: "asc" },
    });
    const voidedAccrual = accruals.find((entry) => entry.status === "voided");
    if (voidedAccrual) throw new SettingsError(voidedAccrualMessage(voidedAccrual.no), { field });
    const claimant = await tx.user.findUniqueOrThrow({ where: { id: data.claimantId } });
    const total = sum(claims.map((claim) => claim.amount));

    const wallet = await tx.wallet.findUnique({ where: { id: data.walletId } });
    if (!wallet?.isActive || (wallet.kind !== "bank" && wallet.kind !== "cash")) {
      throw new SettingsError("支払元は有効な銀行か現金の口座を選んでください", {
        field: "walletId",
      });
    }

    let paidOn = data.paidOn;
    let statementLineId: string | null = null;
    if (data.walletTransactionId) {
      const lineField = "walletTransactionId";
      const line = await lockWalletTransaction(tx, data.walletTransactionId);
      if (!line) {
        throw new SettingsError("明細が見つかりません。画面を読み込み直してください", {
          field: lineField,
        });
      }
      if (line.status !== "pending") {
        throw new SettingsError(
          "この明細は処理済みです。別の明細を選ぶか、明細なしで支払ってください",
          { field: lineField },
        );
      }
      if (line.amount >= 0n) {
        throw new SettingsError("この明細は入金です。出金の明細を選んでください", {
          field: lineField,
        });
      }
      if (line.walletId !== wallet.id) {
        throw new SettingsError("口座が明細の口座と違います。明細の口座を選んでください", {
          field: "walletId",
        });
      }
      if (-line.amount !== total) {
        throw new SettingsError(
          `明細の金額 ${formatYen(-line.amount)} 円が支払の合計 ${formatYen(total)} 円と違います。合計が同じ明細を選んでください`,
          { field: lineField },
        );
      }
      paidOn = fromDbDate(line.txnDate);
      statementLineId = line.id;
    }

    const latestSpentOn = claims
      .map((claim) => fromDbDate(claim.spentOn))
      .reduce((latest, date) => (date > latest ? date : latest));
    if (paidOn < latestSpentOn) {
      throw new SettingsError(`支払日は利用日（${displayDate(latestSpentOn)}）以後にしてください`, {
        field: statementLineId ? "walletTransactionId" : "paidOn",
      });
    }

    const payable = await requirePayableAccount(tx);
    const subAccountId = await ensureExpenseSubAccount(tx, payable.id, options);
    const paymentId = newId();
    let posted: { id: string; no: number };
    try {
      const fiscalYear = await lockFiscalYearFor(tx, paidOn, "paidOn");
      assertOpenDate(fiscalYear, paidOn, "paidOn", "支払日");
      const entry = buildPaymentEntry({
        paymentId,
        paidOn,
        claimantName: userDisplayName(claimant),
        claims,
        payableAccountId: payable.id,
        subAccountId,
        wallet,
      });
      posted = await postJournalEntryInTransaction(
        tx,
        { ...entry, fiscalYearId: fiscalYear.id },
        options,
      );
    } catch (error) {
      if (error instanceof LedgerValidationError) {
        throw withFormFields(error, paymentField(claims.length + 1));
      }
      throw error;
    }

    if (statementLineId) {
      await tx.walletTransaction.update({
        where: { id: statementLineId },
        data: { status: "registered", journalEntryId: posted.id, settledAt: new Date() },
      });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "wallet_transaction.register",
        entity: "wallet_transaction",
        entityId: statementLineId,
        before: { status: "pending", journalEntryId: null },
        after: { status: "registered", journalEntryId: posted.id },
      });
    }

    const payment = await tx.expensePayment.create({
      data: {
        id: paymentId,
        claimantId: claimant.id,
        paidOn: toDbDate(paidOn),
        walletId: wallet.id,
        walletTransactionId: statementLineId,
        amount: total,
        journalEntryId: posted.id,
        createdBy: options.actor,
      },
    });
    await tx.expenseClaim.updateMany({
      where: { id: { in: claims.map((claim) => claim.id) } },
      data: { status: "paid", paymentId },
    });
    for (const claim of claims) {
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "expense_claim.pay",
        entity: "expense_claim",
        entityId: claim.id,
        before: { status: claim.status, paymentId: claim.paymentId },
        after: { status: "paid", paymentId },
      });
    }
    return { payment: toPaymentRecord(payment), entry: { id: posted.id, no: posted.no } };
  });
}

export interface CancelExpensePaymentResult {
  payment: ExpensePaymentRecord;
  /** The reversal of the payment entry (`null` only if the entry had none). */
  reversal: ExpenseEntryRef | null;
}

/**
 * 支払の取消 (23 §5.2): the payment entry is reversed (`voidJournalEntryWithOpenDate`: on the first
 * open day when its month is closed; skipped when the transaction screen voided it already), the
 * payment keeps its row with the cancellation, its claims go back to 未払, and a matched statement
 * line goes back to `pending`. Each claim gets `expense_claim.unpay` with the reason.
 */
export async function cancelExpensePayment(
  db: Db,
  paymentId: string,
  input: ExpenseReasonInput,
  options: ActorOptions,
): Promise<CancelExpensePaymentResult> {
  const { reason } = expenseReasonSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    // The claims first (the lock order of every write), then the payment.
    const claimIds = await tx.expenseClaim.findMany({
      where: { paymentId },
      select: { id: true },
    });
    const claims = (
      await lockClaims(
        tx,
        claimIds.map((claim) => claim.id),
      )
    ).filter((claim) => claim.paymentId === paymentId);
    const payment = await lockPayment(tx, paymentId);
    if (payment.cancelledAt) {
      throw new SettingsError("この支払は取消済みです。画面を読み込み直してください");
    }
    const line = payment.walletTransactionId
      ? await lockWalletTransaction(tx, payment.walletTransactionId)
      : null;

    const reversalEntryId = await reverseUnlessVoided(tx, payment.journalEntryId, reason, options);

    if (line && line.status === "registered" && line.journalEntryId === payment.journalEntryId) {
      await tx.walletTransaction.update({
        where: { id: line.id },
        data: { status: "pending", journalEntryId: null, settledAt: null },
      });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "wallet_transaction.unregister",
        entity: "wallet_transaction",
        entityId: line.id,
        before: { status: line.status, journalEntryId: line.journalEntryId },
        after: { status: "pending", journalEntryId: null },
        reason,
      });
    }

    const cancelled = await tx.expensePayment.update({
      where: { id: payment.id },
      data: { cancelledAt: new Date(), cancelReason: reason, reversalEntryId },
    });
    await tx.expenseClaim.updateMany({
      where: { id: { in: claims.map((claim) => claim.id) } },
      data: { status: "submitted", paymentId: null },
    });
    for (const claim of claims) {
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "expense_claim.unpay",
        entity: "expense_claim",
        entityId: claim.id,
        before: { status: claim.status, paymentId: claim.paymentId },
        after: { status: "submitted", paymentId: null, reversalEntryId },
        reason,
      });
    }
    return {
      payment: toPaymentRecord(cancelled),
      reversal: await entryRef(tx, reversalEntryId),
    };
  });
}

// ---------------------------------------------------------------------------
// Writes: 取消 (23 §5.2)
// ---------------------------------------------------------------------------

export interface VoidExpenseClaimResult {
  claim: ExpenseClaimRecord;
  /** The reversal of the accrual entry (`null` only if the entry had none). */
  reversal: ExpenseEntryRef | null;
}

/**
 * 取消 (23 §5.2): only an unpaid claim. Its accrual entry is reversed (`voidJournalEntryWithOpenDate`;
 * skipped when the transaction screen voided it already) and the claim becomes 取消済み with the
 * reason (`expense_claim.void`). A linked document stays linked to the voided entry (13).
 */
export async function voidExpenseClaim(
  db: Db,
  claimId: string,
  input: ExpenseReasonInput,
  options: ActorOptions,
): Promise<VoidExpenseClaimResult> {
  const { reason } = expenseReasonSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockClaim(tx, claimId);
    if (current.status === "paid") {
      throw new SettingsError("支払済みの立替精算は取り消せません。先に支払を取り消してください");
    }
    if (current.status === "void") {
      throw new SettingsError("この立替精算は取消済みです。画面を読み込み直してください");
    }
    const reversalEntryId = await reverseUnlessVoided(tx, current.journalEntryId, reason, options);
    const row = await tx.expenseClaim.update({
      where: { id: current.id },
      data: { status: "void", voidReason: reason, voidedAt: new Date(), reversalEntryId },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "expense_claim.void",
      entity: "expense_claim",
      entityId: row.id,
      before: { status: current.status, journalEntryId: current.journalEntryId },
      after: {
        status: row.status,
        voidedAt: row.voidedAt,
        voidReason: row.voidReason,
        reversalEntryId,
      },
      reason,
    });
    return { claim: toClaimRecord(row), reversal: await entryRef(tx, reversalEntryId) };
  });
}
