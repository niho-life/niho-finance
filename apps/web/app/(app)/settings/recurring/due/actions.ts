"use server";

import { getPrismaClient, postRecurringOccurrence } from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { attempt } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { authorizeAction } from "@/lib/authz";

/*
 * Server Action of 定期取引の登録 (21-cashflow §10.4, §10.5): one occurrence becomes an entry, as
 * the signed-in user, with the same minimum role as the transaction screens (`entries/actions.ts`).
 * The repository validates the input and refuses what cannot be registered (登録済み・締め済み …).
 */

export interface RecurringPostFormInput {
  recurringItemId: string;
  /** `YYYY-MM` */
  month: string;
  /** Positive yen as typed (`110,000`). */
  amount: string;
}

/** 「登録」: the entry's id and number (the toast links to it). */
export async function postRecurringOccurrenceAction(
  input: RecurringPostFormInput,
): Promise<ActionResult<{ id: string; no: number }>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  const result = await attempt(async () =>
    postRecurringOccurrence(
      getPrismaClient(),
      { recurringItemId: input?.recurringItemId, month: input?.month, amount: input?.amount },
      { actor: await actor() },
    ),
  );
  if (!result.ok) return result;
  // やること on the home, the count on 設定 › 定期取引 and the books change: refresh all.
  revalidatePath("/", "layout");
  return { ok: true, data: { id: result.data.entry.id, no: result.data.entry.no } };
}
