/**
 * Statement imports (12-imports §3, §6.3): the importable wallets and their format, the CSV preview
 * and import, and the two pieces every source shares — `insertWalletTransactions` (duplicates by
 * `(walletId, externalId)`) and `finishImportBatch` (the hook after an import). Imports never post
 * journal entries: lines arrive as `pending` for S5. Every write runs in one transaction and
 * appends to the audit log; neither `fileBytes` nor a line's `raw` goes into a snapshot.
 */
import {
  CSV_FORMAT_KEYS,
  CSV_FORMAT_LABELS,
  CSV_FORMATS,
  decodeCsvBytes,
  detectCsvFormat,
  parseCsvTable,
  parseStatement,
  sha256Hex,
  type CsvEncoding,
  type CsvFormatKey,
  type GenericCsvConfig,
  type ImportSource,
  type ParsedStatement,
  type RowFailure,
  type WalletTransactionDraft,
} from "@niho-finance/importers";
import {
  formatYen,
  WALLET_KIND_LABELS,
  type CalendarDate,
  type Money,
  type WalletKind,
} from "@niho-finance/ledger";
import { Prisma, type Wallet } from "@prisma/client";
import { appendAuditLog, toAuditJson, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, toDbDate } from "./dates";
import { isUniqueViolation, SettingsError } from "./errors";
import { newId } from "./ids";
import {
  csvImportInputSchema,
  genericCsvConfigSchema,
  walletImporterInputSchema,
  type CsvImportInput,
  type ParsedCsvImportInput,
  type WalletImporterInput,
} from "./schemas";
import type { WriteOptions } from "./settings";
import { runInTransaction, type Tx } from "./transaction";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportBatchSummary {
  id: string;
  walletId: string;
  walletName: string;
  source: ImportSource;
  /** Format key (CSV) or `stripe`. */
  importer: string | null;
  /** Name of the imported file (CSV). */
  originalName: string | null;
  periodFrom: CalendarDate | null;
  periodTo: CalendarDate | null;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  failedCount: number;
  /** Why a sync failed; `null` when the import completed. */
  error: string | null;
  executedAt: Date;
  executedBy: string;
}

export interface ImportBatchDetail extends ImportBatchSummary {
  failures: RowFailure[];
  warnings: string[];
}

export interface ImportableWallet {
  id: string;
  name: string;
  kind: WalletKind;
  /** Saved format key (`null` = 自動判別), or `stripe`. */
  importer: string | null;
  /** Saved column mapping of the generic format. */
  importerConfig: GenericCsvConfig | null;
  /** Stripe wallets only. */
  stripe: { connected: boolean; lastSyncedAt: Date | null } | null;
  lastBatch: ImportBatchSummary | null;
}

/** A parsed line in the preview. Amounts stay `bigint`: the web layer turns them into text. */
export interface PreviewRow {
  externalId: string;
  txnDate: CalendarDate;
  valueDate: CalendarDate | null;
  amount: Money;
  descriptionRaw: string;
  counterpartyRaw: string | null;
  balanceAfter: Money | null;
  category: string | null;
  /** Already stored in the wallet: the import counts it as a duplicate and skips it. */
  duplicate: boolean;
}

export interface CsvImportPreview {
  walletId: string;
  fileName: string;
  fileSha256: string;
  byteSize: number;
  encoding: CsvEncoding;
  /** The format the rows were read with: chosen, saved on the wallet, or detected. */
  format: CsvFormatKey | null;
  detectedFormat: CsvFormatKey | null;
  /** The column mapping used for the generic format. */
  config: GenericCsvConfig | null;
  /** The first rows of the file as cells (for the mapping editor). */
  table: string[][];
  columnCount: number;
  /** The first lines, oldest first. Empty until a format (and, for 汎用, a mapping) is known. */
  rows: PreviewRow[];
  rowCount: number;
  /** Lines whose external ID the wallet already has. */
  duplicateCount: number;
  failures: RowFailure[];
  warnings: string[];
  period: { from: CalendarDate; to: CalendarDate } | null;
  openingBalance: Money | null;
  closingBalance: Money | null;
  /** The same file (SHA-256) was imported before: the import is refused. */
  alreadyImported: { batchId: string; executedAt: Date } | null;
}

export interface ImportOutcome {
  /** `null` when nothing was recorded (a sync that fetched nothing). */
  batchId: string | null;
  walletId: string;
  source: ImportSource;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  failedCount: number;
  warnings: string[];
  /** Why a sync failed (no key, a Stripe API error); `null` when it completed. */
  error: string | null;
}

/**
 * The hook after an import (取込後の処理の差し込み点): S5 passes its rule-based registration of the
 * new lines. It runs inside the import's transaction, so a failure rolls the whole import back.
 */
export type AfterImportHook = (
  tx: Tx,
  batch: { id: string; walletId: string; source: ImportSource; transactionIds: string[] },
  options: { actor: string },
) => Promise<void>;

export interface ImportOptions {
  /** Recorded in the audit log and as the batch's `executedBy`. */
  actor: string;
  afterImport?: AfterImportHook;
}

/** The batch `finishImportBatch` reports to the hook. */
export interface ImportBatchRef {
  id: string;
  walletId: string;
  source: ImportSource;
}

// ---------------------------------------------------------------------------
// Reading batches and wallets
// ---------------------------------------------------------------------------

/** Lines shown in the preview (12-imports §1.2). */
const PREVIEW_ROWS = 20;
const DEFAULT_BATCH_LIMIT = 20;
const MAX_BATCH_LIMIT = 200;

const IMPORTABLE_WALLET_KINDS = ["bank", "card", "stripe", "other"] as const;
const CSV_WALLET_KINDS: readonly WalletKind[] = ["bank", "card", "other"];

const NO_WALLET = "口座が見つかりません。画面を読み込み直してください";
const NOT_CSV_WALLET = "この口座は取り込めません。銀行・カード・その他の口座を選んでください";
const INACTIVE_WALLET = "この口座は無効です。設定 › 口座 で有効にしてください";
const ALREADY_IMPORTED = "このファイルは取り込み済みです。取込の履歴を確かめてください";

/** The columns of a batch summary: never `fileBytes`. */
const batchSummarySelect = {
  id: true,
  walletId: true,
  source: true,
  importer: true,
  originalName: true,
  periodFrom: true,
  periodTo: true,
  rowCount: true,
  importedCount: true,
  duplicateCount: true,
  failedCount: true,
  error: true,
  executedAt: true,
  executedBy: true,
  wallet: { select: { name: true } },
} as const satisfies Prisma.ImportBatchSelect;

type BatchSummaryRow = Prisma.ImportBatchGetPayload<{ select: typeof batchSummarySelect }>;

function toImportBatchSummary(row: BatchSummaryRow): ImportBatchSummary {
  return {
    id: row.id,
    walletId: row.walletId,
    walletName: row.wallet.name,
    source: row.source,
    importer: row.importer,
    originalName: row.originalName,
    periodFrom: fromDbDateOrNull(row.periodFrom),
    periodTo: fromDbDateOrNull(row.periodTo),
    rowCount: row.rowCount,
    importedCount: row.importedCount,
    duplicateCount: row.duplicateCount,
    failedCount: row.failedCount,
    error: row.error,
    executedAt: row.executedAt,
    executedBy: row.executedBy,
  };
}

/** The latest batch of a wallet (internal: `stripe-links.ts` shows it too). */
export async function latestImportBatch(
  db: Db,
  walletId: string,
): Promise<ImportBatchSummary | null> {
  const row = await db.importBatch.findFirst({
    where: { walletId },
    orderBy: [{ executedAt: "desc" }, { id: "desc" }],
    select: batchSummarySelect,
  });
  return row ? toImportBatchSummary(row) : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** `ImportBatch.failures` read back defensively: anything but a list of failures is empty. */
function readFailures(value: Prisma.JsonValue): RowFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RowFailure[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const { rowNumber, reason, raw } = item;
    if (typeof rowNumber !== "number" || typeof reason !== "string") return [];
    return [isStringArray(raw) ? { rowNumber, reason, raw } : { rowNumber, reason }];
  });
}

function readWarnings(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** A saved column mapping, or `null` when there is none or it no longer validates. */
function readGenericCsvConfig(value: Prisma.JsonValue): GenericCsvConfig | null {
  if (value === null) return null;
  const parsed = genericCsvConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const importableWalletInclude = {
  stripeAccount: { select: { lastSyncedAt: true } },
} as const satisfies Prisma.WalletInclude;

type ImportableWalletRow = Prisma.WalletGetPayload<{ include: typeof importableWalletInclude }>;

function toImportableWallet(
  row: ImportableWalletRow,
  lastBatch: ImportBatchSummary | null,
): ImportableWallet {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    importer: row.importer,
    importerConfig: readGenericCsvConfig(row.importerConfig),
    stripe:
      row.kind === "stripe"
        ? {
            connected: row.stripeAccount !== null,
            lastSyncedAt: row.stripeAccount?.lastSyncedAt ?? null,
          }
        : null,
    lastBatch,
  };
}

async function loadImportableWallet(db: Db, walletId: string): Promise<ImportableWallet> {
  const row = await db.wallet.findUniqueOrThrow({
    where: { id: walletId },
    include: importableWalletInclude,
  });
  return toImportableWallet(row, await latestImportBatch(db, walletId));
}

/**
 * The wallets the import screen lists (12-imports §1.1): active bank, card, Stripe and other
 * wallets (cash and 役員立替 are entered by hand), with their format and latest batch.
 */
export async function listImportableWallets(db: Db): Promise<ImportableWallet[]> {
  const rows = await db.wallet.findMany({
    where: { isActive: true, kind: { in: [...IMPORTABLE_WALLET_KINDS] } },
    orderBy: { id: "asc" },
    include: importableWalletInclude,
  });
  const lastBatches = await Promise.all(rows.map((row) => latestImportBatch(db, row.id)));
  return rows.map((row, index) => toImportableWallet(row, lastBatches[index] ?? null));
}

/** The history, newest first (20 by default). */
export async function listImportBatches(
  db: Db,
  options: { walletId?: string; limit?: number } = {},
): Promise<ImportBatchSummary[]> {
  const { walletId, limit } = options;
  const take =
    limit !== undefined && Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, MAX_BATCH_LIMIT)
      : DEFAULT_BATCH_LIMIT;
  const rows = await db.importBatch.findMany({
    where: walletId === undefined ? {} : { walletId },
    orderBy: [{ executedAt: "desc" }, { id: "desc" }],
    take,
    select: batchSummarySelect,
  });
  return rows.map(toImportBatchSummary);
}

/** One batch with its failed rows and warnings (取込の結果). */
export async function getImportBatch(db: Db, id: string): Promise<ImportBatchDetail | null> {
  const row = await db.importBatch.findUnique({
    where: { id },
    select: { ...batchSummarySelect, failures: true, warnings: true },
  });
  if (!row) return null;
  return {
    ...toImportBatchSummary(row),
    failures: readFailures(row.failures),
    warnings: readWarnings(row.warnings),
  };
}

// ---------------------------------------------------------------------------
// Formats of CSV wallets
// ---------------------------------------------------------------------------

function isCsvFormatKey(value: string | null): value is CsvFormatKey {
  return value !== null && (CSV_FORMAT_KEYS as readonly string[]).includes(value);
}

/** A bank / card / other wallet that is active; anything else cannot import a CSV. */
async function loadCsvWallet(db: Db, walletId: string): Promise<Wallet> {
  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw new SettingsError(NO_WALLET, { field: "walletId" });
  if (!CSV_WALLET_KINDS.includes(wallet.kind)) {
    throw new SettingsError(NOT_CSV_WALLET, { field: "walletId" });
  }
  if (!wallet.isActive) throw new SettingsError(INACTIVE_WALLET, { field: "walletId" });
  return wallet;
}

/** Refuses a format meant for other kinds of wallet (e.g. a card statement into a bank). */
function assertFormatFitsWallet(format: CsvFormatKey, kind: WalletKind, field: string): void {
  const walletKinds = CSV_FORMATS.find((item) => item.key === format)?.walletKinds ?? [];
  if (walletKinds.includes(kind)) return;
  const kinds = walletKinds.map((item) => WALLET_KIND_LABELS[item]).join("・");
  throw new SettingsError(
    `「${CSV_FORMAT_LABELS[format]}」は${kinds}の口座の形式です。口座か取込形式を選び直してください`,
    { field },
  );
}

/** JSON with object keys sorted: Postgres `jsonb` does not keep the key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = record[key];
    return sorted;
  });
}

/**
 * Saves the wallet's format and mapping (`wallet.update_importer`) unless they are already the
 * same. The mapping is kept for the generic format only.
 */
async function saveWalletImporter(
  tx: Tx,
  wallet: Pick<Wallet, "id" | "importer" | "importerConfig">,
  importer: CsvFormatKey | null,
  importerConfig: GenericCsvConfig | null,
  options: WriteOptions,
): Promise<void> {
  const config = importer === "generic" ? importerConfig : null;
  if (
    wallet.importer === importer &&
    canonicalJson(wallet.importerConfig) === canonicalJson(config)
  ) {
    return;
  }
  const after = await tx.wallet.update({
    where: { id: wallet.id },
    data: { importer, importerConfig: config === null ? Prisma.DbNull : toAuditJson(config) },
    select: { importer: true, importerConfig: true },
  });
  await appendAuditLog(tx, {
    actor: options.actor,
    action: "wallet.update_importer",
    entity: "wallet",
    entityId: wallet.id,
    before: { importer: wallet.importer, importerConfig: wallet.importerConfig },
    after,
  });
}

/**
 * 取込の設定 of a bank / card / other wallet (12-imports §1.4): a format (`null` = 自動判別, which
 * clears the mapping too) or 汎用 with its column mapping.
 */
export async function updateWalletImporter(
  db: Db,
  input: WalletImporterInput,
  options: WriteOptions,
): Promise<ImportableWallet> {
  const data = walletImporterInputSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const wallet = await loadCsvWallet(tx, data.walletId);
    if (data.importer !== null) assertFormatFitsWallet(data.importer, wallet.kind, "importer");
    if (data.importer === "generic" && data.importerConfig === null) {
      throw new SettingsError("列の対応を指定してください", { field: "importerConfig" });
    }
    await saveWalletImporter(tx, wallet, data.importer, data.importerConfig, options);
    return loadImportableWallet(tx, wallet.id);
  });
}

// ---------------------------------------------------------------------------
// CSV preview and import
// ---------------------------------------------------------------------------

interface CsvReading {
  fileSha256: string;
  encoding: CsvEncoding;
  table: string[][];
  detectedFormat: CsvFormatKey | null;
  format: CsvFormatKey | null;
  config: GenericCsvConfig | null;
  /** `null` until a format (and, for 汎用, a column mapping) is known. */
  statement: ParsedStatement | null;
}

/**
 * Reads the file: the format is the one chosen, else the one saved on the wallet, else the
 * detected one; the generic format uses the chosen mapping, else the saved one.
 */
function readCsvFile(wallet: Wallet, input: ParsedCsvImportInput): CsvReading {
  const { text, encoding } = decodeCsvBytes(input.bytes);
  const table = parseCsvTable(text);
  const detectedFormat = detectCsvFormat(table);
  const savedFormat = isCsvFormatKey(wallet.importer) ? wallet.importer : null;
  const format = input.format ?? savedFormat ?? detectedFormat;
  if (format !== null) assertFormatFitsWallet(format, wallet.kind, "format");
  const config =
    format === "generic" ? (input.config ?? readGenericCsvConfig(wallet.importerConfig)) : null;
  const statement =
    format === null || (format === "generic" && config === null)
      ? null
      : parseStatement({ table, format, config });
  return {
    fileSha256: sha256Hex(input.bytes),
    encoding,
    table,
    detectedFormat,
    format,
    config,
    statement,
  };
}

/** The external IDs among `externalIds` that the wallet already has. */
async function storedExternalIds(
  db: Db,
  walletId: string,
  externalIds: readonly string[],
): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const rows = await db.walletTransaction.findMany({
    where: { walletId, externalId: { in: [...externalIds] } },
    select: { externalId: true },
  });
  return new Set(rows.map((row) => row.externalId));
}

function slashDate(date: CalendarDate): string {
  return date.replaceAll("-", "/");
}

/**
 * The balance the wallet's statement stood at before `firstDate` (12-imports §3.4): the latest
 * stored line with a balance on or before that date (the last imported on the same day), else
 * the wallet's statement opening balance when it is dated on or before it.
 */
async function balanceReference(
  db: Db,
  wallet: Pick<Wallet, "id" | "openingBalance" | "openingBalanceDate">,
  firstDate: CalendarDate,
): Promise<{ date: CalendarDate; balance: Money; opening: boolean } | null> {
  const latest = await db.walletTransaction.findFirst({
    where: {
      walletId: wallet.id,
      balanceAfter: { not: null },
      txnDate: { lte: toDbDate(firstDate) },
    },
    orderBy: [{ txnDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { txnDate: true, balanceAfter: true },
  });
  if (latest && latest.balanceAfter !== null) {
    return { date: fromDbDate(latest.txnDate), balance: latest.balanceAfter, opening: false };
  }
  const { openingBalance, openingBalanceDate } = wallet;
  if (openingBalance === null || openingBalanceDate === null) return null;
  const date = fromDbDate(openingBalanceDate);
  return date <= firstDate ? { date, balance: openingBalance, opening: true } : null;
}

/**
 * Whether the file follows on from what the wallet has (12-imports §3.4): the first line's balance
 * against the balance before it. A warning, never a refusal. When the first line is already
 * stored (a file overlapping the last one), the junction lies inside the file, whose own
 * continuity `parseStatement` checks. Runs before the lines are inserted.
 */
async function crossBatchWarnings(
  db: Db,
  wallet: Pick<Wallet, "id" | "openingBalance" | "openingBalanceDate">,
  rows: readonly WalletTransactionDraft[],
): Promise<string[]> {
  const first = rows[0];
  const firstBalance = first?.balanceAfter ?? null;
  if (first === undefined || firstBalance === null) return [];
  const stored = await db.walletTransaction.findUnique({
    where: { walletId_externalId: { walletId: wallet.id, externalId: first.externalId } },
    select: { id: true },
  });
  if (stored) return [];
  const reference = await balanceReference(db, wallet, first.txnDate);
  if (reference === null || reference.balance + first.amount === firstBalance) return [];
  const where = `${slashDate(reference.date)} の残高 ${formatYen(reference.balance)}`;
  return [
    reference.opening
      ? `口座の明細の残高（${where}）と最初の行の残高がつながりません。明細の残高の設定と、取りこぼしがないかを確かめてください`
      : `前回の取込（${where}）と最初の行の残高がつながりません。取りこぼしがないか確かめてください`,
  ];
}

function toPreviewRow(row: WalletTransactionDraft, stored: ReadonlySet<string>): PreviewRow {
  return {
    externalId: row.externalId,
    txnDate: row.txnDate,
    valueDate: row.valueDate ?? null,
    amount: row.amount,
    descriptionRaw: row.descriptionRaw,
    counterpartyRaw: row.counterpartyRaw ?? null,
    balanceAfter: row.balanceAfter ?? null,
    category: row.category ?? null,
    duplicate: stored.has(row.externalId),
  };
}

/**
 * Reads a CSV file for the preview (12-imports §1.2) and writes nothing. Without a format (none
 * chosen, saved or detected), or with 汎用 and no mapping, the lines are empty and the first rows
 * of the file come back for the mapping editor.
 */
export async function previewCsvImport(db: Db, input: CsvImportInput): Promise<CsvImportPreview> {
  const data = csvImportInputSchema.parse(input);
  const wallet = await loadCsvWallet(db, data.walletId);
  const reading = readCsvFile(wallet, data);
  const { statement } = reading;
  const rows = statement?.rows ?? [];
  const stored = await storedExternalIds(
    db,
    wallet.id,
    rows.map((row) => row.externalId),
  );
  const warnings = statement
    ? [...statement.warnings, ...(await crossBatchWarnings(db, wallet, rows))]
    : [];
  const imported = await db.importBatch.findUnique({
    where: { fileSha256: reading.fileSha256 },
    select: { id: true, executedAt: true },
  });
  return {
    walletId: wallet.id,
    fileName: data.fileName,
    fileSha256: reading.fileSha256,
    byteSize: data.bytes.byteLength,
    encoding: reading.encoding,
    format: reading.format,
    detectedFormat: reading.detectedFormat,
    config: reading.config,
    table: reading.table.slice(0, PREVIEW_ROWS),
    columnCount: reading.table.reduce((count, row) => Math.max(count, row.length), 0),
    rows: rows.slice(0, PREVIEW_ROWS).map((row) => toPreviewRow(row, stored)),
    rowCount: rows.length,
    duplicateCount: rows.filter((row) => stored.has(row.externalId)).length,
    failures: statement?.failures ?? [],
    warnings,
    period: statement?.period ?? null,
    openingBalance: statement?.openingBalance ?? null,
    closingBalance: statement?.closingBalance ?? null,
    alreadyImported: imported ? { batchId: imported.id, executedAt: imported.executedAt } : null,
  };
}

/**
 * Imports a CSV file into a bank / card / other wallet in one transaction (12-imports §6.3): the
 * batch (the file's SHA-256 refuses a second import of the same file), the new lines as
 * `pending` (duplicates are counted and left alone), the format saved on the wallet when
 * `rememberFormat`, the hook (`finishImportBatch`) and the audit log. Failed rows are kept on the
 * batch and never become lines; a file without a readable line is refused before anything is
 * written.
 */
export async function importCsv(
  db: Db,
  input: CsvImportInput & { rememberFormat: boolean },
  options: ImportOptions,
): Promise<ImportOutcome> {
  const data = csvImportInputSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const wallet = await loadCsvWallet(tx, data.walletId);
    const { fileSha256, format, config, statement } = readCsvFile(wallet, data);
    if (format === null) throw new SettingsError("取込形式を選んでください", { field: "format" });
    if (statement === null) {
      throw new SettingsError("列の対応を指定してください", { field: "config" });
    }
    if (statement.rows.length === 0) {
      throw new SettingsError("取り込める明細がありません。形式か列の対応を確かめてください", {
        field: "format",
      });
    }
    const imported = await tx.importBatch.findUnique({
      where: { fileSha256 },
      select: { id: true },
    });
    if (imported) throw new SettingsError(ALREADY_IMPORTED, { field: "bytes" });
    const warnings = [
      ...statement.warnings,
      ...(await crossBatchWarnings(tx, wallet, statement.rows)),
    ];

    const batchId = newId();
    try {
      await tx.importBatch.create({
        data: {
          id: batchId,
          walletId: wallet.id,
          source: "csv",
          importer: format,
          originalName: data.fileName,
          fileSha256,
          fileBytes: Buffer.from(data.bytes),
          periodFrom: statement.period ? toDbDate(statement.period.from) : null,
          periodTo: statement.period ? toDbDate(statement.period.to) : null,
          rowCount: statement.rows.length + statement.failures.length,
          failedCount: statement.failures.length,
          failures: toAuditJson(statement.failures),
          warnings,
          executedBy: options.actor,
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new SettingsError(ALREADY_IMPORTED, { field: "bytes" });
      throw error;
    }
    const { created, duplicateCount } = await insertWalletTransactions(tx, {
      walletId: wallet.id,
      importBatchId: batchId,
      drafts: statement.rows,
    });
    const batch = await tx.importBatch.update({
      where: { id: batchId },
      data: { importedCount: created.length, duplicateCount },
      omit: { fileBytes: true },
    });
    if (data.rememberFormat) await saveWalletImporter(tx, wallet, format, config, options);
    await finishImportBatch(
      tx,
      { id: batchId, walletId: wallet.id, source: "csv" },
      created,
      options,
    );
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "import_batch.import",
      entity: "import_batch",
      entityId: batchId,
      after: { ...batch, transactionIds: created.length },
    });
    return {
      batchId,
      walletId: wallet.id,
      source: "csv",
      rowCount: batch.rowCount,
      importedCount: batch.importedCount,
      duplicateCount: batch.duplicateCount,
      failedCount: batch.failedCount,
      warnings,
      error: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Shared by every source (CSV, Stripe, the bank APIs of v2)
// ---------------------------------------------------------------------------

function toTransactionRow(
  draft: WalletTransactionDraft,
  walletId: string,
  importBatchId: string,
): Prisma.WalletTransactionCreateManyInput {
  return {
    id: newId(),
    walletId,
    txnDate: toDbDate(draft.txnDate),
    valueDate: draft.valueDate ? toDbDate(draft.valueDate) : null,
    occurredAt: draft.occurredAt ?? null,
    amount: draft.amount,
    descriptionRaw: draft.descriptionRaw,
    counterpartyRaw: draft.counterpartyRaw ?? null,
    balanceAfter: draft.balanceAfter ?? null,
    category: draft.category ?? null,
    raw: draft.raw === undefined || draft.raw === null ? Prisma.DbNull : toAuditJson(draft.raw),
    externalId: draft.externalId,
    importBatchId,
    status: "pending",
  };
}

/**
 * Stores statement lines as `pending` (12-imports §3.3). A line whose external ID the wallet
 * already has is a duplicate: counted, never changed; within `drafts` the first of an external ID
 * wins. Inserting skips conflicts, so a concurrent import of the same lines is counted as
 * duplicates too. Returns the IDs of the lines actually created, in the order of `drafts`.
 */
export async function insertWalletTransactions(
  tx: Tx,
  params: { walletId: string; importBatchId: string; drafts: readonly WalletTransactionDraft[] },
): Promise<{ created: string[]; duplicateCount: number }> {
  const { walletId, importBatchId, drafts } = params;
  const firsts = new Map<string, WalletTransactionDraft>();
  for (const draft of drafts) {
    if (draft.externalId === "") {
      throw new Error("insertWalletTransactions: a draft has no externalId");
    }
    if (!firsts.has(draft.externalId)) firsts.set(draft.externalId, draft);
  }
  const stored = await storedExternalIds(tx, walletId, [...firsts.keys()]);
  const data = [...firsts.values()]
    .filter((draft) => !stored.has(draft.externalId))
    .map((draft) => toTransactionRow(draft, walletId, importBatchId));
  if (data.length === 0) return { created: [], duplicateCount: drafts.length };
  await tx.walletTransaction.createMany({ data, skipDuplicates: true });
  const rows = await tx.walletTransaction.findMany({
    where: { id: { in: data.map((row) => row.id) } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const created = rows.map((row) => row.id);
  return { created, duplicateCount: drafts.length - created.length };
}

/**
 * Ends an import inside its transaction: the only place that calls the `afterImport` hook (S5
 * registers the new lines by its rules here).
 */
export async function finishImportBatch(
  tx: Tx,
  batch: ImportBatchRef,
  created: string[],
  options: ImportOptions,
): Promise<void> {
  if (!options.afterImport) return;
  await options.afterImport(
    tx,
    { id: batch.id, walletId: batch.walletId, source: batch.source, transactionIds: [...created] },
    { actor: options.actor },
  );
}
