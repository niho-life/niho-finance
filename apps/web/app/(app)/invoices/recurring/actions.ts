"use server";

import {
  createRecurringInvoice,
  createRecurringInvoiceDraft,
  createRecurringInvoiceDrafts,
  getPrismaClient,
  pauseRecurringInvoice,
  resumeRecurringInvoice,
  updateRecurringInvoice,
  type RecurringInvoiceDraftsInput,
  type RecurringInvoiceInput,
  type RecurringInvoiceRecord,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { authorizeAction } from "@/lib/authz";

/*
 * Server Actions of /invoices/recurring (18 §14). The repository validates every input with its Zod
 * schemas, locks the recurring invoice and writes the audit log as the signed-in user. A draft is
 * never issued here: the owner checks it on its detail and issues it there.
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

/** Values from the client: a plain object (the repository checks every field). */
const valuesSchema = z.record(z.string(), z.unknown());

export interface SavedRecurringInvoice {
  id: string;
  name: string;
  isActive: boolean;
}

/** A draft made from a due date (18 §14.3). */
export interface MadeRecurringDraft {
  recurringInvoiceId: string;
  month: string;
  name: string;
  invoiceId: string;
}

/** まとめて下書きを作る: each item made or refused with its reason. */
export interface MadeRecurringDrafts {
  created: number;
  failed: number;
  items: (
    | ({ ok: true } & MadeRecurringDraft)
    | { ok: false; recurringInvoiceId: string; month: string; message: string }
  )[];
}

function saved(record: RecurringInvoiceRecord): SavedRecurringInvoice {
  return { id: record.id, name: record.name, isActive: record.isActive };
}

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The lists, the detail, the invoices (a new draft) and the home's やること read what changed.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

/** 定期請求の追加. */
export async function createRecurringInvoiceAction(
  values: unknown,
): Promise<ActionResult<SavedRecurringInvoice>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      createRecurringInvoice(
        prisma(),
        valuesSchema.parse(values) as RecurringInvoiceInput,
        await by(),
      ),
    saved,
  );
}

/** 定期請求の編集: the drafts and invoices already made never change. */
export async function updateRecurringInvoiceAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedRecurringInvoice>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      updateRecurringInvoice(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as RecurringInvoiceInput,
        await by(),
      ),
    saved,
  );
}

/** 停止: no due dates until it is resumed. */
export async function pauseRecurringInvoiceAction(
  id: string,
): Promise<ActionResult<SavedRecurringInvoice>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(async () => pauseRecurringInvoice(prisma(), parseId(id), await by()), saved);
}

/** 再開. */
export async function resumeRecurringInvoiceAction(
  id: string,
): Promise<ActionResult<SavedRecurringInvoice>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(async () => resumeRecurringInvoice(prisma(), parseId(id), await by()), saved);
}

/** 下書きを作る: one due date's draft (the detail of the draft opens next). */
export async function createRecurringInvoiceDraftAction(
  values: unknown,
): Promise<ActionResult<MadeRecurringDraft>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      createRecurringInvoiceDraft(
        prisma(),
        valuesSchema.parse(values) as { recurringInvoiceId: string; month: string },
        await by(),
      ),
    (made) => ({
      recurringInvoiceId: made.recurringInvoiceId,
      month: made.month,
      name: made.name,
      invoiceId: made.invoice.id,
    }),
  );
}

/** まとめて下書きを作る: one transaction each; a refused item does not stop the others. */
export async function createRecurringInvoiceDraftsAction(
  values: unknown,
): Promise<ActionResult<MadeRecurringDrafts>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      createRecurringInvoiceDrafts(
        prisma(),
        valuesSchema.parse(values) as RecurringInvoiceDraftsInput,
        await by(),
      ),
    (result) => ({
      created: result.created,
      failed: result.failed,
      items: result.items.map((item) =>
        item.ok
          ? {
              ok: true as const,
              recurringInvoiceId: item.recurringInvoiceId,
              month: item.month,
              name: item.name,
              invoiceId: item.invoice.id,
            }
          : item,
      ),
    }),
  );
}
