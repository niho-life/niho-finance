/**
 * Evidence repository (13-documents §8.3): 証憑の登録・項目の変更・無効化・差し替え・紐づけ・検索・
 * 索引簿・証憑の規程. Every write is validated with the schemas in `schemas.ts`, runs in one
 * transaction and appends to the audit log. A document is never deleted (DB guard): a wrong one is
 * voided with a reason (its file and links stay), a corrected file replaces it (a new row with
 * `supersedesId`; the old one is voided). Writes take a client or a transaction (`Db`), so a caller
 * can register and link in one transaction.
 */
import {
  abs,
  addDays,
  daysBetween,
  DOCUMENT_CANDIDATE_LIMIT,
  DOCUMENT_CANDIDATE_WINDOW_DAYS,
  DOCUMENT_LINK_KIND_LABELS,
  DOCUMENT_UNDATED_CANDIDATE_DAYS,
  DOCUMENT_UNPRICED_CANDIDATE_DAYS,
  isUnsortedDocument,
  type CalendarDate,
  type DocumentIndexRow,
  type DocumentKind,
  type DocumentLinkKind,
  type DocumentSource,
  type DocumentStatus,
  type DocumentTab,
  type EntryStatus,
  type Money,
} from "@niho-finance/ledger";
import type { Company, Document, Prisma, WalletTransactionStatus } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, toDbDate, todayInJapan } from "./dates";
import { SettingsError } from "./errors";
import { newId } from "./ids";
import {
  documentLinkSchema,
  documentRegisterSchema,
  documentReplaceSchema,
  documentUpdateSchema,
  documentVoidSchema,
  recordsPolicySchema,
  type DocumentLinkInput,
  type DocumentRegisterInput,
  type DocumentReplaceInput,
  type DocumentSearchFilters,
  type DocumentUpdateInput,
  type DocumentVoidInput,
  type RecordsPolicyInput,
} from "./schemas";
import { requireCompanyRow, type WriteOptions } from "./settings";
import { lockSettings, runInTransaction, type Tx } from "./transaction";

/** Rows per page of the list (13 §3.3). */
export const DOCUMENT_PAGE_SIZE = 50;

const NOT_FOUND = "証憑が見つかりません。画面を読み込み直してください";
const VOIDED_IS_FIXED = "無効にした証憑は変えられません。必要なら差し替えてください";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentRef {
  id: string;
  kind: DocumentKind;
  originalName: string | null;
}

/** The other side of a link, summarized for the screens and the audit log. */
export type DocumentLinkTarget =
  | {
      kind: "journal_entry";
      id: string;
      /** 第 n 期 */
      fiscalYearNo: number;
      no: number;
      entryDate: CalendarDate;
      description: string;
      /** Debit total. */
      amount: Money;
      status: EntryStatus;
    }
  | {
      kind: "wallet_transaction";
      id: string;
      walletId: string;
      walletName: string;
      txnDate: CalendarDate;
      /** Signed as stored (deposits into the wallet are positive). */
      amount: Money;
      description: string;
      status: WalletTransactionStatus;
    }
  | { kind: "invoice"; id: string; number: string };

export type DocumentLinkEntry = DocumentLinkTarget & { linkedAt: Date; linkedBy: string };

export interface DocumentHistoryEntry {
  id: string;
  at: Date;
  actor: string;
  /** `document.create` / `document.update` / … (labels: `DOCUMENT_AUDIT_ACTION_LABELS`). */
  action: string;
  reason: string | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
}

export interface DocumentDetail {
  id: string;
  kind: DocumentKind;
  status: DocumentStatus;
  source: DocumentSource;
  storageKey: string;
  sha256: string;
  mime: string;
  byteSize: number;
  originalName: string | null;
  uploadedBy: string;
  uploadedAt: Date;
  txnDate: CalendarDate | null;
  /** Tax-inclusive whole yen. */
  amount: Money | null;
  partnerId: string | null;
  /** Free-text name, set only when no partner of the master is chosen. */
  partnerName: string | null;
  partner: { id: string; name: string; isActive: boolean } | null;
  /** What the screens show as 取引先: the master's name, else the free-text name. */
  displayPartnerName: string | null;
  invoiceRegistrationNumber: string | null;
  note: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  /** 未整理: the date, the amount or the partner is empty (it stays in the inbox when linked). */
  unsorted: boolean;
  /** The document this one replaced. */
  supersedes: DocumentRef | null;
  /** The document that replaced this one. */
  supersededBy: DocumentRef | null;
  links: DocumentLinkEntry[];
  /** The audit log of this document, oldest first. */
  history: DocumentHistoryEntry[];
}

export interface DocumentRegistration {
  document: DocumentDetail;
  /** `true`: a document with the same file (SHA-256) already existed; nothing was written. */
  duplicate: boolean;
}

export interface DocumentLinkCounts {
  journalEntries: number;
  walletTransactions: number;
  invoices: number;
}

export interface DocumentListRow {
  id: string;
  kind: DocumentKind;
  status: DocumentStatus;
  txnDate: CalendarDate | null;
  amount: Money | null;
  partnerId: string | null;
  /** The master's name, else the free-text name. */
  partnerName: string | null;
  originalName: string | null;
  mime: string;
  voidReason: string | null;
  unsorted: boolean;
  linkCounts: DocumentLinkCounts;
  uploadedAt: Date;
}

export interface DocumentSearchResult {
  rows: DocumentListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DocumentCounts {
  inbox: number;
  all: number;
  voided: number;
}

/** A document linked to an entry / statement line / invoice (voided ones too, with the reason). */
export interface LinkedDocument {
  id: string;
  kind: DocumentKind;
  status: DocumentStatus;
  originalName: string | null;
  mime: string;
  txnDate: CalendarDate | null;
  amount: Money | null;
  partnerName: string | null;
  voidReason: string | null;
  voidedAt: Date | null;
  linkedAt: Date;
  linkedBy: string;
}

export interface WalletTransactionCandidate {
  id: string;
  walletId: string;
  walletName: string;
  txnDate: CalendarDate;
  /** Signed as stored; its absolute value equals the document's amount. */
  amount: Money;
  description: string;
  counterparty: string | null;
  status: WalletTransactionStatus;
  /** Days between the line and the document's date (or upload day). */
  daysApart: number;
  /** Other documents (not voided) already linked to the line: listed after the lines without. */
  documentCount: number;
}

export interface JournalEntryCandidate {
  id: string;
  fiscalYearNo: number;
  no: number;
  entryDate: CalendarDate;
  description: string;
  /** Debit total; equals the document's amount. */
  amount: Money;
  daysApart: number;
  /** Other documents (not voided) already linked to the entry: listed after the entries without. */
  documentCount: number;
}

export interface DocumentLinkCandidates {
  /**
   * `amount`: lines and entries of the same amount. `date`: the amount is still empty, so pending
   * lines of any amount near the date (no entries).
   */
  basis: "amount" | "date";
  walletTransactions: WalletTransactionCandidate[];
  journalEntries: JournalEntryCandidate[];
}

/** An index row plus the file's storage key (the zip export of S7 reads the files). */
export interface DocumentIndexRecord extends DocumentIndexRow {
  storageKey: string;
}

/** What `GET /api/documents/[id]/file` needs. */
export interface DocumentFile {
  id: string;
  storageKey: string;
  mime: string;
  originalName: string | null;
  status: DocumentStatus;
}

export interface RecordsPolicy {
  /** 施行日; `null` while the policy is not in force (未制定). */
  effectiveOn: CalendarDate | null;
  manager: string | null;
  operator: string | null;
  /** Version of the text that was put in force. */
  version: string | null;
  /** 商号: filled into the text. */
  companyName: string;
  /** 代表者: the default 管理責任者. */
  representative: string | null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function audit(
  tx: Tx,
  options: WriteOptions,
  entry: {
    action: string;
    entityId: string;
    entity?: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
  },
): Promise<void> {
  await appendAuditLog(tx, { actor: options.actor, entity: "document", ...entry });
}

/** Whether `patch` changes `row` (dates by time, bigint by value). */
function changes(row: object, patch: object): boolean {
  const current = row as Record<string, unknown>;
  return Object.entries(patch).some(([key, value]) => {
    const before = current[key];
    if (before instanceof Date && value instanceof Date) {
      return before.getTime() !== value.getTime();
    }
    return before !== value;
  });
}

/** Locks the document row until the transaction ends (link / unlink / void serialize on it). */
async function lockDocument(tx: Tx, id: string, missing = NOT_FOUND): Promise<Document> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "document" WHERE "id" = ${id} FOR UPDATE`;
  const row = locked.length > 0 ? await tx.document.findUnique({ where: { id } }) : null;
  if (!row) throw new SettingsError(missing);
  return row;
}

/** Serializes registrations of the same file, so a file is never stored twice. */
async function lockSha256(tx: Tx, sha256: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${sha256}))::text AS "locked"`;
}

async function findActiveBySha256(db: Db, sha256: string): Promise<DocumentRef | null> {
  return db.document.findFirst({
    where: { sha256, status: { not: "voided" } },
    orderBy: [{ uploadedAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true, originalName: true },
  });
}

interface PartnerFields {
  partnerId: string | null;
  partnerName: string | null;
}

/**
 * Applies a partner change to `base`: a partner of the master clears the free-text name, a
 * free-text name clears the partner. At most one of the two is ever stored.
 */
function mergePartner(
  base: PartnerFields,
  input: { partnerId?: string | null | undefined; partnerName?: string | null | undefined },
): PartnerFields {
  if (input.partnerId) return { partnerId: input.partnerId, partnerName: null };
  let { partnerId, partnerName } = base;
  if (input.partnerId === null) partnerId = null;
  if (input.partnerName !== undefined) {
    partnerName = input.partnerName;
    if (partnerName !== null) partnerId = null;
  }
  return { partnerId, partnerName };
}

/** A newly chosen partner must exist and be active (an already stored one may stay as it is). */
async function assertPartnerChoosable(
  tx: Tx,
  partnerId: string | null,
  storedPartnerId: string | null,
): Promise<void> {
  if (partnerId === null || partnerId === storedPartnerId) return;
  const partner = await tx.partner.findUnique({ where: { id: partnerId } });
  if (!partner) {
    throw new SettingsError("取引先が見つかりません。画面を読み込み直してください", {
      field: "partnerId",
    });
  }
  if (!partner.isActive) {
    throw new SettingsError(
      "無効にした取引先は選べません。設定 › 取引先 で有効にするか、別の取引先を選んでください",
      { field: "partnerId" },
    );
  }
}

function dbDateOrNull(date: CalendarDate | null): Date | null {
  return date === null ? null : toDbDate(date);
}

// ---------------------------------------------------------------------------
// Link targets
// ---------------------------------------------------------------------------

const journalEntrySummarySelect = {
  id: true,
  no: true,
  entryDate: true,
  description: true,
  status: true,
  fiscalYear: { select: { no: true } },
  lines: { select: { side: true, amount: true, partnerId: true } },
} satisfies Prisma.JournalEntrySelect;

const walletTransactionSummarySelect = {
  id: true,
  txnDate: true,
  amount: true,
  descriptionRaw: true,
  status: true,
  wallet: { select: { id: true, name: true } },
} satisfies Prisma.WalletTransactionSelect;

const invoiceSummarySelect = { id: true, number: true } satisfies Prisma.InvoiceSelect;

type JournalEntrySummaryRow = Prisma.JournalEntryGetPayload<{
  select: typeof journalEntrySummarySelect;
}>;
type WalletTransactionSummaryRow = Prisma.WalletTransactionGetPayload<{
  select: typeof walletTransactionSummarySelect;
}>;

function debitTotal(lines: readonly { side: string; amount: bigint }[]): Money {
  return lines.reduce((sum, line) => (line.side === "debit" ? sum + line.amount : sum), 0n);
}

function journalEntryTarget(row: JournalEntrySummaryRow): DocumentLinkTarget {
  return {
    kind: "journal_entry",
    id: row.id,
    fiscalYearNo: row.fiscalYear.no,
    no: row.no,
    entryDate: fromDbDate(row.entryDate),
    description: row.description,
    amount: debitTotal(row.lines),
    status: row.status,
  };
}

function walletTransactionTarget(row: WalletTransactionSummaryRow): DocumentLinkTarget {
  return {
    kind: "wallet_transaction",
    id: row.id,
    walletId: row.wallet.id,
    walletName: row.wallet.name,
    txnDate: fromDbDate(row.txnDate),
    amount: row.amount,
    description: row.descriptionRaw,
    status: row.status,
  };
}

/** What a link fills into the document's empty items (13 §4). */
interface TargetFill {
  txnDate: CalendarDate | null;
  amount: Money | null;
  /** An entry's only partner. */
  partnerId: string | null;
  /** A statement line's counterparty (振込人名など), trimmed. */
  partnerName: string | null;
}

interface LoadedTarget {
  summary: DocumentLinkTarget;
  fill: TargetFill;
}

async function loadLinkTarget(
  db: Db,
  kind: DocumentLinkKind,
  id: string,
): Promise<LoadedTarget | null> {
  switch (kind) {
    case "journal_entry": {
      const row = await db.journalEntry.findUnique({
        where: { id },
        select: journalEntrySummarySelect,
      });
      if (!row) return null;
      const partners = new Set(
        row.lines.flatMap((line) => (line.partnerId ? [line.partnerId] : [])),
      );
      const [onlyPartner] = partners;
      return {
        summary: journalEntryTarget(row),
        fill: {
          txnDate: fromDbDate(row.entryDate),
          amount: debitTotal(row.lines),
          partnerId: partners.size === 1 && onlyPartner ? onlyPartner : null,
          partnerName: null,
        },
      };
    }
    case "wallet_transaction": {
      const row = await db.walletTransaction.findUnique({
        where: { id },
        select: { ...walletTransactionSummarySelect, counterpartyRaw: true },
      });
      if (!row) return null;
      const counterparty = row.counterpartyRaw?.trim() ?? "";
      return {
        summary: walletTransactionTarget(row),
        fill: {
          txnDate: fromDbDate(row.txnDate),
          amount: abs(row.amount),
          partnerId: null,
          partnerName: counterparty === "" ? null : counterparty,
        },
      };
    }
    case "invoice": {
      const row = await db.invoice.findUnique({ where: { id }, select: invoiceSummarySelect });
      if (!row) return null;
      return {
        summary: { kind: "invoice", id: row.id, number: row.number },
        fill: { txnDate: null, amount: null, partnerId: null, partnerName: null },
      };
    }
  }
}

/** The `DocumentLink` column of a target kind. */
function linkTargetColumn(
  kind: DocumentLinkKind,
  id: string,
): { journalEntryId: string } | { walletTransactionId: string } | { invoiceId: string } {
  switch (kind) {
    case "journal_entry":
      return { journalEntryId: id };
    case "wallet_transaction":
      return { walletTransactionId: id };
    case "invoice":
      return { invoiceId: id };
  }
}

/** The document's empty items filled from a newly linked target, or `null` when nothing is empty. */
function fillPatch(row: Document, fill: TargetFill): Prisma.DocumentUncheckedUpdateInput | null {
  const patch: Prisma.DocumentUncheckedUpdateInput = {};
  if (row.txnDate === null && fill.txnDate !== null) patch.txnDate = toDbDate(fill.txnDate);
  if (row.amount === null && fill.amount !== null) patch.amount = fill.amount;
  // The partner only when the document has none (neither of the master nor a free-text name).
  if (row.partnerId === null && row.partnerName === null) {
    if (fill.partnerId !== null) patch.partnerId = fill.partnerId;
    else if (fill.partnerName !== null) patch.partnerName = fill.partnerName;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const documentRefSelect = { id: true, kind: true, originalName: true } as const;

const detailInclude = {
  partner: { select: { id: true, name: true, isActive: true } },
  supersedes: { select: documentRefSelect },
  supersededBy: { select: documentRefSelect, orderBy: { createdAt: "asc" } },
  links: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      journalEntry: { select: journalEntrySummarySelect },
      walletTransaction: { select: walletTransactionSummarySelect },
      invoice: { select: invoiceSummarySelect },
    },
  },
} satisfies Prisma.DocumentInclude;

type DetailRow = Prisma.DocumentGetPayload<{ include: typeof detailInclude }>;

function toLinkEntry(link: DetailRow["links"][number]): DocumentLinkEntry {
  const meta = { linkedAt: link.createdAt, linkedBy: link.createdBy };
  if (link.journalEntry) return { ...journalEntryTarget(link.journalEntry), ...meta };
  if (link.walletTransaction)
    return { ...walletTransactionTarget(link.walletTransaction), ...meta };
  if (link.invoice)
    return { kind: "invoice", id: link.invoice.id, number: link.invoice.number, ...meta };
  throw new Error(`document link ${link.id} has no target`);
}

function toDocumentDetail(row: DetailRow, history: DocumentHistoryEntry[]): DocumentDetail {
  const txnDate = fromDbDateOrNull(row.txnDate);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    source: row.source,
    storageKey: row.storageKey,
    sha256: row.sha256,
    mime: row.mime,
    byteSize: row.byteSize,
    originalName: row.originalName,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt,
    txnDate,
    amount: row.amount,
    partnerId: row.partnerId,
    partnerName: row.partnerName,
    partner: row.partner,
    displayPartnerName: row.partner?.name ?? row.partnerName,
    invoiceRegistrationNumber: row.invoiceRegistrationNumber,
    note: row.note,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    unsorted: isUnsortedDocument({
      txnDate,
      amount: row.amount,
      partnerId: row.partnerId,
      partnerName: row.partnerName,
    }),
    supersedes: row.supersedes,
    supersededBy: row.supersededBy[0] ?? null,
    links: row.links.map(toLinkEntry),
    history,
  };
}

async function loadHistory(db: Db, id: string): Promise<DocumentHistoryEntry[]> {
  const rows = await db.auditLog.findMany({
    where: { entity: "document", entityId: id },
    // Rows of one transaction share `at`; the ULID keeps their order.
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    reason: row.reason,
    before: row.before,
    after: row.after,
  }));
}

/** One document with its links, the replacement chain and its audit log; `null` when missing. */
export async function getDocumentDetail(db: Db, id: string): Promise<DocumentDetail | null> {
  const row = await db.document.findUnique({ where: { id }, include: detailInclude });
  if (!row) return null;
  return toDocumentDetail(row, await loadHistory(db, id));
}

async function requireDocumentDetail(db: Db, id: string): Promise<DocumentDetail> {
  const detail = await getDocumentDetail(db, id);
  if (!detail) throw new SettingsError(NOT_FOUND);
  return detail;
}

/** The stored file of a document (voided ones included); `null` when missing. */
export async function getDocumentFile(db: Db, id: string): Promise<DocumentFile | null> {
  return db.document.findUnique({
    where: { id },
    select: { id: true, storageKey: true, mime: true, originalName: true, status: true },
  });
}

/** A document that is not voided with the same file (`prepare` skips the upload when there is one). */
export async function findDocumentBySha256(db: Db, sha256: string): Promise<DocumentRef | null> {
  const value = sha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  return findActiveBySha256(db, value);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Registers a stored file as a document (`uploadedBy` = actor). When a document that is not voided
 * already has the same SHA-256, nothing is written and that one is returned (`duplicate: true`).
 */
export async function registerDocument(
  db: Db,
  input: DocumentRegisterInput,
  options: WriteOptions,
): Promise<DocumentRegistration> {
  const data = documentRegisterSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSha256(tx, data.sha256);
    const existing = await findActiveBySha256(tx, data.sha256);
    if (existing)
      return { document: await requireDocumentDetail(tx, existing.id), duplicate: true };

    const partner = mergePartner({ partnerId: null, partnerName: null }, data);
    await assertPartnerChoosable(tx, partner.partnerId, null);
    const row = await tx.document.create({
      data: {
        id: newId(),
        kind: data.kind,
        storageKey: data.storageKey,
        sha256: data.sha256,
        mime: data.mime,
        byteSize: data.byteSize,
        originalName: data.originalName,
        uploadedBy: options.actor,
        source: data.source,
        txnDate: dbDateOrNull(data.txnDate),
        amount: data.amount,
        ...partner,
        invoiceRegistrationNumber: data.invoiceRegistrationNumber,
        note: data.note,
      },
    });
    await audit(tx, options, { action: "document.create", entityId: row.id, after: row });
    return { document: await requireDocumentDetail(tx, row.id), duplicate: false };
  });
}

/**
 * Edits the items of a document: 種別・取引年月日・金額・取引先・取引先名・登録番号・メモ. Omitted
 * keys are left as they are; a voided document cannot change. Nothing is written without a change.
 */
export async function updateDocument(
  db: Db,
  input: DocumentUpdateInput,
  options: WriteOptions,
): Promise<DocumentDetail> {
  const data = documentUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockDocument(tx, data.id);
    if (current.status === "voided") throw new SettingsError(VOIDED_IS_FIXED);

    const patch: Prisma.DocumentUncheckedUpdateInput = {};
    if (data.kind !== undefined) patch.kind = data.kind;
    if (data.txnDate !== undefined) patch.txnDate = dbDateOrNull(data.txnDate);
    if (data.amount !== undefined) patch.amount = data.amount;
    if (data.invoiceRegistrationNumber !== undefined) {
      patch.invoiceRegistrationNumber = data.invoiceRegistrationNumber;
    }
    if (data.note !== undefined) patch.note = data.note;
    if (data.partnerId !== undefined || data.partnerName !== undefined) {
      const partner = mergePartner(current, data);
      await assertPartnerChoosable(tx, partner.partnerId, current.partnerId);
      Object.assign(patch, partner);
    }
    if (!changes(current, patch)) return requireDocumentDetail(tx, current.id);

    const row = await tx.document.update({ where: { id: current.id }, data: patch });
    await audit(tx, options, {
      action: "document.update",
      entityId: row.id,
      before: current,
      after: row,
    });
    return requireDocumentDetail(tx, row.id);
  });
}

async function voidRow(
  tx: Tx,
  current: Document,
  reason: string,
  options: WriteOptions,
): Promise<void> {
  const row = await tx.document.update({
    where: { id: current.id },
    data: { status: "voided", voidedAt: new Date(), voidReason: reason },
  });
  await audit(tx, options, {
    action: "document.void",
    entityId: row.id,
    before: { status: current.status },
    after: { status: row.status, voidedAt: row.voidedAt, voidReason: row.voidReason },
    reason,
  });
}

/**
 * Voids a document with a reason. The file and the links stay; it keeps showing (with the reason)
 * in 「すべて」 and 「無効」. A void is final (DB guard).
 */
export async function voidDocument(
  db: Db,
  input: DocumentVoidInput,
  options: WriteOptions,
): Promise<DocumentDetail> {
  const data = documentVoidSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockDocument(tx, data.id);
    if (current.status === "voided") {
      throw new SettingsError("この証憑はすでに無効にしています。画面を読み込み直してください");
    }
    await voidRow(tx, current, data.reason, options);
    return requireDocumentDetail(tx, current.id);
  });
}

/**
 * Replaces the file of a document: a new document (`supersedesId`) inherits the items (those in
 * `replacement` win) and the links, then the original is voided with 「差し替え: 理由」. When a
 * document that is not voided already has the new file, nothing is written (`duplicate: true`).
 */
export async function replaceDocument(
  db: Db,
  input: DocumentReplaceInput,
  options: WriteOptions,
): Promise<DocumentRegistration> {
  const data = documentReplaceSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const original = await lockDocument(
      tx,
      data.id,
      "差し替える証憑が見つかりません。画面を読み込み直してください",
    );
    if (original.status === "voided") {
      throw new SettingsError(
        "無効にした証憑は差し替えられません。差し替え後の証憑か、有効な証憑から差し替えてください",
      );
    }
    const file = data.replacement;
    await lockSha256(tx, file.sha256);
    const existing = await findActiveBySha256(tx, file.sha256);
    if (existing)
      return { document: await requireDocumentDetail(tx, existing.id), duplicate: true };

    const partner = mergePartner(original, file);
    await assertPartnerChoosable(tx, partner.partnerId, original.partnerId);
    const links = await tx.documentLink.findMany({
      where: { documentId: original.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const voidReason = `差し替え: ${data.reason}`;
    const row = await tx.document.create({
      data: {
        id: newId(),
        kind: file.kind ?? original.kind,
        storageKey: file.storageKey,
        sha256: file.sha256,
        mime: file.mime,
        byteSize: file.byteSize,
        originalName: file.originalName,
        uploadedBy: options.actor,
        source: file.source,
        txnDate: file.txnDate === undefined ? original.txnDate : dbDateOrNull(file.txnDate),
        amount: file.amount === undefined ? original.amount : file.amount,
        ...partner,
        invoiceRegistrationNumber:
          file.invoiceRegistrationNumber === undefined
            ? original.invoiceRegistrationNumber
            : file.invoiceRegistrationNumber,
        note: file.note === undefined ? original.note : file.note,
        status: links.length > 0 ? "linked" : "inbox",
        supersedesId: original.id,
      },
    });
    await audit(tx, options, {
      action: "document.create",
      entityId: row.id,
      after: row,
      reason: voidReason,
    });
    for (const link of links) {
      await tx.documentLink.create({
        data: {
          id: newId(),
          documentId: row.id,
          journalEntryId: link.journalEntryId,
          walletTransactionId: link.walletTransactionId,
          invoiceId: link.invoiceId,
          createdBy: options.actor,
        },
      });
      const target = await loadLinkTargetOf(tx, link);
      await audit(tx, options, { action: "document.link", entityId: row.id, after: target });
    }
    await voidRow(tx, original, voidReason, options);
    return { document: await requireDocumentDetail(tx, row.id), duplicate: false };
  });
}

/** The summary of a stored link's target (for the audit log). */
async function loadLinkTargetOf(
  db: Db,
  link: {
    journalEntryId: string | null;
    walletTransactionId: string | null;
    invoiceId: string | null;
  },
): Promise<DocumentLinkTarget | null> {
  const [kind, id]: [DocumentLinkKind, string | null] = link.journalEntryId
    ? ["journal_entry", link.journalEntryId]
    : link.walletTransactionId
      ? ["wallet_transaction", link.walletTransactionId]
      : ["invoice", link.invoiceId];
  return id ? ((await loadLinkTarget(db, kind, id))?.summary ?? null) : null;
}

/**
 * Links a document to an entry / statement line / invoice (`inbox` → `linked`). The document's
 * empty date, amount and partner are filled from the target, as a separate `document.update`.
 * Linking twice changes nothing; a voided document cannot be linked.
 */
export async function linkDocument(
  db: Db,
  input: DocumentLinkInput,
  options: WriteOptions,
): Promise<DocumentDetail> {
  const data = documentLinkSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockDocument(tx, data.documentId);
    if (current.status === "voided") {
      throw new SettingsError("無効にした証憑は紐づけられません。有効な証憑を選んでください");
    }
    const label = DOCUMENT_LINK_KIND_LABELS[data.kind];
    const target = await loadLinkTarget(tx, data.kind, data.id);
    if (!target) {
      throw new SettingsError(
        `紐づける先の${label}が見つかりません。画面を読み込み直してください`,
        {
          field: "id",
        },
      );
    }
    const column = linkTargetColumn(data.kind, data.id);
    const existing = await tx.documentLink.findFirst({
      where: { documentId: current.id, ...column },
    });
    if (existing) return requireDocumentDetail(tx, current.id);

    await tx.documentLink.create({
      data: { id: newId(), documentId: current.id, ...column, createdBy: options.actor },
    });
    await audit(tx, options, {
      action: "document.link",
      entityId: current.id,
      after: target.summary,
    });

    let row = current;
    if (row.status === "inbox") {
      row = await tx.document.update({ where: { id: row.id }, data: { status: "linked" } });
    }
    const fill = fillPatch(row, target.fill);
    if (fill) {
      const filled = await tx.document.update({ where: { id: row.id }, data: fill });
      await audit(tx, options, {
        action: "document.update",
        entityId: row.id,
        before: row,
        after: filled,
        reason: `紐づけた${label}から補完`,
      });
    }
    return requireDocumentDetail(tx, current.id);
  });
}

/**
 * Removes a link (the `DocumentLink` row; links are not ledger records). Without links left the
 * document goes back to the inbox. Removing a link that does not exist changes nothing.
 */
export async function unlinkDocument(
  db: Db,
  input: DocumentLinkInput,
  options: WriteOptions,
): Promise<DocumentDetail> {
  const data = documentLinkSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockDocument(tx, data.documentId);
    if (current.status === "voided") {
      throw new SettingsError(
        "無効にした証憑の紐づけは外せません。紐づけは無効にした証憑の記録として残ります",
      );
    }
    const link = await tx.documentLink.findFirst({
      where: { documentId: current.id, ...linkTargetColumn(data.kind, data.id) },
    });
    if (!link) return requireDocumentDetail(tx, current.id);

    const target = await loadLinkTargetOf(tx, link);
    await tx.documentLink.delete({ where: { id: link.id } });
    const remaining = await tx.documentLink.count({ where: { documentId: current.id } });
    if (remaining === 0 && current.status === "linked") {
      await tx.document.update({ where: { id: current.id }, data: { status: "inbox" } });
    }
    await audit(tx, options, {
      action: "document.unlink",
      entityId: current.id,
      before: target ?? { kind: data.kind, id: data.id },
    });
    return requireDocumentDetail(tx, current.id);
  });
}

// ---------------------------------------------------------------------------
// Reads: links, search, counts, candidates, index
// ---------------------------------------------------------------------------

/** Documents linked to an entry / statement line / invoice, voided ones included (with the reason). */
export async function listDocumentLinks(
  db: Db,
  target: { kind: DocumentLinkKind; id: string },
): Promise<LinkedDocument[]> {
  const links = await db.documentLink.findMany({
    where: linkTargetColumn(target.kind, target.id),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { document: { include: { partner: { select: { name: true } } } } },
  });
  return links.map(({ document, createdAt, createdBy }) => ({
    id: document.id,
    kind: document.kind,
    status: document.status,
    originalName: document.originalName,
    mime: document.mime,
    txnDate: fromDbDateOrNull(document.txnDate),
    amount: document.amount,
    partnerName: document.partner?.name ?? document.partnerName,
    voidReason: document.voidReason,
    voidedAt: document.voidedAt,
    linkedAt: createdAt,
    linkedBy: createdBy,
  }));
}

/**
 * 受信箱 (13 §3.2): the documents that still need work — not linked yet, or linked while 未整理
 * (`isUnsortedDocument`: the date, the amount or the partner is empty). Never voided ones. The
 * inbox tab and both counts use this one condition.
 */
const INBOX_WHERE: Prisma.DocumentWhereInput = {
  OR: [
    { status: "inbox" },
    {
      status: "linked",
      OR: [{ txnDate: null }, { amount: null }, { partnerId: null, partnerName: null }],
    },
  ],
};

function containsText(text: string) {
  return { contains: text, mode: "insensitive" as const };
}

/** The search conditions of 13 §3.2 (ANDed). Empty dates / amounts never match a range. */
function documentWhere(
  filters: DocumentSearchFilters,
  tab: DocumentTab,
): Prisma.DocumentWhereInput {
  const and: Prisma.DocumentWhereInput[] = [];
  if (tab === "inbox") and.push(INBOX_WHERE);
  if (tab === "voided") and.push({ status: "voided" });
  if (filters.from !== null) and.push({ txnDate: { gte: toDbDate(filters.from) } });
  if (filters.to !== null) and.push({ txnDate: { lte: toDbDate(filters.to) } });
  if (filters.amountMin !== null) and.push({ amount: { gte: filters.amountMin } });
  if (filters.amountMax !== null) and.push({ amount: { lte: filters.amountMax } });
  if (filters.kind !== null) and.push({ kind: filters.kind });
  if (filters.partner !== null) {
    and.push({
      OR: [
        { partner: { name: containsText(filters.partner) } },
        { partnerName: containsText(filters.partner) },
      ],
    });
  }
  if (filters.q !== null) {
    and.push({
      OR: [
        { originalName: containsText(filters.q) },
        { note: containsText(filters.q) },
        { partnerName: containsText(filters.q) },
        { partner: { name: containsText(filters.q) } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

/** The inbox by upload time; 「すべて」・「無効」 by transaction date (empty first), then upload time. */
function documentOrder(tab: DocumentTab): Prisma.DocumentOrderByWithRelationInput[] {
  if (tab === "inbox") return [{ uploadedAt: "desc" }, { id: "desc" }];
  return [{ txnDate: { sort: "desc", nulls: "first" } }, { uploadedAt: "desc" }, { id: "desc" }];
}

const listInclude = {
  partner: { select: { name: true } },
  links: { select: { journalEntryId: true, walletTransactionId: true, invoiceId: true } },
} satisfies Prisma.DocumentInclude;

type ListRow = Prisma.DocumentGetPayload<{ include: typeof listInclude }>;

function toListRow(row: ListRow): DocumentListRow {
  const txnDate = fromDbDateOrNull(row.txnDate);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    txnDate,
    amount: row.amount,
    partnerId: row.partnerId,
    partnerName: row.partner?.name ?? row.partnerName,
    originalName: row.originalName,
    mime: row.mime,
    voidReason: row.voidReason,
    unsorted: isUnsortedDocument({
      txnDate,
      amount: row.amount,
      partnerId: row.partnerId,
      partnerName: row.partnerName,
    }),
    linkCounts: {
      journalEntries: row.links.filter((link) => link.journalEntryId !== null).length,
      walletTransactions: row.links.filter((link) => link.walletTransactionId !== null).length,
      invoices: row.links.filter((link) => link.invoiceId !== null).length,
    },
    uploadedAt: row.uploadedAt,
  };
}

/**
 * The list of 13 §3: `filters` is the output of `documentSearchSchema` (`tab` defaults to the
 * inbox). Pages count from 1.
 */
export async function searchDocuments(
  db: Db,
  filters: DocumentSearchFilters,
  options: { page?: number; pageSize?: number } = {},
): Promise<DocumentSearchResult> {
  const tab = filters.tab ?? "inbox";
  const pageSize = Math.max(1, Math.trunc(options.pageSize ?? DOCUMENT_PAGE_SIZE));
  const page = Math.max(1, Math.trunc(options.page ?? filters.page));
  const where = documentWhere(filters, tab);
  const total = await db.document.count({ where });
  const rows = await db.document.findMany({
    where,
    orderBy: documentOrder(tab),
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: listInclude,
  });
  return { rows: rows.map(toListRow), total, page, pageSize };
}

/** Counts of the tabs, whatever the search conditions (13 §3.2). */
export async function countDocuments(db: Db): Promise<DocumentCounts> {
  const inbox = await db.document.count({ where: INBOX_WHERE });
  const voided = await db.document.count({ where: { status: "voided" } });
  const all = await db.document.count();
  return { inbox, all, voided };
}

/** Documents in the inbox (the home of S7): the same as `countDocuments().inbox`. */
export async function countInboxDocuments(db: Db): Promise<number> {
  return db.document.count({ where: INBOX_WHERE });
}

function candidateOrder<T extends { daysApart: number; date: CalendarDate; id: string }>(
  a: T,
  b: T,
): number {
  if (a.daysApart !== b.daysApart) return a.daysApart - b.daysApart;
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Links from documents that are not voided: a target that has one already has its evidence. */
const activeDocumentLinks = { where: { document: { status: { not: "voided" as const } } } };

const candidateLineSelect = {
  ...walletTransactionSummarySelect,
  counterpartyRaw: true,
  _count: { select: { documentLinks: activeDocumentLinks } },
} satisfies Prisma.WalletTransactionSelect;

const candidateEntrySelect = {
  ...journalEntrySummarySelect,
  _count: { select: { documentLinks: activeDocumentLinks } },
} satisfies Prisma.JournalEntrySelect;

/** Targets without evidence first: a line or an entry that already has a document comes later. */
function withoutDocumentsFirst(a: { documentCount: number }, b: { documentCount: number }): number {
  return Number(a.documentCount > 0) - Number(b.documentCount > 0);
}

type CandidateLineRow = Prisma.WalletTransactionGetPayload<{ select: typeof candidateLineSelect }>;

interface RankedLine {
  line: CandidateLineRow;
  date: CalendarDate;
  id: string;
  daysApart: number;
  documentCount: number;
}

function rankLine(line: CandidateLineRow, center: CalendarDate): RankedLine {
  const date = fromDbDate(line.txnDate);
  return {
    line,
    date,
    id: line.id,
    daysApart: Math.abs(daysBetween(center, date)),
    documentCount: line._count.documentLinks,
  };
}

function toLineCandidate({
  line,
  date,
  daysApart,
  documentCount,
}: RankedLine): WalletTransactionCandidate {
  return {
    id: line.id,
    walletId: line.wallet.id,
    walletName: line.wallet.name,
    txnDate: date,
    amount: line.amount,
    description: line.descriptionRaw,
    counterparty: line.counterpartyRaw,
    status: line.status,
    daysApart,
    documentCount,
  };
}

/**
 * Link candidates of 13 §4, nearest first (the same distance: the newer first), up to 10 each.
 * Targets already linked are left out; targets that another document (not voided) already evidences
 * come after those without (`documentCount`). A voided document has none.
 * - With an amount (`basis: "amount"`): statement lines (pending first, registered too) and posted
 *   entries (not reversals, not voided; debit total) of the same amount, dated within ±7 days of the
 *   document's date (without a date: the 30 days up to its upload day).
 * - Without an amount (`basis: "date"`): pending statement lines of any amount within ±7 days of
 *   the date (without a date: from 7 days before the upload day to the next day). No entries.
 */
export async function findLinkCandidates(
  db: Db,
  input: { documentId: string },
): Promise<DocumentLinkCandidates> {
  const document = await db.document.findUnique({
    where: { id: input.documentId },
    include: { links: { select: { journalEntryId: true, walletTransactionId: true } } },
  });
  if (!document) throw new SettingsError(NOT_FOUND);
  if (document.status === "voided") {
    return { basis: "amount", walletTransactions: [], journalEntries: [] };
  }
  const txnDate = fromDbDateOrNull(document.txnDate);
  const center = txnDate ?? todayInJapan(document.uploadedAt);
  const linkedLines = document.links.flatMap((link) =>
    link.walletTransactionId ? [link.walletTransactionId] : [],
  );
  const amount = document.amount;

  if (amount === null) {
    const from = txnDate
      ? addDays(txnDate, -DOCUMENT_CANDIDATE_WINDOW_DAYS)
      : addDays(center, -DOCUMENT_UNPRICED_CANDIDATE_DAYS);
    const to = txnDate ? addDays(txnDate, DOCUMENT_CANDIDATE_WINDOW_DAYS) : addDays(center, 1);
    const lines = await db.walletTransaction.findMany({
      where: {
        txnDate: { gte: toDbDate(from), lte: toDbDate(to) },
        status: "pending",
        id: { notIn: linkedLines },
      },
      select: candidateLineSelect,
    });
    return {
      basis: "date",
      walletTransactions: lines
        .map((line) => rankLine(line, center))
        .sort((a, b) => withoutDocumentsFirst(a, b) || candidateOrder(a, b))
        .slice(0, DOCUMENT_CANDIDATE_LIMIT)
        .map(toLineCandidate),
      journalEntries: [],
    };
  }

  const from = txnDate
    ? addDays(txnDate, -DOCUMENT_CANDIDATE_WINDOW_DAYS)
    : addDays(center, -DOCUMENT_UNDATED_CANDIDATE_DAYS);
  const to = txnDate ? addDays(txnDate, DOCUMENT_CANDIDATE_WINDOW_DAYS) : center;
  const linkedEntries = new Set(
    document.links.flatMap((link) => (link.journalEntryId ? [link.journalEntryId] : [])),
  );

  const lines = await db.walletTransaction.findMany({
    where: {
      txnDate: { gte: toDbDate(from), lte: toDbDate(to) },
      amount: { in: [amount, -amount] },
      status: { in: ["pending", "registered"] },
      id: { notIn: linkedLines },
    },
    select: candidateLineSelect,
  });
  const walletTransactions = lines
    .map((line) => rankLine(line, center))
    .sort((a, b) => {
      const pendingFirst =
        Number(b.line.status === "pending") - Number(a.line.status === "pending");
      return pendingFirst || withoutDocumentsFirst(a, b) || candidateOrder(a, b);
    })
    .slice(0, DOCUMENT_CANDIDATE_LIMIT)
    .map(toLineCandidate);

  // Entries whose debit total is the amount (summed in SQL so no window size can cut them off).
  const matching = await db.$queryRaw<{ id: string }[]>`
    SELECT je."id"
      FROM "journal_entry" AS je
      JOIN "journal_line" AS jl ON jl."journal_entry_id" = je."id" AND jl."side" = 'debit'
     WHERE je."status" = 'posted'
       AND je."kind" <> 'reversal'
       AND je."entry_date" BETWEEN ${from}::date AND ${to}::date
     GROUP BY je."id"
    HAVING sum(jl."amount") = ${amount}`;
  const entryIds = matching.map((row) => row.id).filter((id) => !linkedEntries.has(id));
  const entries =
    entryIds.length === 0
      ? []
      : await db.journalEntry.findMany({
          where: { id: { in: entryIds } },
          select: candidateEntrySelect,
        });
  const journalEntries = entries
    .map((entry) => {
      const date = fromDbDate(entry.entryDate);
      return {
        entry,
        date,
        id: entry.id,
        daysApart: Math.abs(daysBetween(center, date)),
        documentCount: entry._count.documentLinks,
      };
    })
    .sort((a, b) => withoutDocumentsFirst(a, b) || candidateOrder(a, b))
    .slice(0, DOCUMENT_CANDIDATE_LIMIT)
    .map(({ entry, date, daysApart, documentCount }): JournalEntryCandidate => ({
      id: entry.id,
      fiscalYearNo: entry.fiscalYear.no,
      no: entry.no,
      entryDate: date,
      description: entry.description,
      amount: debitTotal(entry.lines),
      daysApart,
      documentCount,
    }));
  return { basis: "amount", walletTransactions, journalEntries };
}

const indexInclude = {
  partner: { select: { name: true } },
  links: {
    include: {
      journalEntry: { select: { no: true, fiscalYear: { select: { no: true } } } },
      walletTransaction: {
        select: { id: true, txnDate: true, amount: true, wallet: { select: { name: true } } },
      },
    },
  },
} satisfies Prisma.DocumentInclude;

type IndexRow = Prisma.DocumentGetPayload<{ include: typeof indexInclude }>;

function toIndexRecord(row: IndexRow): DocumentIndexRecord {
  const journalEntries = row.links
    .flatMap((link) =>
      link.journalEntry
        ? [{ fiscalYearNo: link.journalEntry.fiscalYear.no, no: link.journalEntry.no }]
        : [],
    )
    .sort((a, b) => a.fiscalYearNo - b.fiscalYearNo || a.no - b.no);
  const walletTransactions = row.links
    .flatMap((link) => (link.walletTransaction ? [link.walletTransaction] : []))
    .sort((a, b) => a.txnDate.getTime() - b.txnDate.getTime() || (a.id < b.id ? -1 : 1))
    .map((line) => ({
      walletName: line.wallet.name,
      txnDate: fromDbDate(line.txnDate),
      amount: line.amount,
    }));
  return {
    id: row.id,
    storageKey: row.storageKey,
    txnDate: fromDbDateOrNull(row.txnDate),
    amount: row.amount,
    partnerName: row.partner?.name ?? row.partnerName,
    invoiceRegistrationNumber: row.invoiceRegistrationNumber,
    kind: row.kind,
    status: row.status,
    voidReason: row.voidReason,
    journalEntries,
    walletTransactions,
    originalName: row.originalName,
    mime: row.mime,
    sha256: row.sha256,
    uploadedAt: row.uploadedAt,
    uploadedBy: row.uploadedBy,
    note: row.note,
  };
}

/**
 * The rows of the index (索引簿, 13 §7) for `filters` (`tab` defaults to all, voided included), in
 * the list's order. Format them with `documentIndexCells` and `toCsv` (`@niho-finance/ledger`).
 */
export async function loadDocumentIndex(
  db: Db,
  filters: DocumentSearchFilters,
): Promise<DocumentIndexRecord[]> {
  const tab = filters.tab ?? "all";
  const rows = await db.document.findMany({
    where: documentWhere(filters, tab),
    orderBy: documentOrder(tab),
    include: indexInclude,
  });
  return rows.map(toIndexRecord);
}

/** `loadDocumentIndex`, recorded as `document.export` (the conditions and the row count). */
export async function exportDocumentIndex(
  db: Db,
  filters: DocumentSearchFilters,
  options: WriteOptions,
): Promise<DocumentIndexRecord[]> {
  const rows = await loadDocumentIndex(db, filters);
  const { page: _page, ...conditions } = filters;
  await appendAuditLog(db, {
    actor: options.actor,
    action: "document.export",
    entity: "document",
    after: { filters: { ...conditions, tab: filters.tab ?? "all" }, count: rows.length },
  });
  return rows;
}

// ---------------------------------------------------------------------------
// 証憑の規程 (records policy, 13 §5)
// ---------------------------------------------------------------------------

function toRecordsPolicy(company: Company): RecordsPolicy {
  return {
    effectiveOn: fromDbDateOrNull(company.recordsPolicyEffectiveOn),
    manager: company.recordsPolicyManager,
    operator: company.recordsPolicyOperator,
    version: company.recordsPolicyVersion,
    companyName: company.name,
    representative: company.representative,
  };
}

function policySnapshot(company: Company) {
  return {
    effectiveOn: fromDbDateOrNull(company.recordsPolicyEffectiveOn),
    manager: company.recordsPolicyManager,
    operator: company.recordsPolicyOperator,
    version: company.recordsPolicyVersion,
  };
}

/** The state of the policy stored on the company. Without a company: `SettingsError`. */
export async function getRecordsPolicy(db: Db): Promise<RecordsPolicy> {
  return toRecordsPolicy(await requireCompanyRow(db));
}

/**
 * Puts the policy in force (or changes the people responsible): 施行日・管理責任者 (default: 代表者)・
 * 処理責任者 (default: 管理責任者)・版. Recorded as `records_policy.save` (before / after).
 */
export async function saveRecordsPolicy(
  db: Db,
  input: RecordsPolicyInput,
  options: WriteOptions,
): Promise<RecordsPolicy> {
  const data = recordsPolicySchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "company");
    const company = await requireCompanyRow(tx);
    const manager = data.manager ?? company.representative;
    if (!manager) {
      throw new SettingsError(
        "管理責任者を入力してください（設定 › 事業所 に代表者があれば、それが既定になります）",
        { field: "manager" },
      );
    }
    const patch = {
      recordsPolicyEffectiveOn: toDbDate(data.effectiveOn),
      recordsPolicyManager: manager,
      recordsPolicyOperator: data.operator ?? manager,
      recordsPolicyVersion: data.version,
    };
    if (!changes(company, patch)) return toRecordsPolicy(company);
    const row = await tx.company.update({ where: { id: company.id }, data: patch });
    await audit(tx, options, {
      action: "records_policy.save",
      entity: "company",
      entityId: row.id,
      before: policySnapshot(company),
      after: policySnapshot(row),
    });
    return toRecordsPolicy(row);
  });
}
