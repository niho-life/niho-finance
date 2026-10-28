import type { CalendarDate } from "@niho-finance/ledger";
import type { InvoiceStatus, Prisma, PrismaClient, Wallet } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  countActiveRecurringItems,
  createRecurringItem,
  createWallet,
  describeAuditTargets,
  listRecurringItems,
  loadCashflowInputs,
  setWalletActive,
  SettingsError,
  toDbDate,
  updateRecurringItem,
  type RecurringItemCreateInput,
} from "../src";
import { newId } from "../src/ids";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

/** Runs `fn` in a transaction that is rolled back (calendar rows would disturb the home tests). */
async function rolledBack<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const rollback = new Error("rollback");
  let result: { value: T } | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      result = { value: await fn(tx) };
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  if (!result) throw new Error("the transaction did not run");
  return result.value;
}

/** 定期取引 on the seeded book. Each test adds its own items (other files share the database). */
describe.skipIf(!hasTestDatabase)("recurring items", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let bank: Wallet;
  let card: Wallet;
  let cash: Wallet;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    bank = await prisma.wallet.findFirstOrThrow({ where: { name: "架空銀行 普通" } });
    card = await prisma.wallet.findFirstOrThrow({ where: { name: "架空カード" } });
    cash = await prisma.wallet.findFirstOrThrow({ where: { name: "現金" } });
  });

  const rent = (overrides: Partial<RecurringItemCreateInput> = {}): RecurringItemCreateInput => ({
    name: "家賃",
    direction: "withdrawal",
    amount: "110,000",
    frequency: "monthly",
    dayOfMonth: "31",
    startDate: "2026-11-30",
    walletId: bank.id,
    accountId: refs.account("5300"),
    ...overrides,
  });

  async function auditOf(entityId: string) {
    const rows = await prisma.auditLog.findMany({
      where: { entityId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { action: true, actor: true, entity: true, before: true, after: true },
    });
    for (const row of rows) {
      expect(row.actor).toBe(actor);
      expect(row.entity).toBe("recurring_item");
    }
    return rows;
  }

  it("adds an item with a signed amount and records it in the audit log", async () => {
    const item = await createRecurringItem(prisma, rent(), { actor });
    expect(item).toMatchObject({
      name: "家賃",
      amount: -110_000n,
      frequency: "monthly",
      dayOfMonth: 31,
      monthOfYear: null,
      startDate: "2026-11-30",
      endDate: null,
      walletId: bank.id,
      walletName: "架空銀行 普通",
      accountCode: "5300",
      segmentId: null,
      isActive: true,
      cashEffect: -110_000n,
    });
    const audit = await auditOf(item.id);
    expect(audit.map((row) => row.action)).toEqual(["recurring_item.create"]);
    expect(audit[0]?.before).toBeNull();
    expect(audit[0]?.after).toMatchObject({ name: "家賃", amount: "-110000" });
    const targets = await describeAuditTargets(prisma, [
      { entity: "recurring_item", entityId: item.id },
    ]);
    expect(targets.get(`recurring_item:${item.id}`)).toBe("定期取引 家賃");
  });

  it("takes the wallet's default segment, keeps no month for 毎月, and knows card payments", async () => {
    const drop = await createRecurringItem(
      prisma,
      {
        name: "ドロップインの売上",
        direction: "deposit",
        amount: "3300",
        frequency: "monthly",
        monthOfYear: "4",
        dayOfMonth: "15",
        startDate: "2026-12-01",
        walletId: cash.id,
        accountId: refs.account("4010"),
      },
      { actor },
    );
    expect(drop).toMatchObject({
      amount: 3_300n,
      monthOfYear: null,
      segmentId: refs.segment("corporate"),
      cashEffect: 3_300n,
    });
    const gcp = await createRecurringItem(
      prisma,
      rent({ name: "GCP", amount: "3,300", walletId: card.id, accountId: refs.account("5320") }),
      { actor },
    );
    expect(gcp.cashEffect).toBe(0n);
    const withdrawal = await createRecurringItem(
      prisma,
      rent({
        name: "カードの引落し",
        amount: "50000",
        dayOfMonth: "10",
        accountId: refs.account("2100"),
      }),
      { actor },
    );
    expect(withdrawal.cashEffect).toBe(-50_000n);
  });

  it("changes fields in place, deactivates and activates again, all in the audit log", async () => {
    const item = await createRecurringItem(prisma, rent({ name: "倉庫の家賃" }), { actor });

    const renamed = await updateRecurringItem(prisma, item.id, { name: "倉庫の賃料" }, { actor });
    expect(renamed.name).toBe("倉庫の賃料");
    // 金額 alone keeps 出金; 入出金 alone keeps the amount.
    expect(
      (await updateRecurringItem(prisma, item.id, { amount: "120,000" }, { actor })).amount,
    ).toBe(-120_000n);
    expect(
      (await updateRecurringItem(prisma, item.id, { direction: "deposit" }, { actor })).amount,
    ).toBe(120_000n);
    const yearly = await updateRecurringItem(
      prisma,
      item.id,
      { frequency: "yearly", monthOfYear: "5", endDate: "2028-05-31" },
      { actor },
    );
    expect(yearly).toMatchObject({ frequency: "yearly", monthOfYear: 5, endDate: "2028-05-31" });
    const monthly = await updateRecurringItem(prisma, item.id, { frequency: "monthly" }, { actor });
    expect(monthly).toMatchObject({ frequency: "monthly", monthOfYear: null });

    const inactive = await updateRecurringItem(prisma, item.id, { isActive: false }, { actor });
    expect(inactive.isActive).toBe(false);
    const active = await updateRecurringItem(prisma, item.id, { isActive: true }, { actor });
    expect(active.isActive).toBe(true);

    // Nothing changes: nothing is written.
    await updateRecurringItem(prisma, item.id, { name: "倉庫の賃料", dayOfMonth: "31" }, { actor });

    const audit = await auditOf(item.id);
    expect(audit.map((row) => row.action)).toEqual([
      "recurring_item.create",
      "recurring_item.update",
      "recurring_item.update",
      "recurring_item.update",
      "recurring_item.update",
      "recurring_item.update",
      "recurring_item.update",
      "recurring_item.update",
    ]);
    expect(audit[1]?.before).toMatchObject({ name: "倉庫の家賃" });
    expect(audit[1]?.after).toMatchObject({ name: "倉庫の賃料" });
    expect(audit[6]?.after).toMatchObject({ isActive: false });
  });

  it("rejects what 21 §2 does not allow, saying how to get back", async () => {
    const error = await rejectionOf(
      createRecurringItem(prisma, rent({ accountId: refs.account("1100") }), { actor }),
    );
    expect(error).toBeInstanceOf(SettingsError);
    expect(error).toMatchObject({
      field: "accountId",
      message: "口座の科目と同じ科目は選べません",
    });
    await expect(
      createRecurringItem(prisma, rent({ frequency: "yearly" }), { actor }),
    ).rejects.toMatchObject({
      field: "monthOfYear",
      message: "毎年の定期取引は月を選んでください",
    });
    await expect(
      createRecurringItem(prisma, rent({ endDate: "2026-11-29" }), { actor }),
    ).rejects.toMatchObject({ field: "endDate", message: "終了日は開始日より後にしてください" });
    // The end date may be the start date.
    expect(
      (
        await createRecurringItem(prisma, rent({ name: "一度だけ", endDate: "2026-11-30" }), {
          actor,
        })
      ).endDate,
    ).toBe("2026-11-30");

    await expect(
      createRecurringItem(prisma, rent({ amount: "0" }), { actor }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      createRecurringItem(prisma, rent({ amount: "1,000,000,000,000" }), { actor }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(createRecurringItem(prisma, rent({ name: "" }), { actor })).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(
      createRecurringItem(prisma, rent({ dayOfMonth: "32" }), { actor }),
    ).rejects.toBeInstanceOf(ZodError);

    const closed = await createWallet(prisma, { name: "解約した口座", kind: "bank" }, { actor });
    await setWalletActive(prisma, { id: closed.id, isActive: false }, { actor });
    await expect(
      createRecurringItem(prisma, rent({ walletId: closed.id }), { actor }),
    ).rejects.toMatchObject({ field: "walletId" });

    const item = await createRecurringItem(prisma, rent({ name: "検査用" }), { actor });
    await expect(
      updateRecurringItem(prisma, item.id, { accountId: refs.account("1100") }, { actor }),
    ).rejects.toMatchObject({ field: "accountId" });
    await expect(
      updateRecurringItem(
        prisma,
        item.id,
        { startDate: "2027-01-01", endDate: "2026-12-31" },
        { actor },
      ),
    ).rejects.toMatchObject({ field: "endDate" });
    await expect(
      updateRecurringItem(prisma, item.id, { frequency: "yearly" }, { actor }),
    ).rejects.toMatchObject({ field: "monthOfYear" });
    await expect(
      updateRecurringItem(prisma, "missing", { name: "x" }, { actor }),
    ).rejects.toBeInstanceOf(SettingsError);
    // Nothing of the rejected updates was written.
    expect((await auditOf(item.id)).map((row) => row.action)).toEqual(["recurring_item.create"]);
  });

  it("lists active items first, then 毎月 → 毎年, the day and the name", async () => {
    const tag = `並び ${newId().slice(-6)}`;
    const make = (name: string, overrides: Partial<RecurringItemCreateInput>) =>
      createRecurringItem(prisma, rent({ name: `${tag} ${name}`, ...overrides }), { actor });
    const inactive = await make("無効", { dayOfMonth: "1" });
    await updateRecurringItem(prisma, inactive.id, { isActive: false }, { actor });
    await make("毎年", { frequency: "yearly", monthOfYear: "3", dayOfMonth: "1" });
    await make("25 日 B", { dayOfMonth: "25" });
    await make("25 日 A", { dayOfMonth: "25" });
    await make("5 日", { dayOfMonth: "5" });

    const names = (await listRecurringItems(prisma))
      .filter((item) => item.name.startsWith(tag))
      .map((item) => item.name.slice(tag.length + 1));
    expect(names).toEqual(["5 日", "25 日 A", "25 日 B", "毎年", "無効"]);
  });

  it("counts the active items", async () => {
    const before = await countActiveRecurringItems(prisma);
    const item = await createRecurringItem(prisma, rent({ name: "数える" }), { actor });
    expect(await countActiveRecurringItems(prisma)).toBe(before + 1);
    await updateRecurringItem(prisma, item.id, { isActive: false }, { actor });
    expect(await countActiveRecurringItems(prisma)).toBe(before);
  });

  describe("loadCashflowInputs", () => {
    const window = { start: "2026-12-01", days: 90 } as const;

    it("passes every recurring item and leaves the received invoices unconnected", async () => {
      const item = await createRecurringItem(
        prisma,
        rent({ name: "入力の確認", frequency: "yearly", monthOfYear: "2", dayOfMonth: "29" }),
        { actor },
      );
      await updateRecurringItem(prisma, item.id, { isActive: false }, { actor });
      const inputs = await loadCashflowInputs(prisma, window);
      expect(inputs.recurring.find((row) => row.id === item.id)).toEqual({
        id: item.id,
        name: "入力の確認",
        amount: -110_000n,
        frequency: "yearly",
        dayOfMonth: 29,
        monthOfYear: 2,
        startDate: "2026-11-30",
        endDate: null,
        walletId: bank.id,
        accountId: refs.account("5300"),
        isActive: false,
      });
      expect(inputs.receivables).not.toBeNull();
      expect(inputs.payables).toBeNull();
    });

    it("gives what issued invoices still wait for, by their due date", async () => {
      const receivables = await rolledBack(prisma, async (tx) => {
        const partner = await tx.partner.create({
          data: { id: newId(), name: "架空商店", kind: "customer" },
        });
        const invoice = (number: string, status: InvoiceStatus, dueDate: string | null) =>
          tx.invoice.create({
            data: {
              id: newId(),
              docType: "invoice",
              number,
              partnerId: partner.id,
              issueDate: toDbDate("2026-11-30"),
              dueDate: dueDate === null ? null : toDbDate(dueDate as CalendarDate),
              lines: [],
              subtotalByRate: [],
              taxByRate: [],
              total: 330_000n,
              status,
            },
          });
        await invoice("INV-T-0001", "issued", "2026-12-31");
        await invoice("INV-T-0002", "sent", null);
        await invoice("INV-T-0003", "paid", "2026-12-31");
        await invoice("INV-T-0004", "draft", "2026-12-31");
        await invoice("INV-T-0005", "void", "2026-12-31");
        return (await loadCashflowInputs(tx, window)).receivables;
      });
      expect(receivables).toEqual(
        expect.arrayContaining([
          { date: "2026-12-31", amount: 330_000n, label: "INV-T-0001 架空商店" },
          { date: null, amount: 330_000n, label: "INV-T-0002 架空商店" },
        ]),
      );
      expect(receivables?.filter((row) => row.label.startsWith("INV-T-"))).toHaveLength(2);
    });

    it("gives no deadlines (not connected) while the calendar has no row", async () => {
      const inputs = await rolledBack(prisma, async (tx) => {
        await tx.calendarItem.deleteMany();
        return loadCashflowInputs(tx, window);
      });
      expect(inputs.deadlines).toBeNull();
    });

    it("gives the open payment deadlines in the period, with the pay runs' amounts", async () => {
      const deadlines = await rolledBack(prisma, async (tx) => {
        // Other files (payroll) leave deadlines behind: start from an empty calendar.
        await tx.calendarItem.deleteMany();
        const add = (
          title: string,
          dueDate: CalendarDate,
          rest: { kind?: "payment" | "filing"; ruleKey?: string; completedAt?: Date } = {},
        ) =>
          tx.calendarItem.create({
            data: {
              id: newId(),
              fiscalYearId: null,
              kind: rest.kind ?? "payment",
              title,
              dueDate: toDbDate(dueDate),
              ruleKey: rest.ruleKey ?? null,
              completedAt: rest.completedAt ?? null,
            },
          });
        await add("起点の日の納付", "2026-12-01");
        await add("源泉所得税の納付", "2027-01-10");
        await add("納付済み", "2027-01-10", { completedAt: new Date("2027-01-05T00:00:00Z") });
        await add("法人税等の中間申告・納付", "2027-02-28", {
          kind: "filing",
          ruleKey: "annual.interim-return",
        });
        await add("届出", "2027-02-01", { kind: "filing", ruleKey: "notice.other" });
        await add("90 日後の納付", "2027-03-01");
        await add("期間の後の納付", "2027-03-02");
        // A payroll deadline no confirmed pay run pays into has nothing to pay (22-payroll §7.2).
        await add("源泉所得税の納付（支給なし）", "2027-01-10", {
          ruleKey: "payroll.withholding.2030-01",
        });
        return (await loadCashflowInputs(tx, window)).deadlines;
      });
      expect(deadlines).toEqual([
        { date: "2027-01-10", title: "源泉所得税の納付", amount: null },
        { date: "2027-02-28", title: "法人税等の中間申告・納付", amount: null },
        { date: "2027-03-01", title: "90 日後の納付", amount: null },
      ]);
      // Nothing stayed.
      expect(await prisma.calendarItem.count({ where: { title: "90 日後の納付" } })).toBe(0);
    });
  });
});
