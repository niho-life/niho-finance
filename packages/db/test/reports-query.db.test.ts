import {
  buildBackupFiles,
  buildCashReport,
  buildTrialBalance,
  resolveReportPeriod,
} from "@niho-finance/reports";
import type { Prisma, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bankReconnectTodo,
  CALENDAR_RULES,
  countInboxDocuments,
  createInvoiceDraft,
  draftInvoicesTodo,
  HOME_TODO_SOURCES,
  inboxDocumentsTodo,
  listRecentExports,
  loadBackupSource,
  loadCashPosition,
  loadDocumentsForArchive,
  loadHomeTodos,
  loadReportSource,
  loadTrialBalance,
  loadWalletStatus,
  pendingStatementsTodo,
  recordExport,
  recurringDueTodo,
  toDbDate,
  TRANSACTION_OPTIONS,
  payablesDueSoonTodo,
  upcomingDeadlinesTodo,
  type InvoiceDraftInput,
} from "../src";
import { SEED_FISCAL_YEAR } from "../src/seed";
import { hasTestDatabase } from "./support/database";
import { testPrisma } from "./support/prisma";
import { createFiscalYear } from "./support/refs";

const ROLLBACK = new Error("rolled back on purpose");

/**
 * Runs `fn` in a transaction that is always rolled back: 「やること」 needs a book without any
 * unpaid claim or draft invoice, which the other files sharing the database leave behind.
 */
async function rolledBack(
  client: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  try {
    await client.$transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    if (error !== ROLLBACK) throw error;
    return;
  }
  throw new Error("the transaction was expected to roll back");
}

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
      // Through the same date as the status (other test files add lines in later years).
      const last = await prisma.walletTransaction.findFirst({
        where: {
          walletId: row.walletId,
          balanceAfter: { not: null },
          txnDate: { lte: toDbDate("2027-03-31") },
        },
        orderBy: [{ txnDate: "desc" }, { createdAt: "desc" }],
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
    // The seed holds 第 1 期's tax return as the calendar rule gives it (S8, calendar.ts).
    const taxReturn = CALENDAR_RULES.find((rule) => rule.key === "annual.tax-return")?.title;
    const near = (await loadHomeTodos(prisma, "2027-05-28")).filter((row) => row.tone === "date");
    expect(near.find((row) => row.dueDate === "2027-05-31")).toMatchObject({
      badge: "5/31",
      label: taxReturn,
      href: "/calendar",
    });
    const overdue = (await loadHomeTodos(prisma, "2027-06-02")).filter(
      (row) => row.tone === "date",
    );
    expect(overdue.find((row) => row.dueDate === "2027-05-31")?.label).toBe(
      `${taxReturn}（期限切れ）`,
    );
    const custom = await loadHomeTodos(prisma, "2026-12-15", [
      () => Promise.resolve([{ key: "x", badge: "3", tone: "count", label: "テスト", href: "/x" }]),
    ]);
    expect(custom.map((row) => row.key)).toEqual(["x"]);
  });

  it("lists the draft invoices and keeps the sources in the order of 14 §9", async () => {
    expect(HOME_TODO_SOURCES).toEqual([
      pendingStatementsTodo,
      inboxDocumentsTodo,
      bankReconnectTodo,
      upcomingDeadlinesTodo,
      payablesDueSoonTodo,
      draftInvoicesTodo,
      recurringDueTodo,
    ]);
    const today = "2026-12-15";
    const actor = "home-todo-tester@example.com";

    await rolledBack(prisma, async (tx) => {
      // Set aside the drafts of the other files (state columns only, as the guards allow).
      const setAside = {
        status: "void" as const,
        voidedAt: new Date(),
        voidReason: "テストで外す",
      };
      await tx.invoice.updateMany({ where: { status: "draft" }, data: setAside });
      expect(await draftInvoicesTodo(tx, today)).toEqual([]);
      const none = (await loadHomeTodos(tx, today)).map((row) => row.key);
      expect(none).not.toContain("draft-invoices");

      // A year of its own (after every other file's years); everything here is rolled back.
      await createFiscalYear(tx, {
        no: 250,
        startDate: "2110-04-01",
        endDate: "2111-03-31",
        tax: { consumptionTax: "general", accountingMethod: "tax_inclusive" },
      });
      const partner = await tx.partner.findFirstOrThrow({
        where: { name: "架空デザイン合同会社" },
      });
      const draft = (docType: InvoiceDraftInput["docType"]): InvoiceDraftInput => ({
        docType,
        partnerId: partner.id,
        title: "架空サイトの保守",
        issueDate: "2110-06-01",
        dueDate: "",
        pricesIncludeTax: false,
        note: "",
        revenueAccountId: "",
        segmentId: "",
        sourceInvoiceId: "",
        lines: [
          {
            date: "",
            name: "保守 一式",
            quantity: "1",
            unit: "式",
            unitPrice: "30,000",
            taxCategoryCode: "sales_10",
          },
        ],
      });
      await createInvoiceDraft(tx, draft("invoice"), { actor });
      // A draft quote is not an invoice to issue.
      await createInvoiceDraft(tx, draft("quote"), { actor });

      const rows = await loadHomeTodos(tx, today);
      expect(rows.find((row) => row.key === "draft-invoices")).toEqual({
        key: "draft-invoices",
        badge: "1",
        tone: "count",
        label: "発行する請求書",
        href: "/invoices?status=draft",
      });
    });
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
