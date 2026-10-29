import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkFirstMonthStep,
  closeFirstMonthGuide,
  fromDbDateOrNull,
  listAuditLog,
  loadFirstMonthFacts,
  loadFirstMonthGuide,
  SettingsError,
  showFirstMonthGuide,
  toDbDate,
  uncheckFirstMonthStep,
  type FirstMonthStepKey,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";

const actor = "owner@example.com";
const today = "2026-11-20" as const;

/** Founding deadlines this file adds to 第 1 期 (fictional rule keys; removed afterwards). */
const OPEN_ID = "first-month-test-open";
const DONE_ID = "first-month-test-done";

describe.skipIf(!hasTestDatabase)("first-month guide on the seeded book (10 §3.1)", () => {
  let prisma: PrismaClient;
  let companyId: string;
  let original: Prisma.JsonValue | null;

  beforeAll(async () => {
    prisma = testPrisma();
    const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
    companyId = company.id;
    original = company.setupGuide;
    await prisma.company.update({
      where: { id: companyId },
      data: { setupGuide: Prisma.DbNull },
    });
  });

  // The test database is shared by the files: leave the company and the calendar as they were.
  // The audit rows stay (the log is append-only).
  afterAll(async () => {
    if (!prisma || !companyId) return;
    await prisma.calendarItem.deleteMany({ where: { id: { in: [OPEN_ID, DONE_ID] } } });
    await prisma.company.update({
      where: { id: companyId },
      data: { setupGuide: original === null ? Prisma.DbNull : (original as Prisma.InputJsonValue) },
    });
  });

  async function auditCount(action: string): Promise<number> {
    return prisma.auditLog.count({ where: { action, entity: "company", entityId: companyId } });
  }

  async function guide() {
    const loaded = await loadFirstMonthGuide(prisma, today);
    if (!loaded) throw new Error("not seeded");
    return loaded;
  }

  async function stepOf(key: FirstMonthStepKey) {
    const found = (await guide()).steps.find((item) => item.key === key);
    if (!found) throw new Error(`no step ${key}`);
    return found;
  }

  /** A step the seeded book does not show done (the one to check by hand). */
  async function openStepKey(): Promise<FirstMonthStepKey> {
    const open = (await guide()).steps.find((item) => !item.done);
    if (!open) throw new Error("every step is done on the seeded book");
    return open.key;
  }

  it("reads the six steps with the facts of the book", async () => {
    const loaded = await guide();
    expect(loaded.steps).toHaveLength(6);
    expect(loaded.total).toBe(6);
    expect(loaded.shownAgain).toBe(false);

    const facts = await loadFirstMonthFacts(prisma);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const stripeWallets = await prisma.wallet.findMany({
      where: { kind: "stripe", isActive: true },
      include: { stripeAccount: true },
    });
    const founding = await prisma.calendarItem.findMany({
      where: { ruleKey: { startsWith: "founding." }, fiscalYear: { no: 1 } },
    });
    expect(facts.hasImportBatch).toBe(
      (await prisma.importBatch.count({ where: { source: { in: ["csv", "api"] }, error: null } })) >
        0,
    );
    expect(facts.stripe).toEqual({
      hasWallet: stripeWallets.length > 0,
      connected: stripeWallets.some((wallet) => wallet.stripeAccount !== null),
    });
    expect(facts.activeRecurringCount).toBe(
      await prisma.recurringItem.count({ where: { isActive: true } }),
    );
    expect(facts.policyEffectiveOn).toBe(fromDbDateOrNull(company.recordsPolicyEffectiveOn));
    expect(facts.activePartnerCount).toBe(
      await prisma.partner.count({ where: { isActive: true } }),
    );
    expect(facts.foundingDeadlines.map((item) => item.id).sort()).toEqual(
      founding.map((item) => item.id).sort(),
    );

    const expectedDone = [
      founding.length > 0 && founding.every((item) => item.completedAt !== null),
      facts.hasImportBatch,
      facts.stripe.connected,
      facts.activeRecurringCount > 0,
      facts.policyEffectiveOn !== null,
      facts.activePartnerCount > 0,
    ];
    expect(loaded.steps.map((item) => item.done)).toEqual(expectedDone);
    expect(loaded.doneCount).toBe(expectedDone.filter(Boolean).length);
  });

  it("lists 第 1 期's open founding deadlines under the filings step", async () => {
    const fiscalYear = await prisma.fiscalYear.findFirstOrThrow({ where: { no: 1 } });
    const before = await stepOf("filings");
    await prisma.calendarItem.createMany({
      data: [
        {
          id: OPEN_ID,
          fiscalYearId: fiscalYear.id,
          kind: "filing",
          title: "架空の届出（未完了）",
          dueDate: toDbDate("2026-11-19"),
          ruleKey: "founding.first-month-test-open",
        },
        {
          id: DONE_ID,
          fiscalYearId: fiscalYear.id,
          kind: "filing",
          title: "架空の届出（完了）",
          dueDate: toDbDate("2026-11-10"),
          ruleKey: "founding.first-month-test-done",
          completedAt: new Date(),
          completedBy: actor,
        },
      ],
    });
    const filings = await stepOf("filings");
    expect(filings.done).toBe(false);
    expect(filings.noDeadlinesYet).toBe(false);
    expect(filings.deadlines.map((item) => item.id)).not.toContain(DONE_ID);
    // 2026-11-19 is before today: overdue, so it is the nearest of the open ones.
    expect(filings.deadlines[0]).toMatchObject({
      id: OPEN_ID,
      title: "架空の届出（未完了）",
      dueDate: "2026-11-19",
      statusText: "期限切れ",
    });
    expect(filings.deadlines.length + filings.moreDeadlines).toBe(
      before.deadlines.length + before.moreDeadlines + 1,
    );
  });

  it("checks a step by hand once, with one setup.guide_check entry", async () => {
    const key = await openStepKey();
    const auditBefore = await auditCount("setup.guide_check");

    const state = await checkFirstMonthStep(prisma, { key }, { actor });
    expect(state.checked[key]?.by).toBe(actor);
    expect(await auditCount("setup.guide_check")).toBe(auditBefore + 1);
    const step = await stepOf(key);
    expect(step).toMatchObject({ done: true, doneBy: "manual" });
    expect(step.checkedAt).toBe(state.checked[key]?.at);

    const stored = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(stored.setupGuide).toEqual({ checked: { [key]: state.checked[key] }, shownAt: null });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: "setup.guide_check", entityId: companyId },
      orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    expect(row).toMatchObject({ actor, entity: "company" });
    expect(row.before).toEqual({ setupGuide: null });
    expect(row.after).toEqual({
      setupGuide: { checked: { [key]: state.checked[key] }, shownAt: null },
    });

    // Already checked: nothing is written, nothing is logged.
    const again = await checkFirstMonthStep(prisma, { key }, { actor: "other@example.com" });
    expect(again.checked[key]).toEqual(state.checked[key]);
    expect(await auditCount("setup.guide_check")).toBe(auditBefore + 1);

    // The audit log's 「初期設定」 filter shows it.
    const page = await listAuditLog(prisma, { entity: "setup" });
    expect(page.rows.some((item) => item.action === "setup.guide_check")).toBe(true);
  });

  it("unchecks it once, with one setup.guide_uncheck entry", async () => {
    const stored = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const [key] = Object.keys((stored.setupGuide as { checked: object }).checked) as [
      FirstMonthStepKey,
    ];
    const auditBefore = await auditCount("setup.guide_uncheck");

    const state = await uncheckFirstMonthStep(prisma, { key }, { actor });
    expect(state.checked).toEqual({});
    expect(await auditCount("setup.guide_uncheck")).toBe(auditBefore + 1);
    expect(await stepOf(key)).toMatchObject({ done: false, doneBy: null, checkedAt: null });

    await uncheckFirstMonthStep(prisma, { key }, { actor });
    expect(await auditCount("setup.guide_uncheck")).toBe(auditBefore + 1);
  });

  it("shows the guide again and closes it, each once", async () => {
    const shows = await auditCount("setup.guide_show");
    const closes = await auditCount("setup.guide_close");

    const shown = await showFirstMonthGuide(prisma, { actor });
    expect(shown.shownAt).not.toBeNull();
    expect(await guide()).toMatchObject({ shownAgain: true, visible: true });
    await showFirstMonthGuide(prisma, { actor });
    expect(await auditCount("setup.guide_show")).toBe(shows + 1);

    const closed = await closeFirstMonthGuide(prisma, { actor });
    expect(closed.shownAt).toBeNull();
    expect((await guide()).shownAgain).toBe(false);
    await closeFirstMonthGuide(prisma, { actor });
    expect(await auditCount("setup.guide_close")).toBe(closes + 1);
  });

  it("refuses an unknown step without writing", async () => {
    const before = await prisma.auditLog.count({
      where: { action: { startsWith: "setup.guide_" } },
    });
    for (const run of [
      () => checkFirstMonthStep(prisma, { key: "payroll" }, { actor }),
      () => uncheckFirstMonthStep(prisma, { key: "" }, { actor }),
    ]) {
      const error = await rejectionOf(run());
      expect(error).toBeInstanceOf(SettingsError);
      expect((error as SettingsError).message).toMatch(/画面を読み込み直/);
    }
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "setup.guide_" } } })).toBe(
      before,
    );
  });

  it("reads a broken stored value as nothing checked", async () => {
    await prisma.company.update({
      where: { id: companyId },
      data: { setupGuide: { checked: "everything", shownAt: 42 } },
    });
    const loaded = await guide();
    expect(loaded.shownAgain).toBe(false);
    expect(loaded.steps.every((item) => item.doneBy !== "manual")).toBe(true);
    // A write starts over from the empty state.
    const key = await openStepKey();
    const state = await checkFirstMonthStep(prisma, { key }, { actor });
    expect(Object.keys(state.checked)).toEqual([key]);
  });
});
