"use server";

import {
  getPrismaClient,
  saveStatementSettings,
  type StatementSettingsInput,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { attempt, formValues, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";

/** How many その他の注記 the form may send (the repository allows 20; extra rows are a shape error). */
const OTHER_NOTE_ROWS = 40;

const NOTE_FIELDS = [
  "depreciation",
  "revenueRecognition",
  "otherSignificant",
  "accountingPolicyChanges",
  "presentationChanges",
  "errorCorrections",
] as const;
const BUSINESS_REPORT_FIELDS = ["progress", "issues", "otherMatters"] as const;

/**
 * The form of 決算書の設定 as the repository's input: fields are named by their dot path
 * (`notes.depreciation`, `notes.otherNotes.0.title`), so the field errors find their inputs.
 */
function settingsInput(formData: FormData): StatementSettingsInput {
  const values = formValues(formData);
  const pick = <K extends string>(prefix: string, keys: readonly K[]) => {
    const picked: Partial<Record<K, string>> = {};
    for (const key of keys) {
      const value = values[`${prefix}${key}`];
      if (value !== undefined) picked[key] = value;
    }
    return picked;
  };
  const otherNotes: { title: string; body: string }[] = [];
  for (let index = 0; index < OTHER_NOTE_ROWS; index += 1) {
    const title = values[`notes.otherNotes.${index}.title`];
    const body = values[`notes.otherNotes.${index}.body`];
    if (title === undefined && body === undefined) continue;
    otherNotes[index] = { title: title ?? "", body: body ?? "" };
  }
  return {
    issuedShares: values.issuedShares ?? "",
    shareholdersMeetingOn: values.shareholdersMeetingOn ?? "",
    announcementPublishedOn: values.announcementPublishedOn ?? "",
    announcementUrl: values.announcementUrl ?? "",
    notes: {
      ...pick("notes.", NOTE_FIELDS),
      // The form numbers its rows from 0 without gaps, so the error paths match the inputs.
      otherNotes: otherNotes.filter((note) => note !== undefined),
    },
    businessReport: pick("businessReport.", BUSINESS_REPORT_FIELDS),
    simplifiedTaxClass: values.simplifiedTaxClass ?? "",
  };
}

/** 決算書の設定 「保存」 (17 §3.1): written with the audit log `statements.update`. */
export async function saveStatementSettingsAction(
  fiscalYearId: string,
  formData: FormData,
): Promise<ActionResult> {
  const result = await attempt(async () =>
    saveStatementSettings(getPrismaClient(), parseId(fiscalYearId), settingsInput(formData), {
      actor: await actor(),
    }),
  );
  if (!result.ok) return result;
  revalidatePath("/closing/statements", "layout");
  return { ok: true, data: null };
}
