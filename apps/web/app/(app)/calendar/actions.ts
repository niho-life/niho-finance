"use server";

import { completeCalendarItem, getPrismaClient, reopenCalendarItem } from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { attempt, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";

/*
 * Server Actions of /calendar (24 §2): 完了にする / 未完了に戻す as the signed-in user
 * (`lib/actor.ts`), each with its audit log entry. Expected failures come back as `{ ok: false }`.
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

async function write(run: () => Promise<unknown>): Promise<ActionResult> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The list, the home's やること and the audit log read the calendar.
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/** 完了にする. */
export async function completeCalendarItemAction(id: string): Promise<ActionResult> {
  return write(async () => completeCalendarItem(prisma(), parseId(id), await by()));
}

/** 未完了に戻す. */
export async function reopenCalendarItemAction(id: string): Promise<ActionResult> {
  return write(async () => reopenCalendarItem(prisma(), parseId(id), await by()));
}
