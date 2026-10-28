import { assertSequence, assertTrialBalanceIdentity, computeBalances } from "@niho-finance/ledger";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, loadStoredEntry, loadTrialBalance } from "../src";
import { SEED_FISCAL_YEAR, seedDatabase } from "../src/seed";
import { hasTestDatabase } from "./support/database";
import { testPrisma } from "./support/prisma";

describe.skipIf(!hasTestDatabase)("seeded database", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = testPrisma();
  });

  it("fiscal year 1 satisfies assets = liabilities + net assets + net income", async () => {
    const fiscalYear = await prisma.fiscalYear.findFirstOrThrow({
      where: { no: SEED_FISCAL_YEAR.no },
    });
    const tb = await loadTrialBalance(prisma, fiscalYear.id);
    expect(() => assertTrialBalanceIdentity(tb)).not.toThrow();
    expect(tb.totals).toMatchObject({
      assets: 224_029n,
      liabilities: 168_300n,
      equity: 50_000n,
      revenue: 13_200n,
      expenses: 7_471n,
      netIncome: 5_729n,
      internal: 0n,
    });
    expect(tb.totals.debit).toBe(tb.totals.credit);
  });

  it("numbers year 1 from 1 without gaps and keeps the sample void netted to 0", async () => {
    const fiscalYear = await prisma.fiscalYear.findFirstOrThrow({
      where: { no: SEED_FISCAL_YEAR.no },
    });
    const entries = await prisma.journalEntry.findMany({
      where: { fiscalYearId: fiscalYear.id },
      orderBy: { no: "asc" },
    });
    expect(entries).toHaveLength(13);
    assertSequence(entries);
    expect(fiscalYear.nextEntryNo).toBe(14);

    const voided = entries.find((entry) => entry.status === "voided");
    const reversal = entries.find((entry) => entry.reversalOfId === voided?.id);
    expect(voided).toBeDefined();
    expect(reversal?.kind).toBe("reversal");
    const pair = [
      await loadStoredEntry(prisma, voided?.id ?? ""),
      await loadStoredEntry(prisma, reversal?.id ?? ""),
    ];
    for (const groupBy of ["account", "subAccount", "segment"] as const) {
      for (const row of computeBalances(pair, { groupBy })) expect(row.net).toBe(0n);
    }
  });

  it("does not seed twice", async () => {
    const before = await prisma.journalEntry.count();
    expect((await seedDatabase(prisma)).seeded).toBe(false);
    expect(await prisma.journalEntry.count()).toBe(before);
  });

  it("the main database (DATABASE_URL), once seeded, satisfies the identity for every fiscal year", async (context) => {
    const main = createPrismaClient({
      databaseUrl: process.env.NIHO_FINANCE_MAIN_DATABASE_URL ?? "",
    });
    try {
      const fiscalYears = await main.fiscalYear
        .findMany({ orderBy: { no: "asc" } })
        .catch(() => null);
      if (!fiscalYears || fiscalYears.length === 0) {
        context.skip(
          "the main database is not migrated or not seeded yet (run npm run db:migrate && npm run db:seed)",
        );
        return;
      }
      for (const fiscalYear of fiscalYears) {
        const tb = await loadTrialBalance(main, fiscalYear.id);
        expect(() => assertTrialBalanceIdentity(tb), `fiscal year ${fiscalYear.no}`).not.toThrow();
        assertSequence(
          await main.journalEntry.findMany({
            where: { fiscalYearId: fiscalYear.id },
            select: { no: true },
          }),
        );
      }
    } finally {
      await main.$disconnect();
    }
  });
});
