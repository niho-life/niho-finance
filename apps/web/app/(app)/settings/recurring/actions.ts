"use server";

import {
  createRecurringItem,
  getPrismaClient,
  todayInJapan,
  updateRecurringItem,
  type RecurringItemCreateInput,
  type RecurringItemSettings,
} from "@niho-finance/db";
import { formatYenInput } from "@niho-finance/ledger";
import { revalidatePath } from "next/cache";
import { attempt, formInput, inlinePatch, parseBoolean, parseId } from "@/lib/action-result";
import type { ActionResult, RowValues } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { authorizeAction } from "@/lib/authz";

/*
 * Server Actions of 設定 › 定期取引 (21-cashflow §7), the same as the other settings lists: the
 * repository validates (inline edits may only touch the row's editable fields), writes with the
 * audit log as the signed-in user (`lib/actor.ts`), the pages are refreshed (the home's line included).
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The settings index counts the items and the home draws the line: refresh all.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

const RECURRING_FIELDS = [
  "name",
  "direction",
  "amount",
  "frequency",
  "monthOfYear",
  "dayOfMonth",
  "startDate",
  "endDate",
  "walletId",
  "accountId",
  "partnerId",
  "segmentId",
  "taxCategoryCode",
  "note",
] as const;

/** The saved item as the cells show it (金額 positive with grouping, 入出金 separately). */
function recurringValues(item: RecurringItemSettings): RowValues {
  return {
    name: item.name,
    direction: item.amount < 0n ? "withdrawal" : "deposit",
    amount: formatYenInput(item.amount < 0n ? -item.amount : item.amount),
    frequency: item.frequency,
    monthOfYear: item.monthOfYear === null ? "" : String(item.monthOfYear),
    dayOfMonth: item.dayOfMonth === null ? "" : String(item.dayOfMonth),
    startDate: item.startDate,
    endDate: item.endDate ?? "",
    walletId: item.walletId ?? "",
    accountId: item.accountId,
    partnerId: item.partnerId ?? "",
    segmentId: item.segmentId ?? "",
    taxCategoryCode: item.taxCategoryCode ?? "",
    note: item.note ?? "",
  };
}

/** 「追加」: the start date is today unless the form says otherwise (21 §7). */
export async function createRecurringItemAction(formData: FormData): Promise<ActionResult> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () => {
      const input = formInput<RecurringItemCreateInput>(formData);
      return createRecurringItem(
        prisma(),
        { ...input, startDate: input.startDate || todayInJapan() },
        await by(),
      );
    },
    () => null,
  );
}

export async function updateRecurringItemAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(async () => {
    const { id: itemId, ...fields } = inlinePatch(id, patch, RECURRING_FIELDS);
    return updateRecurringItem(prisma(), itemId, fields, await by());
  }, recurringValues);
}

/** 無効にする / 有効にする (the same update, `isActive` only). */
export async function setRecurringItemActiveAction(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      updateRecurringItem(prisma(), parseId(id), { isActive: parseBoolean(isActive) }, await by()),
    () => null,
  );
}
