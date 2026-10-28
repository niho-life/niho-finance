/**
 * 明細 (15-statements §1, §3, §4, §8, §11): the statement lines imported from the wallets, settled as
 * 登録 / 振替 / 無視 and reopened. Registrations and transfers are posted through
 * `postJournalEntryInTransaction` and undone with `voidJournalEntryWithOpenDate` (a reversal): nothing
 * posted is rewritten. Every write runs in one transaction with the lock order statement lines (by
 * id) → journal entry → fiscal year, and appends to the audit log per statement line.
 */
import {
  abs,
  addDays,
  buildStatementEntry,
  buildStatementTransfer,
  CORPORATE_SEGMENT_CODE,
  daysBetween,
  describeRuleMatch,
  descriptionKey,
  displayDate,
  formatYen,
  isTaxCategoryCode,
  LedgerValidationError,
  normalizeText,
  statementEntryInputLine,
  suggest,
  TAX_LINE_ACCOUNT_CODES,
  type CalendarDate,
  type EntryStatus,
  type JournalEntryInput,
  type LedgerError,
  type LedgerErrorCode,
  type Money,
  type SourceKind,
  type SimpleEntryContext,
  type StatementLine,
  type SuggestAccount,
  type SuggestContext,
  type SuggestHistoryItem,
  type SuggestPartner,
  type Suggestion,
  type SuggestWallet,
  type TaxRateRule,
  type TransferCandidate,
  type WalletKind,
  type WalletTransactionStatus,
} from "@niho-finance/ledger";
import type { FiscalYear, Prisma, WalletTransaction } from "@prisma/client";
import { appendAuditLog, toAuditJson, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, toDbDate } from "./dates";
import {
  listDocumentLinks,
  searchDocuments,
  type DocumentListRow,
  type LinkedDocument,
} from "./documents";
import { voidJournalEntryWithOpenDate } from "./entries";
import { SettingsError } from "./errors";
import type { AfterImportHook } from "./imports";
import { postJournalEntryInTransaction, type ActorOptions } from "./journal";
import { loadActiveRules, parseRuleMatch } from "./rule-json";
import {
  documentSearchSchema,
  ignoreStatementSchema,
  registerStatementSchema,
  reopenStatementSchema,
  statementNoteSchema,
  transferStatementSchema,
  type IgnoreStatementInput,
  type ParsedRegisterStatement,
  type ParsedTransferStatement,
  type RegisterStatementInput,
  type ReopenStatementInput,
  type StatementNoteInput,
  type StatementsFilter,
  type TransferStatementInput,
} from "./schemas";
import { runInTransaction, type Tx } from "./transaction";

export const STATEMENT_PAGE_SIZE = 50;
/** Transfer candidates are within this many days of the line (15 §8). */
export const TRANSFER_CANDIDATE_DAYS = 5;
/** At most this many candidates of each kind. */
const CANDIDATE_LIMIT = 5;
/** The newest settled lines `suggest` copies from (15 §4 step 3). */
const HISTORY_LIMIT = 2_000;
/** Description of a statement line used as the entry's 摘要 is cut to this length. */
const DESCRIPTION_MAX = 200;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type StatementErrorCode =
  | "STATEMENT_NOT_FOUND"
  | "STATEMENT_NOT_PENDING"
  | "STATEMENT_NOT_SETTLED"
  | "WALLET_INACTIVE"
  | "ZERO_AMOUNT"
  | "CANDIDATE_MISMATCH";

/**
 * A statement line that cannot be settled or reopened as asked. A `SettingsError`, so that the web's
 * `toActionError` shows the owner-facing message (on `field` when there is one).
 */
export class StatementError extends SettingsError {
  readonly code: StatementErrorCode;

  constructor(code: StatementErrorCode, message: string, options: { field?: string } = {}) {
    super(message, options);
    this.name = "StatementError";
    this.code = code;
  }
}

const NOT_FOUND = "明細が見つかりません。画面を読み込み直してください";
const NOT_PENDING = "この明細は処理済みです。画面を読み込み直してください";
const ZERO_AMOUNT = "金額が 0 円の明細は無視だけできます";
const CANDIDATE_MISMATCH = "相手の明細と金額か日付が合いません。候補から選び直してください";

// ---------------------------------------------------------------------------
// Shared: rows, locks and the ledger context
// ---------------------------------------------------------------------------

const rowInclude = {
  wallet: {
    select: {
      id: true,
      name: true,
      accountId: true,
      subAccountId: true,
      defaultSegmentId: true,
      isActive: true,
    },
  },
} as const;

type LockedRow = Prisma.WalletTransactionGetPayload<{ include: typeof rowInclude }>;

/** Locks statement lines (`FOR UPDATE`) in id order, then loads them with their wallet. */
async function lockRows(tx: Tx, ids: readonly string[]): Promise<Map<string, LockedRow>> {
  const sorted = [...new Set(ids)].sort();
  for (const id of sorted) {
    await tx.$queryRaw`SELECT "id" FROM "wallet_transaction" WHERE "id" = ${id} FOR UPDATE`;
  }
  const rows = await tx.walletTransaction.findMany({
    where: { id: { in: sorted } },
    include: rowInclude,
  });
  return new Map(rows.map((row) => [row.id, row]));
}

function requireRow(rows: ReadonlyMap<string, LockedRow>, id: string): LockedRow {
  const row = rows.get(id);
  if (!row) throw new StatementError("STATEMENT_NOT_FOUND", NOT_FOUND);
  return row;
}

function assertPending(row: LockedRow, field?: string): void {
  if (row.status === "pending") return;
  const message = field ? "相手の明細は処理済みです。画面を読み込み直してください" : NOT_PENDING;
  throw new StatementError("STATEMENT_NOT_PENDING", message, field ? { field } : {});
}

function assertWalletActive(row: LockedRow, field?: string): void {
  if (row.wallet.isActive) return;
  throw new StatementError(
    "WALLET_INACTIVE",
    `口座「${row.wallet.name}」は無効です。設定 › 口座 で有効にしてください`,
    field ? { field } : {},
  );
}

function assertNonZero(row: LockedRow): void {
  if (row.amount === 0n) throw new StatementError("ZERO_AMOUNT", ZERO_AMOUNT);
}

function lineOf(row: {
  id: string;
  walletId: string;
  txnDate: Date;
  amount: bigint;
  descriptionRaw: string;
  counterpartyRaw: string | null;
}): StatementLine {
  return {
    id: row.id,
    walletId: row.walletId,
    txnDate: fromDbDate(row.txnDate),
    amount: row.amount,
    descriptionRaw: row.descriptionRaw,
    counterpartyRaw: row.counterpartyRaw,
  };
}

async function loadTaxRules(db: Db): Promise<TaxRateRule[]> {
  const rows = await db.taxRateRule.findMany({
    orderBy: [{ taxCategoryCode: "asc" }, { effectiveFrom: "asc" }, { ratePercent: "desc" }],
  });
  return rows.map((rule) => ({
    taxCategoryCode: rule.taxCategoryCode,
    effectiveFrom: fromDbDate(rule.effectiveFrom),
    effectiveTo: fromDbDateOrNull(rule.effectiveTo),
    ratePercent: rule.ratePercent,
    deductiblePercent: rule.deductiblePercent,
    enabled: rule.enabled,
    ...(rule.note ? { note: rule.note } : {}),
  }));
}

/**
 * The fiscal year containing `date`, locked until the transaction ends (the lock
 * `postJournalEntry` takes too), so that its accounting method and close cannot change meanwhile.
 */
async function lockFiscalYearOn(tx: Tx, date: CalendarDate): Promise<FiscalYear> {
  const day = toDbDate(date);
  const years = await tx.fiscalYear.findMany({
    where: { startDate: { lte: day }, endDate: { gte: day } },
    select: { id: true },
  });
  const [only] = years;
  if (!only || years.length > 1) {
    throw new LedgerValidationError([
      {
        code: "OUT_OF_FISCAL_YEAR",
        message: `${displayDate(date)} を含む会計期間がありません。設定 › 会計期間 で期を作ってください`,
        field: "entryDate",
      },
    ]);
  }
  await tx.$queryRaw`SELECT "id" FROM "fiscal_year" WHERE "id" = ${only.id} FOR UPDATE`;
  return tx.fiscalYear.findUniqueOrThrow({ where: { id: only.id } });
}

async function loadSimpleEntryContext(tx: Tx, fiscalYear: FiscalYear): Promise<SimpleEntryContext> {
  const accounts = await tx.account.findMany({
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      defaultTaxCategoryCode: true,
      isCashLike: true,
    },
  });
  const wallets = await tx.wallet.findMany({
    select: {
      id: true,
      name: true,
      accountId: true,
      subAccountId: true,
      defaultSegmentId: true,
      isActive: true,
    },
  });
  const corporate = await tx.segment.findUnique({
    where: { code: CORPORATE_SEGMENT_CODE },
    select: { id: true },
  });
  return {
    accountingMethod: fiscalYear.accountingMethod,
    taxRules: await loadTaxRules(tx),
    accounts: new Map(accounts.map((account) => [account.id, account])),
    wallets: new Map(wallets.map((wallet) => [wallet.id, wallet])),
    corporateSegmentId: corporate?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Errors on the fields of the row (15 §5: shown under the row's chips)
// ---------------------------------------------------------------------------

const DATE_CODES: ReadonlySet<LedgerErrorCode> = new Set([
  "INVALID_DATE",
  "OUT_OF_FISCAL_YEAR",
  "PERIOD_LOCKED",
  "FISCAL_YEAR_CLOSED",
  "FISCAL_YEAR_CLOSING",
]);

/** The input of a registered line each line-level ledger error is about. */
const LINE_FIELDS: Partial<Record<LedgerErrorCode, string>> = {
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

/** 「2 行目（4010）の」「1 行目の」: the ledger's way of naming a line. */
const LINE_PREFIX = /^\d+ 行目(?:（[^）]*）)?の/;

function withFields(
  error: LedgerValidationError,
  fieldOf: (item: LedgerError) => string | undefined,
): LedgerValidationError {
  return new LedgerValidationError(
    error.errors.map((item) => {
      if (item.field) return item;
      if (DATE_CODES.has(item.code)) return { ...item, field: "entryDate" };
      if (item.code === "DESCRIPTION_REQUIRED") return { ...item, field: "description" };
      const field = fieldOf(item);
      return field ? { ...item, field, message: item.message.replace(LINE_PREFIX, "") } : item;
    }),
  );
}

/** A registration's ledger error → `lines.<n>.<field>` of the input line it came from. */
function registerField(amount: Money, lineCount: number) {
  return (item: LedgerError): string | undefined => {
    const field = LINE_FIELDS[item.code];
    if (!field || item.lineIndex === undefined) return undefined;
    const index = statementEntryInputLine(item.lineIndex, amount, lineCount);
    return index === null ? undefined : `lines.${index}.${field}`;
  };
}

/** Builder fields of a transfer are relative to the paying line; swap them for the other line. */
function swapWalletFields(error: LedgerValidationError): LedgerValidationError {
  return new LedgerValidationError(
    error.errors.map((item) => {
      if (item.field === "walletId") return { ...item, field: "counterpart" };
      if (item.field === "counterpart" && item.code !== "SAME_WALLET") {
        return { ...item, field: "walletId" };
      }
      return item;
    }),
  );
}

// ---------------------------------------------------------------------------
// Writes: shared
// ---------------------------------------------------------------------------

export interface StatementWriteOptions extends ActorOptions {
  /** Settled by a rule without the owner (§11): `autoPosted = true` on the line. */
  autoPosted?: boolean;
}

/** What the audit log keeps of a statement line (15 §1). */
function snapshot(row: {
  status: WalletTransactionStatus;
  journalEntryId: string | null;
  ignoredReason: string | null;
  ruleId: string | null;
  autoPosted: boolean;
  note: string | null;
}) {
  return {
    status: row.status,
    journalEntryId: row.journalEntryId,
    ignoredReason: row.ignoredReason,
    ruleId: row.ruleId,
    autoPosted: row.autoPosted,
    note: row.note,
  };
}

/** A stored suggestion without its `error` (the line was settled after all). */
function clearedSuggestion(suggestion: Prisma.JsonValue): Prisma.InputJsonValue | undefined {
  if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) return undefined;
  if (!("error" in suggestion) || suggestion.error === null) return undefined;
  return { ...suggestion, error: null };
}

interface Settlement {
  status: "registered" | "transfer" | "ignored";
  journalEntryId: string | null;
  ignoredReason: string | null;
  ruleId: string | null;
}

const SETTLE_ACTIONS = {
  registered: "wallet_transaction.register",
  transfer: "wallet_transaction.transfer",
  ignored: "wallet_transaction.ignore",
} as const;

async function markSettled(
  tx: Tx,
  row: LockedRow,
  settlement: Settlement,
  options: StatementWriteOptions & { reason?: string | null },
): Promise<void> {
  const suggestion = clearedSuggestion(row.suggestion);
  const updated = await tx.walletTransaction.update({
    where: { id: row.id },
    data: {
      ...settlement,
      settledAt: new Date(),
      autoPosted: options.autoPosted ?? false,
      ...(suggestion === undefined ? {} : { suggestion }),
    },
  });
  await appendAuditLog(tx, {
    actor: options.actor,
    action: SETTLE_ACTIONS[settlement.status],
    entity: "wallet_transaction",
    entityId: row.id,
    before: snapshot(row),
    after: snapshot(updated),
    reason: options.reason ?? null,
  });
}

/** The rule named by a settle, if it exists (rules are never deleted; a stale id is dropped). */
async function existingRuleId(tx: Tx, ruleId: string | null): Promise<string | null> {
  if (!ruleId) return null;
  const rule = await tx.rule.findUnique({ where: { id: ruleId }, select: { id: true } });
  return rule?.id ?? null;
}

async function countRuleHit(tx: Tx, ruleId: string | null): Promise<void> {
  if (!ruleId) return;
  await tx.rule.update({
    where: { id: ruleId },
    data: { hitCount: { increment: 1 }, lastHitAt: new Date() },
  });
}

export interface StatementSettleResult {
  /** The entry posted (登録・振替) or linked (照合). */
  entry: { id: string; no: number };
  /** The statement lines now pointing at the entry (2 for a pair of transfer lines). */
  transactionIds: string[];
}

function cut(text: string): string {
  return text.slice(0, DESCRIPTION_MAX);
}

// ---------------------------------------------------------------------------
// Writes: 登録
// ---------------------------------------------------------------------------

async function registerInTransaction(
  tx: Tx,
  id: string,
  data: ParsedRegisterStatement,
  options: StatementWriteOptions,
): Promise<StatementSettleResult> {
  const row = requireRow(await lockRows(tx, [id]), id);
  assertPending(row);
  assertWalletActive(row);
  assertNonZero(row);
  const size = abs(row.amount);
  const lines = data.lines.map((line, index) => {
    if (line.amount !== null) return { ...line, amount: line.amount };
    if (data.lines.length === 1) return { ...line, amount: size };
    throw new LedgerValidationError([
      {
        code: "INVALID_AMOUNT",
        message: "分割した行には金額を入力してください",
        field: `lines.${index}.amount`,
      },
    ]);
  });
  const ruleId = await existingRuleId(tx, data.ruleId);
  const txnDate = fromDbDate(row.txnDate);
  let posted: { id: string; no: number };
  try {
    const fiscalYear = await lockFiscalYearOn(tx, txnDate);
    const entry: JournalEntryInput = buildStatementEntry(
      {
        walletId: row.walletId,
        sourceId: row.id,
        txnDate,
        amount: row.amount,
        description: data.description ?? (cut(row.descriptionRaw) || "明細"),
        partnerId: data.partnerId,
        lines,
      },
      await loadSimpleEntryContext(tx, fiscalYear),
    );
    posted = await postJournalEntryInTransaction(
      tx,
      { ...entry, fiscalYearId: fiscalYear.id },
      { actor: options.actor },
    );
  } catch (error) {
    if (error instanceof LedgerValidationError) {
      throw withFields(error, registerField(row.amount, lines.length));
    }
    throw error;
  }
  await markSettled(
    tx,
    row,
    { status: "registered", journalEntryId: posted.id, ignoredReason: null, ruleId },
    options,
  );
  await countRuleHit(tx, ruleId);
  return { entry: { id: posted.id, no: posted.no }, transactionIds: [row.id] };
}

/**
 * 登録 (15 §1, §5, §9): pending → registered with one entry (`sourceKind = wallet_txn`, dated on the
 * line's date). One line (its amount may be left empty: the whole amount) or several (分割: they
 * must add up to the amount). Errors name the field: `lines.<n>.<field>`, `lines` (the total),
 * `entryDate` (the close, no fiscal year), or the line itself (`StatementError`).
 */
export async function registerWalletTransaction(
  db: Db,
  id: string,
  input: RegisterStatementInput,
  options: ActorOptions,
): Promise<StatementSettleResult> {
  const data = registerStatementSchema.parse(input);
  return runInTransaction(db, (tx) =>
    registerInTransaction(tx, id, data, { actor: options.actor }),
  );
}

// ---------------------------------------------------------------------------
// Writes: 振替
// ---------------------------------------------------------------------------

function transferDescription(outWallet: string, inWallet: string): string {
  return cut(`振替 ${outWallet} → ${inWallet}`);
}

function assertNoFee(data: ParsedTransferStatement): void {
  if (data.fee === null) return;
  throw new LedgerValidationError([
    {
      code: "INVALID_AMOUNT",
      message:
        "相手の明細や登録済みの振替と結ぶときは手数料を入れられません。手数料は別に登録してください",
      field: "fee",
    },
  ]);
}

/** (a) 相手の明細: one entry for both lines, dated on the paying line's date. */
async function transferToLine(
  tx: Tx,
  id: string,
  otherId: string,
  data: ParsedTransferStatement,
  options: StatementWriteOptions,
): Promise<StatementSettleResult> {
  if (otherId === id) {
    throw new StatementError("CANDIDATE_MISMATCH", CANDIDATE_MISMATCH, { field: "counterpart" });
  }
  const rows = await lockRows(tx, [id, otherId]);
  const row = requireRow(rows, id);
  const other = rows.get(otherId);
  if (!other) {
    throw new StatementError(
      "STATEMENT_NOT_FOUND",
      "相手の明細が見つかりません。候補から選び直してください",
      { field: "counterpart" },
    );
  }
  assertPending(row);
  assertPending(other, "counterpart");
  assertWalletActive(row);
  assertWalletActive(other, "counterpart");
  assertNonZero(row);
  assertNoFee(data);
  const days = Math.abs(daysBetween(fromDbDate(row.txnDate), fromDbDate(other.txnDate)));
  if (
    other.walletId === row.walletId ||
    other.amount !== -row.amount ||
    days > TRANSFER_CANDIDATE_DAYS
  ) {
    throw new StatementError("CANDIDATE_MISMATCH", CANDIDATE_MISMATCH, { field: "counterpart" });
  }
  const [paying, receiving] = row.amount < 0n ? [row, other] : [other, row];
  const ruleId = await existingRuleId(tx, data.ruleId);
  const txnDate = fromDbDate(paying.txnDate);
  let posted: { id: string; no: number };
  try {
    const fiscalYear = await lockFiscalYearOn(tx, txnDate);
    const entry = buildStatementTransfer(
      {
        walletId: paying.walletId,
        sourceId: row.id,
        txnDate,
        amount: paying.amount,
        otherWalletId: receiving.walletId,
        fee: null,
        description:
          data.description ?? transferDescription(paying.wallet.name, receiving.wallet.name),
      },
      await loadSimpleEntryContext(tx, fiscalYear),
    );
    posted = await postJournalEntryInTransaction(
      tx,
      { ...entry, fiscalYearId: fiscalYear.id },
      { actor: options.actor },
    );
  } catch (error) {
    if (error instanceof LedgerValidationError) {
      const named = withFields(error, () => undefined);
      throw paying === row ? named : swapWalletFields(named);
    }
    throw error;
  }
  const settlement = {
    status: "transfer",
    journalEntryId: posted.id,
    ignoredReason: null,
  } as const;
  await markSettled(tx, row, { ...settlement, ruleId }, options);
  await markSettled(tx, other, { ...settlement, ruleId: null }, options);
  await countRuleHit(tx, ruleId);
  return { entry: { id: posted.id, no: posted.no }, transactionIds: [row.id, other.id] };
}

/** (b) 相手口座だけ: a transfer entry to the other wallet, with the fee if any. */
async function transferToWallet(
  tx: Tx,
  id: string,
  walletId: string,
  data: ParsedTransferStatement,
  options: StatementWriteOptions,
): Promise<StatementSettleResult> {
  const row = requireRow(await lockRows(tx, [id]), id);
  assertPending(row);
  assertWalletActive(row);
  assertNonZero(row);
  const ruleId = await existingRuleId(tx, data.ruleId);
  const otherName =
    (await tx.wallet.findUnique({ where: { id: walletId }, select: { name: true } }))?.name ?? "";
  const txnDate = fromDbDate(row.txnDate);
  const out = row.amount < 0n;
  let posted: { id: string; no: number };
  try {
    const fiscalYear = await lockFiscalYearOn(tx, txnDate);
    const entry = buildStatementTransfer(
      {
        walletId: row.walletId,
        sourceId: row.id,
        txnDate,
        amount: row.amount,
        otherWalletId: walletId,
        fee: data.fee,
        description:
          data.description ??
          (out
            ? transferDescription(row.wallet.name, otherName)
            : transferDescription(otherName, row.wallet.name)),
      },
      await loadSimpleEntryContext(tx, fiscalYear),
    );
    posted = await postJournalEntryInTransaction(
      tx,
      { ...entry, fiscalYearId: fiscalYear.id },
      { actor: options.actor },
    );
  } catch (error) {
    if (error instanceof LedgerValidationError) throw withFields(error, () => undefined);
    throw error;
  }
  await markSettled(
    tx,
    row,
    { status: "transfer", journalEntryId: posted.id, ignoredReason: null, ruleId },
    options,
  );
  await countRuleHit(tx, ruleId);
  return { entry: { id: posted.id, no: posted.no }, transactionIds: [row.id] };
}

/** The side of the wallet's line in a transfer entry: money in is a debit, money out a credit. */
function walletSide(amount: Money): "debit" | "credit" {
  return amount > 0n ? "debit" : "credit";
}

/** (c) 登録済みの振替: no new entry; the line is linked to a posted transfer entry. */
async function linkToEntry(
  tx: Tx,
  id: string,
  entryId: string,
  data: ParsedTransferStatement,
  options: StatementWriteOptions,
): Promise<StatementSettleResult> {
  const row = requireRow(await lockRows(tx, [id]), id);
  assertPending(row);
  assertWalletActive(row);
  assertNonZero(row);
  assertNoFee(data);
  await tx.$queryRaw`SELECT "id" FROM "journal_entry" WHERE "id" = ${entryId} FOR UPDATE`;
  const entry = await tx.journalEntry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      no: true,
      status: true,
      kind: true,
      entryDate: true,
      lines: { select: { side: true, accountId: true, subAccountId: true, amount: true } },
      walletTransactions: { select: { walletId: true } },
    },
  });
  const side = walletSide(row.amount);
  const size = abs(row.amount);
  const fits =
    entry !== null &&
    entry.status === "posted" &&
    entry.kind === "transfer" &&
    Math.abs(daysBetween(fromDbDate(row.txnDate), fromDbDate(entry.entryDate))) <=
      TRANSFER_CANDIDATE_DAYS &&
    entry.lines.some(
      (line) =>
        line.side === side &&
        line.accountId === row.wallet.accountId &&
        line.subAccountId === row.wallet.subAccountId &&
        line.amount === size,
    ) &&
    !entry.walletTransactions.some((linked) => linked.walletId === row.walletId);
  if (!entry || !fits) {
    throw new StatementError("CANDIDATE_MISMATCH", CANDIDATE_MISMATCH, { field: "counterpart" });
  }
  const ruleId = await existingRuleId(tx, data.ruleId);
  await markSettled(
    tx,
    row,
    { status: "transfer", journalEntryId: entry.id, ignoredReason: null, ruleId },
    options,
  );
  await countRuleHit(tx, ruleId);
  return { entry: { id: entry.id, no: entry.no }, transactionIds: [row.id] };
}

async function transferInTransaction(
  tx: Tx,
  id: string,
  data: ParsedTransferStatement,
  options: StatementWriteOptions,
): Promise<StatementSettleResult> {
  switch (data.counterpart.kind) {
    case "txn":
      return transferToLine(tx, id, data.counterpart.id, data, options);
    case "wallet":
      return transferToWallet(tx, id, data.counterpart.id, data, options);
    case "entry":
      return linkToEntry(tx, id, data.counterpart.id, data, options);
  }
}

/**
 * 振替 (15 §1, §8): pending → transfer. `txn:<id>`: the other wallet's pending line of the opposite
 * amount within ±5 days; one entry, both lines point at it. `wallet:<id>`: a transfer entry to that
 * wallet (with the fee, 11 §4.3). `entry:<id>`: a posted transfer entry with this wallet's line of
 * the amount; no new entry. The default 摘要 is 「振替 <出金側> → <入金側>」.
 */
export async function transferWalletTransaction(
  db: Db,
  id: string,
  input: TransferStatementInput,
  options: ActorOptions,
): Promise<StatementSettleResult> {
  const data = transferStatementSchema.parse(input);
  return runInTransaction(db, (tx) =>
    transferInTransaction(tx, id, data, { actor: options.actor }),
  );
}

// ---------------------------------------------------------------------------
// Writes: 無視・未処理に戻す・メモ
// ---------------------------------------------------------------------------

async function ignoreInTransaction(
  tx: Tx,
  id: string,
  data: { reason: string | null; ruleId: string | null },
  options: StatementWriteOptions,
): Promise<{ transactionIds: string[] }> {
  const row = requireRow(await lockRows(tx, [id]), id);
  assertPending(row);
  const ruleId = await existingRuleId(tx, data.ruleId);
  await markSettled(
    tx,
    row,
    { status: "ignored", journalEntryId: null, ignoredReason: data.reason, ruleId },
    { ...options, reason: data.reason },
  );
  await countRuleHit(tx, ruleId);
  return { transactionIds: [row.id] };
}

/** 無視 (15 §1): pending → ignored. The reason is optional. Lines of inactive wallets can be ignored. */
export async function ignoreWalletTransaction(
  db: Db,
  id: string,
  input: IgnoreStatementInput,
  options: ActorOptions,
): Promise<{ transactionIds: string[] }> {
  const data = ignoreStatementSchema.parse(input);
  return runInTransaction(db, (tx) => ignoreInTransaction(tx, id, data, { actor: options.actor }));
}

export interface ReopenResult {
  /** The lines back to pending (both lines of a transfer pair). */
  reopenedIds: string[];
  /** The reversal that cancelled the entry; `null` when nothing was voided. */
  reversal: { id: string; no: number; entryDate: CalendarDate } | null;
}

/**
 * 未処理に戻す (15 §1, §7): ignored → pending (the reason is optional). registered / transfer →
 * pending with a reason: the entry is voided with `voidJournalEntryWithOpenDate` (a reversal, on the
 * first open date when its month is closed) unless it is voided already, and every line pointing at
 * it goes back to pending. Nothing posted is rewritten.
 */
export async function reopenWalletTransaction(
  db: Db,
  id: string,
  input: ReopenStatementInput,
  options: ActorOptions,
): Promise<ReopenResult> {
  const data = reopenStatementSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    // The lines of the entry are locked together, in id order, before the entry: two reopens of a
    // transfer pair cannot deadlock.
    const peek = await tx.walletTransaction.findUnique({
      where: { id },
      select: { journalEntryId: true },
    });
    if (!peek) throw new StatementError("STATEMENT_NOT_FOUND", NOT_FOUND);
    const entryId = peek.journalEntryId;
    const siblings = entryId
      ? await tx.walletTransaction.findMany({
          where: { journalEntryId: entryId },
          select: { id: true },
        })
      : [];
    const rows = await lockRows(tx, [id, ...siblings.map((sibling) => sibling.id)]);
    const row = requireRow(rows, id);
    if (row.status === "pending") {
      throw new StatementError(
        "STATEMENT_NOT_SETTLED",
        "この明細は未処理です。画面を読み込み直してください",
      );
    }
    if (row.journalEntryId !== entryId) {
      throw new StatementError(
        "STATEMENT_NOT_SETTLED",
        "この明細は別の操作で変わりました。画面を読み込み直してください",
      );
    }
    const reopen = async (target: LockedRow) => {
      const updated = await tx.walletTransaction.update({
        where: { id: target.id },
        data: {
          status: "pending",
          journalEntryId: null,
          ignoredReason: null,
          settledAt: null,
          ruleId: null,
          autoPosted: false,
        },
      });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "wallet_transaction.reopen",
        entity: "wallet_transaction",
        entityId: target.id,
        before: snapshot(target),
        after: snapshot(updated),
        reason: data.reason,
      });
    };

    if (!entryId) {
      await reopen(row);
      return { reopenedIds: [row.id], reversal: null };
    }
    await tx.$queryRaw`SELECT "id" FROM "journal_entry" WHERE "id" = ${entryId} FOR UPDATE`;
    const entry = await tx.journalEntry.findUniqueOrThrow({
      where: { id: entryId },
      select: { status: true, sourceKind: true, sourceId: true },
    });
    // 照合 (the line was matched to an entry posted otherwise: by hand, or for the other line of a
    // transfer): only this line is unlinked; the entry stays as it is.
    if (!ownsEntry(entry, row.id)) {
      await reopen(row);
      return { reopenedIds: [row.id], reversal: null };
    }
    if (entry.status === "posted" && !data.reason) {
      throw new SettingsError("理由を入力してください", { field: "reason" });
    }
    // A line linked meanwhile (照合 before this transaction locked the entry) goes back too.
    const linked = await tx.walletTransaction.findMany({
      where: { journalEntryId: entryId },
      select: { id: true },
    });
    const late = linked.map((item) => item.id).filter((item) => !rows.has(item));
    for (const [lateId, lateRow] of await lockRows(tx, late)) rows.set(lateId, lateRow);

    let reversal: ReopenResult["reversal"] = null;
    if (entry.status === "posted") {
      const voided = await voidJournalEntryWithOpenDate(
        tx,
        entryId,
        { reason: data.reason },
        { actor: options.actor },
      );
      reversal = {
        id: voided.reversal.id,
        no: voided.reversal.no,
        entryDate: voided.reversal.entryDate,
      };
    }
    const targets = [...rows.values()]
      .filter((target) => target.journalEntryId === entryId)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const target of targets) await reopen(target);
    return { reopenedIds: targets.map((target) => target.id), reversal };
  });
}

/** メモ (15 §5): on a line in any state; never written to the entry. Audit `wallet_transaction.update`. */
export async function updateWalletTransactionNote(
  db: Db,
  id: string,
  input: StatementNoteInput,
  options: ActorOptions,
): Promise<{ id: string; note: string | null }> {
  const data = statementNoteSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const row = requireRow(await lockRows(tx, [id]), id);
    if (row.note === data.note) return { id: row.id, note: row.note };
    const updated = await tx.walletTransaction.update({
      where: { id: row.id },
      data: { note: data.note },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "wallet_transaction.update",
      entity: "wallet_transaction",
      entityId: row.id,
      before: snapshot(row),
      after: snapshot(updated),
    });
    return { id: updated.id, note: updated.note };
  });
}

// ---------------------------------------------------------------------------
// Reads: the context of `suggest` and the transfer candidates
// ---------------------------------------------------------------------------

type SuggestBase = Omit<SuggestContext, "candidates">;

/** Rules, history, partners, accounts and wallets for `suggest` (15 §4). */
async function loadSuggestBase(db: Db): Promise<SuggestBase> {
  const wallets = await db.wallet.findMany({
    select: {
      id: true,
      accountId: true,
      subAccountId: true,
      defaultSegmentId: true,
      isActive: true,
    },
  });
  const accounts = await db.account.findMany({
    select: {
      id: true,
      code: true,
      kind: true,
      defaultTaxCategoryCode: true,
      defaultSegmentId: true,
      isCashLike: true,
      isActive: true,
    },
  });
  const partners = await db.partner.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      nameKana: true,
      defaultAccountId: true,
      defaultTaxCategoryCode: true,
      defaultSegmentId: true,
      isActive: true,
    },
  });
  const settled = await db.walletTransaction.findMany({
    where: {
      status: { in: ["registered", "transfer"] },
      journalEntry: { is: { status: "posted" } },
    },
    orderBy: [{ txnDate: "desc" }, { id: "desc" }],
    take: HISTORY_LIMIT,
    select: {
      walletId: true,
      descriptionRaw: true,
      txnDate: true,
      status: true,
      journalEntry: {
        select: {
          lines: {
            orderBy: { lineNo: "asc" },
            select: {
              accountId: true,
              subAccountId: true,
              taxCategoryCode: true,
              partnerId: true,
              segmentId: true,
              account: { select: { code: true } },
            },
          },
        },
      },
    },
  });
  const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet]));
  const history = new Map<string, SuggestHistoryItem[]>();
  for (const row of settled) {
    const wallet = walletById.get(row.walletId);
    const lines = row.journalEntry?.lines ?? [];
    const key = descriptionKey(row.descriptionRaw);
    if (!wallet || key === "") continue;
    const onWallet = (line: { accountId: string; subAccountId: string | null }, of = wallet) =>
      line.accountId === of.accountId && line.subAccountId === of.subAccountId;
    const base = {
      walletId: row.walletId,
      key,
      txnDate: fromDbDate(row.txnDate),
      accountId: null,
      taxCategoryCode: null,
      partnerId: null,
      segmentId: null,
      transferToWalletId: null,
    };
    let item: SuggestHistoryItem | null = null;
    if (row.status === "transfer") {
      const other = wallets.find(
        (candidate) =>
          candidate.id !== wallet.id && lines.some((line) => onWallet(line, candidate)),
      );
      if (other) item = { ...base, mode: "transfer", transferToWalletId: other.id };
    } else {
      const main = lines.find(
        (line) => !onWallet(line) && !TAX_LINE_ACCOUNT_CODES.includes(line.account.code),
      );
      if (main) {
        item = {
          ...base,
          mode: "register",
          accountId: main.accountId,
          taxCategoryCode: main.taxCategoryCode,
          partnerId: main.partnerId,
          segmentId: main.segmentId,
        };
      }
    }
    if (!item) continue;
    const list = history.get(key) ?? [];
    list.push(item);
    history.set(key, list);
  }
  return {
    rules: await loadActiveRules(db),
    history,
    partners: partners satisfies SuggestPartner[],
    accounts: new Map(accounts.map((account) => [account.id, account satisfies SuggestAccount])),
    wallets: new Map(
      wallets.map((wallet) => [
        wallet.id,
        {
          id: wallet.id,
          accountId: wallet.accountId,
          defaultSegmentId: wallet.defaultSegmentId,
          isActive: wallet.isActive,
        } satisfies SuggestWallet,
      ]),
    ),
  };
}

/** A statement line whose transfer candidates are looked for. */
export interface CandidateTarget {
  id: string;
  walletId: string;
  txnDate: CalendarDate;
  amount: Money;
}

function byDistance(date: CalendarDate) {
  return (a: TransferCandidate, b: TransferCandidate): number => {
    const diff = Math.abs(daysBetween(date, a.date)) - Math.abs(daysBetween(date, b.date));
    if (diff !== 0) return diff;
    if (a.kind !== b.kind) return a.kind === "txn" ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

async function candidatesFor(
  db: Db,
  targets: readonly CandidateTarget[],
): Promise<Map<string, TransferCandidate[]>> {
  const result = new Map<string, TransferCandidate[]>();
  const live = targets.filter((target) => target.amount !== 0n);
  if (live.length === 0) return result;
  const dates = live.map((target) => target.txnDate).sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (!first || !last) return result;
  const from = toDbDate(addDays(first, -TRANSFER_CANDIDATE_DAYS));
  const to = toDbDate(addDays(last, TRANSFER_CANDIDATE_DAYS));
  const wallets = await db.wallet.findMany({
    select: { id: true, accountId: true, subAccountId: true, isActive: true },
  });
  const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet]));

  // (a) 相手の明細: pending lines of other active wallets with the opposite amount.
  const opposite = [...new Set(live.map((target) => -target.amount))];
  const lines = await db.walletTransaction.findMany({
    where: {
      status: "pending",
      amount: { in: opposite },
      txnDate: { gte: from, lte: to },
      wallet: { isActive: true },
    },
    select: { id: true, walletId: true, txnDate: true, amount: true, descriptionRaw: true },
  });

  // (b) 登録済みの振替: posted transfer entries with a line on one of the targets' wallets.
  const accountIds = [
    ...new Set(
      live.flatMap((target) => {
        const wallet = walletById.get(target.walletId);
        return wallet ? [wallet.accountId] : [];
      }),
    ),
  ];
  const entries = await db.journalEntry.findMany({
    where: {
      status: "posted",
      kind: "transfer",
      entryDate: { gte: from, lte: to },
      lines: { some: { accountId: { in: accountIds } } },
    },
    select: {
      id: true,
      no: true,
      entryDate: true,
      description: true,
      lines: { select: { side: true, accountId: true, subAccountId: true, amount: true } },
      walletTransactions: { select: { walletId: true } },
    },
  });

  for (const target of live) {
    const within = (date: Date) =>
      Math.abs(daysBetween(target.txnDate, fromDbDate(date))) <= TRANSFER_CANDIDATE_DAYS;
    const sort = byDistance(target.txnDate);
    const fromLines: TransferCandidate[] = lines
      .filter(
        (line) =>
          line.id !== target.id &&
          line.walletId !== target.walletId &&
          line.amount === -target.amount &&
          within(line.txnDate),
      )
      .map((line) => ({
        kind: "txn",
        id: line.id,
        walletId: line.walletId,
        date: fromDbDate(line.txnDate),
        amount: line.amount,
        description: line.descriptionRaw,
        entryNo: null,
      }));
    const wallet = walletById.get(target.walletId);
    const side = walletSide(target.amount);
    const size = abs(target.amount);
    const onWallet = (
      line: { accountId: string; subAccountId: string | null },
      of: { accountId: string; subAccountId: string | null },
    ) => line.accountId === of.accountId && line.subAccountId === of.subAccountId;
    const fromEntries: TransferCandidate[] = wallet
      ? entries.flatMap((entry): TransferCandidate[] => {
          if (!within(entry.entryDate)) return [];
          if (entry.walletTransactions.some((linked) => linked.walletId === target.walletId)) {
            return [];
          }
          const mine = entry.lines.some(
            (line) => line.side === side && line.amount === size && onWallet(line, wallet),
          );
          if (!mine) return [];
          const other = wallets.find(
            (candidate) =>
              candidate.id !== wallet.id &&
              entry.lines.some((line) => line.side !== side && onWallet(line, candidate)),
          );
          if (!other) return [];
          return [
            {
              kind: "entry",
              id: entry.id,
              walletId: other.id,
              date: fromDbDate(entry.entryDate),
              amount: -target.amount,
              description: entry.description,
              entryNo: entry.no,
            },
          ];
        })
      : [];
    const merged = [
      ...fromLines.sort(sort).slice(0, CANDIDATE_LIMIT),
      ...fromEntries.sort(sort).slice(0, CANDIDATE_LIMIT),
    ].sort(sort);
    if (merged.length > 0) result.set(target.id, merged);
  }
  return result;
}

/**
 * 振替の候補 (15 §8) of statement lines, by line id: pending lines of other active wallets with the
 * opposite amount within ±5 days, and posted transfer entries within ±5 days with this wallet's line
 * of the amount on its side (money in: debit, out: credit) that no line of this wallet points at
 * yet. Nearest first, at most 5 of each kind. One query per kind for all the lines.
 */
export async function findTransferCandidates(
  db: Db,
  targets: readonly string[] | readonly CandidateTarget[],
): Promise<Map<string, TransferCandidate[]>> {
  const list: CandidateTarget[] = [];
  for (const target of targets) {
    if (typeof target !== "string") list.push(target);
  }
  const ids = targets.filter((target): target is string => typeof target === "string");
  if (ids.length > 0) {
    const rows = await db.walletTransaction.findMany({
      where: { id: { in: ids } },
      select: { id: true, walletId: true, txnDate: true, amount: true },
    });
    for (const row of rows) list.push({ ...row, txnDate: fromDbDate(row.txnDate) });
  }
  return candidatesFor(db, list);
}

// ---------------------------------------------------------------------------
// Reads: the list
// ---------------------------------------------------------------------------

export interface StatementEntrySummary {
  id: string;
  no: number;
  status: EntryStatus;
  /** Set on a corrected entry (「→ No. 20 に訂正」). */
  replacedByNo: number | null;
  /** 「地代家賃」「消耗品費 ほか 1 行」「振替 → 架空銀行 普通」. */
  summary: string;
  /**
   * The entry was posted for this line (`sourceKind = wallet_txn`, `sourceId` = the line): 未処理に戻す
   * voids it. Otherwise the line was only matched to it (照合) and 未処理に戻す unlinks the line.
   */
  ownsEntry: boolean;
}

export interface StatementRow {
  id: string;
  walletId: string;
  walletName: string;
  walletKind: WalletKind;
  walletActive: boolean;
  txnDate: CalendarDate;
  /** Signed: money into the wallet is positive. */
  amount: Money;
  descriptionRaw: string;
  counterpartyRaw: string | null;
  status: WalletTransactionStatus;
  note: string | null;
  ignoredReason: string | null;
  /** Settled by a rule without the owner (「ルールで自動登録」). */
  autoPosted: boolean;
  settledAt: Date | null;
  rule: { id: string; name: string } | null;
  /** A document is linked to the line (S6); 出金 without one shows 「証憑なし」. */
  hasDocument: boolean;
  entry: StatementEntrySummary | null;
  /** The chips of a pending line (computed on every read); `null` for settled lines. */
  suggestion: Suggestion | null;
  /** Transfer candidates of a pending line, nearest first (at most 5). */
  candidates: TransferCandidate[];
  /** Why the automatic settlement on import failed (§11), while the line is pending. */
  error: string | null;
}

export interface StatementWalletChip {
  id: string;
  name: string;
  kind: WalletKind;
  isActive: boolean;
  /** Pending lines of the wallet. */
  pending: number;
}

export interface StatementPage {
  rows: StatementRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  /** Pending lines of every wallet (the 「すべて n」 chip and the 未処理 tab). */
  pendingTotal: number;
  /** Every active wallet, and inactive wallets with pending lines (15 §3). */
  wallets: StatementWalletChip[];
}

const listInclude = {
  wallet: {
    select: { name: true, kind: true, isActive: true, accountId: true, subAccountId: true },
  },
  rule: { select: { id: true, name: true, match: true } },
  journalEntry: {
    select: {
      id: true,
      no: true,
      status: true,
      sourceKind: true,
      sourceId: true,
      replacedBy: { select: { no: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        select: {
          accountId: true,
          subAccountId: true,
          account: { select: { code: true, name: true } },
        },
      },
    },
  },
  _count: { select: { documentLinks: true } },
} as const;

type ListRow = Prisma.WalletTransactionGetPayload<{ include: typeof listInclude }>;

interface WalletRef {
  id: string;
  name: string;
  accountId: string;
  subAccountId: string | null;
}

function entrySummary(row: ListRow, wallets: readonly WalletRef[]): StatementEntrySummary | null {
  const entry = row.journalEntry;
  if (!entry) return null;
  const onWallet = (
    line: { accountId: string; subAccountId: string | null },
    wallet: { accountId: string; subAccountId: string | null },
  ) => line.accountId === wallet.accountId && line.subAccountId === wallet.subAccountId;
  let summary: string;
  if (row.status === "transfer") {
    const other = wallets.find(
      (wallet) => wallet.id !== row.walletId && entry.lines.some((line) => onWallet(line, wallet)),
    );
    summary = `振替 → ${other?.name ?? "相手の口座"}`;
  } else {
    const main = entry.lines.filter(
      (line) => !onWallet(line, row.wallet) && !TAX_LINE_ACCOUNT_CODES.includes(line.account.code),
    );
    const [first] = main;
    summary = first
      ? main.length > 1
        ? `${first.account.name} ほか ${main.length - 1} 行`
        : first.account.name
      : "";
  }
  return {
    id: entry.id,
    no: entry.no,
    status: entry.status,
    replacedByNo: entry.replacedBy?.no ?? null,
    summary,
    ownsEntry: ownsEntry(entry, row.id),
  };
}

/** The entry was posted for this line (not a hand-written entry or another line's, 照合). */
function ownsEntry(entry: { sourceKind: SourceKind; sourceId: string | null }, lineId: string) {
  return entry.sourceKind === "wallet_txn" && entry.sourceId === lineId;
}

function storedError(suggestion: Prisma.JsonValue): string | null {
  if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) return null;
  const error = (suggestion as Record<string, unknown>).error;
  return typeof error === "string" && error !== "" ? error : null;
}

async function toRows(db: Db, rows: readonly ListRow[]): Promise<StatementRow[]> {
  const wallets = await db.wallet.findMany({
    select: { id: true, name: true, accountId: true, subAccountId: true },
  });
  const pending = rows.filter((row) => row.status === "pending");
  const base = pending.length > 0 ? await loadSuggestBase(db) : null;
  const candidates =
    pending.length > 0
      ? await candidatesFor(
          db,
          pending.map((row) => ({ ...row, txnDate: fromDbDate(row.txnDate) })),
        )
      : new Map<string, TransferCandidate[]>();
  return rows.map((row): StatementRow => {
    const isPending = row.status === "pending";
    const own = candidates.get(row.id) ?? [];
    const match = row.rule ? parseRuleMatch(row.rule.match) : null;
    return {
      id: row.id,
      walletId: row.walletId,
      walletName: row.wallet.name,
      walletKind: row.wallet.kind,
      walletActive: row.wallet.isActive,
      txnDate: fromDbDate(row.txnDate),
      amount: row.amount,
      descriptionRaw: row.descriptionRaw,
      counterpartyRaw: row.counterpartyRaw,
      status: row.status,
      note: row.note,
      ignoredReason: row.ignoredReason,
      autoPosted: row.autoPosted,
      settledAt: row.settledAt,
      rule: row.rule
        ? {
            id: row.rule.id,
            name: row.rule.name ?? (match ? describeRuleMatch(match) : "ルール"),
          }
        : null,
      hasDocument: row._count.documentLinks > 0,
      entry: entrySummary(row, wallets),
      suggestion: isPending && base ? suggest(lineOf(row), { ...base, candidates: own }) : null,
      candidates: isPending ? own.slice(0, CANDIDATE_LIMIT) : [],
      error: isPending ? storedError(row.suggestion) : null,
    };
  });
}

/** Digits and separators only (「1,650」「¥ 88,000」「−1650」) → |金額|; anything else → `null`. */
function amountQuery(q: string): Money | null {
  const text = q.normalize("NFKC");
  if (!/^[\d,\s¥￥円+\-−]+$/u.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  if (digits === "" || digits.length > 15) return null;
  return BigInt(digits);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Lines whose description or counterparty contains `q`, compared after NFKC and lower-casing on both
 * sides: 「カクウ」 finds the half-width 「ｶｸｳ」 banks write.
 */
async function searchIds(db: Db, q: string): Promise<string[]> {
  const pattern = `%${escapeLike(normalizeText(q))}%`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "wallet_transaction"
     WHERE lower(normalize("description_raw", NFKC)) LIKE ${pattern}
        OR lower(normalize(coalesce("counterparty_raw", ''), NFKC)) LIKE ${pattern}`;
  return rows.map((row) => row.id);
}

/** The filters of the list; left out = not narrowed (`status` defaults to 未処理). */
export type StatementFilters = Partial<StatementsFilter>;

/**
 * The statement list (15 §3): one state at a time; pending lines oldest first (to be settled in
 * order), settled ones newest first; `pageSize` (50) per page, a page past the end shows the last.
 * Pending rows carry their suggestion and transfer candidates; the wallet chips carry pending counts.
 */
export async function listWalletTransactions(
  db: Db,
  filters: StatementFilters = {},
  options: { pageSize?: number } = {},
): Promise<StatementPage> {
  const pageSize = options.pageSize ?? STATEMENT_PAGE_SIZE;
  const status = filters.status ?? "pending";
  const and: Prisma.WalletTransactionWhereInput[] = [{ status }];
  if (filters.wallet) and.push({ walletId: filters.wallet });
  if (filters.by === "rule" && status !== "pending") and.push({ autoPosted: true });
  if (filters.q) {
    const amount = amountQuery(filters.q);
    if (amount !== null) and.push({ amount: { in: [amount, -amount] } });
    else and.push({ id: { in: await searchIds(db, filters.q) } });
  }
  const where: Prisma.WalletTransactionWhereInput = { AND: and };
  const total = await db.walletTransaction.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Math.trunc(filters.page ?? 1)), pageCount);
  const direction = status === "pending" ? "asc" : "desc";
  const rows = await db.walletTransaction.findMany({
    where,
    orderBy: [{ txnDate: direction }, { id: direction }],
    skip: (current - 1) * pageSize,
    take: pageSize,
    include: listInclude,
  });

  const counts = await countPendingByWallet(db);
  const wallets = await db.wallet.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, kind: true, isActive: true },
  });
  return {
    rows: await toRows(db, rows),
    total,
    page: current,
    pageCount,
    pageSize,
    pendingTotal: Object.values(counts).reduce((sum, count) => sum + count, 0),
    wallets: wallets
      .map((wallet) => ({ ...wallet, pending: counts[wallet.id] ?? 0 }))
      .filter((wallet) => wallet.isActive || wallet.pending > 0),
  };
}

/** One statement line as a row of the list (with its suggestion when pending), or `null`. */
export async function getWalletTransaction(db: Db, id: string): Promise<StatementRow | null> {
  const row = await db.walletTransaction.findUnique({ where: { id }, include: listInclude });
  if (!row) return null;
  const [result] = await toRows(db, [row]);
  return result ?? null;
}

/** Pending lines of every wallet: the home's 「やること」 (S7). */
export async function countPendingWalletTransactions(db: Db): Promise<number> {
  return db.walletTransaction.count({ where: { status: "pending" } });
}

/** Pending lines per wallet id (wallets without any are left out). */
export async function countPendingByWallet(db: Db): Promise<Record<string, number>> {
  const rows = await db.$queryRaw<{ walletId: string; count: number }[]>`
    SELECT "wallet_id" AS "walletId", count(*)::int AS "count"
      FROM "wallet_transaction"
     WHERE "status" = 'pending'
     GROUP BY "wallet_id"`;
  return Object.fromEntries(rows.map((row) => [row.walletId, row.count]));
}

// ---------------------------------------------------------------------------
// 取込時の自動登録 (§11) and 「ルールを適用」 (§10)
// ---------------------------------------------------------------------------

export interface AutoSettleResult {
  registered: number;
  transferred: number;
  ignored: number;
  /** Lines left pending, with the reason (also stored in `suggestion.error`). */
  failed: { id: string; message: string }[];
}

type PendingRow = WalletTransaction;

function failureMessage(error: LedgerValidationError | SettingsError): string {
  if (error instanceof SettingsError) return error.message;
  return [...new Set(error.errors.map((item) => item.message))].join(" / ");
}

/** Settles one line the way its winning rule says, in the caller's transaction. */
async function settleBySuggestion(
  tx: Tx,
  row: PendingRow,
  suggestion: Suggestion,
  options: StatementWriteOptions,
): Promise<{ status: "registered" | "transfer" | "ignored"; transactionIds: string[] }> {
  switch (suggestion.mode) {
    case "register": {
      const taxCategoryCode = suggestion.taxCategoryCode;
      if (!suggestion.accountId || !taxCategoryCode || !isTaxCategoryCode(taxCategoryCode)) {
        throw new SettingsError("ルールの科目か税区分が使えません。設定 › ルール で直してください");
      }
      const result = await registerInTransaction(
        tx,
        row.id,
        {
          description: suggestion.description,
          partnerId: suggestion.partnerId,
          ruleId: suggestion.ruleId,
          lines: [
            {
              accountId: suggestion.accountId,
              amount: null,
              taxCategoryCode,
              segmentId: suggestion.segmentId,
              partnerId: null,
              description: null,
            },
          ],
        },
        options,
      );
      return { status: "registered", transactionIds: result.transactionIds };
    }
    case "transfer": {
      const counterpart = suggestion.candidate
        ? suggestion.candidate
        : suggestion.transferToWalletId
          ? { kind: "wallet" as const, id: suggestion.transferToWalletId }
          : null;
      if (!counterpart) {
        throw new SettingsError("ルールの相手口座が使えません。設定 › ルール で直してください");
      }
      const result = await transferInTransaction(
        tx,
        row.id,
        { counterpart, fee: null, description: null, ruleId: suggestion.ruleId },
        options,
      );
      return { status: "transfer", transactionIds: result.transactionIds };
    }
    case "ignore": {
      const result = await ignoreInTransaction(
        tx,
        row.id,
        { reason: suggestion.ignoredReason, ruleId: suggestion.ruleId },
        options,
      );
      return { status: "ignored", transactionIds: result.transactionIds };
    }
  }
}

/**
 * Computes the suggestions of pending lines in one batch and settles those a rule wins: on import
 * (`autoPost` rules, storing the snapshot in `suggestion`) or for one rule (「ルールを適用」). Each
 * line is settled in its own transaction (`autoPosted = true`); a refusal leaves it pending with the
 * reason in `suggestion.error`. Lines settled earlier in the batch (the other side of a transfer) are
 * skipped, and are no longer offered as candidates.
 * @internal shared by `settleImportedWalletTransactions` and `applyRuleToPending`.
 */
export async function settlePendingLines(
  db: Db,
  rows: readonly PendingRow[],
  options: ActorOptions & { storeSuggestion: boolean; ruleId?: string },
): Promise<AutoSettleResult> {
  const result: AutoSettleResult = { registered: 0, transferred: 0, ignored: 0, failed: [] };
  if (rows.length === 0) return result;
  const base = await loadSuggestBase(db);
  const candidates = await candidatesFor(
    db,
    rows.map((row) => ({ ...row, txnDate: fromDbDate(row.txnDate) })),
  );
  const settled = new Set<string>();
  for (const row of rows) {
    if (settled.has(row.id)) continue;
    const own = (candidates.get(row.id) ?? []).filter(
      (candidate) => !(candidate.kind === "txn" && settled.has(candidate.id)),
    );
    const suggestion = suggest(lineOf(row), { ...base, candidates: own });
    if (options.storeSuggestion) {
      await db.walletTransaction.updateMany({
        where: { id: row.id, status: "pending" },
        data: { suggestion: toAuditJson({ ...suggestion, error: null }) },
      });
    }
    const wins =
      suggestion.source === "rule" &&
      (options.ruleId ? suggestion.ruleId === options.ruleId : suggestion.autoPost);
    if (!wins) continue;
    try {
      const outcome = await runInTransaction(db, (tx) =>
        settleBySuggestion(tx, row, suggestion, { actor: options.actor, autoPosted: true }),
      );
      for (const id of outcome.transactionIds) settled.add(id);
      if (outcome.status === "registered") result.registered += 1;
      else if (outcome.status === "transfer") result.transferred += 1;
      else result.ignored += 1;
    } catch (error) {
      if (!(error instanceof LedgerValidationError) && !(error instanceof SettingsError)) {
        throw error;
      }
      const message = failureMessage(error);
      result.failed.push({ id: row.id, message });
      await db.walletTransaction.updateMany({
        where: { id: row.id, status: "pending" },
        data: { suggestion: toAuditJson({ ...suggestion, error: message }) },
      });
    }
  }
  return result;
}

/**
 * 取込時の自動登録 (15 §11), called by the imports after the lines are inserted: stores each pending
 * line's suggestion and settles the lines an `autoPost` rule wins (登録 / 振替 / 無視), with
 * `autoPosted = true`, the rule's hit count and the audit log under the importing actor. A line that
 * cannot be settled (the close, a segment, a tax rule …) stays pending with the reason.
 */
export async function settleImportedWalletTransactions(
  db: Db,
  ids: readonly string[],
  options: ActorOptions,
): Promise<AutoSettleResult> {
  const rows = await db.walletTransaction.findMany({
    where: { id: { in: [...new Set(ids)] }, status: "pending" },
    orderBy: [{ txnDate: "asc" }, { id: "asc" }],
  });
  return settlePendingLines(db, rows, { actor: options.actor, storeSuggestion: true });
}

// ---------------------------------------------------------------------------
// 証憑 of a line (15 §5; the documents themselves are S6's, 13-documents §9)
// ---------------------------------------------------------------------------

/** How many inbox documents the sheet offers. */
const DOCUMENT_CHOICES = 50;

export interface StatementInboxDocument extends DocumentListRow {
  /** The document's amount is the line's |amount|: offered first. */
  sameAmount: boolean;
  /** Days between the document's date and the line's (`null` when the document has no date). */
  days: number | null;
}

export interface StatementDocuments {
  /** The documents linked to the line (voided ones included, as the record of the link). */
  linked: LinkedDocument[];
  /**
   * The inbox (unlinked or unsorted documents, 13 §1) without the linked ones: the same amount
   * first, then the nearest date (undated last), then the inbox's own order.
   */
  inbox: StatementInboxDocument[];
}

/** 証憑 of a statement line (15 §5): what is linked, and the inbox to link from. Reads only. */
export async function loadStatementDocuments(db: Db, id: string): Promise<StatementDocuments> {
  const line = await db.walletTransaction.findUnique({
    where: { id },
    select: { id: true, txnDate: true, amount: true },
  });
  if (!line) throw new StatementError("STATEMENT_NOT_FOUND", NOT_FOUND);
  const linked = await listDocumentLinks(db, { kind: "wallet_transaction", id });
  const linkedIds = new Set(linked.map((document) => document.id));
  const { rows } = await searchDocuments(db, documentSearchSchema.parse({ tab: "inbox" }), {
    pageSize: DOCUMENT_CHOICES,
  });
  const size = abs(line.amount);
  const date = fromDbDate(line.txnDate);
  const inbox = rows
    .filter((row) => !linkedIds.has(row.id))
    .map((row, index) => ({
      index,
      row: {
        ...row,
        sameAmount: row.amount !== null && row.amount === size,
        days: row.txnDate ? Math.abs(daysBetween(date, row.txnDate)) : null,
      },
    }))
    .sort(
      (a, b) =>
        Number(b.row.sameAmount) - Number(a.row.sameAmount) ||
        (a.row.days ?? Number.MAX_SAFE_INTEGER) - (b.row.days ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
  return { linked, inbox };
}

/**
 * The `afterImport` hook of the imports (12-imports §6.3, 15 §11): settles the new lines an
 * `autoPost` rule wins, inside the import's transaction. A line a rule cannot settle (the close, a
 * segment, a tax rule …) stays pending with the reason; it never fails the import.
 */
export const settleAfterImport: AfterImportHook = async (tx, batch, options) => {
  await settleImportedWalletTransactions(tx, batch.transactionIds, { actor: options.actor });
};

/** 「1,650」 with the sign of the line: 「−88,000」 for money out (U+2212), as the list shows it. */
export function formatStatementAmount(amount: Money): string {
  return amount < 0n ? `−${formatYen(-amount)}` : formatYen(amount);
}
