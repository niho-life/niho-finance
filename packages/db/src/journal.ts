import {
  assertValidEntry,
  buildReversal,
  displayDate,
  LedgerValidationError,
  type CalendarDate,
  type JournalEntryInput,
  type JournalLineInput,
  type RecordedJournalEntry,
  type ValidationContext,
} from "@niho-finance/ledger";
import type { FiscalYear, Prisma, PrismaClient } from "@prisma/client";
import { appendAuditLog } from "./audit";
import { fromDbDate, toDbDate } from "./dates";
import { newId } from "./ids";
import { toFiscalYearContext } from "./queries";

type Tx = Prisma.TransactionClient;

/** Room for 20+ concurrent postings that queue on the fiscal year lock. */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export interface PostJournalEntryInput extends JournalEntryInput {
  /** Defaults to the fiscal year that contains `entryDate`. */
  fiscalYearId?: string;
}

export interface ActorOptions {
  /** Recorded as `created_by` and in the audit log. */
  actor: string;
}

export interface VoidJournalEntryOptions extends ActorOptions {
  reason: string;
  /** Date of the reversal. Defaults to the original date; pass the first open date when its month is closed. */
  date?: CalendarDate;
}

export interface StoredJournalLine extends JournalLineInput {
  id: string;
  lineNo: number;
  subAccountId: string | null;
  segmentId: string | null;
  partnerId: string | null;
  description: string | null;
  memoTagIds: string[];
}

export interface StoredJournalEntry extends RecordedJournalEntry {
  fiscalYearId: string;
  sourceId: string | null;
  reversalOfId: string | null;
  replacedById: string | null;
  voidReason: string | null;
  voidedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  postedAt: Date;
  lines: StoredJournalLine[];
}

export interface VoidJournalEntryResult {
  /** The original entry, now `voided`. */
  voided: StoredJournalEntry;
  /** The reversing entry that cancels it. */
  reversal: StoredJournalEntry;
}

export class JournalEntryNotFoundError extends Error {
  readonly entryId: string;

  constructor(entryId: string) {
    super(`journal entry ${entryId} was not found`);
    this.name = "JournalEntryNotFoundError";
    this.entryId = entryId;
  }
}

/**
 * Posts an entry atomically: lock the fiscal year → validate with the ledger rules →
 * take the next number → insert the entry and its lines → append the audit log.
 */
export async function postJournalEntry(
  prisma: PrismaClient,
  input: PostJournalEntryInput,
  options: ActorOptions,
): Promise<StoredJournalEntry> {
  return prisma.$transaction(
    (tx) => postJournalEntryInTransaction(tx, input, options),
    TRANSACTION_OPTIONS,
  );
}

/** `postJournalEntry` inside a transaction the caller already holds (e.g. the seed). */
export async function postJournalEntryInTransaction(
  tx: Tx,
  input: PostJournalEntryInput,
  options: ActorOptions,
): Promise<StoredJournalEntry> {
  const fiscalYear = await lockFiscalYear(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.entryDate,
  });
  const entry = await insertEntry(tx, fiscalYear, input, options.actor);
  await appendAuditLog(tx, {
    actor: options.actor,
    action: "journal_entry.post",
    entity: "journal_entry",
    entityId: entry.id,
    after: entry,
  });
  return entry;
}

/**
 * Voids an entry: registers the reversing entry (debit and credit swapped, `kind = reversal`)
 * and marks the original `voided`. Nothing is rewritten; both entries stay in the ledger.
 */
export async function voidJournalEntry(
  prisma: PrismaClient,
  entryId: string,
  options: VoidJournalEntryOptions,
): Promise<VoidJournalEntryResult> {
  return prisma.$transaction(
    (tx) => voidJournalEntryInTransaction(tx, entryId, options),
    TRANSACTION_OPTIONS,
  );
}

/** `voidJournalEntry` inside a transaction the caller already holds. */
export async function voidJournalEntryInTransaction(
  tx: Tx,
  entryId: string,
  options: VoidJournalEntryOptions,
): Promise<VoidJournalEntryResult> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "journal_entry" WHERE "id" = ${entryId} FOR UPDATE`;
  if (locked.length === 0) throw new JournalEntryNotFoundError(entryId);

  const original = await loadStoredEntry(tx, entryId);
  const reason = options.reason.trim();
  const reversalInput = buildReversal(original, {
    date: options.date ?? original.entryDate,
    reason,
  });
  const fiscalYear = await lockFiscalYear(tx, { date: reversalInput.entryDate });
  const reversal = await insertEntry(tx, fiscalYear, reversalInput, options.actor);

  await tx.journalEntry.update({
    where: { id: entryId },
    data: { status: "voided", voidedAt: new Date(), voidReason: reason },
  });
  const voided = await loadStoredEntry(tx, entryId);

  await appendAuditLog(tx, {
    actor: options.actor,
    action: "journal_entry.post",
    entity: "journal_entry",
    entityId: reversal.id,
    after: reversal,
    reason,
  });
  await appendAuditLog(tx, {
    actor: options.actor,
    action: "journal_entry.void",
    entity: "journal_entry",
    entityId: entryId,
    before: headerOf(original),
    after: headerOf(voided),
    reason,
  });
  return { voided, reversal };
}

/** Loads one entry with its lines in line order. */
export async function loadStoredEntry(
  db: Tx | PrismaClient,
  entryId: string,
): Promise<StoredJournalEntry> {
  const row = await db.journalEntry.findUnique({
    where: { id: entryId },
    include: {
      lines: { orderBy: { lineNo: "asc" }, include: { memoTags: { select: { memoTagId: true } } } },
    },
  });
  if (!row) throw new JournalEntryNotFoundError(entryId);
  return {
    id: row.id,
    fiscalYearId: row.fiscalYearId,
    no: row.no,
    entryDate: fromDbDate(row.entryDate),
    description: row.description,
    kind: row.kind,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    status: row.status,
    reversalOfId: row.reversalOfId,
    replacedById: row.replacedById,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    postedAt: row.postedAt,
    lines: row.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      side: line.side,
      accountId: line.accountId,
      subAccountId: line.subAccountId,
      amount: line.amount,
      taxCategoryCode: line.taxCategoryCode,
      taxAmount: line.taxAmount,
      segmentId: line.segmentId,
      partnerId: line.partnerId,
      description: line.description,
      memoTagIds: line.memoTags.map((tag) => tag.memoTagId),
    })),
  };
}

function headerOf(entry: StoredJournalEntry): Omit<StoredJournalEntry, "lines"> {
  const { lines: _lines, ...header } = entry;
  return header;
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/**
 * Locks the fiscal year row until the transaction ends. Numbering and the close check
 * (`lockedThrough`, `status`) are then serialized per fiscal year.
 */
async function lockFiscalYear(
  tx: Tx,
  target: { fiscalYearId?: string | undefined; date: CalendarDate },
): Promise<FiscalYear> {
  let fiscalYearId = target.fiscalYearId;
  if (!fiscalYearId) {
    const day = toDbDate(target.date);
    const candidates = await tx.fiscalYear.findMany({
      where: { startDate: { lte: day }, endDate: { gte: day } },
      select: { id: true },
    });
    const [only, ...others] = candidates;
    if (!only || others.length > 0) {
      throw new LedgerValidationError([
        {
          code: "OUT_OF_FISCAL_YEAR",
          message: only
            ? `${displayDate(target.date)} を含む会計期間が複数あります`
            : `${displayDate(target.date)} を含む会計期間がありません。会計期間の中の日付にするか、設定 › 会計期間 で期を作ってください`,
        },
      ]);
    }
    fiscalYearId = only.id;
  }
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "fiscal_year" WHERE "id" = ${fiscalYearId} FOR UPDATE`;
  if (locked.length === 0) {
    throw new LedgerValidationError([
      { code: "OUT_OF_FISCAL_YEAR", message: "会計期間がありません" },
    ]);
  }
  return tx.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } });
}

async function loadValidationContext(
  tx: Tx,
  fiscalYear: FiscalYear,
  input: JournalEntryInput,
): Promise<ValidationContext> {
  const accountIds = unique(input.lines.map((line) => line.accountId));
  const subAccountIds = unique(
    input.lines.flatMap((line) => (line.subAccountId ? [line.subAccountId] : [])),
  );
  const accounts = await tx.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, code: true, kind: true, isActive: true },
  });
  const subAccounts = await tx.subAccount.findMany({
    where: { id: { in: subAccountIds } },
    select: { id: true, accountId: true },
  });
  const taxCategories = await tx.taxCategory.findMany({
    where: { isActive: true },
    select: { code: true },
  });
  return {
    fiscalYear: toFiscalYearContext(fiscalYear),
    accounts: new Map(accounts.map((account) => [account.id, account])),
    subAccounts: new Map(subAccounts.map((subAccount) => [subAccount.id, subAccount])),
    taxCategoryCodes: new Set(taxCategories.map((category) => category.code)),
  };
}

/** Takes the next number of the fiscal year. Rolled back with the transaction, so no gaps. */
async function allocateEntryNo(tx: Tx, fiscalYearId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ no: number }[]>`
    UPDATE "fiscal_year"
       SET "next_entry_no" = "next_entry_no" + 1, "updated_at" = now()
     WHERE "id" = ${fiscalYearId}
    RETURNING "next_entry_no" - 1 AS "no"`;
  if (!row) throw new Error(`fiscal year ${fiscalYearId} disappeared while numbering`);
  return row.no;
}

async function insertEntry(
  tx: Tx,
  fiscalYear: FiscalYear,
  input: JournalEntryInput,
  actor: string,
): Promise<StoredJournalEntry> {
  assertValidEntry(input, await loadValidationContext(tx, fiscalYear, input));
  const no = await allocateEntryNo(tx, fiscalYear.id);
  const id = newId();
  const memoTags: { journalLineId: string; memoTagId: string }[] = [];
  const lines = input.lines.map((line, index) => {
    const lineId = newId();
    for (const memoTagId of unique(line.memoTagIds ?? []))
      memoTags.push({ journalLineId: lineId, memoTagId });
    return {
      id: lineId,
      lineNo: index + 1,
      side: line.side,
      accountId: line.accountId,
      subAccountId: line.subAccountId ?? null,
      amount: line.amount,
      taxCategoryCode: line.taxCategoryCode,
      taxAmount: line.taxAmount,
      segmentId: line.segmentId ?? null,
      partnerId: line.partnerId ?? null,
      description: line.description ?? null,
    };
  });
  await tx.journalEntry.create({
    data: {
      id,
      fiscalYearId: fiscalYear.id,
      no,
      entryDate: toDbDate(input.entryDate),
      description: input.description,
      kind: input.kind,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId ?? null,
      reversalOfId: input.reversalOfId ?? null,
      createdBy: actor,
      lines: { create: lines },
    },
  });
  if (memoTags.length > 0) await tx.journalLineMemoTag.createMany({ data: memoTags });
  return loadStoredEntry(tx, id);
}
