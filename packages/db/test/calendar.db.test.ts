import { addDays, type CalendarDate } from "@niho-finance/ledger";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCalendarItems,
  fromDbDate,
  getCompany,
  listFiscalYears,
  loadOpenCalendarItems,
  markCalendarItemsNotified,
  syncCalendarItems,
  toDbDate,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { testPrisma } from "./support/prisma";

const actor = "system";

describe.skipIf(!hasTestDatabase)("calendar items from the fiscal years", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = testPrisma();
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
});
