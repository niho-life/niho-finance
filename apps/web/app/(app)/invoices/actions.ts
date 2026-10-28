"use server";

import {
  cancelInvoicePayment,
  createInvoiceDraft,
  discardInvoiceDraft,
  getPrismaClient,
  issueInvoice,
  markInvoiceSent,
  recordInvoicePayment,
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
import { actor } from "@/lib/env";

/*
 * Server Actions of /invoices (18 §8–§10). The repository validates every input with its Zod
 * schemas, locks the document and writes the audit log as `NIHO_FINANCE_ACTOR`. Expected failures
 * come back as `{ ok: false }` with the field of each problem. Amounts go back as decimal text:
 * bigint stays on the server.
 */

const prisma = () => getPrismaClient();
const by = () => ({ actor: actor() });

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
    () => createInvoiceDraft(prisma(), valuesSchema.parse(values) as InvoiceDraftInput, by()),
    saved,
  );
}

/** 編集 of a draft. */
export async function updateInvoiceDraftAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedInvoice>> {
  return write(
    () =>
      updateInvoiceDraft(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as InvoiceDraftInput,
        by(),
      ),
    saved,
  );
}

/** 発行: the number, the copies and (請求書) the 売掛金 / 売上 entry. */
export async function issueInvoiceAction(id: string): Promise<ActionResult<SavedInvoice>> {
  return write(() => issueInvoice(prisma(), parseId(id), by()), saved);
}

/** 破棄 of a draft (logical). */
export async function discardInvoiceDraftAction(id: string): Promise<ActionResult<SavedInvoice>> {
  return write(() => discardInvoiceDraft(prisma(), parseId(id), by()), saved);
}

/** 送付済みにする. */
export async function markInvoiceSentAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedInvoice>> {
  return write(
    () =>
      markInvoiceSent(prisma(), parseId(id), valuesSchema.parse(values) as InvoiceSendInput, by()),
    saved,
  );
}

/** 無効にする: an invoice's 売掛金 entry is reversed. */
export async function voidInvoiceAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedInvoice>> {
  return write(
    () => voidInvoice(prisma(), parseId(id), valuesSchema.parse(values) as InvoiceVoidInput, by()),
    saved,
  );
}

/** 入金の登録 (by hand or from a statement line). */
export async function recordInvoicePaymentAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedInvoice>> {
  return write(
    () =>
      recordInvoicePayment(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as InvoicePaymentInput,
        by(),
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
    () =>
      cancelInvoicePayment(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as CancelInvoicePaymentInput,
        by(),
      ),
    saved,
  );
}

/** 請求の設定: the 振込先 printed on invoices. */
export async function saveInvoiceSettingsAction(formData: FormData): Promise<ActionResult> {
  return write(
    () => updateInvoiceSettings(prisma(), formInput(formData), by()),
    () => null,
  );
}
