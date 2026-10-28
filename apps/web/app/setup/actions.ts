"use server";

import {
  bootstrapStandardData,
  createCompany,
  createFirstFiscalYear,
  createWallets,
  getCompany,
  getPrismaClient,
  postOpeningEntries,
  previewOpeningEntries,
  skipSetupStep,
  updateCompany,
  type CompanyInput,
  type OpeningInput,
  type WalletCreateInput,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { attempt, formInput } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { toOpeningPreviewView, type OpeningPreviewView } from "@/lib/opening-view";
import { stepHref, type WizardStep } from "./steps";

/*
 * Server Actions of the setup wizard. Each step saves, then moves on with a redirect, so that
 * reopening /setup resumes from the database state. Failures come back as `{ ok: false }`.
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

function goTo(step: WizardStep): never {
  revalidatePath("/", "layout");
  redirect(stepHref(step));
}

/** Step 1: registers the company, or updates it when the owner came back to this step. */
export async function saveCompanyStepAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const result = await attempt(async () => {
    const values = formInput<CompanyInput>(formData);
    const existing = await getCompany(prisma());
    return existing
      ? updateCompany(prisma(), values, await by())
      : createCompany(prisma(), values, await by());
  });
  if (!result.ok) return result;
  goTo("fiscal_year");
}

/** Step 2: creates 第 1 期 from the founding date. */
export async function createFirstFiscalYearAction(values: {
  endDate: string;
  consumptionTax: string;
  accountingMethod: string;
}): Promise<ActionResult> {
  const result = await attempt(async () =>
    createFirstFiscalYear(
      prisma(),
      {
        endDate: values.endDate,
        consumptionTax: values.consumptionTax,
        accountingMethod: values.accountingMethod,
      },
      await by(),
    ),
  );
  if (!result.ok) return result;
  goTo("accounts");
}

/** Step 3: the chart template with the tax categories, rate rules and segments. */
export async function bootstrapStandardDataAction(): Promise<ActionResult> {
  const result = await attempt(async () => bootstrapStandardData(prisma(), await by()));
  if (!result.ok) return result;
  goTo("wallets");
}

const walletRowsSchema = z.array(z.record(z.string(), z.string())).max(20);

/** Step 4: the wallets checked in the list, in one transaction. */
export async function createWalletsAction(rows: unknown): Promise<ActionResult> {
  const result = await attempt(async () =>
    createWallets(prisma(), walletRowsSchema.parse(rows) as WalletCreateInput[], await by()),
  );
  if (!result.ok) return result;
  goTo("opening");
}

/** 「あとで」 on Step 4 or 5 (done later from the settings or the home). */
export async function skipWalletsAction(): Promise<ActionResult> {
  const result = await attempt(async () => skipSetupStep(prisma(), "wallets", await by()));
  if (!result.ok) return result;
  goTo("opening");
}

export async function skipOpeningAction(): Promise<ActionResult> {
  const result = await attempt(async () => skipSetupStep(prisma(), "opening", await by()));
  if (!result.ok) return result;
  goTo("complete");
}

/** Step 5 preview: the entries that 「登録」 would post (nothing is written). */
export async function previewOpeningAction(
  input: OpeningInput,
): Promise<ActionResult<OpeningPreviewView>> {
  const result = await attempt(() => previewOpeningEntries(prisma(), input));
  return result.ok ? { ok: true, data: toOpeningPreviewView(result.data) } : result;
}

/** Step 5: posts the opening entries once (kind 開始, segment 共通). */
export async function postOpeningAction(input: OpeningInput): Promise<ActionResult> {
  const result = await attempt(async () => postOpeningEntries(prisma(), input, await by()));
  if (!result.ok) return result;
  goTo("complete");
}
