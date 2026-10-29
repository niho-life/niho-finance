/**
 * 給与 (22-payroll §5–§7, acceptance §7.3 except the screens): employees, a pay run's preview and
 * confirmation, the 2 entries, the payment schedule and its balances, payments, the append-only
 * run and the rejections. Every name and amount is fictional.
 *
 * The runs post into a fiscal year of their own (第 220 期, 2026-04-01〜2026-11-01, 税抜経理, closed
 * through 2026-05-31): the registered tables cover premium months 2026-03〜2027-02, and the other
 * test files keep fiscal year 1 to themselves. A trial balance carries every earlier entry, so the
 * entries are voided at the end (reversals, nothing deleted): other files see fiscal year 1 as seeded
 * whatever the order. Payments use the 役員立替 wallet.
 */
import { LedgerValidationError } from "@niho-finance/ledger";
import {
  calculatePayroll,
  parsePayrollRunItems,
  parsePayrollTableIds,
  payrollInputOf,
  PayrollTableMissingError,
  pinnedTables,
  serializePayrollRunItems,
  type YearMonth,
} from "@niho-finance/payroll";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  confirmPayrollRun,
  createEmployee,
  getPayrollRun,
  listEmployees,
  listPayrollRuns,
  listPayrollSchedule,
  loadPayrollDraft,
  loadPayslip,
  markPayrollPaymentDone,
  postPayrollPayment,
  postVoucherEntry,
  previewPayrollPayment,
  previewPayrollRun,
  regularPayRevisionDeadline,
  setEmployeeActive,
  SettingsError,
  updateEmployee,
  voidJournalEntry,
  type EmployeeCreateInput,
  type PayrollPreview,
  type PayrollRunDetail,
  type PayrollRunValues,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

/** 第 220 期: only the payroll tests post here. */
async function payrollYear(prisma: PrismaClient): Promise<FiscalYear> {
  const existing = await prisma.fiscalYear.findFirst({ where: { no: 220 } });
  return (
    existing ??
    createFiscalYear(prisma, {
      no: 220,
      startDate: "2026-04-01",
      endDate: "2026-11-01",
      lockedThrough: "2026-05-31",
      tax: { consumptionTax: "general", accountingMethod: "tax_exclusive" },
    })
  );
}

function officerInput(overrides: Partial<Record<string, unknown>> = {}): EmployeeCreateInput {
  return {
    name: "テスト 太郎",
    kind: "officer",
    birthDate: "1990-04-15",
    basePay: "300,000",
    commuteAllowance: "",
    socialInsured: true,
    insuredFrom: "2026-04-01",
    healthSmr: "300000",
    pensionSmr: "300000",
    employmentInsured: false,
    taxColumn: "kou",
    dependents: "0",
    residentTax: "0",
    ...overrides,
  };
}

function employeeInput(overrides: Partial<Record<string, unknown>> = {}): EmployeeCreateInput {
  return {
    name: "テスト 花子",
    kind: "employee",
    birthDate: "1995-06-20",
    basePay: 250_000n,
    commuteAllowance: 10_000n,
    socialInsured: true,
    insuredFrom: "2026-04-01",
    healthSmr: 260_000n,
    pensionSmr: 260_000n,
    employmentInsured: true,
    taxColumn: "kou",
    dependents: 0,
    residentTax: 10_000n,
    ...overrides,
  };
}

function zodPaths(error: unknown): string[] {
  expect(error).toBeInstanceOf(ZodError);
  return (error as ZodError).issues.map((issue) => issue.path.join("."));
}

function ledgerCodes(error: unknown) {
  expect(error).toBeInstanceOf(LedgerValidationError);
  return (error as LedgerValidationError).errors.map(({ code, field }) => ({ code, field }));
}

async function deactivateAllEmployees(prisma: PrismaClient): Promise<void> {
  for (const employee of await listEmployees(prisma)) {
    if (employee.isActive)
      await setEmployeeActive(prisma, { id: employee.id, isActive: false }, { actor });
  }
}

// ---------------------------------------------------------------------------------------------
// 従業員
// ---------------------------------------------------------------------------------------------

describe.skipIf(!hasTestDatabase)("employees (従業員)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = testPrisma();
    await payrollYear(prisma);
  });

  it("adds, changes and deactivates with the audit log and the officer warnings", async () => {
    const created = await createEmployee(
      prisma,
      officerInput({ name: "テスト 一郎", basePay: "0" }),
      { actor, today: "2026-04-10" },
    );
    expect(created.employee).toMatchObject({
      name: "テスト 一郎",
      kind: "officer",
      basePay: 0n,
      commuteAllowance: 0n,
      healthSmr: 300_000n,
      insuredFrom: "2026-04-01",
      dependents: 0,
      isActive: true,
    });
    expect(created.warnings.map((warning) => warning.code)).toEqual(["OFFICER_ZERO_PAY_INSURED"]);
    const id = created.employee.id;

    // 期首 (2026-04-01) から 3 か月以内の改定: no 定期同額 warning.
    const early = await updateEmployee(
      prisma,
      { id, ...officerInput({ name: "テスト 一郎", basePay: "200,000" }) },
      { actor, today: "2026-06-30" },
    );
    expect(early.employee.basePay).toBe(200_000n);
    expect(early.warnings).toEqual([]);

    // 3 か月を過ぎた改定: warned, still saved.
    const late = await updateEmployee(
      prisma,
      { id, ...officerInput({ name: "テスト 一郎", basePay: "250000" }) },
      { actor, today: "2026-07-01" },
    );
    expect(late.employee.basePay).toBe(250_000n);
    expect(late.warnings.map((warning) => warning.code)).toEqual(["OFFICER_PAY_CHANGED_LATE"]);
    expect(late.warnings[0]?.message).toMatch(/2026\/06\/30 まで/);

    // 報酬を払う役員に社会保険なし: warned; the insurance fields are not kept.
    const uninsured = await updateEmployee(
      prisma,
      { id, ...officerInput({ name: "テスト 一郎", basePay: "250000", socialInsured: false }) },
      { actor, today: "2026-07-01" },
    );
    expect(uninsured.employee).toMatchObject({
      socialInsured: false,
      insuredFrom: null,
      healthSmr: null,
      pensionSmr: null,
    });
    expect(uninsured.warnings.map((warning) => warning.code)).toEqual(["OFFICER_PAID_NOT_INSURED"]);

    // The same values again: nothing is written.
    const before = await prisma.auditLog.count({ where: { entityId: id } });
    await updateEmployee(
      prisma,
      { id, ...officerInput({ name: "テスト 一郎", basePay: "250000", socialInsured: false }) },
      { actor, today: "2026-07-01" },
    );
    expect(await prisma.auditLog.count({ where: { entityId: id } })).toBe(before);

    const inactive = await setEmployeeActive(prisma, { id, isActive: false }, { actor });
    expect(inactive.isActive).toBe(false);
    expect((await listEmployees(prisma)).find((row) => row.id === id)?.isActive).toBe(false);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: id },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(audit.map((row) => row.action)).toEqual([
      "employee.create",
      "employee.update",
      "employee.update",
      "employee.update",
      "employee.deactivate",
    ]);
    expect(audit[0]?.after).toMatchObject({
      name: "テスト 一郎",
      basePay: "0",
      birthDate: "1990-04-15",
    });
    expect(audit[1]?.before).toMatchObject({ basePay: "0" });
    expect(audit[1]?.after).toMatchObject({ basePay: "200000" });
  });

  it("rejects 雇用保険 for an officer and missing insurance fields", async () => {
    expect(
      zodPaths(
        await rejectionOf(
          createEmployee(prisma, officerInput({ employmentInsured: true }), { actor }),
        ),
      ),
    ).toEqual(["employmentInsured"]);
    expect(
      zodPaths(
        await rejectionOf(
          createEmployee(
            prisma,
            employeeInput({ insuredFrom: "", healthSmr: "", pensionSmr: "0" }),
            { actor },
          ),
        ),
      ),
    ).toEqual(["insuredFrom", "healthSmr", "pensionSmr"]);
    expect(
      zodPaths(
        await rejectionOf(createEmployee(prisma, employeeInput({ basePay: "-1" }), { actor })),
      ),
    ).toEqual(["basePay"]);
  });

  it("rejects a 標準報酬月額 that is not a grade amount of this month's table", async () => {
    const error = await rejectionOf(
      createEmployee(prisma, employeeInput({ healthSmr: "255,000" }), {
        actor,
        today: "2026-10-01",
      }),
    );
    expect(error).toBeInstanceOf(SettingsError);
    expect((error as SettingsError).field).toBe("healthSmr");
    expect((error as SettingsError).message).toMatch(/255,000 円は等級表にありません/);
    const pension = await rejectionOf(
      createEmployee(prisma, employeeInput({ pensionSmr: "58000" }), {
        actor,
        today: "2026-10-01",
      }),
    );
    expect((pension as SettingsError).field).toBe("pensionSmr");
  });

  it("counts 3 months from the start of the fiscal year (民法 143 条)", () => {
    expect(regularPayRevisionDeadline("2026-04-01")).toBe("2026-06-30");
    expect(regularPayRevisionDeadline("2026-11-02")).toBe("2027-02-01");
    expect(regularPayRevisionDeadline("2026-11-30")).toBe("2027-02-28");
  });
});

// ---------------------------------------------------------------------------------------------
// 支給
// ---------------------------------------------------------------------------------------------

type LineRow = [side: string, account: string, amount: bigint, taxAmount: bigint];

describe.skipIf(!hasTestDatabase)("pay runs (支給の計算と確定)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let ownerWallet: string;
  let officerId: string;
  let employeeId: string;
  let preview1: PayrollPreview;
  let run1: PayrollRunDetail;
  let preview2: PayrollPreview;
  let run2: PayrollRunDetail;

  /** The draft of `payMonth` as the screen would send it. */
  async function draftInput(
    payMonth: string,
    overrides: Partial<PayrollRunValues> = {},
  ): Promise<PayrollRunValues> {
    const draft = await loadPayrollDraft(prisma, payMonth);
    return { ...draft.input, ...overrides };
  }

  /** Lines of a posted entry as `[side, 2300〔源泉所得税〕, amount, tax]`. */
  async function postedLines(entryId: string): Promise<LineRow[]> {
    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entryId },
      orderBy: { lineNo: "asc" },
      include: { account: true, subAccount: true },
    });
    return lines.map((line) => [
      line.side,
      line.subAccount ? `${line.account.code}〔${line.subAccount.name}〕` : line.account.code,
      line.amount,
      line.taxAmount,
    ]);
  }

  /** Balance (credit − debit) of a sub-account over every entry. */
  async function subBalance(accountCode: string, name: string): Promise<bigint> {
    const sub = await prisma.subAccount.findFirst({
      where: { name, account: { code: accountCode } },
    });
    if (!sub) return 0n;
    const lines = await prisma.journalLine.findMany({ where: { subAccountId: sub.id } });
    return lines.reduce(
      (sum, line) => sum + (line.side === "credit" ? line.amount : -line.amount),
      0n,
    );
  }

  /** §5.5: each 預り金 / 未払費用 balance equals the open scheduled amounts of its category. */
  async function expectBalancesMatchSchedule(): Promise<void> {
    const open = (await listPayrollSchedule(prisma)).filter((row) => row.completedAt === null);
    const sum = (rows: typeof open, pick: (row: (typeof open)[number]) => bigint) =>
      rows.reduce((total, row) => total + pick(row), 0n);
    const of = (category: string) => open.filter((row) => row.category === category);
    expect(await subBalance("2300", "源泉所得税")).toBe(
      sum(of("withholding"), (row) => row.withheld),
    );
    expect(await subBalance("2300", "住民税")).toBe(sum(of("resident_tax"), (row) => row.withheld));
    expect(await subBalance("2300", "社会保険料")).toBe(
      sum(of("social_insurance"), (row) => row.withheld),
    );
    expect(await subBalance("2110", "社会保険料")).toBe(
      sum(of("social_insurance"), (row) => row.employer),
    );
  }

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    await payrollYear(prisma);
    ownerWallet = (await prisma.wallet.findFirstOrThrow({ where: { name: "役員立替" } })).id;
    // A run takes every active employee: only the two of this file.
    await deactivateAllEmployees(prisma);
    officerId = (await createEmployee(prisma, officerInput(), { actor })).employee.id;
    employeeId = (await createEmployee(prisma, employeeInput(), { actor })).employee.id;

    // 2026 年 9 月支給 (翌月控除: 8 月分の社会保険料), 未払金〔給与〕.
    const input1 = await draftInput("2026-09");
    preview1 = await previewPayrollRun(prisma, input1);
    run1 = await confirmPayrollRun(
      prisma,
      { ...input1, tableIds: preview1.tableIds, expected: preview1.expected },
      { actor },
    );

    // 2026 年 10 月支給: 役員立替 から、源泉の納期の特例、花子さんに調整.
    const input2 = await draftInput("2026-10", {
      paymentDate: "2026-10-23",
      payFromWalletId: ownerWallet,
      withholdingSpecialDue: true,
    });
    input2.items = input2.items.map((item) =>
      item.employeeId === employeeId
        ? {
            ...item,
            incomeTaxAdjustment: -200n,
            socialInsuranceAdjustment: 100n,
            adjustmentNote: "9 月分の誤りの訂正",
          }
        : item,
    );
    preview2 = await previewPayrollRun(prisma, input2);
    run2 = await confirmPayrollRun(
      prisma,
      { ...input2, tableIds: preview2.tableIds, expected: preview2.expected },
      { actor },
    );
  });

  afterAll(async () => {
    const year = await payrollYear(prisma);
    const entries = await prisma.journalEntry.findMany({
      where: { fiscalYearId: year.id, status: "posted", reversalOfId: null },
      orderBy: { no: "asc" },
    });
    for (const entry of entries) {
      await voidJournalEntry(prisma, entry.id, { actor, reason: "給与のテストの後片付け" });
    }
    // The deadlines of these test runs are in the past: close them so that other tests (the home's
    // 「やること」) do not see them as overdue.
    await prisma.calendarItem.updateMany({
      where: { ruleKey: { startsWith: "payroll." }, completedAt: null },
      data: { completedAt: new Date(), completedBy: actor },
    });
  });

  it("starts from the employees' monthly amounts and the previous run's settings", async () => {
    const draft = await loadPayrollDraft(prisma, "2026-11");
    expect(draft.confirmedRunId).toBeNull();
    expect(draft.premiumMonth).toBe("2026-10");
    expect(draft.premiumTimingLocked).toBe(true);
    expect(draft.input).toMatchObject({
      paymentDate: "2026-11-23",
      premiumTiming: "next_month",
      payFromWalletId: ownerWallet,
      withholdingSpecialDue: true,
      residentTaxSpecialDue: false,
    });
    expect(draft.input.items).toEqual([
      expect.objectContaining({ employeeId: officerId, taxablePay: 300_000n, residentTax: 0n }),
      expect.objectContaining({ employeeId, taxablePay: 250_000n, commuteAllowance: 10_000n }),
    ]);
    expect(draft.employees.map((row) => row.coverage)).toEqual([
      { health: true, care: false, pension: true, employment: false },
      { health: true, care: false, pension: true, employment: true },
    ]);
    expect((await loadPayrollDraft(prisma, "2026-09")).confirmedRunId).toBe(run1.id);
  });

  it("confirms what the preview showed", async () => {
    expect(run1.items).toEqual(preview1.items);
    expect(run1.totals).toEqual(preview1.totals);
    expect(run1.tableIds).toEqual(preview1.tableIds);
    const byRuleKey = <T extends { ruleKey: string }>(rows: readonly T[]) =>
      [...rows].sort((a, b) => (a.ruleKey < b.ruleKey ? -1 : 1));
    expect(byRuleKey(run1.schedule).map((row) => [row.ruleKey, row.dueDate, row.amount])).toEqual(
      byRuleKey(preview1.schedule).map((row) => [row.ruleKey, row.dueDate, row.scheduledTotal]),
    );
    const previewRows = (lines: PayrollPreview["entries"]["pay"]["lines"]): LineRow[] =>
      lines.map((line) => [
        line.side,
        line.subAccountName && !line.walletName
          ? `${line.accountCode}〔${line.subAccountName}〕`
          : line.walletName
            ? `${line.accountCode}〔${line.walletName}〕`
            : line.accountCode,
        line.amount,
        line.taxAmount,
      ]);
    for (const [run, preview] of [
      [run1, preview1],
      [run2, preview2],
    ] as const) {
      expect(await postedLines(run.payEntry?.id ?? "")).toEqual(
        previewRows(preview.entries.pay.lines),
      );
      expect(await postedLines(run.employerEntry?.id ?? "")).toEqual(
        previewRows(preview.entries.employer?.lines ?? []),
      );
    }
  });

  it("§8.4: the officer and the employee, 2 balanced entries with the expected amounts", async () => {
    const [officer, employee] = run1.items;
    expect(officer?.result).toMatchObject({
      grossPay: 300_000n,
      socialInsuranceEmployeeTotal: 42_675n,
      withholdingBase: 257_325n,
      incomeTax: 6_430n,
      netPay: 250_895n,
    });
    expect(employee?.result).toMatchObject({
      grossPay: 260_000n,
      socialInsuranceEmployeeTotal: 36_985n,
      withholdingBase: 211_715n,
      incomeTax: 4_770n,
      residentTax: 10_000n,
      netPay: 206_945n,
    });
    expect(employee?.result.employmentInsurance?.employee).toBe(1_300n);

    const pay = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: run1.payEntry?.id ?? "" },
    });
    expect(pay).toMatchObject({
      description: "給与 2026 年 9 月支給",
      sourceKind: "payroll",
      sourceId: run1.id,
      kind: "normal",
    });
    expect(pay.entryDate.toISOString().slice(0, 10)).toBe("2026-09-25");
    // 税抜経理: 通勤手当 10,000 円 = 旅費交通費 9,091 円 + 仮払消費税 909 円.
    expect(await postedLines(pay.id)).toEqual([
      ["debit", "5200", 300_000n, 0n],
      ["debit", "5210", 250_000n, 0n],
      ["debit", "5360", 9_091n, 909n],
      ["debit", "1400", 909n, 0n],
      ["credit", "2300〔源泉所得税〕", 11_200n, 0n],
      ["credit", "2300〔住民税〕", 10_000n, 0n],
      ["credit", "2300〔社会保険料〕", 79_660n, 0n],
      ["credit", "2300〔雇用保険料〕", 1_300n, 0n],
      ["credit", "2100〔給与〕", 457_840n, 0n],
    ]);
    const segments = await prisma.journalLine.findMany({
      where: { journalEntryId: pay.id, account: { kind: "expense" } },
    });
    expect(new Set(segments.map((line) => line.segmentId))).toEqual(
      new Set([refs.segment("corporate")]),
    );

    const employer = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: run1.employerEntry?.id ?? "" },
    });
    expect(employer.description).toBe("法定福利費 2026 年 8 月分");
    expect(await postedLines(employer.id)).toEqual([
      ["debit", "5220", 81_676n, 0n],
      ["credit", "2110〔社会保険料〕", 81_676n, 0n],
    ]);

    // 10 月: the adjustments (社会保険料 +100 → 対象額 211,615 円, 源泉 −200) and the wallet line.
    const adjusted = run2.items.find((item) => item.employeeId === employeeId);
    expect(adjusted?.result).toMatchObject({
      socialInsuranceEmployeeTotal: 37_085n,
      withholdingBase: 211_615n,
      incomeTax: 4_770n,
      incomeTaxTotal: 4_570n,
      netPay: 207_045n,
    });
    expect(adjusted?.adjustmentNote).toBe("9 月分の誤りの訂正");
    expect((await postedLines(run2.payEntry?.id ?? "")).slice(4)).toEqual([
      ["credit", "2300〔源泉所得税〕", 6_430n + 4_570n, 0n],
      ["credit", "2300〔住民税〕", 10_000n, 0n],
      ["credit", "2300〔社会保険料〕", 42_675n + 37_085n, 0n],
      ["credit", "2300〔雇用保険料〕", 1_300n, 0n],
      ["credit", "2400〔役員立替〕", 250_895n + 207_045n, 0n],
    ]);
    expect(run2.payFromWallet).toEqual({ id: ownerWallet, name: "役員立替" });
  });

  it("records the run, its sub-accounts and its deadlines with the audit log", async () => {
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "payroll_run.confirm", entityId: run1.id },
    });
    expect(audit.actor).toBe(actor);
    expect(audit.after).toMatchObject({
      payMonth: "2026-09",
      premiumMonth: "2026-08",
      payEntryId: run1.payEntry?.id,
      employerEntryId: run1.employerEntry?.id,
    });
    for (const [code, name] of [
      ["2300", "源泉所得税"],
      ["2300", "住民税"],
      ["2300", "社会保険料"],
      ["2300", "雇用保険料"],
      ["2100", "給与"],
      ["2110", "社会保険料"],
    ] as const) {
      const sub = await prisma.subAccount.findFirstOrThrow({
        where: { name, account: { code } },
      });
      expect(
        await prisma.auditLog.count({ where: { action: "sub_account.create", entityId: sub.id } }),
      ).toBe(1);
    }
    const schedule = await listPayrollSchedule(prisma);
    const byKey = new Map(schedule.map((row) => [row.ruleKey, row]));
    expect(byKey.get("payroll.social_insurance.2026-08")).toMatchObject({
      title: "社会保険料の納付（2026 年 8 月分）",
      dueDate: "2026-09-30",
      amount: 79_660n + 81_676n,
    });
    expect(byKey.get("payroll.withholding.2026-09")).toMatchObject({
      dueDate: "2026-10-10",
      amount: 11_200n,
    });
    expect(byKey.get("payroll.withholding.2026-H2")).toMatchObject({
      title: "源泉所得税の納付（2026 年 7〜12 月支給分・納期の特例）",
      dueDate: "2027-01-20",
      amount: 11_000n,
    });
    expect(byKey.get("payroll.resident_tax.2026-10")).toMatchObject({
      dueDate: "2026-11-10",
      amount: 10_000n,
    });
    expect(byKey.get("payroll.social_insurance.2026-09")?.dueDate).toBe("2026-10-31");
    // The payments (the 賞与支払届 of a bonus run is a filing, payroll-bonus.db.test.ts).
    const items = await prisma.calendarItem.findMany({
      where: {
        ruleKey: { startsWith: "payroll." },
        NOT: { ruleKey: { startsWith: "payroll.bonus_report." } },
      },
    });
    expect(items.every((item) => item.kind === "payment" && item.fiscalYearId === null)).toBe(true);

    // This file's runs (payroll-bonus.db.test.ts confirms a run of its own month).
    const runs = (await listPayrollRuns(prisma)).filter((row) =>
      ["2026-09", "2026-10"].includes(row.payMonth),
    );
    expect(runs.map((row) => [row.payMonth, row.totals.headcount, row.totals.netPay])).toEqual([
      ["2026-10", 2, 250_895n + 207_045n],
      ["2026-09", 2, 457_840n],
    ]);
    expect(runs[1]?.payEntry?.id).toBe(run1.payEntry?.id);
    expect(await getPayrollRun(prisma, "missing")).toBeNull();
  });

  it("keeps 預り金 and 未払費用〔社会保険料〕 equal to the open schedule", async () => {
    await expectBalancesMatchSchedule();
  });

  it("recalculates every stored run identically with its stored table ids", async () => {
    const rows = await prisma.payrollRun.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const tables = pinnedTables(parsePayrollTableIds(row.tableIds));
      const run = {
        paymentDate: row.paymentDate.toISOString().slice(0, 10) as `${number}-${number}-${number}`,
        premiumMonth: row.premiumMonth as YearMonth,
      };
      const again = parsePayrollRunItems(row.items).map((item) => ({
        ...item,
        result: calculatePayroll(payrollInputOf(run, item, tables)),
      }));
      expect(serializePayrollRunItems(again)).toEqual(row.items);
    }
  });

  it("gives the payslip of a person of a run", async () => {
    const payslip = await loadPayslip(prisma, run2.id, employeeId);
    expect(payslip).toMatchObject({
      companyName: "架空商会株式会社",
      payMonth: "2026-10",
      paymentDate: "2026-10-23",
      employee: { id: employeeId, name: "テスト 花子", kind: "employee" },
      pay: { taxablePay: 250_000n, commuteAllowance: 10_000n, grossPay: 260_000n },
      deductions: {
        health: 13_195n,
        pension: 23_790n,
        employmentInsurance: 1_300n,
        incomeTax: 4_770n,
        residentTax: 10_000n,
        adjustments: { incomeTax: -200n, socialInsurance: 100n },
        total: 52_955n,
      },
      netPay: 207_045n,
      reference: { healthSmr: 260_000n, pensionSmr: 260_000n, premiumMonth: "2026-09" },
    });
    expect(await loadPayslip(prisma, run2.id, "missing")).toBeNull();
  });

  it("posts payments, completes the deadlines and keeps the balances in line", async () => {
    const schedule = await listPayrollSchedule(prisma);
    const find = (ruleKey: string) => {
      const row = schedule.find((item) => item.ruleKey === ruleKey);
      if (!row) throw new Error(`no ${ruleKey}`);
      return row;
    };

    // 社会保険料 2026 年 8 月分: the notice is 1 円 more; the difference goes to 法定福利費.
    const social = find("payroll.social_insurance.2026-08");
    const withheldBefore = await subBalance("2300", "社会保険料");
    const employerBefore = await subBalance("2110", "社会保険料");
    const paymentInput = {
      calendarItemId: social.id,
      walletId: ownerWallet,
      paymentDate: "2026-09-30",
      amount: (social.amount + 1n).toString(),
    };
    const shown = await previewPayrollPayment(prisma, paymentInput);
    expect(shown.difference).toBe(1n);
    const paid = await postPayrollPayment(prisma, paymentInput, { actor });
    expect(paid.item.completedAt).not.toBeNull();
    expect(paid.item.paymentEntry?.id).toBe(paid.entry.id);
    expect(await postedLines(paid.entry.id)).toEqual([
      ["debit", "2300〔社会保険料〕", 79_660n, 0n],
      ["debit", "2110〔社会保険料〕", 81_676n, 0n],
      ["debit", "5220", 1n, 0n],
      ["credit", "2400〔役員立替〕", 161_337n, 0n],
    ]);
    expect(await postedLines(paid.entry.id)).toEqual(
      shown.entry.lines.map((line) => [
        line.side,
        line.walletName
          ? `${line.accountCode}〔${line.walletName}〕`
          : line.subAccountName
            ? `${line.accountCode}〔${line.subAccountName}〕`
            : line.accountCode,
        line.amount,
        line.taxAmount,
      ]),
    );
    expect(await subBalance("2300", "社会保険料")).toBe(withheldBefore - 79_660n);
    expect(await subBalance("2110", "社会保険料")).toBe(employerBefore - 81_676n);
    expect(
      await prisma.auditLog.count({
        where: { action: "payroll_payment.post", entityId: social.id },
      }),
    ).toBe(1);
    const again = await rejectionOf(postPayrollPayment(prisma, paymentInput, { actor }));
    expect(again).toBeInstanceOf(SettingsError);
    expect((again as SettingsError).message).toMatch(/納付済み/);

    // 源泉所得税: only at the scheduled amount.
    const withholding = find("payroll.withholding.2026-09");
    const wrong = await rejectionOf(
      postPayrollPayment(
        prisma,
        {
          calendarItemId: withholding.id,
          walletId: ownerWallet,
          paymentDate: "2026-10-09",
          amount: "11,000",
        },
        { actor },
      ),
    );
    expect((wrong as SettingsError).field).toBe("amount");
    await postPayrollPayment(
      prisma,
      { calendarItemId: withholding.id, walletId: ownerWallet, paymentDate: "2026-10-09" },
      { actor },
    );

    // 住民税 registered from the statement (S5) as a 伝票, then 納付済みにする only.
    const resident = find("payroll.resident_tax.2026-09");
    const residentSub = await prisma.subAccount.findFirstOrThrow({
      where: { name: "住民税", account: { code: "2300" } },
    });
    const ownerSub = await prisma.wallet.findUniqueOrThrow({ where: { id: ownerWallet } });
    await postVoucherEntry(
      prisma,
      {
        kind: "normal",
        entryDate: "2026-10-09",
        description: "住民税の納付（明細から）",
        partnerId: "",
        lines: [
          {
            side: "debit",
            accountId: refs.account("2300"),
            subAccountId: residentSub.id,
            amount: "10000",
            taxCategoryCode: "na",
            segmentId: "",
            partnerId: "",
            description: "",
          },
          {
            side: "credit",
            accountId: ownerSub.accountId,
            subAccountId: ownerSub.subAccountId,
            amount: "10000",
            taxCategoryCode: "na",
            segmentId: "",
            partnerId: "",
            description: "",
          },
        ],
      },
      { actor },
    );
    const done = await markPayrollPaymentDone(prisma, resident.id, { actor });
    expect(done.completedAt).not.toBeNull();
    expect(done.paymentEntry).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { action: "calendar_item.complete", entityId: resident.id },
      }),
    ).toBe(1);
    expect(
      await rejectionOf(markPayrollPaymentDone(prisma, resident.id, { actor })),
    ).toBeInstanceOf(SettingsError);

    await expectBalancesMatchSchedule();
  });

  it("rejects UPDATE, DELETE and TRUNCATE of a confirmed run", async () => {
    await expect(
      prisma.$executeRaw`UPDATE "payroll_run" SET "confirmed_by" = 'someone' WHERE "id" = ${run1.id}`,
    ).rejects.toThrow(/ledger guard: payroll_run is append-only \(UPDATE/);
    await expect(prisma.payrollRun.delete({ where: { id: run1.id } })).rejects.toThrow(
      /append-only/,
    );
    // payroll_year_end references payroll_run, so PostgreSQL may refuse the TRUNCATE for the foreign
    // key before the guard trigger runs; either way the table cannot be emptied.
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "payroll_run"`)).rejects.toThrow(
      /ledger guard: TRUNCATE on payroll_run is not allowed|cannot truncate a table referenced in a foreign key constraint/,
    );
    expect(await prisma.payrollRun.findUnique({ where: { id: run1.id } })).not.toBeNull();
  });

  it("checks the months of a run in the database too", async () => {
    class Rollback extends Error {}
    const row = (overrides: Record<string, unknown>) => ({
      id: `run_check_${Date.now()}_${Math.random()}`,
      payMonth: "2027-01",
      paymentDate: new Date("2027-01-25T00:00:00Z"),
      premiumTiming: "next_month" as const,
      premiumMonth: "2026-12",
      withholdingSpecialDue: false,
      residentTaxSpecialDue: false,
      tableIds: {},
      items: [],
      payEntryId: "none",
      confirmedBy: actor,
      ...overrides,
    });
    // A valid January row (翌月控除 → 前年 12 月分) passes the checks; it is rolled back.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.payrollRun.create({ data: row({}) });
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    await expect(
      prisma.payrollRun.create({ data: row({ premiumMonth: "2027-01" }) }),
    ).rejects.toThrow(/payroll_run_premium_month_of_timing/);
    await expect(
      prisma.payrollRun.create({ data: row({ paymentDate: new Date("2027-02-01T00:00:00Z") }) }),
    ).rejects.toThrow(/payroll_run_pay_month_of_payment_date/);
  });

  it("rejects a second run of a pay month and a second deduction of a premium month", async () => {
    const duplicate = await rejectionOf(
      confirmPayrollRun(prisma, await draftInput("2026-09"), { actor }),
    );
    expect(duplicate).toBeInstanceOf(SettingsError);
    expect((duplicate as SettingsError).field).toBe("payMonth");
    expect((duplicate as SettingsError).message).toMatch(/2026 年 9 月の支給は確定済みです/);

    // 当月控除 for August would deduct the August premiums again (deducted in September).
    const premium = await rejectionOf(
      previewPayrollRun(
        prisma,
        await draftInput("2026-08", { paymentDate: "2026-08-25", premiumTiming: "same_month" }),
      ),
    );
    expect((premium as SettingsError).field).toBe("premiumTiming");
    expect((premium as SettingsError).message).toMatch(
      /2026 年 8 月分の社会保険料は 2026 年 9 月の支給で控除済みです/,
    );

    // The timing is fixed by the first run.
    const timing = await rejectionOf(
      confirmPayrollRun(
        prisma,
        await draftInput("2026-07", { paymentDate: "2026-07-24", premiumTiming: "same_month" }),
        { actor },
      ),
    );
    expect((timing as SettingsError).field).toBe("premiumTiming");
    expect((timing as SettingsError).message).toMatch(/翌月控除/);
  });

  it("rejects a closed date without writing anything", async () => {
    const before = await prisma.payrollRun.count();
    const input = await draftInput("2026-05", { paymentDate: "2026-05-25" });
    expect(ledgerCodes(await rejectionOf(previewPayrollRun(prisma, input)))).toEqual([
      { code: "PERIOD_LOCKED", field: "paymentDate" },
    ]);
    const error = await rejectionOf(confirmPayrollRun(prisma, input, { actor }));
    expect(ledgerCodes(error)).toEqual([{ code: "PERIOD_LOCKED", field: "paymentDate" }]);
    expect((error as LedgerValidationError).message).toMatch(/2026\/05\/31 までは締めています/);
    expect(await prisma.payrollRun.count()).toBe(before);
    expect(
      await prisma.calendarItem.count({ where: { ruleKey: "payroll.withholding.2026-05" } }),
    ).toBe(0);
  });

  it("rejects a month whose tables are not registered", async () => {
    const input = await draftInput("2027-04", { paymentDate: "2027-04-24" });
    for (const attempt of [
      previewPayrollRun(prisma, input),
      confirmPayrollRun(prisma, input, { actor }),
    ]) {
      const error = await rejectionOf(attempt);
      expect(error).toBeInstanceOf(PayrollTableMissingError);
      expect((error as PayrollTableMissingError).tableKind).toBe("kyokai-kenpo");
      expect((error as PayrollTableMissingError).message).toMatch(/2027 年 3 月分の協会けんぽ/);
    }
  });

  it("rejects stale input: other totals, missing or unknown employees, a note-less adjustment", async () => {
    const input = await draftInput("2026-07", { paymentDate: "2026-07-24" });
    const shown = await previewPayrollRun(prisma, input);
    const stale = await rejectionOf(
      confirmPayrollRun(
        prisma,
        {
          ...input,
          tableIds: shown.tableIds,
          expected: { ...shown.expected, netPay: shown.expected.netPay + 1n },
        },
        { actor },
      ),
    );
    expect(stale).toBeInstanceOf(SettingsError);
    expect((stale as SettingsError).message).toMatch(/計算の結果が確認した内容と変わりました/);

    const missing = await rejectionOf(
      previewPayrollRun(prisma, { ...input, items: input.items.slice(0, 1) }),
    );
    expect((missing as SettingsError).message).toMatch(/テスト 花子」の入力がありません/);

    const unknown = await rejectionOf(
      previewPayrollRun(prisma, {
        ...input,
        items: [...input.items, { ...input.items[0]!, employeeId: "emp_unknown" }],
      }),
    );
    expect((unknown as SettingsError).field).toBe("items.2.employeeId");

    const noNote = await rejectionOf(
      previewPayrollRun(prisma, {
        ...input,
        items: input.items.map((item) => ({ ...item, incomeTaxAdjustment: 100n })),
      }),
    );
    expect(zodPaths(noNote)).toEqual(["items.0.adjustmentNote", "items.1.adjustmentNote"]);

    const wrongTable = await rejectionOf(
      previewPayrollRun(prisma, {
        ...input,
        tableIds: { ...shown.tableIds, kenpo: "kyokai-kenpo-kanagawa-1999" },
      }),
    );
    expect(wrongTable).toBeInstanceOf(SettingsError);
    // The 令和 8 年分 table seen for July is not the one of a January 2027 payment.
    const nextYear = await rejectionOf(
      previewPayrollRun(prisma, {
        ...(await draftInput("2027-01", { paymentDate: "2027-01-25" })),
        tableIds: shown.tableIds,
      }),
    );
    expect((nextYear as SettingsError).message).toMatch(/表の版（.*令和8年分.*）が変わります/);

    const month = await rejectionOf(
      previewPayrollRun(prisma, { ...input, paymentDate: "2026-08-01" }),
    );
    expect((month as SettingsError).field).toBe("paymentDate");
    expect(await prisma.payrollRun.count({ where: { payMonth: "2026-07" } })).toBe(0);
  });
});
