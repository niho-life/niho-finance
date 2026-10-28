"use server";

import {
  cancelPayable,
  cancelPayablePayment,
  getPrismaClient,
  payPayable,
  registerPayable,
  updatePartnerPaymentTerms,
  updatePayable,
  type CancelPayableInput,
  type CancelPayablePaymentInput,
  type PartnerPaymentTermsInput,
  type PayablePaymentInput,
  type PayableRegisterInput,
  type PayableUpdateInput,
} from "@niho-finance/db";
import type { PayableState, PaymentTerms } from "@niho-finance/ledger";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";

/*
 * Server Actions of /payables (25 §6, §7). The repository validates every input with its Zod
 * schemas, locks the document and writes the audit log as the signed-in user (`lib/actor.ts`).
 * Expected failures come back as `{ ok: false }` with the field of each problem. Amounts go back as
 * decimal text: bigint stays on the server.
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

/** Values from the client: a plain object (the repository checks every field). */
const valuesSchema = z.record(z.string(), z.unknown());

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The list, the detail, the journal, the statements, the documents and the home read what changed.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

export interface RegisteredPayable {
  documentId: string;
  partnerName: string;
  entryNo: number;
}

/** 未払として登録: 費用 / 未払金 on the invoice date; the document is linked and filled. */
export async function registerPayableAction(
  values: unknown,
): Promise<ActionResult<RegisteredPayable>> {
  return write(
    async () =>
      registerPayable(prisma(), valuesSchema.parse(values) as PayableRegisterInput, await by()),
    (record) => ({
      documentId: record.documentId,
      partnerName: record.partnerName,
      entryNo: record.entry.no,
    }),
  );
}

/** 期日・支払元を変える (not a ledger change). */
export async function updatePayableAction(id: string, values: unknown): Promise<ActionResult> {
  return write(
    async () =>
      updatePayable(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as PayableUpdateInput,
        await by(),
      ),
    () => null,
  );
}

export interface PaidPayable {
  entryNo: number;
  /** 充当額・手数料・支払後の残り as decimal text. */
  applied: string;
  fee: string;
  remaining: string;
  state: PayableState;
}

/** 支払を登録 (by hand or from a statement line, which becomes 登録済み). */
export async function payPayableAction(
  id: string,
  values: unknown,
): Promise<ActionResult<PaidPayable>> {
  return write(
    async () =>
      payPayable(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as PayablePaymentInput,
        await by(),
      ),
    (result) => ({
      entryNo: result.entry.no,
      applied: result.applied.toString(),
      fee: result.fee.toString(),
      remaining: result.remaining.toString(),
      state: result.state,
    }),
  );
}

export interface ReversedPayable {
  reversalNo: number;
  /** Statement lines put back to 未処理. */
  reopenedCount: number;
}

/** 支払の取消: the payment's entry is reversed (a statement line goes back to 未処理 with it). */
export async function cancelPayablePaymentAction(
  id: string,
  values: unknown,
): Promise<ActionResult<ReversedPayable>> {
  return write(
    async () =>
      cancelPayablePayment(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as CancelPayablePaymentInput,
        await by(),
      ),
    (result) => ({ reversalNo: result.reversal.no, reopenedCount: result.reopenedIds.length }),
  );
}

/** 登録を取り消す: the 計上 entry is reversed and the payable becomes 取消. */
export async function cancelPayableAction(
  id: string,
  values: unknown,
): Promise<ActionResult<ReversedPayable>> {
  return write(
    async () =>
      cancelPayable(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as CancelPayableInput,
        await by(),
      ),
    (result) => ({ reversalNo: result.reversal.no, reopenedCount: result.reopenedIds.length }),
  );
}

/** 「この取引先の支払条件として保存」 (audit `partner.update`). */
export async function savePaymentTermsAction(
  values: unknown,
): Promise<ActionResult<PaymentTerms | null>> {
  return write(
    async () =>
      updatePartnerPaymentTerms(
        prisma(),
        valuesSchema.parse(values) as PartnerPaymentTermsInput,
        await by(),
      ),
    (terms) => terms,
  );
}
