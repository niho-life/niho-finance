import { addDays, type CalendarDate } from "@niho-finance/ledger";
import type { CalendarItem, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCalendarItems,
  completeCalendarItem,
  fromDbDate,
  getCompany,
  listAuditLog,
  listCalendarItems,
  listFiscalYears,
  loadOpenCalendarItems,
  markCalendarItemsNotified,
  reopenCalendarItem,
  SettingsError,
  syncCalendarItems,
  toDbDate,
  upcomingDeadlinesTodo,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { testPrisma } from "./support/prisma";

const actor = "system";
/** Who completes and reopens on the calendar screen (the Server Action's actor). */
const owner = "owner@example.com";

describe.skipIf(!hasTestDatabase)("calendar items from the fiscal years", () => {
  let prisma: PrismaClient;
  let seeded: CalendarItem[];

  beforeAll(async () => {
    prisma = testPrisma();
    seeded = await prisma.calendarItem.findMany();
  });

  // The test database is shared by the files (others read the calendar for the home): leave the
  // calendar as the seed made it. calendar_item has no ledger guard; the audit rows stay.
  afterAll(async () => {
    if (!seeded) return;
    await prisma.calendarItem.deleteMany({ where: { id: { notIn: seeded.map((row) => row.id) } } });
    for (const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...row } of seeded) {
      await prisma.calendarItem.update({ where: { id }, data: row });
    }
  });

  async function expectedCount(): Promise<number> {
    const company = await getCompany(prisma);
    if (!company) throw new Error("not seeded");
    let count = 0;
    for (const fiscalYear of await listFiscalYears(prisma)) {
      count += buildCalendarItems({ company: { foundedOn: company.foundedOn }, fiscalYear }).length;
    }
    return count;
  }

  async function ruleItem(ruleKey: string) {
    const fiscalYear = await prisma.fiscalYear.findFirstOrThrow({ where: { no: 1 } });
    return prisma.calendarItem.findUniqueOrThrow({
      where: { fiscalYearId_ruleKey: { fiscalYearId: fiscalYear.id, ruleKey } },
    });
  }

  it("creates the items of every fiscal year once, with an audit entry each", async () => {
    // The seed already holds 第 1 期's annual.tax-return exactly as the rule gives it.
    const seeded = await ruleItem("annual.tax-return");
    const expected = (await expectedCount()) - 1;
    const auditBefore = await prisma.auditLog.count({ where: { action: "calendar_item.create" } });
    expect(await syncCalendarItems(prisma, { actor })).toEqual({ created: expected, updated: 0 });
    expect(await prisma.auditLog.count({ where: { action: "calendar_item.create" } })).toBe(
      auditBefore + expected,
    );
    // The seeded item is recognised by its rule key: kept, not duplicated.
    expect(
      await prisma.calendarItem.count({
        where: { fiscalYearId: seeded.fiscalYearId, ruleKey: "annual.tax-return" },
      }),
    ).toBe(1);
    expect((await ruleItem("annual.tax-return")).id).toBe(seeded.id);

    const blueReturn = await ruleItem("founding.blue-return-application");
    // Seed: founded 2026-11-02 → 3 months later 2027-02-02, the day before.
    expect(fromDbDate(blueReturn.dueDate)).toBe("2027-02-01");
    expect(blueReturn.kind).toBe("filing");
    expect(blueReturn.note).toBe("少額減価償却資産の特例の前提。最優先");
  });

  it("changes nothing on the next run", async () => {
    expect(await syncCalendarItems(prisma, { actor })).toEqual({ created: 0, updated: 0 });
  });

  it("puts an open item back on the rule's date, and leaves a completed one alone", async () => {
    const open = await ruleItem("annual.tax-return");
    const completed = await ruleItem("annual.shareholders-meeting");
    await prisma.calendarItem.update({
      where: { id: open.id },
      data: { dueDate: toDbDate("2027-05-01") },
    });
    await prisma.calendarItem.update({
      where: { id: completed.id },
      data: {
        dueDate: toDbDate("2027-06-01"),
        completedAt: new Date("2027-06-01T03:00:00Z"),
        completedBy: "owner@example.com",
      },
    });

    expect(await syncCalendarItems(prisma, { actor })).toEqual({ created: 0, updated: 1 });
    expect(fromDbDate((await ruleItem("annual.tax-return")).dueDate)).toBe(
      fromDbDate(open.dueDate),
    );
    expect(fromDbDate((await ruleItem("annual.shareholders-meeting")).dueDate)).toBe("2027-06-01");

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "calendar_item.update", entityId: open.id },
      orderBy: { at: "desc" },
    });
    expect(audit.actor).toBe(actor);
    expect(audit.before).toMatchObject({ dueDate: "2027-05-01T00:00:00.000Z" });
    expect(audit.after).toMatchObject({ dueDate: open.dueDate.toISOString() });
  });

  it("lists open items by due date and records the reminder mail", async () => {
    const items = await loadOpenCalendarItems(prisma);
    const completed = await ruleItem("annual.shareholders-meeting");
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((item) => item.id)).not.toContain(completed.id);
    const dates = items.map((item) => item.dueDate);
    expect([...dates].sort()).toEqual(dates);

    const today: CalendarDate = "2026-11-05";
    const notified = items.slice(0, 2).map((item) => item.id);
    await markCalendarItemsNotified(prisma, notified, today, { actor });
    for (const id of notified) {
      const row = await prisma.calendarItem.findUniqueOrThrow({ where: { id } });
      expect(row.lastNotifiedOn && fromDbDate(row.lastNotifiedOn)).toBe(today);
    }
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "calendar_item.notify" },
      orderBy: { at: "desc" },
    });
    expect(audit).toMatchObject({ actor, entity: "calendar_item", entityId: null });
    expect(audit.after).toEqual({ ids: notified, today });

    // Nothing to record: no write, no audit entry.
    const before = await prisma.auditLog.count();
    await markCalendarItemsNotified(prisma, [], addDays(today, 1), { actor });
    expect(await prisma.auditLog.count()).toBe(before);
  });

  // 完了にする / 未完了に戻す (24 §2). The items stay as the earlier tests left them: the sync has
  // run, and annual.shareholders-meeting is completed.

  it("completes an item once: when, by whom and an audit entry; a second time writes nothing", async () => {
    const item = await ruleItem("founding.social-insurance-application");
    expect(item.completedAt).toBeNull();
    const logged = () =>
      prisma.auditLog.count({ where: { action: "calendar_item.complete", entityId: item.id } });
    const auditBefore = await logged();

    const completed = await completeCalendarItem(prisma, item.id, { actor: owner });
    expect(completed).toMatchObject({ id: item.id, completedBy: owner });
    const row = await prisma.calendarItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.completedBy).toBe(owner);
    expect(row.completedAt?.getTime()).toBe(completed.completedAt?.getTime());

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "calendar_item.complete", entityId: item.id },
      orderBy: { at: "desc" },
    });
    expect(audit).toMatchObject({ actor: owner, entity: "calendar_item" });
    expect(audit.before).toMatchObject({ completedAt: null, completedBy: null });
    expect(audit.after).toMatchObject({
      completedAt: row.completedAt?.toISOString(),
      completedBy: owner,
    });

    // Again (another tab): the first record stays and nothing is logged.
    await completeCalendarItem(prisma, item.id, { actor: "other@example.com" });
    expect(
      (await prisma.calendarItem.findUniqueOrThrow({ where: { id: item.id } })).completedBy,
    ).toBe(owner);
    expect(await logged()).toBe(auditBefore + 1);

    // No more reminders for it.
    expect((await loadOpenCalendarItems(prisma)).map((open) => open.id)).not.toContain(item.id);
  });

  it("keeps a completed item off the sync, and puts it back on its rule once reopened", async () => {
    const item = await ruleItem("founding.social-insurance-application");
    const ruleDate = fromDbDate(item.dueDate);
    // The rule's date moved after the completion (simulated): the sync leaves the item alone.
    await prisma.calendarItem.update({
      where: { id: item.id },
      data: { dueDate: toDbDate("2026-11-20") },
    });
    expect(await syncCalendarItems(prisma, { actor })).toEqual({ created: 0, updated: 0 });
    expect(fromDbDate((await ruleItem(item.ruleKey ?? "")).dueDate)).toBe("2026-11-20");

    const reopened = await reopenCalendarItem(prisma, item.id, { actor: owner });
    expect(reopened).toMatchObject({ completedAt: null, completedBy: null });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "calendar_item.reopen", entityId: item.id },
      orderBy: { at: "desc" },
    });
    expect(audit).toMatchObject({ actor: owner, entity: "calendar_item" });
    expect(audit.before).toMatchObject({ completedBy: owner });
    expect(audit.after).toMatchObject({ completedAt: null, completedBy: null });

    // Open again: the next sync follows the rule.
    expect(await syncCalendarItems(prisma, { actor })).toEqual({ created: 0, updated: 1 });
    expect(fromDbDate((await ruleItem(item.ruleKey ?? "")).dueDate)).toBe(ruleDate);

    // Reopening an open item writes nothing.
    const reopenedCount = await prisma.auditLog.count({
      where: { action: "calendar_item.reopen", entityId: item.id },
    });
    await reopenCalendarItem(prisma, item.id, { actor: owner });
    expect(
      await prisma.auditLog.count({ where: { action: "calendar_item.reopen", entityId: item.id } }),
    ).toBe(reopenedCount);
  });

  it("rejects an item that does not exist", async () => {
    await expect(completeCalendarItem(prisma, "no-such-item", { actor: owner })).rejects.toThrow(
      SettingsError,
    );
    await expect(reopenCalendarItem(prisma, "no-such-item", { actor: owner })).rejects.toThrow(
      "この期限は見つかりません",
    );
  });

  it("lists the calendar by fiscal year: open items by due date, completed ones apart", async () => {
    const groups = await listCalendarItems(prisma);
    const years = await prisma.fiscalYear.findMany({ orderBy: { no: "asc" } });
    const yearGroups = groups.filter((group) => group.fiscalYear !== null);
    expect(yearGroups.map((group) => group.fiscalYear?.id)).toEqual(years.map((year) => year.id));
    // Items outside every year (none from the rules) come last, in one group.
    expect(groups.slice(0, yearGroups.length)).toEqual(yearGroups);
    expect(groups.length - yearGroups.length).toBeLessThanOrEqual(1);

    const rows = new Map((await prisma.calendarItem.findMany()).map((row) => [row.id, row]));
    const listed = groups.flatMap((group) => [...group.open, ...group.completed]);
    expect(new Set(listed.map((item) => item.id))).toEqual(new Set(rows.keys()));
    expect(listed).toHaveLength(rows.size);
    for (const group of groups) {
      expect(group.open.every((item) => item.completedAt === null)).toBe(true);
      expect(group.completed.every((item) => item.completedAt !== null)).toBe(true);
      for (const items of [group.open, group.completed]) {
        const dates = items.map((item) => item.dueDate);
        expect([...dates].sort()).toEqual(dates);
      }
      // A rule's item is in its own year; one of no year (a payroll payment) in its due date's.
      for (const item of [...group.open, ...group.completed]) {
        const fiscalYearId = rows.get(item.id)?.fiscalYearId ?? null;
        const year = group.fiscalYear;
        if (fiscalYearId !== null) expect(year?.id).toBe(fiscalYearId);
        else if (year)
          expect(year.startDate <= item.dueDate && item.dueDate <= year.endDate).toBe(true);
      }
    }
    const meeting = await ruleItem("annual.shareholders-meeting");
    expect(groups[0]?.fiscalYear?.no).toBe(1);
    expect(groups[0]?.completed.map((item) => item.id)).toContain(meeting.id);
  });

  it("lists a payroll payment by its due date and leaves its completion to the payroll screen", async () => {
    const payment = (id: string, ruleKey: string, dueDate: CalendarDate) =>
      prisma.calendarItem.create({
        data: {
          id,
          fiscalYearId: null,
          kind: "payment",
          title: `源泉所得税の納付（${ruleKey}）`,
          dueDate: toDbDate(dueDate),
          ruleKey,
        },
      });
    // As a pay run makes them (22 §7.1): in 第 1 期 by its date, and after every fiscal year.
    const inYear = await payment(
      "calendar-test-payroll-1",
      "payroll.withholding.2027-01",
      "2027-02-10",
    );
    const later = await payment(
      "calendar-test-payroll-2",
      "payroll.withholding.2099-01",
      "2099-02-10",
    );

    const groups = await listCalendarItems(prisma);
    const first = groups.find((group) => group.fiscalYear?.no === 1);
    expect(first?.open.find((item) => item.id === inYear.id)).toMatchObject({
      managedBy: "payroll",
      dueDate: "2027-02-10",
    });
    const taxReturn = await ruleItem("annual.tax-return");
    expect(first?.open.find((item) => item.id === taxReturn.id)?.managedBy).toBe("calendar");
    const last = groups.at(-1);
    expect(last?.fiscalYear).toBeNull();
    expect(last?.open.map((item) => item.id)).toContain(later.id);

    // 納付を登録 posts the entry and completes it on the payroll screen: not here, either way.
    const logged = () => prisma.auditLog.count({ where: { entityId: inYear.id } });
    const auditBefore = await logged();
    await expect(completeCalendarItem(prisma, inYear.id, { actor: owner })).rejects.toThrow(
      "給与の画面で納付を記録します",
    );
    await prisma.calendarItem.update({
      where: { id: inYear.id },
      data: { completedAt: new Date(), completedBy: owner },
    });
    await expect(reopenCalendarItem(prisma, inYear.id, { actor: owner })).rejects.toThrow(
      SettingsError,
    );
    const row = await prisma.calendarItem.findUniqueOrThrow({ where: { id: inYear.id } });
    expect(row.completedBy).toBe(owner);
    expect(await logged()).toBe(auditBefore);
  });

  it("takes a completed deadline off the home's やること, whose rows open the calendar", async () => {
    const item = await ruleItem("annual.tax-return");
    const today: CalendarDate = "2027-05-28";
    const key = `deadline:${item.id}`;
    expect(
      (await upcomingDeadlinesTodo(prisma, today)).find((row) => row.key === key),
    ).toMatchObject({ href: "/calendar" });

    await completeCalendarItem(prisma, item.id, { actor: owner });
    expect((await upcomingDeadlinesTodo(prisma, today)).map((row) => row.key)).not.toContain(key);
    await reopenCalendarItem(prisma, item.id, { actor: owner });
    expect((await upcomingDeadlinesTodo(prisma, today)).map((row) => row.key)).toContain(key);
  });

  it("names the calendar's audit rows and narrows the log to them", async () => {
    const item = await ruleItem("founding.social-insurance-application");
    const page = await listAuditLog(prisma, { entity: "calendar_item" });
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((row) => row.entity === "calendar_item")).toBe(true);
    const reopen = page.rows.find(
      (row) => row.action === "calendar_item.reopen" && row.entityId === item.id,
    );
    expect(reopen?.target).toBe(`期限 第 1 期 ${item.title}`);
  });
});
