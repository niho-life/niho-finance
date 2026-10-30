import type { CalendarDate } from "@niho-finance/ledger";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  countDueRecurringInvoices,
  createInvoiceDraft,
  createRecurringInvoice,
  createRecurringInvoiceDraft,
  createRecurringInvoiceDrafts,
  describeAuditTargets,
  discardInvoiceDraft,
  getInvoiceDetail,
  getRecurringInvoiceDetail,
  issueInvoice,
  listDueRecurringInvoices,
  listInvoices,
  listRecurringInvoices,
  loadHomeTodos,
  loadInvoiceDraftInput,
  loadRecurringInvoiceFormOptions,
  loadRecurringInvoiceHistory,
  newId,
  pauseRecurringInvoice,
  recurringInvoicesDueTodo,
  resumeRecurringInvoice,
  SettingsError,
  updateRecurringInvoice,
  type RecurringInvoiceInput,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear } from "./support/refs";

const actor = "recurring-invoice-tester@example.com";
const options = { actor };
/** 第 66 期 (2066-04-01〜2067-03-31) is this file's own year. */
const TODAY: CalendarDate = "2066-07-26";

function settingsError(error: unknown) {
  expect(error).toBeInstanceOf(SettingsError);
  const { message, field } = error as SettingsError;
  return { message, field };
}

/**
 * 定期請求 (18-invoicing §14): the due dates, the drafts made on them (once per month, also when two
 * requests race, a discarded draft included), the pause, the start and end dates, `{対象月}`, the
 * home's やること and the audit log, in a fiscal year of its own (第 66 期).
 */
describe.skipIf(!hasTestDatabase)("recurring invoices (定期請求)", () => {
  let prisma: PrismaClient;
  let partnerId: string;

  beforeAll(async () => {
    prisma = testPrisma();
    await createFiscalYear(prisma, { no: 66, startDate: "2066-04-01", endDate: "2067-03-31" });
    partnerId = (
      await prisma.partner.create({
        data: { id: newId(), name: "架空顧問合同会社", kind: "customer" },
      })
    ).id;
  });

  afterAll(async () => {
    // Nothing of this file stays due for the other files' やること.
    await prisma?.recurringInvoice.updateMany({ data: { isActive: false } });
  });

  const input = (overrides: Partial<RecurringInvoiceInput> = {}): RecurringInvoiceInput => ({
    name: "顧問料 架空顧問",
    partnerId,
    title: "顧問料（{対象月}分）",
    pricesIncludeTax: false,
    note: "",
    revenueAccountId: "",
    segmentId: "",
    lines: [
      {
        name: "顧問料 {対象月}",
        quantity: "1",
        unit: "月",
        unitPrice: "50,000",
        taxCategoryCode: "sales_10",
      },
    ],
    frequency: "monthly",
    issueDay: "25",
    targetMonthOffset: "0",
    dueMonths: "1",
    dueDay: "31",
    startDate: "2066-05-01",
    endDate: "",
    ...overrides,
  });

  const dueOf = async (recurringInvoiceId: string) =>
    (await listDueRecurringInvoices(prisma, { today: TODAY }))
      .filter((row) => row.recurringInvoiceId === recurringInvoiceId)
      .map((row) => row.date);

  it("makes a draft on a due date with {対象月} written in, and nothing in the ledger", async () => {
    const recurring = await createRecurringInvoice(prisma, input(), options);
    // today − 92 = 2066-04-25 < date ≤ 2066-07-26, from the start date 2066-05-01.
    expect(await dueOf(recurring.id)).toEqual(["2066-05-25", "2066-06-25", "2066-07-25"]);
    const [row] = (await listDueRecurringInvoices(prisma, { today: TODAY })).filter(
      (item) => item.recurringInvoiceId === recurring.id,
    );
    expect(row).toMatchObject({
      key: `${recurring.id}:2066-05`,
      name: "顧問料 架空顧問",
      partnerName: "架空顧問合同会社",
      month: "2066-05",
      title: "顧問料（2066年5月分）",
      total: 55_000n,
    });

    const entries = await prisma.journalEntry.count();
    const made = await createRecurringInvoiceDraft(
      prisma,
      { recurringInvoiceId: recurring.id, month: "2066-07" },
      { ...options, today: TODAY },
    );
    expect(made).toMatchObject({ recurringInvoiceId: recurring.id, month: "2066-07" });
    expect(made.name).toBe("顧問料 架空顧問");
    expect(made.invoice).toMatchObject({
      docType: "invoice",
      status: "draft",
      issueDate: "2066-07-25",
      dueDate: "2066-08-31",
      total: 55_000n,
      journalEntryId: null,
    });
    expect(await prisma.journalEntry.count()).toBe(entries);
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: made.invoice.id } });
    expect(stored.title).toBe("顧問料（2066年7月分）");
    expect(stored.lines).toMatchObject([{ name: "顧問料 2066年7月", date: null, amount: "50000" }]);
    expect(stored).toMatchObject({ recurringInvoiceId: recurring.id, recurringMonth: "2066-07" });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: "invoice", entityId: made.invoice.id, action: "invoice.create" },
    });
    expect(audit.after).toMatchObject({
      recurringInvoiceId: recurring.id,
      recurringMonth: "2066-07",
    });

    // The month is 作成済み: it leaves the due dates; the detail and the list point back.
    expect(await dueOf(recurring.id)).toEqual(["2066-05-25", "2066-06-25"]);
    const detail = await getInvoiceDetail(prisma, made.invoice.id, { today: TODAY });
    expect(detail?.recurring).toEqual({
      id: recurring.id,
      name: "顧問料 架空顧問",
      month: "2066-07",
      monthLabel: "2066年7月",
    });
    const page = await listInvoices(prisma, { status: "draft", partner: partnerId }, 1, {
      today: TODAY,
    });
    expect(page.rows.find((item) => item.id === made.invoice.id)?.recurring?.id).toBe(recurring.id);
  });

  it("never makes two invoices of a month: refused, and only one of two at once", async () => {
    const recurring = await createRecurringInvoice(
      prisma,
      input({ name: "保守 架空顧問", issueDay: "10" }),
      options,
    );
    const month = { recurringInvoiceId: recurring.id, month: "2066-06" };
    const [first, second] = await Promise.allSettled([
      createRecurringInvoiceDraft(prisma, month, { ...options, today: TODAY }),
      createRecurringInvoiceDraft(prisma, month, { ...options, today: TODAY }),
    ]);
    const outcomes = [first, second].map((result) => result?.status).sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
    const rejected = [first, second].find((result) => result?.status === "rejected");
    expect(settingsError((rejected as PromiseRejectedResult).reason).message).toMatch(
      /この月の請求書はすでに作成済みです/,
    );
    expect(
      await prisma.invoice.count({
        where: { recurringInvoiceId: recurring.id, recurringMonth: "2066-06" },
      }),
    ).toBe(1);

    // Asked again later: refused, naming the invoice of the month.
    expect(
      settingsError(
        await rejectionOf(createRecurringInvoiceDraft(prisma, month, { ...options, today: TODAY })),
      ),
    ).toEqual({ message: "この月の請求書はすでに作成済みです（下書き）", field: "month" });

    // The partial unique index is the last guard, under the application.
    const made = await prisma.invoice.findFirstOrThrow({
      where: { recurringInvoiceId: recurring.id, recurringMonth: "2066-06" },
    });
    const twin = newId();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "invoice" ("id", "doc_type", "number", "partner_id", "issue_date", "lines",
          "subtotal_by_rate", "tax_by_rate", "total", "status", "recurring_invoice_id",
          "recurring_month", "updated_at")
        SELECT ${twin}, "doc_type", ${`INV-draft-${twin}`}, "partner_id", "issue_date", "lines",
          "subtotal_by_rate", "tax_by_rate", "total", "status", "recurring_invoice_id",
          "recurring_month", now()
        FROM "invoice" WHERE "id" = ${made.id}`,
    ).rejects.toThrow(/Key \(recurring_invoice_id, recurring_month\)=.* already exists/);
    // Rows without a recurring invoice are not constrained, and the pair is set together.
    await expect(
      prisma.$executeRaw`UPDATE "invoice" SET "recurring_month" = NULL WHERE "id" = ${made.id}`,
    ).rejects.toThrow(/invoice_recurring_pair/);
  });

  it("does not make a discarded or voided month again", async () => {
    const recurring = await createRecurringInvoice(
      prisma,
      input({ name: "記帳代行 架空顧問", issueDay: "31" }),
      options,
    );
    const made = await createRecurringInvoiceDraft(
      prisma,
      { recurringInvoiceId: recurring.id, month: "2066-06" },
      { ...options, today: TODAY },
    );
    expect(made.invoice.issueDate).toBe("2066-06-30");
    await discardInvoiceDraft(prisma, made.invoice.id, options);
    expect(await dueOf(recurring.id)).toEqual(["2066-05-31"]);
    expect(
      settingsError(
        await rejectionOf(
          createRecurringInvoiceDraft(
            prisma,
            { recurringInvoiceId: recurring.id, month: "2066-06" },
            { ...options, today: TODAY },
          ),
        ),
      ).message,
    ).toBe("この月の請求書はすでに作成済みです（破棄した下書き）");

    // Made again by copying: the copy is not tied to the recurring invoice (§14.2).
    const source = await loadInvoiceDraftInput(prisma, made.invoice.id);
    if (!source) throw new Error("no source");
    const copy = await createInvoiceDraft(prisma, source.values, options);
    expect(
      await prisma.invoice.findUniqueOrThrow({
        where: { id: copy.id },
        select: { recurringInvoiceId: true, recurringMonth: true },
      }),
    ).toEqual({ recurringInvoiceId: null, recurringMonth: null });
  });

  it("keeps the pair after the issue (the body trigger) and never deletes a recurring invoice", async () => {
    const recurring = await createRecurringInvoice(
      prisma,
      input({ name: "監査 架空顧問", issueDay: "1", startDate: "2066-07-01" }),
      options,
    );
    const made = await createRecurringInvoiceDraft(
      prisma,
      { recurringInvoiceId: recurring.id, month: "2066-07" },
      { ...options, today: TODAY },
    );
    // A draft's columns are free (§1); the issued invoice's are not.
    await prisma.$executeRaw`UPDATE "invoice" SET "recurring_month" = '2066-08' WHERE "id" = ${made.invoice.id}`;
    await prisma.$executeRaw`UPDATE "invoice" SET "recurring_month" = '2066-07' WHERE "id" = ${made.invoice.id}`;
    await issueInvoice(prisma, made.invoice.id, options);
    await expect(
      prisma.$executeRaw`UPDATE "invoice" SET "recurring_month" = '2066-08' WHERE "id" = ${made.invoice.id}`,
    ).rejects.toThrow(/its body is immutable/);
    await expect(
      prisma.$executeRaw`UPDATE "invoice" SET "recurring_invoice_id" = NULL, "recurring_month" = NULL WHERE "id" = ${made.invoice.id}`,
    ).rejects.toThrow(/its body is immutable/);

    await expect(
      prisma.$executeRaw`DELETE FROM "recurring_invoice" WHERE "id" = ${recurring.id}`,
    ).rejects.toThrow(/recurring_invoice .* cannot be deleted/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "recurring_invoice" CASCADE`)).rejects.toThrow(
      /ledger guard: TRUNCATE on/,
    );
    await expect(
      prisma.$executeRaw`UPDATE "recurring_invoice" SET "due_months" = 4 WHERE "id" = ${recurring.id}`,
    ).rejects.toThrow(/recurring_invoice_due_months_range/);
    await expect(
      prisma.$executeRaw`UPDATE "recurring_invoice" SET "due_months" = 1, "due_day" = 0 WHERE "id" = ${recurring.id}`,
    ).rejects.toThrow(/recurring_invoice_due_day_range/);
  });

  it("follows the pause, the start date and the end date", async () => {
    const recurring = await createRecurringInvoice(
      prisma,
      input({ name: "保管 架空顧問", issueDay: "20", startDate: "2066-06-01" }),
      options,
    );
    expect(await dueOf(recurring.id)).toEqual(["2066-06-20", "2066-07-20"]);
    // Before the start date: not a due date.
    expect(
      settingsError(
        await rejectionOf(
          createRecurringInvoiceDraft(
            prisma,
            { recurringInvoiceId: recurring.id, month: "2066-05" },
            { ...options, today: TODAY },
          ),
        ),
      ),
    ).toEqual({ message: "この月は予定日ではありません", field: "month" });
    // Not come yet, or older than 92 days: neither.
    for (const [month, today] of [
      ["2066-08", TODAY],
      ["2066-06", "2066-09-20"],
    ] as const) {
      expect(
        settingsError(
          await rejectionOf(
            createRecurringInvoiceDraft(
              prisma,
              { recurringInvoiceId: recurring.id, month },
              { ...options, today },
            ),
          ),
        ).message,
      ).toBe("この月は予定日ではありません");
    }

    await pauseRecurringInvoice(prisma, recurring.id, options);
    expect(await dueOf(recurring.id)).toEqual([]);
    expect(
      settingsError(
        await rejectionOf(
          createRecurringInvoiceDraft(
            prisma,
            { recurringInvoiceId: recurring.id, month: "2066-07" },
            { ...options, today: TODAY },
          ),
        ),
      ).message,
    ).toBe("この定期請求は停止しています");
    expect(
      settingsError(await rejectionOf(pauseRecurringInvoice(prisma, recurring.id, options)))
        .message,
    ).toMatch(/すでに停止しています/);
    await resumeRecurringInvoice(prisma, recurring.id, options);
    expect(await dueOf(recurring.id)).toEqual(["2066-06-20", "2066-07-20"]);

    // The end date (inclusive) stops it; editing never changes the drafts already made.
    const made = await createRecurringInvoiceDraft(
      prisma,
      { recurringInvoiceId: recurring.id, month: "2066-06" },
      { ...options, today: TODAY },
    );
    await updateRecurringInvoice(
      prisma,
      recurring.id,
      input({
        name: "保管 架空顧問",
        issueDay: "20",
        startDate: "2066-06-01",
        endDate: "2066-06-30",
        title: "保管料",
      }),
      options,
    );
    expect(await dueOf(recurring.id)).toEqual([]);
    expect(
      settingsError(
        await rejectionOf(
          createRecurringInvoiceDraft(
            prisma,
            { recurringInvoiceId: recurring.id, month: "2066-07" },
            { ...options, today: TODAY },
          ),
        ),
      ).message,
    ).toBe("この月は予定日ではありません");
    const kept = await prisma.invoice.findUniqueOrThrow({ where: { id: made.invoice.id } });
    expect(kept.title).toBe("顧問料（2066年6月分）");
  });

  it("writes the target month with its offset (前月分 / 翌月分) and the due rule", async () => {
    const previous = await createRecurringInvoice(
      prisma,
      input({ name: "前月分 架空顧問", targetMonthOffset: "-1", dueMonths: "0", dueDay: "31" }),
      options,
    );
    const made = await createRecurringInvoiceDraft(
      prisma,
      { recurringInvoiceId: previous.id, month: "2066-07" },
      { ...options, today: TODAY },
    );
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: made.invoice.id } });
    expect(row.title).toBe("顧問料（2066年6月分）");
    expect(made.invoice.dueDate).toBe("2066-07-31");

    const next = await createRecurringInvoice(
      prisma,
      input({ name: "翌月分 架空顧問", targetMonthOffset: "1", dueMonths: "2", dueDay: "10" }),
      options,
    );
    const ahead = await createRecurringInvoiceDraft(
      prisma,
      { recurringInvoiceId: next.id, month: "2066-07" },
      { ...options, today: TODAY },
    );
    const aheadRow = await prisma.invoice.findUniqueOrThrow({ where: { id: ahead.invoice.id } });
    expect(aheadRow.title).toBe("顧問料（2066年8月分）");
    expect(ahead.invoice.dueDate).toBe("2066-09-10");
  });

  it("validates the template and the rule", async () => {
    const zod = async (value: RecurringInvoiceInput) => {
      const error = await rejectionOf(createRecurringInvoice(prisma, value, options));
      expect(error).toBeInstanceOf(ZodError);
      return (error as ZodError).issues.map(({ path, message }) => ({ path, message }));
    };
    expect(await zod(input({ dueMonths: "0", dueDay: "10" }))).toContainEqual({
      path: ["dueDay"],
      message:
        "支払期限が発行日より前になります。当月にするときは、発行日の日以後の日にしてください",
    });
    expect(await zod(input({ endDate: "2066-04-30" }))).toContainEqual({
      path: ["endDate"],
      message: "終了日は開始日以後にしてください",
    });
    expect(await zod(input({ issueDay: "32" }))).toContainEqual({
      path: ["issueDay"],
      message: "発行日は 1〜31 にしてください",
    });
    expect(await zod(input({ targetMonthOffset: "2" }))).toContainEqual({
      path: ["targetMonthOffset"],
      message: "対象月は 前月分・当月分・翌月分 から選んでください",
    });
    const inactive = await prisma.partner.create({
      data: { id: newId(), name: "架空休眠合同会社", kind: "customer", isActive: false },
    });
    expect(
      settingsError(
        await rejectionOf(
          createRecurringInvoice(prisma, input({ partnerId: inactive.id }), options),
        ),
      ).field,
    ).toBe("partnerId");
  });

  it("makes several drafts, one transaction each, reporting the rejected ones", async () => {
    const recurring = await createRecurringInvoice(
      prisma,
      input({ name: "まとめて 架空顧問", issueDay: "15" }),
      options,
    );
    const before = await countDueRecurringInvoices(prisma, { today: TODAY });
    const result = await createRecurringInvoiceDrafts(
      prisma,
      {
        items: [
          { recurringInvoiceId: recurring.id, month: "2066-05" },
          { recurringInvoiceId: recurring.id, month: "2066-08" },
          { recurringInvoiceId: recurring.id, month: "2066-06" },
        ],
      },
      { ...options, today: TODAY },
    );
    expect(result).toMatchObject({ created: 2, failed: 1 });
    expect(result.items.map((item) => item.ok)).toEqual([true, false, true]);
    expect(result.items[1]).toMatchObject({
      month: "2066-08",
      message: "この月は予定日ではありません",
    });
    expect(await countDueRecurringInvoices(prisma, { today: TODAY })).toBe(before - 2);
  });

  it("counts the due dates in やること before 発行する請求書", async () => {
    const count = await countDueRecurringInvoices(prisma, { today: TODAY });
    expect(count).toBeGreaterThan(0);
    expect(await recurringInvoicesDueTodo(prisma, TODAY)).toEqual([
      {
        key: "recurring-invoices-due",
        badge: String(count),
        tone: "count",
        label: "定期請求の下書きを作る",
        href: "/invoices/recurring/due",
      },
    ]);
    const keys = (await loadHomeTodos(prisma, TODAY)).map((row) => row.key);
    expect(keys.indexOf("recurring-invoices-due")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("recurring-invoices-due")).toBeLessThan(keys.indexOf("draft-invoices"));
    // Before every start date of this file: nothing to do.
    expect(await recurringInvoicesDueTodo(prisma, "2066-01-10")).toEqual([]);
  });

  it("lists, details and fills the form from an invoice", async () => {
    const recurring = await createRecurringInvoice(
      prisma,
      input({ name: "一覧 架空顧問", issueDay: "28" }),
      options,
    );
    await createRecurringInvoiceDraft(
      prisma,
      { recurringInvoiceId: recurring.id, month: "2066-06" },
      { ...options, today: TODAY },
    );
    const list = await listRecurringInvoices(prisma, { today: TODAY });
    const row = list.rows.find((item) => item.id === recurring.id);
    expect(row).toMatchObject({
      name: "一覧 架空顧問",
      partnerName: "架空顧問合同会社",
      scheduleLabel: "毎月 28 日",
      total: 55_000n,
      nextDate: "2066-07-28",
      dueCount: 1,
      isActive: true,
    });
    expect(list.activeCount).toBeGreaterThan(0);
    expect(list.next?.date).toBeDefined();

    const detail = await getRecurringInvoiceDetail(prisma, recurring.id, { today: TODAY });
    expect(detail).toMatchObject({
      scheduleLabel: "毎月 28 日",
      dueRuleLabel: "翌月末",
      targetMonthLabel: "当月分",
      nextDates: ["2066-07-28", "2066-08-28", "2066-09-28"],
      titlePreview: "顧問料（2066年7月分）",
      due: [{ date: "2066-05-28", month: "2066-05" }],
    });
    expect(detail?.totals?.total).toBe(55_000n);
    expect(detail?.lines[0]).toMatchObject({ name: "顧問料 {対象月}", amount: 50_000n });
    expect(detail?.invoices.map((invoice) => [invoice.month, invoice.status])).toEqual([
      ["2066-06", "draft"],
    ]);
    expect(await getRecurringInvoiceDetail(prisma, newId(), { today: TODAY })).toBeNull();

    // The form from an issued invoice: its body, its issue day and its due rule.
    const invoice = await createInvoiceDraft(
      prisma,
      {
        docType: "invoice",
        partnerId,
        title: "保守",
        issueDate: "2066-06-30",
        dueDate: "2066-07-31",
        pricesIncludeTax: false,
        note: "",
        revenueAccountId: "",
        segmentId: "",
        sourceInvoiceId: "",
        lines: [
          {
            date: "2066-06-30",
            name: "保守 一式",
            quantity: "1",
            unit: "式",
            unitPrice: "30000",
            taxCategoryCode: "sales_10",
          },
        ],
      },
      options,
    );
    await issueInvoice(prisma, invoice.id, options);
    const form = await loadRecurringInvoiceFormOptions(prisma, { today: TODAY, from: invoice.id });
    expect(form?.source?.id).toBe(invoice.id);
    expect(form?.values).toMatchObject({
      name: "保守 架空顧問合同会社",
      partnerId,
      title: "保守",
      issueDay: "31",
      dueMonths: "1",
      dueDay: "31",
      startDate: TODAY,
      lines: [{ name: "保守 一式", quantity: "1", unit: "式", unitPrice: "30000" }],
    });
    expect(form?.options.partners.some((partner) => partner.id === partnerId)).toBe(true);
    const edit = await loadRecurringInvoiceFormOptions(prisma, { today: TODAY, id: recurring.id });
    expect(edit?.values).toMatchObject({ name: "一覧 架空顧問", issueDay: "28" });
    expect(await loadRecurringInvoiceFormOptions(prisma, { today: TODAY, id: newId() })).toBeNull();
  });

  it("logs the writes and names the recurring invoice in the audit log", async () => {
    const recurring = await createRecurringInvoice(
      prisma,
      input({ name: "履歴 架空顧問" }),
      options,
    );
    // Saving the same template again changes nothing and logs nothing.
    await updateRecurringInvoice(prisma, recurring.id, input({ name: "履歴 架空顧問" }), options);
    await updateRecurringInvoice(
      prisma,
      recurring.id,
      input({ name: "履歴 架空顧問", issueDay: "26" }),
      options,
    );
    await pauseRecurringInvoice(prisma, recurring.id, options);
    await resumeRecurringInvoice(prisma, recurring.id, options);
    const history = await loadRecurringInvoiceHistory(prisma, recurring.id);
    expect(history.map((row) => row.action)).toEqual([
      "recurring_invoice.create",
      "recurring_invoice.update",
      "recurring_invoice.pause",
      "recurring_invoice.resume",
    ]);
    expect(history[1]?.before).toMatchObject({ issueDay: 25 });
    expect(history[1]?.after).toMatchObject({ issueDay: 26 });
    const names = await describeAuditTargets(prisma, [
      { entity: "recurring_invoice", entityId: recurring.id },
    ]);
    expect(names.get(`recurring_invoice:${recurring.id}`)).toBe("定期請求 履歴 架空顧問");
  });

  it("refuses a draft whose {対象月} would pass the invoice's limits", async () => {
    // 200 characters as saved; 「2066年7月」 makes the title 202.
    const title = `${"顧".repeat(195)}{対象月}`;
    const recurring = await createRecurringInvoice(
      prisma,
      input({ name: "長い件名 架空顧問", title }),
      options,
    );
    const month = { recurringInvoiceId: recurring.id, month: "2066-07" };
    expect(
      settingsError(
        await rejectionOf(createRecurringInvoiceDraft(prisma, month, { ...options, today: TODAY })),
      ),
    ).toEqual({
      message: "{対象月} を入れると件名が 200 文字を超えます。定期請求の件名を短くしてください",
      field: "month",
    });
    expect(await prisma.invoice.count({ where: { recurringInvoiceId: recurring.id } })).toBe(0);
    await pauseRecurringInvoice(prisma, recurring.id, options);
  });
});
