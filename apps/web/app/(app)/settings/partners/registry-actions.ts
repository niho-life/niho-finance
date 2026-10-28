"use server";

import {
  checkPartnerRegistrations,
  getPrismaClient,
  SettingsError,
  type RegistryCheckResult,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { attempt } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { getNtaLookup } from "@/lib/reader/config";

const NOT_CONFIGURED = "国税庁の照合が設定されていません";

/**
 * 照合する (20-reader §10.3): the registration numbers of every active partner (valid ones only)
 * are looked up at the National Tax Agency's publication and the result is stored on the
 * partners (`partner.registry_check`). Failed batches leave their partners as they were and come
 * back in `errors`.
 */
export async function checkPartnerRegistrationsAction(): Promise<
  ActionResult<RegistryCheckResult>
> {
  const result = await attempt(async () => {
    const lookup = getNtaLookup();
    if (!lookup) throw new SettingsError(NOT_CONFIGURED);
    return checkPartnerRegistrations(getPrismaClient(), lookup, { actor: await actor() });
  });
  if (!result.ok) return result;
  // 照合 of the list, the documents' estimates and the readings use the stored result.
  revalidatePath("/", "layout");
  return result;
}
