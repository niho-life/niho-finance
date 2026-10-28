"use server";

import {
  cancelYearEnd,
  closeYear,
  disposeFixedAsset,
  getPrismaClient,
  postAccrual,
  postConsumptionTaxSettlement,
  postCorporateTax,
  postDeferredAmortization,
  postDepreciation,
  registerFixedAsset,
  reopenYear,
  setYearEndCheck,
  startYearEnd,
  updateFixedAsset,
  voidFixedAsset,
  voidYearEndEntry,
  type AccrualEntryInput,
  type ConsumptionTaxSettlementInput,
  type CorporateTaxEntryInput,
  type DeferredAmortizationInput,
  type FixedAssetDisposeInput,
  type FixedAssetRegisterInput,
  type FixedAssetUpdateInput,
  type FixedAssetVoidInput,
  type YearEndCheckInput,
  type YearEndTransitionInput,
  type YearEndTransitionResult,
  type YearEndVoidInput,
} from "@niho-finance/db";
import { formatYen, type CalendarDate } from "@niho-finance/ledger";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/env";

/*
 * Server Actions of /closing (16-year-end §1.1, §3–§9) and of the fixed asset ledger (§5). The
 * repository validates every input with its Zod schemas, locks the fiscal years and writes the audit
 * log as `NIHO_FINANCE_ACTOR`. Expected failures come back as `{ ok: false }` with the field of each
 * problem. Amounts go back as text: bigint stays on the server.
 */

const prisma = () => getPrismaClient();
const by = () => ({ actor: actor() });

/** Form values from the client: a plain object (the repository checks every field). */
const valuesSchema = z.record(z.string(), z.unknown());

function values<T>(input: unknown): T {
  return valuesSchema.parse(input) as T;
}

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The checklist, the ledger, the journal, the reports and the shell all read what changed.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

// ---------------------------------------------------------------------------
// 期の遷移 (§1.1)
// ---------------------------------------------------------------------------

export interface YearEndTransitionData {
  no: number;
  lockedThrough: CalendarDate | null;
  /** 締める: the closing entry (`null` when the year had no P&L). */
  closingEntryNo: number | null;
}

function transitionData(result: YearEndTransitionResult): YearEndTransitionData {
  return {
    no: result.no,
    lockedThrough: result.lockedThrough,
    closingEntryNo: result.closingEntry?.no ?? null,
  };
}

/** 決算整理を始める (open → closing). The reason is optional. */
export async function startYearEndAction(
  fiscalYearId: string,
  input: unknown,
): Promise<ActionResult<YearEndTransitionData>> {
  return write(
    () =>
      startYearEnd(prisma(), parseId(fiscalYearId), values<YearEndTransitionInput>(input), by()),
    transitionData,
  );
}

/** 決算整理をやめる (closing → open). The reason is required. */
export async function cancelYearEndAction(
  fiscalYearId: string,
  input: unknown,
): Promise<ActionResult<YearEndTransitionData>> {
  return write(
    () =>
      cancelYearEnd(prisma(), parseId(fiscalYearId), values<YearEndTransitionInput>(input), by()),
    transitionData,
  );
}

/** 締める (closing → closed): posts the closing entry. */
export async function closeYearAction(
  fiscalYearId: string,
): Promise<ActionResult<YearEndTransitionData>> {
  return write(() => closeYear(prisma(), parseId(fiscalYearId), {}, by()), transitionData);
}

/** 締めを戻す (closed → closing): voids the closing entry. The reason is required. */
export async function reopenYearAction(
  fiscalYearId: string,
  input: unknown,
): Promise<ActionResult<YearEndTransitionData>> {
  return write(
    () => reopenYear(prisma(), parseId(fiscalYearId), values<YearEndTransitionInput>(input), by()),
    transitionData,
  );
}

// ---------------------------------------------------------------------------
// 確認・計上・取消 (§3–§9)
// ---------------------------------------------------------------------------

/** 「照合した」「確認した」 / 「確認を外す」. */
export async function setYearEndCheckAction(
  fiscalYearId: string,
  input: unknown,
): Promise<ActionResult<null>> {
  return write(
    () => setYearEndCheck(prisma(), parseId(fiscalYearId), values<YearEndCheckInput>(input), by()),
    () => null,
  );
}

export interface PostedEntryNo {
  no: number;
}

/** 減価償却を計上: every asset with an amount for the year and no entry yet. */
export async function postDepreciationAction(
  fiscalYearId: string,
): Promise<ActionResult<{ count: number; total: string }>> {
  return write(
    () => postDepreciation(prisma(), parseId(fiscalYearId), {}, by()),
    (posted) => ({
      count: posted.length,
      total: formatYen(posted.reduce((sum, item) => sum + item.amount, 0n)),
    }),
  );
}

/** 繰延資産の償却: 5 年 or 全額 of one account. */
export async function postDeferredAmortizationAction(
  fiscalYearId: string,
  input: unknown,
): Promise<ActionResult<PostedEntryNo>> {
  return write(
    () =>
      postDeferredAmortization(
        prisma(),
        parseId(fiscalYearId),
        values<DeferredAmortizationInput>(input),
        by(),
      ),
    (entry) => ({ no: entry.no }),
  );
}

/** 前払・未払・前受・貯蔵品, with the reversal on the next year's first day when chosen. */
export async function postAccrualAction(
  fiscalYearId: string,
  input: unknown,
): Promise<ActionResult<{ no: number; reversalNo: number | null }>> {
  return write(
    () => postAccrual(prisma(), parseId(fiscalYearId), values<AccrualEntryInput>(input), by()),
    (posted) => ({ no: posted.entry.no, reversalNo: posted.reversal?.no ?? null }),
  );
}

/** 消費税の精算. */
export async function postConsumptionTaxSettlementAction(
  fiscalYearId: string,
  input: unknown,
): Promise<ActionResult<PostedEntryNo>> {
  return write(
    () =>
      postConsumptionTaxSettlement(
        prisma(),
        parseId(fiscalYearId),
        values<ConsumptionTaxSettlementInput>(input),
        by(),
      ),
    (entry) => ({ no: entry.no }),
  );
}

/** 法人税等の計上. */
export async function postCorporateTaxAction(
  fiscalYearId: string,
  input: unknown,
): Promise<ActionResult<PostedEntryNo>> {
  return write(
    () =>
      postCorporateTax(
        prisma(),
        parseId(fiscalYearId),
        values<CorporateTaxEntryInput>(input),
        by(),
      ),
    (entry) => ({ no: entry.no }),
  );
}

export interface VoidedYearEndEntryData {
  no: number;
  reversalNo: number;
  /** The next year's accrual reversal voided with it. */
  accrualReversalNo: number | null;
}

/** 取り消す: an adjusting entry of a year not closed (with an accrual's reversal). */
export async function voidYearEndEntryAction(
  entryId: string,
  input: unknown,
): Promise<ActionResult<VoidedYearEndEntryData>> {
  return write(
    () => voidYearEndEntry(prisma(), parseId(entryId), values<YearEndVoidInput>(input), by()),
    (result) => ({
      no: result.voided.no,
      reversalNo: result.reversal.no,
      accrualReversalNo: result.accrualReversal?.voided.no ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// 固定資産 (§5)
// ---------------------------------------------------------------------------

/** 固定資産の登録: from an acquisition entry, or with the 支出 posted in the same transaction. */
export async function registerFixedAssetAction(
  input: unknown,
): Promise<ActionResult<{ id: string; name: string }>> {
  return write(
    () => registerFixedAsset(prisma(), values<FixedAssetRegisterInput>(input), by()),
    (asset) => ({ id: asset.id, name: asset.name }),
  );
}

/** 編集. */
export async function updateFixedAssetAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ name: string }>> {
  return write(
    () => updateFixedAsset(prisma(), parseId(id), values<FixedAssetUpdateInput>(input), by()),
    (asset) => ({ name: asset.name }),
  );
}

/** 登録を取り消す (a logical delete; the reason is required). */
export async function voidFixedAssetAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ name: string }>> {
  return write(
    () => voidFixedAsset(prisma(), parseId(id), values<FixedAssetVoidInput>(input), by()),
    (asset) => ({ name: asset.name }),
  );
}

/** 除却・売却. */
export async function disposeFixedAssetAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ entryNo: number | null; bookValue: string }>> {
  return write(
    () => disposeFixedAsset(prisma(), parseId(id), values<FixedAssetDisposeInput>(input), by()),
    (result) => ({ entryNo: result.entry?.no ?? null, bookValue: formatYen(result.bookValue) }),
  );
}
