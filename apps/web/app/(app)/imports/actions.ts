"use server";

import {
  getPrismaClient,
  importCsv,
  settleAfterImport,
  MAX_CSV_FILE_BYTES,
  previewCsvImport,
  removeStripeAccountLink,
  saveStripeAccountLink,
  SettingsError,
  syncStripeWallet,
  updateWalletImporter,
  type CsvImportInput,
  type CsvImportPreview,
  type StripeAccountLinkInput,
  type WalletImporterInput,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { attempt, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { keepImportFileAsDocument } from "@/lib/documents/import-evidence";
import { actor } from "@/lib/env";
import type { CsvImported, CsvPreviewView, StripeSyncView } from "./_lib/types";

/*
 * Server Actions of /imports (12-imports §1, §4.4). The repository validates every input with its
 * Zod schemas and writes through `@niho-finance/db` with the audit log (as `NIHO_FINANCE_ACTOR`).
 * The CSV file comes with every call (the preview and the import each read it; nothing is kept on
 * the server in between). Expected failures come back as `{ ok: false }`, never thrown.
 */

const prisma = () => getPrismaClient();
const by = () => ({ actor: actor() });

/** Form values from the client: a plain object (the repository checks every field). */
const valuesSchema = z.record(z.string(), z.unknown());

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The import list, the history, the wallets' 取込形式 and the result pages read what changed.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

/** A malformed request (not a typing mistake): `toActionError` turns it into the shape error. */
function shapeError(field: string, input: unknown): ZodError {
  return new ZodError([{ code: "custom", path: [field], message: "Malformed form value", input }]);
}

function textValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (value === null) return "";
  if (typeof value !== "string") throw shapeError(name, value);
  return value;
}

/** The mapping of 汎用 as JSON text; "" when the server should use the wallet's saved one. */
function configValue(formData: FormData): unknown {
  const text = textValue(formData, "config").trim();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw shapeError("config", text);
  }
}

/** walletId, file, format ("" = the saved or detected format) and config of the CSV form. */
async function csvInput(formData: FormData): Promise<CsvImportInput> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new SettingsError("ファイルを選んでください", { field: "file" });
  }
  if (file.size > MAX_CSV_FILE_BYTES) {
    throw new SettingsError("ファイルが大きすぎます（10 MB まで）", { field: "file" });
  }
  const format = textValue(formData, "format").trim();
  return {
    walletId: textValue(formData, "walletId"),
    fileName: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    format: format === "" ? null : format,
    config: configValue(formData),
  };
}

function toPreviewView(preview: CsvImportPreview): CsvPreviewView {
  const money = (value: bigint | null) => (value === null ? null : String(value));
  return {
    walletId: preview.walletId,
    fileName: preview.fileName,
    byteSize: preview.byteSize,
    encoding: preview.encoding,
    format: preview.format,
    detectedFormat: preview.detectedFormat,
    config: preview.config,
    table: preview.table,
    columnCount: preview.columnCount,
    rows: preview.rows.map((row) => ({
      externalId: row.externalId,
      txnDate: row.txnDate,
      amount: String(row.amount),
      descriptionRaw: row.descriptionRaw,
      counterpartyRaw: row.counterpartyRaw,
      balanceAfter: money(row.balanceAfter),
      duplicate: row.duplicate,
    })),
    rowCount: preview.rowCount,
    duplicateCount: preview.duplicateCount,
    failures: preview.failures,
    warnings: preview.warnings,
    period: preview.period,
    openingBalance: money(preview.openingBalance),
    closingBalance: money(preview.closingBalance),
    alreadyImported: preview.alreadyImported
      ? {
          batchId: preview.alreadyImported.batchId,
          executedAt: preview.alreadyImported.executedAt.toISOString(),
        }
      : null,
  };
}

// CSV ------------------------------------------------------------------------

/** プレビュー: reads the file and writes nothing (no revalidation). */
export async function previewCsvImportAction(
  formData: FormData,
): Promise<ActionResult<CsvPreviewView>> {
  return attempt(async () =>
    toPreviewView(await previewCsvImport(prisma(), await csvInput(formData))),
  );
}

/** 取り込む: the same fields as the preview, plus `rememberFormat`. */
export async function importCsvAction(formData: FormData): Promise<ActionResult<CsvImported>> {
  return write(
    async () => {
      const input = await csvInput(formData);
      const remember = textValue(formData, "rememberFormat");
      const outcome = await importCsv(
        prisma(),
        { ...input, rememberFormat: remember === "true" || remember === "on" },
        // 取込時の自動登録 (15 §11): the new lines an `autoPost` rule wins are settled in the import.
        { ...by(), afterImport: settleAfterImport },
      );
      // A CSV import always records its batch; without one there is nothing to open.
      if (outcome.batchId === null) throw new Error("importCsv returned no batch");
      // The file is electronic transaction data: kept as a 明細書 document (S6, 13 §9).
      await keepImportFileAsDocument(
        prisma(),
        {
          batchId: outcome.batchId,
          bytes: input.bytes,
          fileName: typeof input.fileName === "string" ? input.fileName : null,
        },
        by(),
      );
      return outcome.batchId;
    },
    (batchId) => ({ batchId }),
  );
}

// 取込の設定 -------------------------------------------------------------------

/** 取込形式 of a bank / card / other wallet: `{ walletId, importer, importerConfig }`. */
export async function updateWalletImporterAction(values: unknown): Promise<ActionResult> {
  return write(
    () => updateWalletImporter(prisma(), valuesSchema.parse(values) as WalletImporterInput, by()),
    () => null,
  );
}

/** Stripe の接続: `{ walletId, stripeAccountId, secretName }` (the key's variable name, never the key). */
export async function saveStripeAccountLinkAction(values: unknown): Promise<ActionResult> {
  return write(
    () =>
      saveStripeAccountLink(prisma(), valuesSchema.parse(values) as StripeAccountLinkInput, by()),
    () => null,
  );
}

/** 接続を外す: the lines and the history stay; the cursor goes with the connection. */
export async function removeStripeAccountLinkAction(walletId: string): Promise<ActionResult> {
  return write(
    () => removeStripeAccountLink(prisma(), { walletId: parseId(walletId) }, by()),
    () => null,
  );
}

/**
 * 同期 of one Stripe wallet. A sync that failed (no key, an API error) is recorded as a batch and
 * comes back as `ok: true` with `error`; a wallet that cannot sync at all is `ok: false`.
 */
export async function syncStripeAction(walletId: string): Promise<ActionResult<StripeSyncView>> {
  return write(
    () =>
      syncStripeWallet(
        prisma(),
        { walletId: parseId(walletId) },
        { ...by(), afterImport: settleAfterImport },
      ),
    ({ batchId, importedCount, duplicateCount, failedCount, error }) => ({
      batchId,
      importedCount,
      duplicateCount,
      failedCount,
      error,
    }),
  );
}
