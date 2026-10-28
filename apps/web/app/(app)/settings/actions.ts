"use server";

import {
  createAccount,
  createMemoTag,
  createNextFiscalYear,
  createPartner,
  createSegment,
  createSubAccount,
  createTaxRateRule,
  createWallet,
  getPrismaClient,
  setAccountActive,
  setMemoTagActive,
  setPartnerActive,
  setSegmentActive,
  setSubAccountActive,
  setTaxRateRuleEnabled,
  setWalletActive,
  updateAccount,
  updateCompany,
  updateFiscalYear,
  updateMemoTag,
  updatePartner,
  updateSegment,
  updateSubAccount,
  updateWallet,
  type AccountSettings,
  type MemoTagSettings,
  type PartnerSettings,
  type SegmentSettings,
  type TaxRateRuleCreateInput,
  type WalletUpdateInput,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { attempt, formInput, inlinePatch, parseBoolean, parseId } from "@/lib/action-result";
import type { ActionResult, RowValues } from "@/lib/action-types";
import { actor } from "@/lib/actor";

/*
 * Server Actions of /settings. Each one: validates with the repository's Zod schemas (inline edits
 * may only touch the row's editable fields), writes through `@niho-finance/db` (audit log included)
 * as the signed-in user (`lib/actor.ts`), refreshes the pages and returns
 * `{ ok: true } | { ok: false, error }`.
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The shell shows the company and the fiscal year, and the index shows counts: refresh all.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

const nothing = () => null;

// 事業所 ---------------------------------------------------------------------

export async function saveCompanyAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return write(async () => updateCompany(prisma(), formInput(formData), await by()), nothing);
}

// 会計期間 -------------------------------------------------------------------

export async function updateFiscalYearAction(
  id: string,
  values: { consumptionTax: string; accountingMethod: string },
): Promise<ActionResult<RowValues>> {
  return write(
    async () =>
      updateFiscalYear(
        prisma(),
        {
          id: parseId(id),
          consumptionTax: values.consumptionTax,
          accountingMethod: values.accountingMethod,
        },
        await by(),
      ),
    (year) => ({ consumptionTax: year.consumptionTax, accountingMethod: year.accountingMethod }),
  );
}

export async function createNextFiscalYearAction(values: {
  endDate: string;
  consumptionTax: string;
  accountingMethod: string;
}): Promise<ActionResult> {
  return write(
    async () =>
      createNextFiscalYear(
        prisma(),
        {
          endDate: values.endDate,
          consumptionTax: values.consumptionTax,
          accountingMethod: values.accountingMethod,
        },
        await by(),
      ),
    nothing,
  );
}

// 勘定科目・補助科目 ------------------------------------------------------------

const ACCOUNT_FIELDS = ["name", "group", "defaultTaxCategoryCode", "isCashLike"] as const;

function accountValues(account: AccountSettings): RowValues {
  return {
    name: account.name,
    group: account.group,
    defaultTaxCategoryCode: account.defaultTaxCategoryCode ?? "",
    isCashLike: account.isCashLike,
  };
}

export async function createAccountAction(formData: FormData): Promise<ActionResult> {
  return write(async () => createAccount(prisma(), formInput(formData), await by()), nothing);
}

export async function updateAccountAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  return write(
    async () => updateAccount(prisma(), inlinePatch(id, patch, ACCOUNT_FIELDS), await by()),
    accountValues,
  );
}

export async function setAccountActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  return write(
    async () =>
      setAccountActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, await by()),
    nothing,
  );
}

export async function createSubAccountAction(
  accountId: string,
  formData: FormData,
): Promise<ActionResult> {
  return write(
    async () =>
      createSubAccount(
        prisma(),
        { accountId: parseId(accountId), name: formData.get("name") },
        await by(),
      ),
    nothing,
  );
}

export async function updateSubAccountAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  return write(
    async () => {
      const { id: subAccountId, name } = inlinePatch(id, patch, ["name"] as const);
      return updateSubAccount(prisma(), { id: subAccountId, name }, await by());
    },
    (subAccount) => ({ name: subAccount.name }),
  );
}

export async function setSubAccountActiveAction(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  return write(
    async () =>
      setSubAccountActive(
        prisma(),
        { id: parseId(id), isActive: parseBoolean(isActive) },
        await by(),
      ),
    nothing,
  );
}

// 税区分 ---------------------------------------------------------------------

export async function createTaxRateRuleAction(
  taxCategoryCode: string,
  formData: FormData,
): Promise<ActionResult> {
  return write(
    async () =>
      createTaxRateRule(
        prisma(),
        { ...formInput<TaxRateRuleCreateInput>(formData), taxCategoryCode },
        await by(),
      ),
    nothing,
  );
}

export async function setTaxRateRuleEnabledAction(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  return write(
    async () =>
      setTaxRateRuleEnabled(
        prisma(),
        { id: parseId(id), enabled: parseBoolean(enabled) },
        await by(),
      ),
    nothing,
  );
}

// 口座 -----------------------------------------------------------------------

export async function createWalletAction(formData: FormData): Promise<ActionResult> {
  return write(async () => createWallet(prisma(), formInput(formData), await by()), nothing);
}

export async function updateWalletAction(id: string, formData: FormData): Promise<ActionResult> {
  return write(
    async () =>
      updateWallet(
        prisma(),
        { ...formInput<WalletUpdateInput>(formData), id: parseId(id) },
        await by(),
      ),
    nothing,
  );
}

export async function setWalletActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  return write(
    async () =>
      setWalletActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, await by()),
    nothing,
  );
}

// 取引先 ---------------------------------------------------------------------

const PARTNER_FIELDS = [
  "name",
  "nameKana",
  "kind",
  "invoiceRegistrationNumber",
  "defaultAccountId",
  "defaultSegmentId",
  "defaultTaxCategoryCode",
] as const;

function partnerValues(partner: PartnerSettings): RowValues {
  return {
    name: partner.name,
    nameKana: partner.nameKana ?? "",
    kind: partner.kind,
    invoiceRegistrationNumber: partner.invoiceRegistrationNumber ?? "",
    defaultAccountId: partner.defaultAccountId ?? "",
    defaultSegmentId: partner.defaultSegmentId ?? "",
    defaultTaxCategoryCode: partner.defaultTaxCategoryCode ?? "",
  };
}

export async function createPartnerAction(formData: FormData): Promise<ActionResult> {
  return write(async () => createPartner(prisma(), formInput(formData), await by()), nothing);
}

export async function updatePartnerAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  return write(
    async () => updatePartner(prisma(), inlinePatch(id, patch, PARTNER_FIELDS), await by()),
    partnerValues,
  );
}

export async function setPartnerActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  return write(
    async () =>
      setPartnerActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, await by()),
    nothing,
  );
}

// セグメント・タグ ---------------------------------------------------------------

function segmentValues(segment: SegmentSettings): RowValues {
  return { code: segment.code, name: segment.name };
}

export async function createSegmentAction(formData: FormData): Promise<ActionResult> {
  return write(async () => createSegment(prisma(), formInput(formData), await by()), nothing);
}

export async function updateSegmentAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  return write(
    async () =>
      updateSegment(prisma(), inlinePatch(id, patch, ["code", "name"] as const), await by()),
    segmentValues,
  );
}

export async function setSegmentActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  return write(
    async () =>
      setSegmentActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, await by()),
    nothing,
  );
}

function memoTagValues(tag: MemoTagSettings): RowValues {
  return { name: tag.name };
}

export async function createMemoTagAction(formData: FormData): Promise<ActionResult> {
  return write(async () => createMemoTag(prisma(), formInput(formData), await by()), nothing);
}

export async function updateMemoTagAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  return write(async () => {
    const { id: tagId, name } = inlinePatch(id, patch, ["name"] as const);
    return updateMemoTag(prisma(), { id: tagId, name }, await by());
  }, memoTagValues);
}

export async function setMemoTagActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  return write(
    async () =>
      setMemoTagActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, await by()),
    nothing,
  );
}
