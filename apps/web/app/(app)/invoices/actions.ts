"use server";

import {
  cancelInvoicePayment,
  createInvoiceDraft,
  discardInvoiceDraft,
  getPrismaClient,
  issueInvoice,
  markInvoiceSent,
  recordInvoicePayment,
  SettingsError,
  updateInvoiceDraft,
  updateInvoiceSettings,
  voidInvoice,
  type CancelInvoicePaymentInput,
  type InvoiceDraftInput,
  type InvoicePaymentInput,
  type InvoiceRecord,
  type InvoiceSendInput,
  type InvoiceVoidInput,
} from "@niho-finance/db";
import type { InvoiceStatus } from "@niho-finance/ledger";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, formInput, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { keepInvoicePdfAsDocument } from "./_lib/evidence";
import { sendInvoiceMail, type SentInvoiceMail } from "./_lib/mail";

/*
 * Server Actions of /invoices (18 §8–§10). The repository validates every input with its Zod
 * schemas, locks the document and writes the audit log as the signed-in user (`lib/actor.ts`). Expected failures
 * come back as `{ ok: false }` with the field of each problem. Amounts go back as decimal text:
 * bigint stays on the server.
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

/** Values from the client: a plain object (the repository checks every field). */
const valuesSchema = z.record(z.string(), z.unknown());

/** What the screens need after a write. */
export interface SavedInvoice {
  id: string;
  /** Raw number (`invoiceNumberLabel` shows a draft's as 下書き). */
  number: string;
  status: InvoiceStatus;
  /** 残高 as decimal text (請求書 only). */
  balance: string | null;
}

export interface IssuedInvoice extends SavedInvoice {
  /** The 証憑 the issued PDF was saved as; `null` when saving it failed (offered again on the detail). */
  pdfDocumentId: string | null;
}

function saved(record: InvoiceRecord): SavedInvoice {
  return {
    id: record.id,
    number: record.number,
    status: record.status,
    balance: record.balance === null ? null : record.balance.toString(),
  };
}

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The list, the detail, the journal (売掛金 / 入金) and the home read what changed.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

/** 新規 / 変換 / 複製: saves a draft. */
export async function createInvoiceDraftAction(
  values: unknown,
): Promise<ActionResult<SavedInvoice>> {
  return write(
    async () =>
      createInvoiceDraft(prisma(), valuesSchema.parse(values) as InvoiceDraftInput, await by()),
    saved,
  );
}

/** 編集 of a draft. */
export async function updateInvoiceDraftAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedInvoice>> {
  return write(
    async () =>
      updateInvoiceDraft(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as InvoiceDraftInput,
        await by(),
      ),
    saved,
  );
}

/**
 * 発行: the number, the copies and (請求書) the 売掛金 / 売上 entry; then the PDF is kept as a 証憑
 * (18 §11). The issue stands even when the PDF cannot be saved.
 */
export async function issueInvoiceAction(id: string): Promise<ActionResult<IssuedInvoice>> {
  return write(
    async () => {
      const record = await issueInvoice(prisma(), parseId(id), await by());
      const pdfDocumentId = await keepInvoicePdfAsDocument(prisma(), record.id, await by());
      return { record, pdfDocumentId };
    },
    ({ record, pdfDocumentId }) => ({ ...saved(record), pdfDocumentId }),
  );
}

/** PDF を証憑に保存: for an issued document whose PDF was not saved on issue (18 §11). */
export async function saveInvoicePdfAction(id: string): Promise<ActionResult<string>> {
  return write(
    async () => {
      const documentId = await keepInvoicePdfAsDocument(prisma(), parseId(id), await by());
      if (!documentId) {
        throw new SettingsError(
          "PDF を証憑に保存できませんでした。もう一度試してください。続くときは 設定 › 証憑の規程 の保存先を確かめてください",
        );
      }
      return documentId;
    },
    (documentId) => documentId,
  );
}

/** 破棄 of a draft (logical). */
export async function discardInvoiceDraftAction(id: string): Promise<ActionResult<SavedInvoice>> {
  return write(async () => discardInvoiceDraft(prisma(), parseId(id), await by()), saved);
}

/** 送付済みにする. */
export async function markInvoiceSentAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedInvoice>> {
  return write(
    async () =>
      markInvoiceSent(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as InvoiceSendInput,
        await by(),
      ),
    saved,
  );
}

/**
 * メールで送付: the PDF goes to the partner by mail; a mail that went out (SMTP) records 送付済み.
 */
export async function sendInvoiceMailAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SentInvoiceMail>> {
  return write(
    async () =>
      sendInvoiceMail(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as Parameters<typeof sendInvoiceMail>[2],
        await by(),
      ),
    (sent) => sent,
  );
}

/** 無効にする: an invoice's 売掛金 entry is reversed. */
export async function voidInvoiceAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedInvoice>> {
  return write(
    async () =>
      voidInvoice(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as InvoiceVoidInput,
        await by(),
      ),
    saved,
  );
}

/** 入金の登録 (by hand or from a statement line). */
export async function recordInvoicePaymentAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedInvoice>> {
  return write(
    async () =>
      recordInvoicePayment(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as InvoicePaymentInput,
        await by(),
      ),
    saved,
  );
}

/** 入金の取消: the payment's entry is reversed and the balance comes back. */
export async function cancelInvoicePaymentAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedInvoice>> {
  return write(
    async () =>
      cancelInvoicePayment(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as CancelInvoicePaymentInput,
        await by(),
      ),
    saved,
  );
}

/** 請求の設定: the 振込先 printed on invoices. */
export async function saveInvoiceSettingsAction(formData: FormData): Promise<ActionResult> {
  return write(
    async () => updateInvoiceSettings(prisma(), formInput(formData), await by()),
    () => null,
  );
}
