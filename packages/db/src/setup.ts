/**
 * Progress of the setup wizard (10-settings-and-setup §3), derived from the database so that the
 * wizard resumes where it was left: 1 事業所 → 2 会計期間 → 3 勘定科目 → 4 口座 → 5 開始仕訳.
 * Steps 4 and 5 can be postponed (「あとで」); that choice is the only state stored for the wizard.
 */
import { appendAuditLog, type Db } from "./audit";
import { hasStandardData } from "./bootstrap";
import { SettingsError } from "./errors";
import { lockSettings, runInTransaction } from "./transaction";

export const SETUP_STEPS = ["company", "fiscal_year", "accounts", "wallets", "opening"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** The steps that can be postponed and done later from the settings. */
export const SKIPPABLE_SETUP_STEPS = ["wallets", "opening"] as const;
export type SkippableSetupStep = (typeof SKIPPABLE_SETUP_STEPS)[number];

export interface SetupProgress {
  /** Each step is done (for 4 and 5: done or postponed). */
  done: Readonly<Record<SetupStep, boolean>>;
  /** Postponed with 「あとで」 and not done since. */
  skipped: Readonly<Record<SkippableSetupStep, boolean>>;
  /** The first step that is not done, or `complete`. */
  current: SetupStep | "complete";
  /** Company, fiscal year 1 and the chart exist: the rest of the app can be used. */
  ready: boolean;
}

export async function getSetupProgress(db: Db): Promise<SetupProgress> {
  const company = await db.company.findFirst({
    orderBy: { createdAt: "asc" },
    select: { setupWalletsSkippedAt: true, setupOpeningSkippedAt: true },
  });
  const hasFiscalYear = company ? (await db.fiscalYear.count({ where: { no: 1 } })) > 0 : false;
  const hasAccounts = await hasStandardData(db);
  const walletCount = await db.wallet.count();
  const openingCount = await db.journalEntry.count({
    where: { kind: "opening", fiscalYear: { no: 1 } },
  });

  const skipped = {
    wallets: walletCount === 0 && Boolean(company?.setupWalletsSkippedAt),
    opening: openingCount === 0 && Boolean(company?.setupOpeningSkippedAt),
  };
  const done: Record<SetupStep, boolean> = {
    company: company !== null,
    fiscal_year: hasFiscalYear,
    accounts: hasAccounts,
    wallets: walletCount > 0 || skipped.wallets,
    opening: openingCount > 0 || skipped.opening,
  };
  const current = SETUP_STEPS.find((step) => !done[step]) ?? "complete";
  return {
    done,
    skipped,
    current,
    ready: done.company && done.fiscal_year && done.accounts,
  };
}

/** 「あとで」: postpones step 4 or 5. The steps before it must be done. */
export async function skipSetupStep(
  db: Db,
  step: SkippableSetupStep,
  options: { actor: string },
): Promise<SetupProgress> {
  await runInTransaction(db, async (tx) => {
    await lockSettings(tx, "company");
    const progress = await getSetupProgress(tx);
    if (!progress.ready) {
      throw new SettingsError("先に事業所・会計期間・勘定科目を登録してください");
    }
    const company = await tx.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
    const column = step === "wallets" ? "setupWalletsSkippedAt" : "setupOpeningSkippedAt";
    if (company[column] !== null) return;
    const row = await tx.company.update({
      where: { id: company.id },
      data: { [column]: new Date() },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "setup.skip",
      entity: "company",
      entityId: row.id,
      before: { [column]: company[column] },
      after: { [column]: row[column], step },
    });
  });
  return getSetupProgress(db);
}
