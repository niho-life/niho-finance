"use server";

import { getPrismaClient, saveRecordsPolicy } from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { attempt, formInput } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { POLICY_VERSION } from "@/lib/documents/policy";
import { actor } from "@/lib/env";

/**
 * 設定 › 証憑の規程 (13 §5): puts the policy text of `POLICY_VERSION` in force with its 施行日 and
 * the people responsible. Recorded as `records_policy.save` by the repository.
 */
export async function saveRecordsPolicyAction(formData: FormData): Promise<ActionResult> {
  const result = await attempt(() =>
    saveRecordsPolicy(
      getPrismaClient(),
      { ...formInput(formData), version: POLICY_VERSION },
      { actor: actor() },
    ),
  );
  if (!result.ok) return result;
  // The settings index shows the 施行日.
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}
