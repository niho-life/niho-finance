import { assertSequence, assertTrialBalanceIdentity, computeBalances } from "@niho-finance/ledger";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  listWalletTransactions,
  loadStoredEntry,
  loadTrialBalance,
  type StatementRow,
} from "../src";
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

  it("seeds statement lines: settled ones on the sample entries, 12 pending ones with a suggestion each", async () => {
    const fiscalYear = await prisma.fiscalYear.findFirstOrThrow({
      where: { no: SEED_FISCAL_YEAR.no },
    });
    const seeded = await prisma.walletTransaction.findMany({
      where: { externalId: { startsWith: "seed-" } },
      include: { journalEntry: true },
    });
    const pending = seeded.filter((line) => line.status === "pending");
    const settled = seeded.filter((line) => line.status !== "pending");
    expect(pending).toHaveLength(12);
    expect(settled).toHaveLength(10);
    for (const line of settled) {
      expect(line.journalEntry?.status, line.descriptionRaw).toBe("posted");
      expect(line.journalEntry?.fiscalYearId).toBe(fiscalYear.id);
      expect(line.settledAt).not.toBeNull();
    }
    expect(await prisma.rule.count({ where: { isActive: true } })).toBeGreaterThanOrEqual(5);
    // No entry was added: the numbering and the trial balance are the ones checked above.
    expect(await prisma.journalEntry.count({ where: { fiscalYearId: fiscalYear.id } })).toBe(13);

    const wallets = new Map(
      (await prisma.wallet.findMany()).map((wallet) => [wallet.name, wallet.id] as const),
    );
    const accounts = new Map(
      (await prisma.account.findMany()).map((account) => [account.id, account.code] as const),
    );
    const segments = new Map(
      (await prisma.segment.findMany()).map((segment) => [segment.id, segment.code] as const),
    );
    const partners = new Map(
      (await prisma.partner.findMany()).map((partner) => [partner.id, partner.name] as const),
    );
    const rows: StatementRow[] = [];
    for (const walletId of wallets.values()) {
      rows.push(...(await listWalletTransactions(prisma, { wallet: walletId })).rows);
    }
    const summary = rows
      .filter((row) => row.txnDate <= "2027-03-31")
      .sort((a, b) =>
        a.txnDate === b.txnDate ? (a.id < b.id ? -1 : 1) : a.txnDate < b.txnDate ? -1 : 1,
      )
      .map((row) => {
        const suggestion = row.suggestion;
        const transferTo = [...wallets].find(([, id]) => id === suggestion?.transferToWalletId);
        return [
          row.walletName,
          row.txnDate,
          row.amount,
          suggestion?.mode,
          suggestion?.source,
          suggestion?.accountId ? accounts.get(suggestion.accountId) : null,
          suggestion?.taxCategoryCode ?? null,
          suggestion?.partnerId ? partners.get(suggestion.partnerId) : null,
          suggestion?.segmentId ? segments.get(suggestion.segmentId) : null,
          transferTo?.[0] ?? null,
          suggestion?.candidate?.kind ?? null,
        ];
      });
    // One row per pending line: [wallet, date, amount, mode, source, account, tax, partner,
    // segment, transfer to, candidate] — Enter takes it as is (15 §6).
    // prettier-ignore
    expect(summary).toEqual([
      ["架空カード", "2026-12-27", 1_650n, "transfer", "candidate", null, null, null, null, "架空銀行 普通", "entry"],
      ["架空カード", "2027-01-05", -1_650n, "register", "history", "5320", "purchase_10", "架空クラウド株式会社", "platform", null, null],
      ["架空銀行 普通", "2027-01-05", -88_000n, "register", "rule", "5300", "purchase_10", "架空不動産株式会社", "kamakura", null, null],
      ["架空カード", "2027-01-08", -1_200n, "register", "none", null, null, null, null, null, null],
      ["架空銀行 普通", "2027-01-10", 330_000n, "register", "partner", "4040", "sales_10", "架空デザイン合同会社", "contract", null, null],
      ["Stripe platform", "2027-01-12", 15_000n, "register", "rule", "4010", "sales_10", null, "kamakura", null, null],
      ["Stripe platform", "2027-01-12", -540n, "register", "history", "5400", "purchase_10", null, "kamakura", null, null],
      ["Stripe platform", "2027-01-15", -14_460n, "transfer", "rule", null, null, null, null, "架空銀行 普通", "txn"],
      ["架空銀行 普通", "2027-01-16", 14_460n, "transfer", "candidate", null, null, null, null, "Stripe platform", "txn"],
      ["架空銀行 普通", "2027-01-20", -30_000n, "transfer", "rule", null, null, null, null, "現金", null],
      ["架空銀行 普通", "2027-01-27", -9_870n, "transfer", "candidate", null, null, null, null, "架空カード", "txn"],
      ["架空カード", "2027-01-27", 9_870n, "transfer", "candidate", null, null, null, null, "架空銀行 普通", "txn"],
    ]);
  });
});
