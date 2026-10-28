"use server";

import {
  correctJournalEntry,
  getPrismaClient,
  postSimpleEntry,
  postVoucherEntry,
  voidJournalEntryWithOpenDate,
  type CorrectEntryInput,
  type SimpleEntryFormInput,
  type VoucherEntryFormInput,
} from "@niho-finance/db";
import type { CalendarDate } from "@niho-finance/ledger";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { authorizeAction } from "@/lib/authz";

/*
 * Server Actions of /entries (11 §4–§6). The repository validates every input with its Zod schemas
 * and posts through the ledger (numbering, the rules, the audit log as the signed-in user,
 * `lib/actor.ts`).
 * Expected failures come back as `{ ok: false }` with the field of each problem.
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

/** Form values from the client: a plain object (the repository checks every field). */
const valuesSchema = z.record(z.string(), z.unknown());

export interface PostedEntry {
  id: string;
  no: number;
}

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The list, the detail, the home and the fiscal years (entry counts) read the journal.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

/** 収入 / 支出 / 振替. */
export async function postSimpleEntryAction(values: unknown): Promise<ActionResult<PostedEntry>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      postSimpleEntry(prisma(), valuesSchema.parse(values) as SimpleEntryFormInput, await by()),
    (entry) => ({ id: entry.id, no: entry.no }),
  );
}

/** 伝票. */
export async function postVoucherEntryAction(values: unknown): Promise<ActionResult<PostedEntry>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      postVoucherEntry(prisma(), valuesSchema.parse(values) as VoucherEntryFormInput, await by()),
    (entry) => ({ id: entry.id, no: entry.no }),
  );
}

export interface VoidedEntry {
  no: number;
  reversalNo: number;
  /** The date the reversal was given (the first open date when the entry's month is closed). */
  reversalDate: CalendarDate;
}

/** 取消: the reversal is dated on the entry's date, or the first open date when it is closed. */
export async function voidEntryAction(
  id: string,
  values: { reason: string },
): Promise<ActionResult<VoidedEntry>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      voidJournalEntryWithOpenDate(
        prisma(),
        parseId(id),
        { reason: valuesSchema.parse(values).reason },
        await by(),
      ),
    ({ voided, reversal }) => ({
      no: voided.no,
      reversalNo: reversal.no,
      reversalDate: reversal.entryDate,
    }),
  );
}

export interface CorrectedEntry extends PostedEntry {
  voidedNo: number;
}

/** 訂正. The replacement's field errors come back without the `replacement.` prefix. */
export async function correctEntryAction(
  id: string,
  values: { reason: string; replacement: unknown },
): Promise<ActionResult<CorrectedEntry>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  const result = await write(
    async () => {
      const input = valuesSchema.parse(values);
      return correctJournalEntry(
        prisma(),
        parseId(id),
        { reason: input.reason, replacement: input.replacement } as CorrectEntryInput,
        await by(),
      );
    },
    ({ voided, replacement }) => ({ id: replacement.id, no: replacement.no, voidedNo: voided.no }),
  );
  if (result.ok) return result;
  const fieldErrors = Object.fromEntries(
    Object.entries(result.fieldErrors).map(([field, message]) => [
      field.replace(/^replacement\./, ""),
      message,
    ]),
  );
  return { ...result, fieldErrors };
}
