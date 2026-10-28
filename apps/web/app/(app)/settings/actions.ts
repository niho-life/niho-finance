"use server";

import {
  closeFiscalYearThrough,
  createAccount,
  createMemoTag,
  createNextFiscalYear,
  createPartner,
  createSegment,
  createSubAccount,
  createTaxRateRule,
  createWallet,
  getPrismaClient,
  previewFiscalYearClose,
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
  type ClosePreview,
  type CloseRange,
  type MemoTagSettings,
  type PartnerSettings,
  type SegmentSettings,
  type TaxRateRuleCreateInput,
  type WalletUpdateInput,
} from "@niho-finance/db";
import { isCalendarDate, type CalendarDate } from "@niho-finance/ledger";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, formInput, inlinePatch, parseBoolean, parseId } from "@/lib/action-result";
import type { ActionResult, RowValues } from "@/lib/action-types";
import { actor } from "@/lib/env";

/*
 * Server Actions of /settings. Each one: validates with the repository's Zod schemas (inline edits
 * may only touch the row's editable fields), writes through `@niho-finance/db` (audit log included)
 * as `NIHO_FINANCE_ACTOR`, refreshes the pages and returns `{ ok: true } | { ok: false, error }`.
 */

const prisma = () => getPrismaClient();
const by = () => ({ actor: actor() });

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
  return write(() => updateCompany(prisma(), formInput(formData), by()), nothing);
}

// 会計期間 -------------------------------------------------------------------

export async function updateFiscalYearAction(
  id: string,
  values: { consumptionTax: string; accountingMethod: string },
): Promise<ActionResult<RowValues>> {
  return write(
    () =>
      updateFiscalYear(
        prisma(),
        {
          id: parseId(id),
          consumptionTax: values.consumptionTax,
          accountingMethod: values.accountingMethod,
        },
        by(),
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
    () =>
      createNextFiscalYear(
        prisma(),
        {
          endDate: values.endDate,
          consumptionTax: values.consumptionTax,
          accountingMethod: values.accountingMethod,
        },
        by(),
      ),
    nothing,
  );
}

// 締め (11 §7) ----------------------------------------------------------------

/** 締め日 from the sheet's select: a date, or "" for 締めない. */
const closeDateSchema = z.union([
  z.literal(""),
  z.custom<CalendarDate>((value) => isCalendarDate(value)),
]);

/** What the chosen close would affect (read only: nothing is written, no audit row). */
export async function previewFiscalYearCloseAction(
  fiscalYearId: string,
  lockedThrough: string,
): Promise<ActionResult<ClosePreview>> {
  return attempt(() => {
    const date = closeDateSchema.parse(lockedThrough);
    return previewFiscalYearClose(prisma(), parseId(fiscalYearId), date === "" ? null : date);
  });
}

export interface ClosedFiscalYear {
  no: number;
  lockedThrough: string | null;
  range: CloseRange | null;
  affectedCount: number;
}

export async function closeFiscalYearAction(
  fiscalYearId: string,
  values: { lockedThrough: string; reason: string },
): Promise<ActionResult<ClosedFiscalYear>> {
  return write(
    () =>
      closeFiscalYearThrough(
        prisma(),
        parseId(fiscalYearId),
        { lockedThrough: values.lockedThrough, reason: values.reason },
        by(),
      ),
    (result) => ({
      no: result.no,
      lockedThrough: result.lockedThrough,
      range: result.range,
      affectedCount: result.affectedCount,
    }),
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
  return write(() => createAccount(prisma(), formInput(formData), by()), nothing);
}

export async function updateAccountAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  return write(
    () => updateAccount(prisma(), inlinePatch(id, patch, ACCOUNT_FIELDS), by()),
    accountValues,
  );
}

export async function setAccountActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  return write(
    () => setAccountActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, by()),
    nothing,
  );
}

export async function createSubAccountAction(
  accountId: string,
  formData: FormData,
): Promise<ActionResult> {
  return write(
    () =>
      createSubAccount(
        prisma(),
        { accountId: parseId(accountId), name: formData.get("name") },
        by(),
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
      return updateSubAccount(prisma(), { id: subAccountId, name }, by());
    },
    (subAccount) => ({ name: subAccount.name }),
  );
}

export async function setSubAccountActiveAction(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  return write(
    () =>
      setSubAccountActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, by()),
    nothing,
  );
}

// 税区分 ---------------------------------------------------------------------

export async function createTaxRateRuleAction(
  taxCategoryCode: string,
  formData: FormData,
): Promise<ActionResult> {
  return write(
    () =>
      createTaxRateRule(
        prisma(),
        { ...formInput<TaxRateRuleCreateInput>(formData), taxCategoryCode },
        by(),
      ),
    nothing,
  );
}

export async function setTaxRateRuleEnabledAction(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  return write(
    () =>
      setTaxRateRuleEnabled(prisma(), { id: parseId(id), enabled: parseBoolean(enabled) }, by()),
    nothing,
  );
}

// 口座 -----------------------------------------------------------------------

export async function createWalletAction(formData: FormData): Promise<ActionResult> {
  return write(() => createWallet(prisma(), formInput(formData), by()), nothing);
}

export async function updateWalletAction(id: string, formData: FormData): Promise<ActionResult> {
  return write(
    () =>
      updateWallet(prisma(), { ...formInput<WalletUpdateInput>(formData), id: parseId(id) }, by()),
    nothing,
  );
}

export async function setWalletActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  return write(
    () => setWalletActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, by()),
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
  return write(() => createPartner(prisma(), formInput(formData), by()), nothing);
}

export async function updatePartnerAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  return write(
    () => updatePartner(prisma(), inlinePatch(id, patch, PARTNER_FIELDS), by()),
    partnerValues,
  );
}

export async function setPartnerActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  return write(
    () => setPartnerActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, by()),
    nothing,
  );
}

// セグメント・タグ ---------------------------------------------------------------

function segmentValues(segment: SegmentSettings): RowValues {
  return { code: segment.code, name: segment.name };
}

export async function createSegmentAction(formData: FormData): Promise<ActionResult> {
  return write(() => createSegment(prisma(), formInput(formData), by()), nothing);
}

export async function updateSegmentAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  return write(
    () => updateSegment(prisma(), inlinePatch(id, patch, ["code", "name"] as const), by()),
    segmentValues,
  );
}

export async function setSegmentActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  return write(
    () => setSegmentActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, by()),
    nothing,
  );
}

function memoTagValues(tag: MemoTagSettings): RowValues {
  return { name: tag.name };
}

export async function createMemoTagAction(formData: FormData): Promise<ActionResult> {
  return write(() => createMemoTag(prisma(), formInput(formData), by()), nothing);
}

export async function updateMemoTagAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  return write(async () => {
    const { id: tagId, name } = inlinePatch(id, patch, ["name"] as const);
    return updateMemoTag(prisma(), { id: tagId, name }, by());
  }, memoTagValues);
}

export async function setMemoTagActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  return write(
    () => setMemoTagActive(prisma(), { id: parseId(id), isActive: parseBoolean(isActive) }, by()),
    nothing,
  );
}
