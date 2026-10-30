/**
 * 受け渡しパッケージ (14-reports §16): the documents of the year with their index row, and the audit
 * log `export.package` — one row per phase (`downloaded` · `requested` · `ready` · `failed`, §16.5),
 * never updated. A request is resolved from its rows (`entityId` = the request id).
 */
import type { CalendarDate } from "@niho-finance/ledger";
import type { ArchiveDocument } from "@niho-finance/reports";
import type { Prisma } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull } from "./dates";
import type { DocumentIndexRecord } from "./documents";
import { newId } from "./ids";
import { listRecentExports, loadDocumentsForArchive, type ExportLogRow } from "./reports-query";

export const HANDOVER_PACKAGE_AUDIT_ACTION = "export.package";
const ENTITY = "export";
/** A request still being made after this long has probably failed (§16.1). */
export const HANDOVER_STALE_MINUTES = 30;
/** The `kind` of a package download in 「最近の書き出し」 (labels.ts names it). */
export const HANDOVER_EXPORT_KIND = "package";

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** One document of the package: S7's archive row (file name), the 13 §7 index row and its size. */
export interface HandoverDocumentRecord {
  archive: ArchiveDocument;
  index: DocumentIndexRecord;
  byteSize: number;
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

/** The 13 §7 row of a document (the same fields as `loadDocumentIndex`). */
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
 * The documents of `from`..`to` chosen as S7's documents archive does (`loadDocumentsForArchive`:
 * dated within the range, or undated and saved within it; voided ones included), in its order.
 */
export async function loadHandoverDocuments(
  db: Db,
  range: { from: CalendarDate; to: CalendarDate },
): Promise<HandoverDocumentRecord[]> {
  const archive = await loadDocumentsForArchive(db, range);
  if (archive.length === 0) return [];
  const rows = await db.document.findMany({
    where: { id: { in: archive.map((document) => document.id) } },
    include: indexInclude,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return archive.map((document) => {
    const row = byId.get(document.id);
    if (!row) throw new Error(`handover: document ${document.id} disappeared while loading`);
    return { archive: document, index: toIndexRecord(row), byteSize: row.byteSize };
  });
}

// ---------------------------------------------------------------------------
// Audit log (§16.5)
// ---------------------------------------------------------------------------

export interface HandoverPeriodInput {
  fiscalYearId: string;
  fiscalYearNo: number;
  from: CalendarDate;
  to: CalendarDate;
  includeDocuments: boolean;
}

export interface HandoverDirectDownloadInput extends Omit<HandoverPeriodInput, "fiscalYearId"> {
  fileCount: number;
  documentCount: number;
  missingDocumentCount: number;
  bytes: number;
}

/** `downloaded` (`delivery: "direct"`): the screen made the zip and returned it. */
export async function recordHandoverDirectDownload(
  db: Db,
  input: HandoverDirectDownloadInput,
  options: { actor: string },
): Promise<void> {
  await appendAuditLog(db, {
    actor: options.actor,
    action: HANDOVER_PACKAGE_AUDIT_ACTION,
    entity: ENTITY,
    after: {
      phase: "downloaded",
      delivery: "direct",
      fiscalYearNo: input.fiscalYearNo,
      from: input.from,
      to: input.to,
      includeDocuments: input.includeDocuments,
      fileCount: input.fileCount,
      documentCount: input.documentCount,
      missingDocumentCount: input.missingDocumentCount,
      bytes: input.bytes,
    },
  });
}

/** `requested`: a job was asked to make the package. Returns the new request id. */
export async function recordHandoverRequest(
  db: Db,
  input: HandoverPeriodInput & { estimateBytes: number },
  options: { actor: string; requestId?: string },
): Promise<string> {
  const requestId = options.requestId ?? newId();
  await appendAuditLog(db, {
    actor: options.actor,
    action: HANDOVER_PACKAGE_AUDIT_ACTION,
    entity: ENTITY,
    entityId: requestId,
    after: {
      phase: "requested",
      requestId,
      fiscalYearId: input.fiscalYearId,
      fiscalYearNo: input.fiscalYearNo,
      from: input.from,
      to: input.to,
      includeDocuments: input.includeDocuments,
      estimateBytes: input.estimateBytes,
    },
  });
  return requestId;
}

/** `ready`: the job stored the zip under `key`. */
export async function recordHandoverReady(
  db: Db,
  input: { requestId: string; key: string; fileCount: number; bytes: number },
  options: { actor: string },
): Promise<void> {
  await appendAuditLog(db, {
    actor: options.actor,
    action: HANDOVER_PACKAGE_AUDIT_ACTION,
    entity: ENTITY,
    entityId: input.requestId,
    after: {
      phase: "ready",
      requestId: input.requestId,
      key: input.key,
      fileCount: input.fileCount,
      bytes: input.bytes,
    },
  });
}

/** `failed`: the job could not make the package; `reason` is shown to the owner. */
export async function recordHandoverFailed(
  db: Db,
  input: { requestId: string; reason: string },
  options: { actor: string },
): Promise<void> {
  await appendAuditLog(db, {
    actor: options.actor,
    action: HANDOVER_PACKAGE_AUDIT_ACTION,
    entity: ENTITY,
    entityId: input.requestId,
    after: { phase: "failed", requestId: input.requestId, reason: input.reason },
  });
}

/** `downloaded` (`delivery: "signed-url"`): a made package was handed out. */
export async function recordHandoverStoredDownload(
  db: Db,
  input: { requestId: string },
  options: { actor: string },
): Promise<void> {
  await appendAuditLog(db, {
    actor: options.actor,
    action: HANDOVER_PACKAGE_AUDIT_ACTION,
    entity: ENTITY,
    entityId: input.requestId,
    after: { phase: "downloaded", delivery: "signed-url", requestId: input.requestId },
  });
}

/** 作成中 · 失敗した可能性（30 分を超えた作成中）· 作成済み · 失敗 */
export type HandoverRequestState = "pending" | "stale" | "ready" | "failed";

export interface HandoverRequest {
  requestId: string;
  requestedAt: Date;
  requestedBy: string;
  fiscalYearId: string;
  fiscalYearNo: number;
  from: CalendarDate;
  to: CalendarDate;
  includeDocuments: boolean;
  estimateBytes: number;
  state: HandoverRequestState;
  /** The storage key of a made package. */
  key: string | null;
  /** The zip's size once made. */
  bytes: number | null;
  fileCount: number | null;
  finishedAt: Date | null;
  /** Why it failed (owner-facing). */
  reason: string | null;
}

type AuditRow = Prisma.AuditLogGetPayload<object>;

function afterOf(row: AuditRow): Record<string, unknown> {
  const after: unknown = row.after;
  return typeof after === "object" && after !== null && !Array.isArray(after)
    ? (after as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The request of a `requested` row, resolved with the rows of the same request. */
function resolveRequest(
  requested: AuditRow,
  rows: readonly AuditRow[],
  now: Date,
): HandoverRequest | null {
  const after = afterOf(requested);
  const requestId = requested.entityId;
  const fiscalYearId = text(after.fiscalYearId);
  const fiscalYearNo = count(after.fiscalYearNo);
  const from = text(after.from) as CalendarDate | null;
  const to = text(after.to) as CalendarDate | null;
  if (!requestId || !fiscalYearId || fiscalYearNo === null || !from || !to) return null;
  const phase = (row: AuditRow) => text(afterOf(row).phase);
  const ready = rows.find((row) => row.entityId === requestId && phase(row) === "ready");
  const failed = rows.find((row) => row.entityId === requestId && phase(row) === "failed");
  const finished = ready ?? failed;
  const finishedAfter = finished ? afterOf(finished) : {};
  const stale = now.getTime() - requested.at.getTime() > HANDOVER_STALE_MINUTES * 60_000;
  return {
    requestId,
    requestedAt: requested.at,
    requestedBy: requested.actor,
    fiscalYearId,
    fiscalYearNo,
    from,
    to,
    includeDocuments: after.includeDocuments === true,
    estimateBytes: count(after.estimateBytes) ?? 0,
    state: ready ? "ready" : failed ? "failed" : stale ? "stale" : "pending",
    key: ready ? text(finishedAfter.key) : null,
    bytes: ready ? count(finishedAfter.bytes) : null,
    fileCount: ready ? count(finishedAfter.fileCount) : null,
    finishedAt: finished?.at ?? null,
    reason: failed && !ready ? text(finishedAfter.reason) : null,
  };
}

const requestedWhere = {
  action: HANDOVER_PACKAGE_AUDIT_ACTION,
  entity: ENTITY,
  after: { path: ["phase"], equals: "requested" },
} satisfies Prisma.AuditLogWhereInput;

/** The request `requestId` with its state, or `null` when there is no such request. */
export async function findHandoverRequest(
  db: Db,
  requestId: string,
  options: { now?: Date } = {},
): Promise<HandoverRequest | null> {
  const rows = await db.auditLog.findMany({
    where: { action: HANDOVER_PACKAGE_AUDIT_ACTION, entity: ENTITY, entityId: requestId },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  const requested = rows.find((row) => text(afterOf(row).phase) === "requested");
  return requested ? resolveRequest(requested, rows, options.now ?? new Date()) : null;
}

/** The latest requests (「作成した受け渡しパッケージ」, §16.1), newest first. */
export async function listHandoverRequests(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<HandoverRequest[]> {
  const requested = await db.auditLog.findMany({
    where: requestedWhere,
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: options.limit ?? 10,
  });
  const ids = requested.flatMap((row) => (row.entityId ? [row.entityId] : []));
  if (ids.length === 0) return [];
  const rows = await db.auditLog.findMany({
    where: { action: HANDOVER_PACKAGE_AUDIT_ACTION, entity: ENTITY, entityId: { in: ids } },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  const now = options.now ?? new Date();
  return requested.flatMap((row) => resolveRequest(row, rows, now) ?? []);
}

/**
 * 「最近の書き出し」 (14 §10, §16.5): `listRecentExports` plus the package downloads (both
 * deliveries) as kind `package` / format `zip`, newest first.
 */
export async function listRecentExportsWithPackages(db: Db, limit = 20): Promise<ExportLogRow[]> {
  const exports = await listRecentExports(db, limit);
  const downloads = await db.auditLog.findMany({
    where: {
      action: HANDOVER_PACKAGE_AUDIT_ACTION,
      entity: ENTITY,
      after: { path: ["phase"], equals: "downloaded" },
    },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: limit,
  });
  const requestIds = downloads.flatMap((row) => (row.entityId ? [row.entityId] : []));
  const requests =
    requestIds.length === 0
      ? []
      : await db.auditLog.findMany({
          where: { ...requestedWhere, entityId: { in: requestIds } },
        });
  const periodOf = new Map(requests.map((row) => [row.entityId, afterOf(row)]));
  const packages = downloads.map((row): ExportLogRow => {
    const after = row.entityId ? (periodOf.get(row.entityId) ?? {}) : afterOf(row);
    return {
      id: row.id,
      at: row.at,
      actor: row.actor,
      kind: HANDOVER_EXPORT_KIND,
      format: "zip",
      fiscalYearNo: count(after.fiscalYearNo),
      from: text(after.from) as CalendarDate | null,
      to: text(after.to) as CalendarDate | null,
      segment: null,
      encoding: null,
    };
  });
  return [...exports, ...packages]
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
    .slice(0, limit);
}
