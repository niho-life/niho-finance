"use server";

import { getPrismaClient, setPropertyTaxMunicipality } from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { attempt, formValues } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";

/**
 * 申告先 「保存」 (16 §14.4): the municipality of the head office on the company, written with the
 * audit log `company.update` (the repository validates the field).
 */
export async function savePropertyTaxMunicipalityAction(
  formData: FormData,
): Promise<ActionResult<{ municipality: string | null }>> {
  const result = await attempt(async () =>
    setPropertyTaxMunicipality(
      getPrismaClient(),
      { municipality: formValues(formData).municipality ?? "" },
      { actor: await actor() },
    ),
  );
  if (!result.ok) return result;
  revalidatePath("/closing/assets/return");
  return result;
}
