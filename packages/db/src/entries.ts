/**
 * 取引 (11-transactions §1–§6, §9): the journal list and the detail with its chain and history, the
 * options of the forms, and the writes of the transaction screens. 収入 / 支出 / 振替 / 伝票 are posted
 * through `postJournalEntryInTransaction` (numbering, the ledger rules, the audit log); a void of an
 * entry in a closed month is dated on the first open day; a correction voids, posts the replacement
 * and links it (`replacedById`) in one transaction. Nothing posted is ever rewritten.
 */
import {
  buildSimpleEntry,
  buildVoucherEntry,
  CORPORATE_SEGMENT_CODE,
  displayDate,
  ENTRY_KIND_LABELS,
  firstOpenDate,
  isLocked,
  LedgerValidationError,
  type AccountGroup,
  type AccountingMethod,
  type AccountKind,
  type CalendarDate,
  type ConsumptionTaxMethod,
  type EntryKind,
  type EntryStatus,
  type FiscalYearStatus,
  type JournalEntryInput,
  type LedgerError,
  type LedgerErrorCode,
  type Money,
  type Side,
  type SimpleEntryContext,
  type SourceKind,
  type TaxDirection,
  type TaxKind,
  type TaxRateRule,
  type WalletKind,
} from "@niho-finance/ledger";
import type { FiscalYear, Prisma } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, toDbDate } from "./dates";
import { SettingsError } from "./errors";
import {
  JournalEntryNotFoundError,
  loadStoredEntry,
  postJournalEntryInTransaction,
  voidJournalEntryInTransaction,
  type ActorOptions,
  type StoredJournalEntry,
  type StoredJournalLine,
  type VoidJournalEntryResult,
} from "./journal";
import { toFiscalYearContext } from "./queries";
import {
  correctEntrySchema,
  simpleEntrySchema,
  voidEntrySchema,
  VOUCHER_KINDS,
  voucherEntrySchema,
  type CorrectEntryInput,
  type EntriesFilter,
  type ParsedSimpleEntry,
  type SimpleEntryFormInput,
  type VoidEntryInput,
  type VoucherEntryFormInput,
} from "./schemas";
import { runInTransaction, type Tx } from "./transaction";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** An entry as a link target (「No. 12」). */
export interface EntryRef {
  id: string;
  no: number;
  entryDate: CalendarDate;
}

const entryRefSelect = { id: true, no: true, entryDate: true } as const;

function toEntryRef(row: { id: string; no: number; entryDate: Date }): EntryRef {
  return { id: row.id, no: row.no, entryDate: fromDbDate(row.entryDate) };
}

/** Every tax rate rule (disabled ones too), as the ledger's `resolveTaxRule` reads them. */
export async function loadTaxRules(db: Db): Promise<TaxRateRule[]> {
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

function noFiscalYearMessage(date: CalendarDate): string {
  return `${displayDate(date)} を含む会計期間がありません。会計期間の中の日付にするか、設定 › 会計期間 で期を作ってください`;
}

/**
 * The fiscal year containing `date`, locked until the transaction ends (the lock
 * `postJournalEntry` takes too), so that its accounting method and close cannot change meanwhile.
 */
export async function lockFiscalYearOn(tx: Tx, date: CalendarDate): Promise<FiscalYear> {
  const day = toDbDate(date);
  const years = await tx.fiscalYear.findMany({
    where: { startDate: { lte: day }, endDate: { gte: day } },
    select: { id: true },
  });
  const [only] = years;
  if (!only || years.length > 1) {
    throw new LedgerValidationError([
      { code: "OUT_OF_FISCAL_YEAR", message: noFiscalYearMessage(date), field: "entryDate" },
    ]);
  }
  await tx.$queryRaw`SELECT "id" FROM "fiscal_year" WHERE "id" = ${only.id} FOR UPDATE`;
  return tx.fiscalYear.findUniqueOrThrow({ where: { id: only.id } });
}

/**
 * When an entry can be voided or corrected, and the date of its reversal (11 §1): its own date, or
 * the first open date when its month is closed. `blocked` says why it cannot be.
 */
function reversalPlan(
  entry: { status: EntryStatus; kind: EntryKind; entryDate: CalendarDate },
  fiscalYear: FiscalYear,
): { date: CalendarDate | null; blocked: LedgerError | null } {
  if (entry.status === "voided") {
    return {
      date: null,
      blocked: { code: "ALREADY_VOIDED", message: "取消済みのため、訂正・取消はできません" },
    };
  }
  if (entry.kind === "reversal") {
    return {
      date: null,
      blocked: {
        code: "CANNOT_REVERSE_REVERSAL",
        message: "反対仕訳は訂正・取消できません。必要なら新しい仕訳を登録してください",
      },
    };
  }
  if (fiscalYear.status === "closed") {
    return {
      date: null,
      blocked: {
        code: "FISCAL_YEAR_CLOSED",
        message: `第 ${fiscalYear.no} 期は決算済みのため、訂正・取消はできません`,
      },
    };
  }
  if (fiscalYear.status === "closing") {
    return {
      date: null,
      blocked: {
        code: "FISCAL_YEAR_CLOSING",
        message: `第 ${fiscalYear.no} 期は決算整理中のため、訂正・取消はできません`,
      },
    };
  }
  const period = toFiscalYearContext(fiscalYear);
  if (!isLocked(entry.entryDate, period)) return { date: entry.entryDate, blocked: null };
  const open = firstOpenDate(period);
  if (open) return { date: open, blocked: null };
  return {
    date: null,
    blocked: {
      code: "PERIOD_LOCKED",
      message: `第 ${fiscalYear.no} 期は ${displayDate(period.lockedThrough ?? period.endDate)} まですべて締めています。訂正・取消するには 設定 › 会計期間 で締めを戻してください`,
    },
  };
}

// ---------------------------------------------------------------------------
// Errors on the form fields
// ---------------------------------------------------------------------------

const DATE_CODES: ReadonlySet<LedgerErrorCode> = new Set([
  "INVALID_DATE",
  "OUT_OF_FISCAL_YEAR",
  "PERIOD_LOCKED",
  "FISCAL_YEAR_CLOSED",
  "FISCAL_YEAR_CLOSING",
]);

/** The input of a line each line-level error is about. */
const LINE_FIELDS: Partial<
  Record<LedgerErrorCode, "side" | "amount" | "tax" | "account" | "sub" | "segment">
> = {
  INVALID_SIDE: "side",
  INVALID_AMOUNT: "amount",
  NON_POSITIVE_AMOUNT: "amount",
  INVALID_TAX_AMOUNT: "tax",
  TAX_AMOUNT_NOT_ALLOWED: "tax",
  TAX_CATEGORY_REQUIRED: "tax",
  UNKNOWN_TAX_CATEGORY: "tax",
  TAX_RULE_MISSING: "tax",
  UNKNOWN_ACCOUNT: "account",
  ACCOUNT_INACTIVE: "account",
  UNKNOWN_SUB_ACCOUNT: "sub",
  SUB_ACCOUNT_MISMATCH: "sub",
  SEGMENT_REQUIRED: "segment",
};

const VOUCHER_LINE_FIELD = {
  side: "side",
  amount: "amount",
  tax: "taxCategoryCode",
  account: "accountId",
  sub: "subAccountId",
  segment: "segmentId",
} as const;

function headerField(error: LedgerError): string | undefined {
  if (error.field) return error.field;
  if (DATE_CODES.has(error.code)) return "entryDate";
  if (error.code === "DESCRIPTION_REQUIRED") return "description";
  return undefined;
}

/** A 伝票 error → `entryDate`, `description` or `lines.<n>.<field>`; balance errors stay on the form. */
function voucherField(error: LedgerError): string | undefined {
  const header = headerField(error);
  if (header) return header;
  const input = LINE_FIELDS[error.code];
  if (!input || error.lineIndex === undefined) return undefined;
  return `lines.${error.lineIndex}.${VOUCHER_LINE_FIELD[input]}`;
}

/**
 * A 収入 / 支出 / 振替 error → the field that chose the line's account. The lines are in the order
 * `buildSimpleEntry` writes them: 収入 [入金先, 収益, 仮受?], 支出 [科目, 仮払?, 支払元],
 * 振替 [入金先, 手数料?, 仮払?, 出金元]. Errors of the added tax lines stay on the form.
 */
function simpleField(input: ParsedSimpleEntry, entry: JournalEntryInput | undefined) {
  return (error: LedgerError): string | undefined => {
    const header = headerField(error);
    if (header) return header;
    const kind = LINE_FIELDS[error.code];
    if (!kind || error.lineIndex === undefined || !entry) return undefined;
    const index = error.lineIndex;
    const last = entry.lines.length - 1;
    if (input.type === "transfer") {
      if (index === 0) return kind === "amount" ? "amount" : "toWalletId";
      if (index === last) return kind === "amount" ? "amount" : "fromWalletId";
      return "fee";
    }
    const mainIndex = input.type === "income" ? 1 : 0;
    const counterIndex = input.type === "income" ? 0 : last;
    if (index === counterIndex) return kind === "amount" ? "amount" : "counterpart";
    if (index !== mainIndex) return undefined;
    switch (kind) {
      case "amount":
        return "amount";
      case "tax":
        return "taxCategoryCode";
      case "account":
      case "sub":
        return "accountId";
      case "segment":
        return "segmentId";
      case "side":
        return undefined;
    }
  };
}

/** 「2 行目（4010）の」「1 行目の」: the ledger's way of naming a line. */
const LINE_PREFIX = /^\d+ 行目(?:（[^）]*）)?の/;

function withFields(
  error: LedgerValidationError,
  fieldOf: (error: LedgerError) => string | undefined,
  options: { dropLineNo?: boolean } = {},
): LedgerValidationError {
  return new LedgerValidationError(
    error.errors.map((item) => {
      const field = fieldOf(item);
      if (!field) return item;
      // A form without rows (収入・支出・振替) shows a line's message under the field that chose the
      // line's account: the line number means nothing there.
      const message =
        options.dropLineNo && item.field === undefined
          ? item.message.replace(LINE_PREFIX, "")
          : item.message;
      return { ...item, field, message };
    }),
  );
}

// ---------------------------------------------------------------------------
// Writes: 収入 / 支出 / 振替 / 伝票
// ---------------------------------------------------------------------------

/** The accounts, wallets and rules `buildSimpleEntry` (and the invoice entries) build from. */
export async function loadSimpleEntryContext(
  tx: Tx,
  fiscalYear: FiscalYear,
): Promise<SimpleEntryContext> {
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

/**
 * Posts 収入 / 支出 / 振替 (11 §4.1–§4.3): the tax-inclusive amount is split by the fiscal year's
 * accounting method (仮受・仮払消費税 in tax-exclusive years). Errors name the form field (`field`).
 */
export async function postSimpleEntry(
  db: Db,
  input: SimpleEntryFormInput,
  options: ActorOptions,
): Promise<StoredJournalEntry> {
  const data = simpleEntrySchema.parse(input);
  return runInTransaction(db, async (tx) => {
    let entry: JournalEntryInput | undefined;
    try {
      const fiscalYear = await lockFiscalYearOn(tx, data.entryDate);
      entry = buildSimpleEntry(data, await loadSimpleEntryContext(tx, fiscalYear));
      return await postJournalEntryInTransaction(
        tx,
        { ...entry, fiscalYearId: fiscalYear.id },
        options,
      );
    } catch (error) {
      if (error instanceof LedgerValidationError) {
        throw withFields(error, simpleField(data, entry), { dropLineNo: true });
      }
      throw error;
    }
  });
}

/** The rows of the entry being corrected, whose tax unchanged rows keep (11 §1). */
interface OriginalRows {
  accountingMethod: AccountingMethod;
  lines: readonly StoredJournalLine[];
}

/**
 * An unchanged row of a correction keeps the original row's tax: recomputing it from the row (amount
 * × rate) can differ by a yen from the tax the 仮受・仮払 rows were written with (or, 経過措置, from
 * the creditable share). Rows are matched one to one on side, account, sub-account, amount and tax
 * category; only when both years use the same accounting method. Changed rows are computed.
 */
function keepUnchangedTax(
  lines: Parameters<typeof buildVoucherEntry>[0]["lines"],
  original: OriginalRows | undefined,
  accountingMethod: AccountingMethod,
): Parameters<typeof buildVoucherEntry>[0]["lines"] {
  if (!original || original.accountingMethod !== accountingMethod) return lines;
  const unmatched = [...original.lines];
  return lines.map((line) => {
    const index = unmatched.findIndex(
      (row) =>
        row.side === line.side &&
        row.accountId === line.accountId &&
        (row.subAccountId ?? null) === (line.subAccountId ?? null) &&
        row.amount === line.amount &&
        row.taxCategoryCode === line.taxCategoryCode,
    );
    const [match] = index < 0 ? [] : unmatched.splice(index, 1);
    return match ? { ...line, taxAmount: match.taxAmount } : line;
  });
}

async function postVoucherInTransaction(
  tx: Tx,
  data: Parameters<typeof buildVoucherEntry>[0],
  options: ActorOptions,
  original?: OriginalRows,
): Promise<StoredJournalEntry> {
  const fiscalYear = await lockFiscalYearOn(tx, data.entryDate);
  const lines = keepUnchangedTax(data.lines, original, fiscalYear.accountingMethod);
  const entry = buildVoucherEntry(
    { ...data, lines },
    { accountingMethod: fiscalYear.accountingMethod, taxRules: await loadTaxRules(tx) },
  );
  return postJournalEntryInTransaction(tx, { ...entry, fiscalYearId: fiscalYear.id }, options);
}

/** Posts a 伝票 (11 §4.4). An unbalanced one is rejected with `UNBALANCED`. */
export async function postVoucherEntry(
  db: Db,
  input: VoucherEntryFormInput,
  options: ActorOptions,
): Promise<StoredJournalEntry> {
  const data = voucherEntrySchema.parse(input);
  return runInTransaction(db, async (tx) => {
    try {
      return await postVoucherInTransaction(tx, data, options);
    } catch (error) {
      if (error instanceof LedgerValidationError) throw withFields(error, voucherField);
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Writes: 取消 and 訂正
// ---------------------------------------------------------------------------

interface ReversalTarget {
  /** The date of the reversal: the original's, or the first open date of a closed month. */
  date: CalendarDate;
  kind: EntryKind;
  accountingMethod: AccountingMethod;
}

/**
 * The modules that own the entries they post (`sourceKind`): only they void them, so that the
 * document and the ledger move together (docs/decisions/2026-10-29-invoice-entries-locked.md).
 * Today: 請求 (`invoice`: the 売掛金 of an issued document and its payments) and 立替精算
 * (`expense`: the accrual of a claim and its payment, 23-users-and-expenses §5.2).
 */
const OWNED_SOURCE_KINDS: ReadonlySet<SourceKind> = new Set(["invoice", "expense"]);

export interface VoidOwnerOptions {
  /** The module voiding its own entry (e.g. `invoice` from `invoices.ts`); screens leave it out. */
  owner?: SourceKind;
}

/** Why an entry posted by the invoices cannot be voided or corrected on the transaction screen. */
function invoiceEntryMessage(number: string | null): string {
  const document = number && !number.includes("-draft-") ? `請求書 ${number}` : "請求書";
  return `${document} から作った仕訳です。取消・訂正は 請求 の画面で、書類を無効にするか入金を取り消して行います`;
}

async function ownedEntryProblem(
  db: Db,
  entry: { sourceKind: SourceKind; sourceId: string | null },
  owner: SourceKind | undefined,
): Promise<string | null> {
  if (!OWNED_SOURCE_KINDS.has(entry.sourceKind) || entry.sourceKind === owner) return null;
  if (entry.sourceKind === "expense") {
    return "立替精算 から作った仕訳です。取消は 立替精算 の画面で、立替精算を取り消すか支払を取り消して行います";
  }
  const invoice = entry.sourceId
    ? await db.invoice.findUnique({ where: { id: entry.sourceId }, select: { number: true } })
    : null;
  return invoiceEntryMessage(invoice?.number ?? null);
}

/**
 * Locks the entry, then the fiscal years the void (and the correction) will write to: the
 * original's and the one containing `alsoDate` (the replacement's date), in `start_date` order, so
 * that corrections across two years in opposite directions cannot deadlock. The later locks of
 * `voidJournalEntry` and `postJournalEntry` are re-entrant. Throws when the entry cannot be voided.
 */
async function lockForReversal(
  tx: Tx,
  entryId: string,
  alsoDate?: CalendarDate,
  owner?: SourceKind,
): Promise<ReversalTarget> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "journal_entry" WHERE "id" = ${entryId} FOR UPDATE`;
  if (locked.length === 0) throw new JournalEntryNotFoundError(entryId);
  const original = await tx.journalEntry.findUniqueOrThrow({
    where: { id: entryId },
    select: {
      status: true,
      kind: true,
      entryDate: true,
      fiscalYearId: true,
      sourceKind: true,
      sourceId: true,
    },
  });
  const owned = await ownedEntryProblem(tx, original, owner);
  if (owned) throw new SettingsError(owned);
  const yearIds = new Set([original.fiscalYearId]);
  if (alsoDate !== undefined) {
    const day = toDbDate(alsoDate);
    const containing = await tx.fiscalYear.findMany({
      where: { startDate: { lte: day }, endDate: { gte: day } },
      select: { id: true },
    });
    // No (or an ambiguous) year: the replacement's posting reports it, with its field.
    const [only] = containing;
    if (only && containing.length === 1) yearIds.add(only.id);
  }
  const years = await tx.fiscalYear.findMany({
    where: { id: { in: [...yearIds] } },
    select: { id: true },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  for (const year of years) {
    await tx.$queryRaw`SELECT "id" FROM "fiscal_year" WHERE "id" = ${year.id} FOR UPDATE`;
  }
  const fiscalYear = await tx.fiscalYear.findUniqueOrThrow({
    where: { id: original.fiscalYearId },
  });
  const plan = reversalPlan({ ...original, entryDate: fromDbDate(original.entryDate) }, fiscalYear);
  if (plan.blocked || !plan.date) {
    throw new LedgerValidationError([
      plan.blocked ?? { code: "PERIOD_LOCKED", message: "取消できる日付がありません" },
    ]);
  }
  return { date: plan.date, kind: original.kind, accountingMethod: fiscalYear.accountingMethod };
}

/**
 * 取消 (11 §1, §5): the reversing entry is dated on the original's date, or on the first open date
 * when the original's month is closed (`lockedThrough`). The reason is required.
 */
export async function voidJournalEntryWithOpenDate(
  db: Db,
  entryId: string,
  input: VoidEntryInput,
  options: ActorOptions & VoidOwnerOptions,
): Promise<VoidJournalEntryResult> {
  const data = voidEntrySchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const { date } = await lockForReversal(tx, entryId, undefined, options.owner);
    return voidJournalEntryInTransaction(tx, entryId, {
      reason: data.reason,
      date,
      actor: options.actor,
    });
  });
}

/** A correction keeps the original's kind or becomes one a 伝票 can have (通常・決算整理). */
function assertCorrectionKind(kind: EntryKind, originalKind: EntryKind): void {
  if ((VOUCHER_KINDS as readonly EntryKind[]).includes(kind) || kind === originalKind) return;
  throw new LedgerValidationError([
    {
      code: "INVALID_KIND",
      message: `訂正後の種類は 通常・決算整理 か、元の仕訳と同じ「${ENTRY_KIND_LABELS[originalKind]}」にしてください`,
      field: "replacement.kind",
    },
  ]);
}

export interface CorrectJournalEntryResult extends VoidJournalEntryResult {
  /** The new entry; `voided.replacedById` points to it. */
  replacement: StoredJournalEntry;
}

/**
 * 訂正 (11 §1, §6) in one transaction: 取消 (the reversal, dated like a void) → the replacement,
 * posted as a 伝票 (`sourceKind = manual`, its date as given: a closed date is rejected; its kind
 * 通常・決算整理 or the original's; unchanged rows keep the original's tax) → the original's
 * `replacedById`. The audit log gets the two rows of the void, the replacement's posting and
 * `journal_entry.correct` with the reason. Field errors of the replacement are `replacement.<field>`.
 */
export async function correctJournalEntry(
  db: Db,
  entryId: string,
  input: CorrectEntryInput,
  options: ActorOptions,
): Promise<CorrectJournalEntryResult> {
  const data = correctEntrySchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const target = await lockForReversal(tx, entryId, data.replacement.entryDate);
    assertCorrectionKind(data.replacement.kind, target.kind);
    const { voided, reversal } = await voidJournalEntryInTransaction(tx, entryId, {
      reason: data.reason,
      date: target.date,
      actor: options.actor,
    });
    let replacement: StoredJournalEntry;
    try {
      replacement = await postVoucherInTransaction(tx, data.replacement, options, {
        accountingMethod: target.accountingMethod,
        lines: voided.lines,
      });
    } catch (error) {
      if (error instanceof LedgerValidationError) {
        throw withFields(error, (item) => {
          const field = voucherField(item);
          return field ? `replacement.${field}` : undefined;
        });
      }
      throw error;
    }
    await tx.journalEntry.update({
      where: { id: entryId },
      data: { replacedById: replacement.id },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "journal_entry.correct",
      entity: "journal_entry",
      entityId: entryId,
      before: { replacedById: null },
      after: { replacedById: replacement.id },
      reason: data.reason,
    });
    return { voided: await loadStoredEntry(tx, entryId), reversal, replacement };
  });
}

// ---------------------------------------------------------------------------
// Reads: the list (仕訳帳)
// ---------------------------------------------------------------------------

export const ENTRY_PAGE_SIZE = 50;

/** The filters of the list; left out = not narrowed (`status` defaults to 登録済み). */
export type JournalEntryFilters = Partial<Omit<EntriesFilter, "page">>;

export interface EntrySideSummary {
  /** The first line on the side. */
  accountName: string;
  subAccountName: string | null;
  /** Further lines on the same side (「ほか n 行」). */
  others: number;
}

export interface JournalEntryListRow {
  id: string;
  fiscalYearNo: number;
  no: number;
  entryDate: CalendarDate;
  description: string;
  kind: EntryKind;
  sourceKind: SourceKind;
  status: EntryStatus;
  debit: EntrySideSummary | null;
  credit: EntrySideSummary | null;
  /** The debit total. */
  amount: Money;
  /** The segment of the revenue and expense lines: the first one, `others` when there are more. */
  segment: { name: string; others: boolean } | null;
  /** Set on a reversal: the entry it cancels. */
  reversalOf: { id: string; no: number } | null;
  /** Set on a corrected entry: its replacement. */
  replacedBy: { id: string; no: number } | null;
  /** On or before the fiscal year's close (締め済み). */
  isLocked: boolean;
}

export interface JournalEntryPage {
  rows: JournalEntryListRow[];
  /** Entries matching the filters (all pages). */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

function entriesWhere(filters: JournalEntryFilters): Prisma.JournalEntryWhereInput {
  const and: Prisma.JournalEntryWhereInput[] = [];
  if (filters.from || filters.to) {
    and.push({
      entryDate: {
        ...(filters.from ? { gte: toDbDate(filters.from) } : {}),
        ...(filters.to ? { lte: toDbDate(filters.to) } : {}),
      },
    });
  }
  // 登録済み: the entries in force (no reversals). 取消済み: the voided entries and the reversals
  // that cancel them, side by side. すべて: everything.
  const status = filters.status ?? "posted";
  if (status === "posted") and.push({ status: "posted", kind: { not: "reversal" } });
  if (status === "voided") and.push({ OR: [{ status: "voided" }, { kind: "reversal" }] });
  if (filters.account) and.push({ lines: { some: { accountId: filters.account } } });
  if (filters.partner) and.push({ lines: { some: { partnerId: filters.partner } } });
  if (filters.segment) and.push({ lines: { some: { segmentId: filters.segment } } });
  if (filters.tag) {
    and.push({ lines: { some: { memoTags: { some: { memoTagId: filters.tag } } } } });
  }
  if (filters.q) {
    and.push({
      OR: [
        { description: { contains: filters.q, mode: "insensitive" } },
        { lines: { some: { description: { contains: filters.q, mode: "insensitive" } } } },
      ],
    });
  }
  return { AND: and };
}

const listInclude = {
  fiscalYear: { select: { no: true, lockedThrough: true } },
  reversalOf: { select: { id: true, no: true } },
  replacedBy: { select: { id: true, no: true } },
  lines: {
    orderBy: { lineNo: "asc" },
    select: {
      side: true,
      amount: true,
      account: { select: { name: true, kind: true } },
      subAccount: { select: { name: true } },
      segment: { select: { name: true } },
    },
  },
} as const;

type ListRow = Prisma.JournalEntryGetPayload<{ include: typeof listInclude }>;
type ListLine = ListRow["lines"][number];

const PROFIT_AND_LOSS: ReadonlySet<AccountKind> = new Set(["revenue", "expense"]);

function sideSummary(lines: ListLine[], side: Side): EntrySideSummary | null {
  const onSide = lines.filter((line) => line.side === side);
  const [first] = onSide;
  if (!first) return null;
  return {
    accountName: first.account.name,
    subAccountName: first.subAccount?.name ?? null,
    others: onSide.length - 1,
  };
}

function segmentSummary(lines: ListLine[]): JournalEntryListRow["segment"] {
  const names = [
    ...new Set(
      lines.flatMap((line) =>
        PROFIT_AND_LOSS.has(line.account.kind) && line.segment ? [line.segment.name] : [],
      ),
    ),
  ];
  const [first] = names;
  return first ? { name: first, others: names.length > 1 } : null;
}

function toListRow(row: ListRow): JournalEntryListRow {
  const entryDate = fromDbDate(row.entryDate);
  const lockedThrough = fromDbDateOrNull(row.fiscalYear.lockedThrough);
  return {
    id: row.id,
    fiscalYearNo: row.fiscalYear.no,
    no: row.no,
    entryDate,
    description: row.description,
    kind: row.kind,
    sourceKind: row.sourceKind,
    status: row.status,
    debit: sideSummary(row.lines, "debit"),
    credit: sideSummary(row.lines, "credit"),
    amount: row.lines.reduce(
      (total, line) => (line.side === "debit" ? total + line.amount : total),
      0n,
    ),
    segment: segmentSummary(row.lines),
    reversalOf: row.reversalOf,
    replacedBy: row.replacedBy,
    isLocked: lockedThrough !== null && entryDate <= lockedThrough,
  };
}

/**
 * The journal (仕訳帳, 11 §3): newest date first, then the highest number, `pageSize` (50) per page.
 * A page past the end shows the last page.
 */
export async function listJournalEntries(
  db: Db,
  filters: JournalEntryFilters,
  page = 1,
  options: { pageSize?: number } = {},
): Promise<JournalEntryPage> {
  const pageSize = options.pageSize ?? ENTRY_PAGE_SIZE;
  const where = entriesWhere(filters);
  const total = await db.journalEntry.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Math.trunc(page)), pageCount);
  const rows = await db.journalEntry.findMany({
    where,
    orderBy: [{ entryDate: "desc" }, { no: "desc" }, { id: "desc" }],
    skip: (current - 1) * pageSize,
    take: pageSize,
    include: listInclude,
  });
  return { rows: rows.map(toListRow), total, page: current, pageSize, pageCount };
}

// ---------------------------------------------------------------------------
// Reads: the detail
// ---------------------------------------------------------------------------

export interface JournalEntryDetailLine {
  lineNo: number;
  side: Side;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountKind: AccountKind;
  subAccountId: string | null;
  subAccountName: string | null;
  amount: Money;
  taxCategoryCode: string;
  taxCategoryName: string;
  taxAmount: Money;
  segmentId: string | null;
  segmentName: string | null;
  partnerId: string | null;
  partnerName: string | null;
  description: string | null;
  memoTags: { id: string; name: string }[];
}

export interface JournalEntryDetail {
  id: string;
  no: number;
  entryDate: CalendarDate;
  description: string;
  kind: EntryKind;
  sourceKind: SourceKind;
  sourceId: string | null;
  status: EntryStatus;
  voidReason: string | null;
  voidedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  postedAt: Date;
  fiscalYear: {
    id: string;
    no: number;
    startDate: CalendarDate;
    endDate: CalendarDate;
    lockedThrough: CalendarDate | null;
    status: FiscalYearStatus;
    accountingMethod: AccountingMethod;
  };
  lines: JournalEntryDetailLine[];
  debitTotal: Money;
  creditTotal: Money;
  /** Set on a reversal: the entry it cancels. */
  reversalOf: EntryRef | null;
  /** Set on a voided entry: the reversal that cancels it. */
  reversal: EntryRef | null;
  /** Set on a corrected entry: its replacement. */
  replacedBy: EntryRef | null;
  /** The entries this one corrects. */
  replaces: EntryRef[];
  /** On or before the fiscal year's close (締め済み). */
  isLocked: boolean;
  firstOpenDate: CalendarDate | null;
  /** The date a void or a correction gives the reversal; `null` when it cannot be voided. */
  reversalDate: CalendarDate | null;
  /** Why it cannot be voided or corrected (owner-facing), `null` when it can. */
  blockedReason: string | null;
}

const detailInclude = {
  fiscalYear: true,
  lines: {
    orderBy: { lineNo: "asc" },
    include: {
      account: { select: { code: true, name: true, kind: true } },
      subAccount: { select: { name: true } },
      taxCategory: { select: { name: true } },
      segment: { select: { name: true } },
      partner: { select: { name: true } },
      memoTags: {
        include: { memoTag: { select: { id: true, name: true } } },
        orderBy: { memoTag: { name: "asc" } },
      },
    },
  },
  reversalOf: { select: entryRefSelect },
  reversal: { select: entryRefSelect },
  replacedBy: { select: entryRefSelect },
  replaces: { select: entryRefSelect, orderBy: { no: "asc" } },
} as const;

/** One entry with the names of its lines, its chain and its close state; `null` when not found. */
export async function getJournalEntryDetail(
  db: Db,
  entryId: string,
): Promise<JournalEntryDetail | null> {
  const row = await db.journalEntry.findUnique({ where: { id: entryId }, include: detailInclude });
  if (!row) return null;
  const entryDate = fromDbDate(row.entryDate);
  const period = toFiscalYearContext(row.fiscalYear);
  const plan = reversalPlan({ status: row.status, kind: row.kind, entryDate }, row.fiscalYear);
  // An entry the invoices posted is voided there (decision 2026-10-29), never on this screen.
  const owned = await ownedEntryProblem(db, row, undefined);
  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const line of row.lines) {
    if (line.side === "debit") debitTotal += line.amount;
    else creditTotal += line.amount;
  }
  return {
    id: row.id,
    no: row.no,
    entryDate,
    description: row.description,
    kind: row.kind,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    status: row.status,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    postedAt: row.postedAt,
    fiscalYear: {
      id: row.fiscalYear.id,
      no: row.fiscalYear.no,
      startDate: period.startDate,
      endDate: period.endDate,
      lockedThrough: period.lockedThrough,
      status: period.status,
      accountingMethod: period.accountingMethod,
    },
    lines: row.lines.map((line) => ({
      lineNo: line.lineNo,
      side: line.side,
      accountId: line.accountId,
      accountCode: line.account.code,
      accountName: line.account.name,
      accountKind: line.account.kind,
      subAccountId: line.subAccountId,
      subAccountName: line.subAccount?.name ?? null,
      amount: line.amount,
      taxCategoryCode: line.taxCategoryCode,
      taxCategoryName: line.taxCategory.name,
      taxAmount: line.taxAmount,
      segmentId: line.segmentId,
      segmentName: line.segment?.name ?? null,
      partnerId: line.partnerId,
      partnerName: line.partner?.name ?? null,
      description: line.description,
      memoTags: line.memoTags.map((tag) => tag.memoTag),
    })),
    debitTotal,
    creditTotal,
    reversalOf: row.reversalOf ? toEntryRef(row.reversalOf) : null,
    reversal: row.reversal ? toEntryRef(row.reversal) : null,
    replacedBy: row.replacedBy ? toEntryRef(row.replacedBy) : null,
    replaces: row.replaces.map(toEntryRef),
    isLocked: isLocked(entryDate, period),
    firstOpenDate: firstOpenDate(period),
    reversalDate: owned ? null : plan.date,
    blockedReason: plan.blocked?.message ?? owned,
  };
}

/** The entries whose history the detail shows: itself and the ones chained to it. */
export function chainedEntryIds(detail: JournalEntryDetail): string[] {
  return [
    detail.id,
    ...[detail.reversal, detail.replacedBy, detail.reversalOf].flatMap((ref) =>
      ref ? [ref.id] : [],
    ),
    ...detail.replaces.map((ref) => ref.id),
  ];
}

export interface EntryHistoryRow {
  id: string;
  at: Date;
  actor: string;
  action: string;
  entryId: string | null;
  /** The number of the entry the row is about. */
  entryNo: number | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string | null;
}

/** The audit log of the given entries (`entity = journal_entry`), oldest first (11 §5). Read only. */
export async function loadEntryHistory(
  db: Db,
  entryIds: readonly string[],
): Promise<EntryHistoryRow[]> {
  const ids = [...new Set(entryIds)];
  if (ids.length === 0) return [];
  const rows = await db.auditLog.findMany({
    where: { entity: "journal_entry", entityId: { in: ids } },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  const entries = await db.journalEntry.findMany({
    where: { id: { in: ids } },
    select: { id: true, no: true },
  });
  const numbers = new Map(entries.map((entry) => [entry.id, entry.no]));
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    entryId: row.entityId,
    entryNo: row.entityId ? (numbers.get(row.entityId) ?? null) : null,
    before: row.before,
    after: row.after,
    reason: row.reason,
  }));
}

// ---------------------------------------------------------------------------
// Reads: the options of the forms
// ---------------------------------------------------------------------------

export interface EntryFormFiscalYear {
  id: string;
  no: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
  lockedThrough: CalendarDate | null;
  status: FiscalYearStatus;
  consumptionTax: ConsumptionTaxMethod;
  accountingMethod: AccountingMethod;
}

export interface EntryFormWallet {
  id: string;
  name: string;
  kind: WalletKind;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountKind: AccountKind;
  subAccountId: string | null;
  subAccountName: string | null;
  defaultSegmentId: string | null;
  isActive: boolean;
}

export interface EntryFormAccount {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  group: AccountGroup;
  defaultTaxCategoryCode: string | null;
  defaultSegmentId: string | null;
  isCashLike: boolean;
  isActive: boolean;
}

export interface EntryFormOptions {
  fiscalYears: EntryFormFiscalYear[];
  wallets: EntryFormWallet[];
  accounts: EntryFormAccount[];
  subAccounts: { id: string; accountId: string; name: string; isActive: boolean }[];
  taxCategories: {
    code: string;
    name: string;
    kind: TaxKind;
    direction: TaxDirection;
    isActive: boolean;
  }[];
  segments: { id: string; code: string; name: string; isActive: boolean }[];
  partners: {
    id: string;
    name: string;
    defaultAccountId: string | null;
    defaultSegmentId: string | null;
    defaultTaxCategoryCode: string | null;
    isActive: boolean;
  }[];
  memoTags: { id: string; name: string; isActive: boolean }[];
  /** Every rule (disabled ones too): the forms resolve the rate with `resolveTaxRule`. */
  taxRules: TaxRateRule[];
}

/**
 * The choices of the transaction forms (11 §4): active rows, plus the rows named in `includeIds`
 * even when inactive (the lines of an entry being corrected keep their values; `isActive` tells).
 */
export async function loadEntryFormOptions(
  db: Db,
  options: { includeIds?: readonly string[] } = {},
): Promise<EntryFormOptions> {
  const include = [...new Set(options.includeIds ?? [])];
  const activeOr = { OR: [{ isActive: true }, { id: { in: include } }] };
  const fiscalYears = await db.fiscalYear.findMany({ orderBy: { no: "asc" } });
  const wallets = await db.wallet.findMany({
    where: activeOr,
    orderBy: { id: "asc" },
    include: {
      account: { select: { code: true, name: true, kind: true } },
      subAccount: { select: { name: true } },
    },
  });
  const accounts = await db.account.findMany({ where: activeOr, orderBy: { code: "asc" } });
  const subAccounts = await db.subAccount.findMany({
    where: activeOr,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, accountId: true, name: true, isActive: true },
  });
  const taxCategories = await db.taxCategory.findMany({
    where: { OR: [{ isActive: true }, { code: { in: include } }] },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: { code: true, name: true, kind: true, direction: true, isActive: true },
  });
  const segments = await db.segment.findMany({
    where: activeOr,
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: { id: true, code: true, name: true, isActive: true },
  });
  const partners = await db.partner.findMany({
    where: activeOr,
    orderBy: [{ nameKana: { sort: "asc", nulls: "last" } }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      defaultAccountId: true,
      defaultSegmentId: true,
      defaultTaxCategoryCode: true,
      isActive: true,
    },
  });
  const memoTags = await db.memoTag.findMany({
    where: activeOr,
    orderBy: { name: "asc" },
    select: { id: true, name: true, isActive: true },
  });
  return {
    fiscalYears: fiscalYears.map((year) => ({
      id: year.id,
      no: year.no,
      ...toFiscalYearContext(year),
    })),
    wallets: wallets.map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
      kind: wallet.kind,
      accountId: wallet.accountId,
      accountCode: wallet.account.code,
      accountName: wallet.account.name,
      accountKind: wallet.account.kind,
      subAccountId: wallet.subAccountId,
      subAccountName: wallet.subAccount?.name ?? null,
      defaultSegmentId: wallet.defaultSegmentId,
      isActive: wallet.isActive,
    })),
    accounts: accounts.map((account) => ({
      id: account.id,
      code: account.code,
      name: account.name,
      kind: account.kind,
      group: account.group,
      defaultTaxCategoryCode: account.defaultTaxCategoryCode,
      defaultSegmentId: account.defaultSegmentId,
      isCashLike: account.isCashLike,
      isActive: account.isActive,
    })),
    subAccounts,
    taxCategories,
    segments,
    partners,
    memoTags,
    taxRules: await loadTaxRules(db),
  };
}
