/**
 * 賞与 (22-payroll §10): a monthly run, then a bonus in the next month for a fictional officer (with
 * the 事前確定届出給与 filing) and an employee; the preview is what the confirmation posts, the 2
 * entries balance, 預り金 and 未払費用 stay equal to the open schedule with the bonus in it, the
 * health cap carries across two bonuses of one 年度, and the run is append-only. Every name and
 * amount is fictional.
 *
 * The runs post into 第 220 期 (2026-04-01〜2026-11-01, closed through 2026-05-31), the year of
 * payroll.db.test.ts, on months that file does not use (monthly 2026-06, bonuses 2026-07 and
 * 2026-11), so the two files share no deadline whatever their order. Entries are voided and the
 * deadlines completed at the end, as payroll.db.test.ts does, so other files are unaffected.
 */
import {
  bonusInputOf,
  calculateBonus,
  parseBonusRunItems,
  parseBonusTableIds,
  pinnedBonusTables,
  serializeBonusRunItems,
} from "@niho-finance/payroll";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  completeCalendarItem,
  confirmBonusRun,
  confirmPayrollRun,
  createEmployee,
  getBonusRun,
  listBonusRuns,
  listCalendarItems,
  listEmployees,
  listPayrollSchedule,
  loadBonusDraft,
  loadBonusPayslip,
  loadPayrollDraft,
  previewBonusRun,
  previewPayrollRun,
  setEmployeeActive,
  SettingsError,
  voidJournalEntry,
  type BonusPreview,
  type BonusRunDetail,
  type BonusRunValues,
  type EmployeeCreateInput,
  type PayrollRunDetail,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear } from "./support/refs";

const actor = "tester@example.com";

/** 第 220 期 (shared with payroll.db.test.ts; whichever file runs first creates it). */
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

const officerInput: EmployeeCreateInput = {
  name: "賞与 一郎",
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
};

const employeeInput: EmployeeCreateInput = {
  name: "賞与 二子",
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
};

type LineRow = [side: string, account: string, amount: bigint];

describe.skipIf(!hasTestDatabase)("bonus runs (賞与の計算と確定)", () => {
  let prisma: PrismaClient;
  let ownerWallet: string;
  let officerId: string;
  let employeeId: string;
  let monthly: PayrollRunDetail;
  let preview1: BonusPreview;
  let bonus1: BonusRunDetail;
  let bonus2: BonusRunDetail;

  /** The draft of `payMonth` with the amounts of each person. */
  async function bonusInput(
    payMonth: string,
    amounts: Record<string, Partial<BonusRunValues["items"][number]>>,
    overrides: Partial<BonusRunValues> = {},
  ): Promise<BonusRunValues> {
    const draft = await loadBonusDraft(prisma, payMonth);
    return {
      ...draft.input,
      // payroll.db.test.ts's runs use 納期の特例 (2026-H2): this file keeps clear of it.
      withholdingSpecialDue: false,
      payFromWalletId: null,
      ...overrides,
      items: draft.input.items.map((item) => ({ ...item, ...amounts[item.employeeId] })),
    };
  }

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
    ]);
  }

  const previewRows = (lines: BonusPreview["entries"]["pay"]["lines"]): LineRow[] =>
    lines.map((line) => [
      line.side,
      line.walletName
        ? `${line.accountCode}〔${line.walletName}〕`
        : line.subAccountName
          ? `${line.accountCode}〔${line.subAccountName}〕`
          : line.accountCode,
      line.amount,
    ]);

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

  /** §5.5 with the bonuses: each 預り金 / 未払費用 balance equals its open scheduled amounts. */
  async function expectBalancesMatchSchedule(): Promise<void> {
    const open = (await listPayrollSchedule(prisma)).filter((row) => row.completedAt === null);
    const sum = (category: string, pick: (row: (typeof open)[number]) => bigint) =>
      open.filter((row) => row.category === category).reduce((total, row) => total + pick(row), 0n);
    expect(await subBalance("2300", "源泉所得税")).toBe(sum("withholding", (row) => row.withheld));
    expect(await subBalance("2300", "住民税")).toBe(sum("resident_tax", (row) => row.withheld));
    expect(await subBalance("2300", "社会保険料")).toBe(
      sum("social_insurance", (row) => row.withheld),
    );
    expect(await subBalance("2110", "社会保険料")).toBe(
      sum("social_insurance", (row) => row.employer),
    );
    // 雇用保険料 has no deadline here (年度更新): the balance is what this file's runs withheld
    // (the other files void their entries).
    const withheld = [monthly, bonus1, bonus2].reduce(
      (total, run) => total + run.totals.employmentInsuranceEmployee,
      0n,
    );
    expect(await subBalance("2300", "雇用保険料")).toBe(withheld);
  }

  beforeAll(async () => {
    prisma = testPrisma();
    await payrollYear(prisma);
    ownerWallet = (await prisma.wallet.findFirstOrThrow({ where: { name: "役員立替" } })).id;
    // A run takes every active employee: only the two of this file.
    for (const employee of await listEmployees(prisma)) {
      if (employee.isActive) {
        await setEmployeeActive(prisma, { id: employee.id, isActive: false }, { actor });
      }
    }
    officerId = (await createEmployee(prisma, officerInput, { actor })).employee.id;
    employeeId = (await createEmployee(prisma, employeeInput, { actor })).employee.id;

    // 2026 年 6 月支給 (翌月控除: 5 月分).
    const draft = await loadPayrollDraft(prisma, "2026-06");
    const input = {
      ...draft.input,
      paymentDate: "2026-06-25",
      payFromWalletId: null,
      withholdingSpecialDue: false,
      residentTaxSpecialDue: false,
    };
    const shown = await previewPayrollRun(prisma, input);
    monthly = await confirmPayrollRun(
      prisma,
      { ...input, tableIds: shown.tableIds, expected: shown.expected },
      { actor },
    );

    // 2026 年 7 月の夏季賞与: the officer as filed, the employee.
    const input1 = await bonusInput(
      "2026-07",
      {
        [officerId]: { bonus: 4_000_000n, filingDate: "2026-07-10", filingAmount: 4_000_000n },
        [employeeId]: { bonus: 600_000n },
      },
      { paymentDate: "2026-07-10", title: "夏季賞与" },
    );
    preview1 = await previewBonusRun(prisma, input1);
    bonus1 = await confirmBonusRun(
      prisma,
      { ...input1, tableIds: preview1.tableIds, expected: preview1.expected },
      { actor },
    );

    // 2026 年 11 月の冬季賞与 (same 年度): the officer only, 1,500,000 円 filed, 2,000,000 円 paid.
    const input2 = await bonusInput(
      "2026-11",
      {
        [officerId]: { bonus: 2_000_000n, filingDate: "2026-11-01", filingAmount: 1_500_000n },
        [employeeId]: { bonus: 0n },
      },
      { paymentDate: "2026-11-01", title: "冬季賞与", payFromWalletId: ownerWallet },
    );
    const preview2 = await previewBonusRun(prisma, input2);
    bonus2 = await confirmBonusRun(
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
      await voidJournalEntry(prisma, entry.id, { actor, reason: "賞与のテストの後片付け" });
    }
    await prisma.calendarItem.updateMany({
      where: { ruleKey: { startsWith: "payroll." }, completedAt: null },
      data: { completedAt: new Date(), completedBy: actor },
    });
  });

  it("starts from the previous month's run and leaves the filing empty", async () => {
    const draft = await loadBonusDraft(prisma, "2026-07");
    expect(draft.confirmedRunId).toBe(bonus1.id);
    expect(draft.previousPayMonth).toBe("2026-06");
    expect(draft.previousRunId).toBe(monthly.id);
    expect(draft.input).toMatchObject({ title: "夏季賞与", calcPeriodOver6Months: false });
    // 前月の給与 = 課税支給 − 社会保険料等 of the June run, and its table tax (§8.4 の金額).
    expect(draft.input.items).toEqual([
      {
        employeeId: officerId,
        bonus: 0n,
        previousMonthPay: 257_325n,
        previousMonthTax: 6_430n,
        filingDate: null,
        filingAmount: null,
      },
      {
        employeeId,
        bonus: 0n,
        previousMonthPay: 211_715n,
        previousMonthTax: 4_770n,
        filingDate: null,
        filingAmount: null,
      },
    ]);
    const december = await loadBonusDraft(prisma, "2026-12");
    expect(december.input.title).toBe("冬季賞与");
    expect(december.confirmedRunId).toBeNull();
  });

  it("confirms what the preview showed, with 2 balanced entries", async () => {
    expect(bonus1.items).toEqual(preview1.items);
    expect(bonus1.totals).toEqual(preview1.totals);
    expect(bonus1.tableIds).toEqual(preview1.tableIds);
    expect(bonus1.warnings).toEqual([]);
    expect(await postedLines(bonus1.payEntry?.id ?? "")).toEqual(
      previewRows(preview1.entries.pay.lines),
    );
    expect(await postedLines(bonus1.employerEntry?.id ?? "")).toEqual(
      previewRows(preview1.entries.employer?.lines ?? []),
    );

    const [officer, employee] = bonus1.items;
    // 健保 4,000,000 × 10.15% ÷ 2; 厚年 150 万円 × 18.3% ÷ 2; the 10-times exception.
    expect(officer?.result).toMatchObject({
      standardBonus: { amount: 4_000_000n, health: 4_000_000n, pension: 1_500_000n },
      withholdingBase: 4_000_000n - 203_000n - 137_250n,
      withholding: { method: "monthly_10x", divisor: 6, previousMonthTax: 6_430n },
    });
    expect(officer?.result.socialInsurance.health.employee).toBe(203_000n);
    expect(officer?.result.socialInsurance.pension.employee).toBe(137_250n);
    // 600,000: 健保 30,450・厚年 54,900・雇用 3,000, 4.084% of 511,650 = 20,895.
    expect(employee?.result).toMatchObject({
      withholdingBase: 511_650n,
      withholding: { method: "rate", ratePercent: "4.084" },
      incomeTax: 20_895n,
      netPay: 490_755n,
    });
    const officerTax = officer?.result.incomeTax ?? 0n;
    const officerNet = officer?.result.netPay ?? 0n;

    const pay = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: bonus1.payEntry?.id ?? "" },
    });
    expect(pay).toMatchObject({
      description: "夏季賞与 2026 年 7 月支給",
      sourceKind: "payroll",
      sourceId: bonus1.id,
      kind: "normal",
    });
    expect(pay.entryDate.toISOString().slice(0, 10)).toBe("2026-07-10");
    const lines = await postedLines(pay.id);
    expect(lines).toEqual([
      ["debit", "5200〔賞与〕", 4_000_000n],
      ["debit", "5210〔賞与〕", 600_000n],
      ["credit", "2300〔源泉所得税〕", officerTax + 20_895n],
      ["credit", "2300〔社会保険料〕", 340_250n + 85_350n],
      ["credit", "2300〔雇用保険料〕", 3_000n],
      ["credit", "2100〔給与〕", officerNet + 490_755n],
    ]);
    const side = (rows: LineRow[], which: string) =>
      rows.filter((row) => row[0] === which).reduce((total, row) => total + row[2], 0n);
    expect(side(lines, "debit")).toBe(side(lines, "credit"));
    // 健保 466,900 − 233,450, 厚年 384,300 − 192,150, 拠出金 2,100,000 × 0.36% = 7,560.
    expect(await postedLines(bonus1.employerEntry?.id ?? "")).toEqual([
      ["debit", "5220", 433_160n],
      ["credit", "2110〔社会保険料〕", 433_160n],
    ]);
    for (const code of ["5200", "5210"]) {
      const sub = await prisma.subAccount.findFirstOrThrow({
        where: { name: "賞与", account: { code } },
      });
      expect(
        await prisma.auditLog.count({ where: { action: "sub_account.create", entityId: sub.id } }),
      ).toBe(1);
    }
  });

  it("warns about an officer's bonus that differs from the filing, without stopping", async () => {
    // As filed: no warning (July). Not as filed: the run is still confirmed, with the warning.
    expect(bonus1.warnings).toEqual([]);
    expect(bonus2.warnings.map(({ employeeId: id, code }) => [id, code])).toEqual([
      [officerId, "FILING_AMOUNT_MISMATCH"],
    ]);
    expect(bonus2.warnings[0]?.message).toMatch(
      /賞与 一郎: 賞与の額 2,000,000 円が届け出た金額 1,500,000 円と違います/,
    );
    // Only a date entered, and not the payment date: both warnings in the preview.
    const shown = await previewBonusRun(
      prisma,
      await bonusInput(
        "2026-08",
        { [officerId]: { bonus: 100_000n, filingDate: "2026-08-11" } },
        { paymentDate: "2026-08-10" },
      ),
    );
    expect(shown.warnings.map((warning) => [warning.employeeId, warning.code])).toEqual([
      [officerId, "FILING_MISSING"],
      [officerId, "FILING_DATE_MISMATCH"],
    ]);
    expect(shown.items.map((item) => item.employeeId)).toEqual([officerId]);
  });

  it("caps 健康保険 across the bonuses of one 年度 and 厚生年金 by the month", async () => {
    const [officer] = bonus2.items;
    expect(bonus2.items).toHaveLength(1);
    // 573 万円 − 400 万円 (July) = 173 万円 left; 厚年 150 万円.
    expect(officer?.input.priorHealthStandardBonus).toBe(4_000_000n);
    expect(officer?.result.standardBonus).toEqual({
      amount: 2_000_000n,
      health: 1_730_000n,
      pension: 1_500_000n,
    });
    // 1,730,000 × 10.15% ÷ 2 = 87,797.5 → 87,797.
    expect(officer?.result.socialInsurance.health.employee).toBe(87_797n);
    // No monthly run of October for this officer: 前月の給与なし.
    expect(officer?.input.previousMonth).toBeNull();
    expect(officer?.result.withholding.method).toBe("monthly_no_prev");
    expect(bonus2.payFromWallet).toEqual({ id: ownerWallet, name: "役員立替" });
    expect((await postedLines(bonus2.payEntry?.id ?? "")).at(-1)).toEqual([
      "credit",
      "2400〔役員立替〕",
      officer?.result.netPay,
    ]);
  });

  it("adds the bonus to the payment schedule and files 被保険者賞与支払届", async () => {
    const schedule = await listPayrollSchedule(prisma);
    const byKey = new Map(schedule.map((row) => [row.ruleKey, row]));
    expect(byKey.get("payroll.withholding.2026-07")).toMatchObject({
      dueDate: "2026-08-10",
      amount: bonus1.totals.incomeTax,
      payMonths: [],
      bonusMonths: ["2026-07"],
    });
    expect(byKey.get("payroll.social_insurance.2026-07")).toMatchObject({
      dueDate: "2026-08-31",
      withheld: 425_600n,
      employer: 433_160n,
      bonusMonths: ["2026-07"],
    });
    expect(bonus1.schedule.map((row) => row.ruleKey).sort()).toEqual([
      "payroll.social_insurance.2026-07",
      "payroll.withholding.2026-07",
    ]);
    expect(preview1.schedule.map((row) => [row.ruleKey, row.amount])).toEqual([
      ["payroll.withholding.2026-07", bonus1.totals.incomeTax],
      ["payroll.social_insurance.2026-07", 425_600n + 433_160n],
    ]);

    expect(bonus1.filing).toMatchObject({
      title: "被保険者賞与支払届の提出（2026 年 7 月支給の賞与）",
      dueDate: "2026-07-15",
      completedAt: null,
    });
    const filing = await prisma.calendarItem.findUniqueOrThrow({
      where: { id: bonus1.filing?.id ?? "" },
    });
    expect(filing).toMatchObject({
      kind: "filing",
      fiscalYearId: null,
      ruleKey: "payroll.bonus_report.2026-07",
    });
    // A filing is completed on the calendar (a payment is completed on the payroll screen).
    const listed = (await listCalendarItems(prisma))
      .flatMap((group) => [...group.open, ...group.completed])
      .find((item) => item.id === filing.id);
    expect(listed?.managedBy).toBe("calendar");
    const done = await completeCalendarItem(prisma, filing.id, { actor });
    expect(done.completedAt).not.toBeNull();

    await expectBalancesMatchSchedule();
  });

  it("lists the bonuses, recalculates them identically and gives the payslips", async () => {
    const rows = await listBonusRuns(prisma);
    expect(rows.map((row) => [row.payMonth, row.title, row.totals.headcount])).toEqual([
      ["2026-11", "冬季賞与", 1],
      ["2026-07", "夏季賞与", 2],
    ]);
    expect(await getBonusRun(prisma, "missing")).toBeNull();

    for (const row of await prisma.payrollBonusRun.findMany()) {
      const tables = pinnedBonusTables(parseBonusTableIds(row.tableIds));
      const run = {
        paymentDate: row.paymentDate.toISOString().slice(0, 10) as `${number}-${number}-${number}`,
        calcPeriodOver6Months: row.calcPeriodOver6Months,
      };
      const again = parseBonusRunItems(row.items).map((item) => ({
        ...item,
        result: calculateBonus(bonusInputOf(run, item, tables)),
      }));
      expect(serializeBonusRunItems(again)).toEqual(row.items);
    }

    const payslip = await loadBonusPayslip(prisma, bonus1.id, employeeId);
    expect(payslip).toMatchObject({
      companyName: "架空商会株式会社",
      payMonth: "2026-07",
      paymentDate: "2026-07-10",
      title: "夏季賞与",
      employee: { id: employeeId, name: "賞与 二子", kind: "employee" },
      bonus: 600_000n,
      deductions: {
        health: 30_450n,
        pension: 54_900n,
        employmentInsurance: 3_000n,
        incomeTax: 20_895n,
        total: 109_245n,
      },
      netPay: 490_755n,
      reference: {
        standardBonus: 600_000n,
        healthStandardBonus: 600_000n,
        withholdingBase: 511_650n,
      },
    });
    expect(await loadBonusPayslip(prisma, bonus2.id, employeeId)).toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "payroll_bonus_run.confirm", entityId: bonus1.id },
    });
    expect(audit.after).toMatchObject({
      payMonth: "2026-07",
      title: "夏季賞与",
      payEntryId: bonus1.payEntry?.id,
      employerEntryId: bonus1.employerEntry?.id,
    });
  });

  it("rejects a second bonus of a month, a month of no bonus and a date of another month", async () => {
    const before = await prisma.payrollBonusRun.count();
    const duplicate = await rejectionOf(
      confirmBonusRun(
        prisma,
        await bonusInput(
          "2026-07",
          { [employeeId]: { bonus: 1_000n } },
          { paymentDate: "2026-07-20" },
        ),
        { actor },
      ),
    );
    expect(duplicate).toBeInstanceOf(SettingsError);
    expect((duplicate as SettingsError).field).toBe("payMonth");
    expect((duplicate as SettingsError).message).toMatch(/2026 年 7 月の賞与は確定済みです/);

    const nothing = await rejectionOf(
      previewBonusRun(prisma, await bonusInput("2026-08", {}, { paymentDate: "2026-08-10" })),
    );
    expect((nothing as SettingsError).message).toMatch(/賞与の額がすべて 0 円です/);

    const month = await rejectionOf(
      previewBonusRun(
        prisma,
        await bonusInput(
          "2026-08",
          { [employeeId]: { bonus: 1_000n } },
          { paymentDate: "2026-09-01" },
        ),
      ),
    );
    expect((month as SettingsError).field).toBe("paymentDate");

    const stale = await rejectionOf(
      confirmBonusRun(
        prisma,
        {
          ...(await bonusInput(
            "2026-08",
            { [employeeId]: { bonus: 1_000n } },
            { paymentDate: "2026-08-10" },
          )),
          expected: { grossPay: 1n, netPay: 1n, employerTotal: 0n },
        },
        { actor },
      ),
    );
    expect((stale as SettingsError).message).toMatch(/計算の結果が確認した内容と変わりました/);
    expect(await prisma.payrollBonusRun.count()).toBe(before);
  });

  it("rejects UPDATE, DELETE and TRUNCATE of a confirmed bonus run and checks its month", async () => {
    await expect(
      prisma.$executeRaw`UPDATE "payroll_bonus_run" SET "title" = 'x' WHERE "id" = ${bonus1.id}`,
    ).rejects.toThrow(/ledger guard: payroll_bonus_run is append-only \(UPDATE/);
    await expect(prisma.payrollBonusRun.delete({ where: { id: bonus1.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "payroll_bonus_run"`)).rejects.toThrow(
      /ledger guard: TRUNCATE on payroll_bonus_run is not allowed/,
    );
    await expect(
      prisma.payrollBonusRun.create({
        data: {
          id: `bonus_check_${Date.now()}`,
          payMonth: "2027-06",
          paymentDate: new Date("2027-07-01T00:00:00Z"),
          title: "賞与",
          calcPeriodOver6Months: false,
          withholdingSpecialDue: false,
          tableIds: {},
          items: [],
          payEntryId: "none",
          confirmedBy: actor,
        },
      }),
    ).rejects.toThrow(/payroll_bonus_run_pay_month_of_payment_date/);
    expect(await prisma.payrollBonusRun.findUnique({ where: { id: bonus1.id } })).not.toBeNull();
  });
});
