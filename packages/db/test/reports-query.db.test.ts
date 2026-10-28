import {
  buildBackupFiles,
  buildCashReport,
  buildTrialBalance,
  resolveReportPeriod,
} from "@niho-finance/reports";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  countInboxDocuments,
  listRecentExports,
  loadBackupSource,
  loadCashPosition,
  loadDocumentsForArchive,
  loadHomeTodos,
  loadReportSource,
  loadTrialBalance,
  loadWalletStatus,
  recordExport,
} from "../src";
import { SEED_FISCAL_YEAR } from "../src/seed";
import { hasTestDatabase } from "./support/database";
import { testPrisma } from "./support/prisma";

describe.skipIf(!hasTestDatabase)("reports queries (seeded book)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = testPrisma();
  });

  it("loads the whole book and agrees with the ledger's trial balance and cash", async () => {
    const source = await loadReportSource(prisma);
    expect(source.company.name).toBe("架空商会株式会社");
    // Other test files add fiscal years and wallets to the shared test database.
    const yearNos = source.fiscalYears.map((year) => year.no);
    expect(yearNos).toContain(SEED_FISCAL_YEAR.no);
    expect(yearNos).toEqual([...yearNos].sort((a, b) => a - b));
    expect(source.accounts.length).toBeGreaterThan(50);
    expect(source.wallets).toHaveLength(await prisma.wallet.count());
    const entryCount = await prisma.journalEntry.count();
    expect(source.entries).toHaveLength(entryCount);
    const voided = source.entries.find((entry) => entry.status === "voided");
    expect(voided).toBeDefined();
    expect(source.entries.some((entry) => entry.reversalOfId === voided?.id)).toBe(true);

    const period = resolveReportPeriod({}, source.fiscalYears, "2026-12-31");
    expect(period).not.toBeNull();
    const tb = buildTrialBalance(source, period!);
    expect(tb.check.ok).toBe(true);
    const ledgerTb = await loadTrialBalance(prisma, period!.fiscalYear.id);
    expect(tb.balanceSheet.totals.assets.balance).toBe(ledgerTb.totals.assets);
    expect(tb.balanceSheet.totals.liabilities.balance).toBe(ledgerTb.totals.liabilities);
    expect(tb.balanceSheet.netIncome).toBe(ledgerTb.totals.netIncome);

    const cash = buildCashReport(source, period!);
    const position = await loadCashPosition(prisma, period!.to);
    expect(cash.total).toBe(position.total);
    for (const wallet of position.wallets) {
      expect(cash.wallets.find((row) => row.walletId === wallet.id)?.balance).toBe(wallet.balance);
    }
  });

  it("describes the wallets' statements", async () => {
    const status = await loadWalletStatus(prisma, { through: "2027-03-31" });
    const active = await prisma.wallet.count({ where: { isActive: true } });
    expect(status).toHaveLength(active);
    for (const row of status) {
      const pending = await prisma.walletTransaction.count({
        where: { walletId: row.walletId, status: "pending" },
      });
      expect(row.pendingCount).toBe(pending);
      const last = await prisma.walletTransaction.findFirst({
        where: { walletId: row.walletId, balanceAfter: { not: null } },
        orderBy: { txnDate: "desc" },
      });
      expect(row.lastStatement?.balanceAfter ?? null).toBe(last?.balanceAfter ?? null);
    }
  });

  it("lists pending statements, inbox documents and the deadlines within 7 days", async () => {
    const pending = await prisma.walletTransaction.count({ where: { status: "pending" } });
    const inbox = await countInboxDocuments(prisma);
    const far = await loadHomeTodos(prisma, "2026-12-15");
    expect(far.filter((row) => row.tone === "date")).toEqual([]);
    expect(far.find((row) => row.key === "pending-statements")?.badge).toBe(
      pending > 0 ? String(pending) : undefined,
    );
    expect(far.find((row) => row.key === "inbox-documents")?.badge).toBe(
      inbox > 0 ? String(inbox) : undefined,
    );
    const near = (await loadHomeTodos(prisma, "2027-05-28")).filter((row) => row.tone === "date");
    expect(near.find((row) => row.dueDate === "2027-05-31")).toMatchObject({
      badge: "5/31",
      label: "法人税等の確定申告・納付",
    });
    const overdue = (await loadHomeTodos(prisma, "2027-06-02")).filter(
      (row) => row.tone === "date",
    );
    expect(overdue.find((row) => row.dueDate === "2027-05-31")?.label).toBe(
      "法人税等の確定申告・納付（期限切れ）",
    );
    const custom = await loadHomeTodos(prisma, "2026-12-15", [
      () => Promise.resolve([{ key: "x", badge: "3", tone: "count", label: "テスト", href: "/x" }]),
    ]);
    expect(custom.map((row) => row.key)).toEqual(["x"]);
  });

  it("records exports in the audit log and lists the latest first", async () => {
    await recordExport(
      prisma,
      {
        kind: "freee",
        format: "csv",
        fiscalYearNo: 1,
        from: "2026-11-02",
        to: "2027-03-31",
        encoding: "utf8",
      },
      { actor: "tester@example.com" },
    );
    await recordExport(
      prisma,
      {
        kind: "trial-balance",
        format: "pdf",
        fiscalYearNo: 1,
        from: "2026-12-01",
        to: "2026-12-31",
        segment: "seg",
      },
      { actor: "tester@example.com" },
    );
    const rows = await listRecentExports(prisma, 5);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]).toMatchObject({
      kind: "trial-balance",
      format: "pdf",
      segment: "seg",
      actor: "tester@example.com",
    });
    expect(rows[1]).toMatchObject({
      kind: "freee",
      format: "csv",
      encoding: "utf8",
      from: "2026-11-02",
    });
    const logged = await prisma.auditLog.findMany({ where: { action: "export.download" } });
    expect(logged.length).toBeGreaterThanOrEqual(2);
  });

  it("loads the backup source and builds the backup files", async () => {
    const archive = await loadDocumentsForArchive(prisma, { from: "2026-11-01", to: "2027-03-31" });
    expect(archive.length).toBeLessThanOrEqual(await prisma.document.count());
    const source = await loadBackupSource(prisma);
    expect(source.walletTransactions).toHaveLength(await prisma.walletTransaction.count());
    expect(source.documents).toHaveLength(await prisma.document.count());
    expect(source.settings.taxRateRules.length).toBeGreaterThan(0);
    expect(source.settings.company).toMatchObject({
      name: "架空商会株式会社",
      foundedOn: "2026-11-02",
    });
    expect(source.settings.company).not.toHaveProperty("setupWalletsSkippedAt");
    const files = await buildBackupFiles(source, { now: new Date() });
    expect(files.map((file) => file.path)).toContain("ledger.beancount");
    expect(files.map((file) => file.path)).toContain("manifest.json");
  });
});
