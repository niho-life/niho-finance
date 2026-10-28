"use server";

import {
  applyRuleToPending,
  countRuleMatches,
  createRule,
  getPrismaClient,
  setRuleActive,
  updateRule,
  type RuleCreateInput,
  type RuleUpdateInput,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, parseBoolean, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/env";

/*
 * Server Actions of 設定 › ルール (15 §10), also called by 「ルールにする」 on /statements. The
 * repository validates the conditions and the action (`match.*`, `action.*`, `walletId` …), writes
 * the audit log (`rule.*`) and settles lines through the ledger when a rule is applied.
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
  // The rules change the chips of /statements; applying one posts entries.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

export interface SavedRule {
  id: string;
  displayName: string;
}

const saved = (rule: { id: string; displayName: string }): SavedRule => ({
  id: rule.id,
  displayName: rule.displayName,
});

export async function createRuleAction(values: unknown): Promise<ActionResult<SavedRule>> {
  return write(
    () => createRule(prisma(), valuesSchema.parse(values) as RuleCreateInput, by()),
    saved,
  );
}

export async function updateRuleAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SavedRule>> {
  return write(
    () => updateRule(prisma(), parseId(id), valuesSchema.parse(values) as RuleUpdateInput, by()),
    saved,
  );
}

export async function setRuleActiveAction(
  id: string,
  isActive: boolean,
): Promise<ActionResult<SavedRule>> {
  return write(() => setRuleActive(prisma(), parseId(id), parseBoolean(isActive), by()), saved);
}

export interface RuleMatchTotals {
  count: number;
  /** Money in, as text (bigint stays on the server). */
  inflow: string;
  /** Money out, as a positive amount in text. */
  outflow: string;
}

/** 「いま一致する未処理 n 件」: read-only, nothing is revalidated. */
export async function countRuleMatchesAction(values: {
  walletId: string;
  match: unknown;
}): Promise<ActionResult<RuleMatchTotals>> {
  const result = await attempt(() => {
    const input = z.object({ walletId: z.string().max(64), match: z.unknown() }).parse(values);
    return countRuleMatches(prisma(), { walletId: input.walletId || null, match: input.match });
  });
  if (!result.ok) return result;
  return {
    ok: true,
    data: {
      count: result.data.count,
      inflow: String(result.data.inflow),
      outflow: String(result.data.outflow),
    },
  };
}

export interface AppliedRule {
  registered: number;
  transferred: number;
  ignored: number;
  failed: { id: string; message: string }[];
}

/** 既存の未処理への適用: settles the pending lines this rule wins, as the import would. */
export async function applyRuleAction(id: string): Promise<ActionResult<AppliedRule>> {
  return write(
    () => applyRuleToPending(prisma(), parseId(id), by()),
    (result) => ({
      registered: result.registered,
      transferred: result.transferred,
      ignored: result.ignored,
      failed: result.failed,
    }),
  );
}
