"use server";

import {
  checkFirstMonthStep,
  closeFirstMonthGuide,
  FIRST_MONTH_STEP_KEYS,
  getPrismaClient,
  showFirstMonthGuide,
  uncheckFirstMonthStep,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { authorizeAction } from "@/lib/authz";

/*
 * Server Actions of 初月のガイド「はじめの手順」(10 §3.1, §4.1): 済みにする / 未了に戻す on the home's
 * card, ホームに表示する on 設定 › 事業所 and 閉じる, as the signed-in user (`lib/actor.ts`), each with
 * its audit log entry. Expected failures come back as `{ ok: false }`.
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

const stepKeySchema = z.enum(FIRST_MONTH_STEP_KEYS, {
  error: "この手順は見つかりません。画面を読み込み直してから、もう一度試してください",
});

async function write(run: () => Promise<unknown>): Promise<ActionResult> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The home's card and 設定 › 事業所 read the guide, the audit log its entries.
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/** 済みにする. */
export async function checkFirstMonthStepAction(key: string): Promise<ActionResult> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(async () =>
    checkFirstMonthStep(prisma(), { key: stepKeySchema.parse(key) }, await by()),
  );
}

/** 未了に戻す. */
export async function uncheckFirstMonthStepAction(key: string): Promise<ActionResult> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(async () =>
    uncheckFirstMonthStep(prisma(), { key: stepKeySchema.parse(key) }, await by()),
  );
}

/** ホームに表示する (設定 › 事業所). */
export async function showFirstMonthGuideAction(): Promise<ActionResult> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(async () => showFirstMonthGuide(prisma(), await by()));
}

/** 閉じる (the card shown again after everything is done). */
export async function closeFirstMonthGuideAction(): Promise<ActionResult> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(async () => closeFirstMonthGuide(prisma(), await by()));
}
