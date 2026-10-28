/**
 * Stripe connections and sync (12-imports §4): a Stripe wallet's account ID and the name of the
 * environment variable that holds its read-only key, and the sync of its balance transactions into
 * statement lines. The key itself is never stored, logged, audited or returned. Expected failures
 * (no key, a Stripe API error) are recorded as a batch with `error` and returned, never thrown.
 */
import {
  convertBalanceTransaction,
  createStripeBalanceTransactionSource,
  fetchBalanceTransactions,
  parseSyncCursor,
  type BalanceTransactionSource,
  type RowFailure,
  type StripeBalanceTransaction,
  type SyncCursor,
  type WalletTransactionDraft,
} from "@niho-finance/importers";
import type { CalendarDate } from "@niho-finance/ledger";
import type { Prisma, Wallet } from "@prisma/client";
import { appendAuditLog, toAuditJson, type Db } from "./audit";
import { fromDbDate, toDbDate, todayInJapan } from "./dates";
import { loadRootEnv } from "./env";
import { SettingsError } from "./errors";
import { newId } from "./ids";
import {
  finishImportBatch,
  insertWalletTransactions,
  latestImportBatch,
  type ImportBatchSummary,
  type ImportOptions,
  type ImportOutcome,
} from "./imports";
import {
  idField,
  STRIPE_KEY_NAME_PATTERN,
  stripeAccountLinkInputSchema,
  type StripeAccountLinkInput,
} from "./schemas";
import type { WriteOptions } from "./settings";
import { runInTransaction } from "./transaction";

export interface StripeAccountLinkSettings {
  walletId: string;
  walletName: string;
  stripeAccountId: string;
  /** Name of the environment variable that holds the key (never the key itself). */
  secretName: string;
  /** Whether that variable is set where this runs. */
  keyConfigured: boolean;
  /** The newest balance transaction seen; the next sync starts 7 days before it. */
  syncCursor: { created: Date; id: string } | null;
  lastSyncedAt: Date | null;
  lastBatch: ImportBatchSummary | null;
}

export interface StripeSyncOptions extends ImportOptions {
  /** Where balance transactions come from: the Stripe API with the wallet's key by default. */
  source?: BalanceTransactionSource;
}

export interface StripeSyncAllOptions extends ImportOptions {
  now?: Date;
  /** The source of a wallet's balance transactions; the Stripe API when it returns `undefined`. */
  sourceFor?: (walletId: string) => BalanceTransactionSource | undefined;
}

const NO_WALLET = "口座が見つかりません。画面を読み込み直してください";

/** Each sync reads again the 7 days before the cursor: late arrivals are caught, duplicates skipped. */
const CURSOR_OVERLAP_SECONDS = 7 * 24 * 60 * 60;
/** `ImportBatch.error` is one line of at most this many characters. */
const MAX_ERROR_LENGTH = 500;

const linkInclude = {
  wallet: { select: { name: true } },
} as const satisfies Prisma.StripeAccountLinkInclude;

type LinkRow = Prisma.StripeAccountLinkGetPayload<{ include: typeof linkInclude }>;

/**
 * The key named `secretName` (12-imports §4.1): `.env` locally, Secret Manager bound to the same
 * name on Cloud Run. `null` when it is not set, or when the name is not a `NIHO_FINANCE_STRIPE_*`
 * variable (no other secret is ever read as a Stripe key).
 */
export function resolveStripeApiKey(
  secretName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!STRIPE_KEY_NAME_PATTERN.test(secretName)) return null;
  loadRootEnv();
  const value = env[secretName]?.trim();
  return value ? value : null;
}

function toStripeAccountLinkSettings(
  row: LinkRow,
  lastBatch: ImportBatchSummary | null,
): StripeAccountLinkSettings {
  const cursor = parseSyncCursor(row.syncCursor);
  return {
    walletId: row.walletId,
    walletName: row.wallet.name,
    stripeAccountId: row.stripeAccountId,
    secretName: row.secretName,
    keyConfigured: resolveStripeApiKey(row.secretName) !== null,
    syncCursor: cursor ? { created: new Date(cursor.created * 1000), id: cursor.id } : null,
    lastSyncedAt: row.lastSyncedAt,
    lastBatch,
  };
}

export async function getStripeAccountLink(
  db: Db,
  walletId: string,
): Promise<StripeAccountLinkSettings | null> {
  const row = await db.stripeAccountLink.findUnique({ where: { walletId }, include: linkInclude });
  return row ? toStripeAccountLinkSettings(row, await latestImportBatch(db, walletId)) : null;
}

/** An active Stripe wallet; anything else cannot be connected or synced. */
async function loadStripeWallet(db: Db, walletId: string): Promise<Wallet> {
  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw new SettingsError(NO_WALLET, { field: "walletId" });
  if (wallet.kind !== "stripe") {
    throw new SettingsError("Stripe の口座ではありません。種類が Stripe の口座を選んでください", {
      field: "walletId",
    });
  }
  if (!wallet.isActive) {
    throw new SettingsError("この口座は無効です。設定 › 口座 で有効にしてください", {
      field: "walletId",
    });
  }
  return wallet;
}

/**
 * Connects a Stripe wallet, or changes its connection (`stripe_account_link.create` / `.update`).
 * Another account ID starts the sync over: its cursor and last sync are cleared.
 */
export async function saveStripeAccountLink(
  db: Db,
  input: StripeAccountLinkInput,
  options: WriteOptions,
): Promise<StripeAccountLinkSettings> {
  const data = stripeAccountLinkInputSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const wallet = await loadStripeWallet(tx, data.walletId);
    const other = await tx.stripeAccountLink.findFirst({
      where: { stripeAccountId: data.stripeAccountId, walletId: { not: wallet.id } },
      include: linkInclude,
    });
    if (other) {
      throw new SettingsError(
        `このアカウントは口座「${other.wallet.name}」に接続済みです。同じアカウントを 2 つの口座に接続すると明細が二重になります`,
        { field: "stripeAccountId" },
      );
    }
    const current = await tx.stripeAccountLink.findUnique({ where: { walletId: wallet.id } });
    if (current === null) {
      const created = await tx.stripeAccountLink.create({
        data: {
          id: newId(),
          walletId: wallet.id,
          stripeAccountId: data.stripeAccountId,
          secretName: data.secretName,
        },
      });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "stripe_account_link.create",
        entity: "stripe_account_link",
        entityId: created.id,
        after: created,
      });
    } else if (
      current.stripeAccountId !== data.stripeAccountId ||
      current.secretName !== data.secretName
    ) {
      const accountChanged = current.stripeAccountId !== data.stripeAccountId;
      const updated = await tx.stripeAccountLink.update({
        where: { id: current.id },
        data: {
          stripeAccountId: data.stripeAccountId,
          secretName: data.secretName,
          ...(accountChanged ? { syncCursor: null, lastSyncedAt: null } : {}),
        },
      });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "stripe_account_link.update",
        entity: "stripe_account_link",
        entityId: updated.id,
        before: current,
        after: updated,
      });
    }
    const row = await tx.stripeAccountLink.findUniqueOrThrow({
      where: { walletId: wallet.id },
      include: linkInclude,
    });
    return toStripeAccountLinkSettings(row, await latestImportBatch(tx, wallet.id));
  });
}

/**
 * 接続を外す (`stripe_account_link.delete`): the lines and batches stay, the cursor goes with the
 * link. A wallet without a link is left as it is.
 */
export async function removeStripeAccountLink(
  db: Db,
  input: { walletId: string },
  options: WriteOptions,
): Promise<void> {
  const walletId = idField("口座").parse(input.walletId);
  await runInTransaction(db, async (tx) => {
    const link = await tx.stripeAccountLink.findUnique({ where: { walletId } });
    if (!link) return;
    await tx.stripeAccountLink.delete({ where: { id: link.id } });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "stripe_account_link.delete",
      entity: "stripe_account_link",
      entityId: link.id,
      before: link,
    });
  });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * `created[gte]` of the fetch (12-imports §4.2): 7 days before the cursor; without one, the JST
 * midnight of the wallet's statement opening date; without that, everything.
 */
function syncStartOf(
  cursor: SyncCursor | null,
  openingBalanceDate: Date | null,
): number | undefined {
  if (cursor) return Math.max(0, cursor.created - CURSOR_OVERLAP_SECONDS);
  if (openingBalanceDate) {
    return Date.parse(`${fromDbDate(openingBalanceDate)}T00:00:00+09:00`) / 1000;
  }
  return undefined;
}

/** The cursor never moves back: a fetch that saw only older transactions keeps the current one. */
function laterCursor(current: SyncCursor | null, newest: SyncCursor | null): SyncCursor | null {
  if (newest === null) return current;
  if (current !== null && current.created > newest.created) return current;
  return newest;
}

function periodOf(
  rows: readonly WalletTransactionDraft[],
): { from: CalendarDate; to: CalendarDate } | null {
  let from: CalendarDate | null = null;
  let to: CalendarDate | null = null;
  for (const { txnDate } of rows) {
    if (from === null || txnDate < from) from = txnDate;
    if (to === null || txnDate > to) to = txnDate;
  }
  return from === null || to === null ? null : { from, to };
}

/** Masks anything that looks like a Stripe secret or restricted key, and the key in use. */
function redactKeys(text: string, apiKey: string | null): string {
  const masked = apiKey ? text.split(apiKey).join("***") : text;
  return masked.replace(/\b(?:rk|sk)_[A-Za-z0-9_*]+/g, "***");
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The SDK's error class name (`StripeAuthenticationError`, …), or "" when the error has none. */
function stripeErrorType(error: unknown): string {
  if (typeof error !== "object" || error === null || !("type" in error)) return "";
  return typeof error.type === "string" ? error.type : "";
}

/** Why a fetch failed, for the history (12-imports §4.4), followed by the API's own message. */
function fetchErrorMessage(error: unknown, secretName: string, apiKey: string): string {
  let reason: string;
  switch (stripeErrorType(error)) {
    case "StripeAuthenticationError":
      reason = `Stripe が鍵を受け付けませんでした。環境変数 ${secretName} の鍵を確かめてください`;
      break;
    case "StripePermissionError":
      reason =
        "鍵に残高の取引を読む権限がありません。制限付きキーで Balance transactions の読み取りを許可してください";
      break;
    case "StripeRateLimitError":
      reason = "Stripe の利用制限に当たりました。時間をおいて、もう一度同期してください";
      break;
    case "StripeConnectionError":
      reason = "Stripe に接続できませんでした。通信を確かめて、もう一度同期してください";
      break;
    default:
      reason = "Stripe から明細を取得できませんでした。時間をおいて、もう一度同期してください";
  }
  const detail = redactKeys(messageOf(error), apiKey).trim();
  return oneLine(detail === "" ? reason : `${reason}（${detail}）`);
}

/** The cells shown for a balance transaction that could not be read (its date, amount, kind). */
function failureCells(bt: StripeBalanceTransaction): string[] {
  return [
    todayInJapan(new Date(bt.created * 1000)),
    `${bt.amount} ${bt.currency.toUpperCase()}`,
    bt.description ?? bt.reporting_category,
  ];
}

/** A sync that could not fetch: a batch with `error`; the cursor and last sync stay as they were. */
async function recordFailedSync(
  db: Db,
  walletId: string,
  error: string,
  options: ImportOptions,
): Promise<ImportOutcome> {
  return runInTransaction(db, async (tx) => {
    const batchId = newId();
    await tx.importBatch.create({
      data: {
        id: batchId,
        walletId,
        source: "stripe",
        importer: "stripe",
        rowCount: 0,
        error,
        executedBy: options.actor,
      },
      select: { id: true },
    });
    const outcome: ImportOutcome = {
      batchId,
      walletId,
      source: "stripe",
      rowCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      failedCount: 0,
      warnings: [],
      error,
    };
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "import_batch.sync",
      entity: "import_batch",
      entityId: batchId,
      after: outcome,
    });
    return outcome;
  });
}

/**
 * Syncs a connected Stripe wallet (12-imports §4): resolves the key, fetches the balance
 * transactions since the cursor (less 7 days), converts them into gross and fee lines, stores the
 * new ones as `pending` in one batch and moves the cursor forward. A fetch that brings nothing
 * records no batch (only the last sync and the audit log). A missing key or an API error is
 * recorded as a batch with `error` and returned. Throws `SettingsError` only for a wallet that
 * is not a connected, active Stripe wallet.
 */
export async function syncStripeWallet(
  db: Db,
  input: { walletId: string; now?: Date },
  options: StripeSyncOptions,
): Promise<ImportOutcome> {
  const now = input.now ?? new Date();
  const wallet = await loadStripeWallet(db, input.walletId);
  const link = await db.stripeAccountLink.findUnique({ where: { walletId: wallet.id } });
  if (!link) {
    throw new SettingsError("Stripe が接続されていません。取込の設定で接続してください", {
      field: "walletId",
    });
  }
  const apiKey = resolveStripeApiKey(link.secretName);
  if (apiKey === null) {
    return recordFailedSync(
      db,
      wallet.id,
      `鍵がありません（環境変数 ${link.secretName}）。鍵を置いてから、もう一度同期してください`,
      options,
    );
  }
  const cursor = parseSyncCursor(link.syncCursor);
  const createdGte = syncStartOf(cursor, wallet.openingBalanceDate);
  let fetched: { transactions: StripeBalanceTransaction[]; newest: SyncCursor | null };
  try {
    const source = options.source ?? createStripeBalanceTransactionSource({ apiKey });
    fetched = await fetchBalanceTransactions(
      source,
      createdGte === undefined ? {} : { createdGte },
    );
  } catch (error) {
    return recordFailedSync(
      db,
      wallet.id,
      fetchErrorMessage(error, link.secretName, apiKey),
      options,
    );
  }

  // Oldest first (the API lists newest first), so the lines' IDs follow time as CSV lines do.
  const rows: WalletTransactionDraft[] = [];
  const failures: RowFailure[] = [];
  let rowCount = 0;
  for (const bt of [...fetched.transactions].reverse()) {
    const converted = convertBalanceTransaction(bt);
    // Zero amount and zero fee: skipped, and not counted either (12-imports §4.3).
    if (converted.failure === null && converted.rows.length === 0) continue;
    if (converted.failure) {
      // Read again in the 7 days of overlap: the sync that first saw it recorded the failure.
      if (cursor !== null && bt.created <= cursor.created) continue;
      failures.push({ ...converted.failure, raw: failureCells(bt) });
    }
    rowCount += 1;
    rows.push(...converted.rows);
  }
  const syncCursor = laterCursor(cursor, fetched.newest);
  // The overlap re-reads lines the wallet has: a batch is recorded only when something is new
  // (a line or a failure), so the daily sync does not fill the history with 「新規 0」.
  const stored = new Set(
    rows.length === 0
      ? []
      : (
          await db.walletTransaction.findMany({
            where: { walletId: wallet.id, externalId: { in: rows.map((row) => row.externalId) } },
            select: { externalId: true },
          })
        ).map((row) => row.externalId),
  );
  const hasNewLines = rows.some((row) => !stored.has(row.externalId));

  return runInTransaction(db, async (tx) => {
    let batchId: string | null = null;
    let created: string[] = [];
    let duplicateCount = rows.length;
    if (hasNewLines || failures.length > 0) {
      batchId = newId();
      const period = periodOf(rows);
      await tx.importBatch.create({
        data: {
          id: batchId,
          walletId: wallet.id,
          source: "stripe",
          importer: "stripe",
          periodFrom: period ? toDbDate(period.from) : null,
          periodTo: period ? toDbDate(period.to) : null,
          rowCount,
          failedCount: failures.length,
          failures: toAuditJson(failures),
          warnings: [],
          executedBy: options.actor,
        },
        select: { id: true },
      });
      ({ created, duplicateCount } = await insertWalletTransactions(tx, {
        walletId: wallet.id,
        importBatchId: batchId,
        drafts: rows,
      }));
      await tx.importBatch.update({
        where: { id: batchId },
        data: { importedCount: created.length, duplicateCount },
        select: { id: true },
      });
      await finishImportBatch(
        tx,
        { id: batchId, walletId: wallet.id, source: "stripe" },
        created,
        options,
      );
    }
    await tx.stripeAccountLink.update({
      where: { id: link.id },
      data: {
        syncCursor: syncCursor === null ? null : JSON.stringify(syncCursor),
        lastSyncedAt: now,
      },
    });
    const outcome: ImportOutcome = {
      batchId,
      walletId: wallet.id,
      source: "stripe",
      rowCount,
      importedCount: created.length,
      duplicateCount,
      failedCount: failures.length,
      warnings: [],
      error: null,
    };
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "import_batch.sync",
      entity: "import_batch",
      entityId: batchId,
      after: { ...outcome, syncCursor, lastSyncedAt: now },
    });
    return outcome;
  });
}

/** A wallet whose sync threw: its outcome carries the reason instead. */
function unsyncedOutcome(walletId: string, error: unknown): ImportOutcome {
  let message: string;
  if (error instanceof SettingsError) {
    message = error.message;
  } else {
    console.error(
      `[niho-finance] Stripe sync of wallet ${walletId} failed: ${redactKeys(messageOf(error), null)}`,
    );
    message = "同期できませんでした。時間をおいて、もう一度同期してください";
  }
  return {
    batchId: null,
    walletId,
    source: "stripe",
    rowCount: 0,
    importedCount: 0,
    duplicateCount: 0,
    failedCount: 0,
    warnings: [],
    error: message,
  };
}

/**
 * Syncs every active, connected Stripe wallet in turn (the daily job, 12-imports §4.4). One
 * wallet's failure is that wallet's outcome (`error`); it never stops the others or throws.
 */
export async function syncAllStripeWallets(
  db: Db,
  options: StripeSyncAllOptions,
): Promise<ImportOutcome[]> {
  const wallets = await db.wallet.findMany({
    where: { isActive: true, kind: "stripe", stripeAccount: { isNot: null } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const outcomes: ImportOutcome[] = [];
  for (const { id } of wallets) {
    try {
      outcomes.push(
        await syncStripeWallet(
          db,
          { walletId: id, now: options.now },
          {
            actor: options.actor,
            afterImport: options.afterImport,
            source: options.sourceFor?.(id),
          },
        ),
      );
    } catch (error) {
      outcomes.push(unsyncedOutcome(id, error));
    }
  }
  return outcomes;
}
