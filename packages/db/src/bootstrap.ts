/**
 * Standard data of a new book (10-settings-and-setup §3 Step 3, §5): the tax categories and their
 * rate rules, the 4 standard segments and the chart of accounts template. Sub-accounts are not
 * part of it: they come with the wallets. The seed uses this too, so the data is defined once.
 */
import {
  CHART_TEMPLATE,
  STANDARD_SEGMENTS,
  STANDARD_TAX_RATE_RULES,
  TAX_CATEGORIES,
} from "@niho-finance/ledger";
import { appendAuditLog, type Db } from "./audit";
import { toDbDate } from "./dates";
import { newId } from "./ids";
import { lockSettings, runInTransaction, type Tx } from "./transaction";

export interface BootstrapOptions {
  actor: string;
}

/** Rows created by this run (0 everywhere when the data was already there). */
export interface BootstrapResult {
  taxCategories: number;
  taxRateRules: number;
  segments: number;
  accounts: number;
}

/**
 * Inserts the standard data that is missing and leaves existing rows as they are (renamed or
 * disabled rows stay so). Idempotent; one audit row when something was created.
 */
export async function bootstrapStandardData(
  db: Db,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  return runInTransaction(db, (tx) => bootstrapInTransaction(tx, options));
}

async function bootstrapInTransaction(tx: Tx, options: BootstrapOptions): Promise<BootstrapResult> {
  await lockSettings(tx, "standardData");

  const taxCategories = await tx.taxCategory.createMany({
    data: TAX_CATEGORIES.map((category) => ({ id: newId(), ...category })),
    skipDuplicates: true,
  });

  const taxRateRules = await tx.taxRateRule.createMany({
    data: STANDARD_TAX_RATE_RULES.map((rule) => ({
      id: newId(),
      taxCategoryCode: rule.taxCategoryCode,
      effectiveFrom: toDbDate(rule.effectiveFrom),
      effectiveTo: rule.effectiveTo === null ? null : toDbDate(rule.effectiveTo),
      ratePercent: rule.ratePercent,
      deductiblePercent: rule.deductiblePercent,
      enabled: rule.enabled,
      note: rule.note ?? null,
    })),
    skipDuplicates: true,
  });

  const segments = await tx.segment.createMany({
    data: STANDARD_SEGMENTS.map((segment) => ({ id: newId(), ...segment })),
    skipDuplicates: true,
  });

  const segmentIds = new Map(
    (await tx.segment.findMany({ select: { id: true, code: true } })).map((segment) => [
      segment.code,
      segment.id,
    ]),
  );
  const accounts = await tx.account.createMany({
    data: CHART_TEMPLATE.map((account) => ({
      id: newId(),
      code: account.code,
      name: account.name,
      kind: account.kind,
      group: account.group,
      defaultTaxCategoryCode: account.defaultTaxCategoryCode,
      defaultSegmentId: account.defaultSegmentCode
        ? (segmentIds.get(account.defaultSegmentCode) ?? null)
        : null,
      isCashLike: account.isCashLike,
      sortOrder: Number(account.code),
      note: account.note ?? null,
    })),
    skipDuplicates: true,
  });

  const result: BootstrapResult = {
    taxCategories: taxCategories.count,
    taxRateRules: taxRateRules.count,
    segments: segments.count,
    accounts: accounts.count,
  };
  if (Object.values(result).some((count) => count > 0)) {
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "standard_data.bootstrap",
      entity: "standard_data",
      after: {
        ...result,
        template: {
          taxCategories: TAX_CATEGORIES.length,
          taxRateRules: STANDARD_TAX_RATE_RULES.length,
          segments: STANDARD_SEGMENTS.length,
          accounts: CHART_TEMPLATE.length,
        },
      },
    });
  }
  return result;
}

/** True when the chart has been created (the setup's Step 3 is done). */
export async function hasStandardData(db: Db): Promise<boolean> {
  const [accounts, taxCategories, segments] = [
    await db.account.count(),
    await db.taxCategory.count(),
    await db.segment.count(),
  ];
  return accounts > 0 && taxCategories > 0 && segments > 0;
}
