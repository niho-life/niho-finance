/**
 * 年末調整 (22-payroll §11): the declarations with their audit log, the totals of a fictional
 * officer's and employee's year from the confirmed monthly and bonus runs (by payment date), the
 * December run as the condition of 確定, the balanced settlement entries (不足 then 過納) with 預り金
 * 〔源泉所得税〕 equal to the open schedule after each, the second confirmation refused, 源泉徴収簿, and
 * payroll_year_end append-only. Every name and amount is fictional.
 *
 * Why every scenario runs in a transaction that is rolled back: a 2026 年末調整 needs the December
 * 2026 pay run, whose payment date falls in the seeded 第 1 期 (2026-11-02〜2027-03-31) — the period
 * the other files keep to themselves (seed.db.test.ts counts its entries) — and pay runs are
 * append-only and one per month (a persisted December run would also change the drafts the other
 * payroll files check). So each scenario builds its runs (the October bonus in 第 220 期 of
 * payroll.db.test.ts, the December bonus, the December and January 2027 runs in 第 1 期), checks, and
 * rolls everything back; nothing of this file stays in the database. The months avoid the deadlines
 * the other payroll files complete (源泉 06・07・09・11・H2, 社保 05・07・08・09・11, 住民税 06・09・10): both
 * people join 社会保険 on 2026-12-01, so the December run (社会保険料は 11 月分) has no 社会保険料 and only
 * the December bonus and the January run (12 月分) do. The settlements keep the December 源泉所得税
 * deadline positive, so no refund carries into another file's deadline.
 */
import type { CalendarDate } from "@niho-finance/ledger";
import {
  calculateYearEnd,
  emptyYearEndDeclaration,
  PayrollTableMissingError,
  type PayrollBonusItem,
  type YearEndDeclaration,
} from "@niho-finance/payroll";
import type { FiscalYear, Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  confirmBonusRun,
  confirmPayrollRun,
  confirmYearEnd,
  createEmployee,
  getYearEndDeclaration,
  listEmployees,
  listPayrollSchedule,
  loadBonusDraft,
  loadPayrollDraft,
  loadWithholdingLedger,
  loadYearEnd,
  previewBonusRun,
  previewPayrollRun,
  previewYearEnd,
  saveYearEndDeclaration,
  setEmployeeActive,
  SettingsError,
  type BonusRunDetail,
  type EmployeeCreateInput,
  type PayrollRunDetail,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear } from "./support/refs";

type Tx = Prisma.TransactionClient;

const actor = "tester@example.com";
/** 今日 for the 標準報酬月額 check: a day the registered tables cover, whenever the tests run. */
const TODAY = "2026-10-29";

/** 第 220 期 (shared with payroll.db.test.ts and payroll-bonus.db.test.ts). */
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
  name: "年調 一郎",
  kind: "officer",
  birthDate: "1985-05-05",
  basePay: 300_000n,
  commuteAllowance: 0n,
  socialInsured: true,
  insuredFrom: "2026-12-01",
  healthSmr: 300_000n,
  pensionSmr: 300_000n,
  employmentInsured: false,
  taxColumn: "kou",
  dependents: 0,
  residentTax: 0n,
};

const employeeInput: EmployeeCreateInput = {
  name: "年調 二子",
  kind: "employee",
  birthDate: "1992-09-09",
  basePay: 280_000n,
  commuteAllowance: 10_000n,
  socialInsured: true,
  insuredFrom: "2026-12-01",
  healthSmr: 260_000n,
  pensionSmr: 260_000n,
  employmentInsured: true,
  taxColumn: "kou",
  dependents: 1,
  residentTax: 10_000n,
};

function declaration(patch: Partial<YearEndDeclaration>): YearEndDeclaration {
  const empty = emptyYearEndDeclaration();
  return { ...empty, ...patch, insurance: { ...empty.insurance, ...patch.insurance } };
}

/** The officer: 生命保険料 and 地震保険料 only (a 過納). */
const officerDeclaration = declaration({
  insurance: { ...emptyYearEndDeclaration().insurance, newGeneral: 50_000n, earthquake: 10_000n },
});

/** The employee: one 一般の扶養親族 and a previous employer that withheld little (a 不足). */
const employeeDeclaration = declaration({
  dependents: [{ category: "general", disability: "none", under23: false }],
  insurance: { ...emptyYearEndDeclaration().insurance, newGeneral: 50_000n },
  previousEmployer: { paid: 3_600_000n, socialInsurance: 500_000n, withheld: 20_000n },
});

interface Scenario {
  officerId: string;
  employeeId: string;
  october: BonusRunDetail;
  decemberBonus: BonusRunDetail;
  december: PayrollRunDetail | null;
  january: PayrollRunDetail | null;
}

async function bonus(
  tx: Tx,
  payMonth: string,
  paymentDate: CalendarDate,
  title: string,
  amounts: Record<string, bigint>,
): Promise<BonusRunDetail> {
  const draft = await loadBonusDraft(tx, payMonth);
  const input = {
    ...draft.input,
    paymentDate,
    title,
    payFromWalletId: null,
    withholdingSpecialDue: false,
    items: draft.input.items.map((item) => {
      const amount = amounts[item.employeeId] ?? 0n;
      const officer = draft.employees.find((row) => row.employee.id === item.employeeId);
      return officer?.employee.kind === "officer"
        ? { ...item, bonus: amount, filingDate: paymentDate, filingAmount: amount }
        : { ...item, bonus: amount };
    }),
  };
  const shown = await previewBonusRun(tx, input);
  return confirmBonusRun(
    tx,
    { ...input, tableIds: shown.tableIds, expected: shown.expected },
    { actor },
  );
}

async function monthly(
  tx: Tx,
  payMonth: string,
  paymentDate: CalendarDate,
  employeeId: string,
): Promise<PayrollRunDetail> {
  const draft = await loadPayrollDraft(tx, payMonth);
  const input = {
    ...draft.input,
    paymentDate,
    payFromWalletId: null,
    withholdingSpecialDue: false,
    residentTaxSpecialDue: false,
    items: draft.input.items.map((item) =>
      item.employeeId === employeeId && payMonth === "2026-12"
        ? { ...item, incomeTaxAdjustment: -100n, adjustmentNote: "11 月分の端数の訂正" }
        : item,
    ),
  };
  const shown = await previewPayrollRun(tx, input);
  return confirmPayrollRun(
    tx,
    { ...input, tableIds: shown.tableIds, expected: shown.expected },
    { actor },
  );
}

async function setUp(tx: Tx, options: { december: boolean }): Promise<Scenario> {
  // A run takes every active employee: only the two of this scenario (rolled back with it).
  for (const employee of await listEmployees(tx)) {
    if (employee.isActive) {
      await setEmployeeActive(tx, { id: employee.id, isActive: false }, { actor });
    }
  }
  const officerId = (await createEmployee(tx, officerInput, { actor, today: TODAY })).employee.id;
  const employeeId = (await createEmployee(tx, employeeInput, { actor, today: TODAY })).employee.id;
  const october = await bonus(tx, "2026-10", "2026-10-15", "秋季賞与", {
    [officerId]: 600_000n,
    [employeeId]: 400_000n,
  });
  const decemberBonus = await bonus(tx, "2026-12", "2026-12-10", "冬季賞与", {
    [officerId]: 1_000_000n,
    [employeeId]: 500_000n,
  });
  const december = options.december ? await monthly(tx, "2026-12", "2026-12-25", employeeId) : null;
  const january = options.december ? await monthly(tx, "2027-01", "2027-01-25", employeeId) : null;
  return { officerId, employeeId, october, decemberBonus, december, january };
}

class Rollback extends Error {}

describe.skipIf(!hasTestDatabase)("year-end adjustment (年末調整)", () => {
  let prisma: PrismaClient;

  /** Runs `check` on a fresh scenario and rolls everything back. */
  async function inScenario(
    options: { december: boolean },
    check: (tx: Tx, scenario: Scenario) => Promise<void>,
  ): Promise<void> {
    const error = await rejectionOf(
      prisma.$transaction(
        async (tx) => {
          await check(tx, await setUp(tx, options));
          throw new Rollback();
        },
        { maxWait: 20_000, timeout: 170_000 },
      ),
    );
    if (!(error instanceof Rollback)) throw error;
  }

  /** Balance (credit − debit) of a sub-account over every entry. */
  async function subBalance(tx: Tx, accountCode: string, name: string): Promise<bigint> {
    const sub = await tx.subAccount.findFirst({ where: { name, account: { code: accountCode } } });
    if (!sub) return 0n;
    const lines = await tx.journalLine.findMany({ where: { subAccountId: sub.id } });
    return lines.reduce(
      (sum, line) => sum + (line.side === "credit" ? line.amount : -line.amount),
      0n,
    );
  }

  /**
   * §5.5 with the settlements: 預り金〔源泉所得税〕 equals the open 源泉所得税 deadlines minus the
   * refund still to apply (0 here: the December deadline stays positive).
   */
  async function expectWithholdingMatchesSchedule(tx: Tx): Promise<void> {
    const withholding = (await listPayrollSchedule(tx)).filter(
      (row) => row.category === "withholding",
    );
    const open = withholding
      .filter((row) => row.completedAt === null)
      .reduce((total, row) => total + row.withheld, 0n);
    const carried = withholding.at(-1)?.refundCarried ?? 0n;
    expect(carried).toBe(0n);
    expect(await subBalance(tx, "2300", "源泉所得税")).toBe(open - carried);
  }

  async function postedLines(tx: Tx, entryId: string) {
    const lines = await tx.journalLine.findMany({
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

  beforeAll(async () => {
    prisma = testPrisma();
    await payrollYear(prisma);
  });

  afterAll(async () => {
    // Nothing of this file persists (every scenario is rolled back); the shared fiscal year stays.
    expect(await prisma.payrollYearEnd.count({ where: { year: 2026 } })).toBe(0);
  });

  it("saves and updates the declaration with the audit log", async () => {
    await inScenario({ december: false }, async (tx, { officerId }) => {
      const created = await saveYearEndDeclaration(
        tx,
        { year: 2026, employeeId: officerId, declaration: { ...officerDeclaration } },
        { actor },
      );
      expect(created.declaration).toEqual(officerDeclaration);
      const updated = await saveYearEndDeclaration(
        tx,
        {
          year: 2026,
          employeeId: officerId,
          // The form sends text: amounts with grouping, empty fields, a checkbox's "on".
          declaration: {
            dependents: [{ category: "minor", disability: "general", under23: "on" }],
            self: { disability: "none", widowStatus: "none", workingStudent: "" },
            otherIncome: "120,000",
            spouse: { totalIncome: "", elderly: "false", disability: "none" },
            specificRelatives: [],
            incomeAdjustment: false,
            insurance: {
              newGeneral: "50,000",
              oldGeneral: "",
              medical: "",
              newPension: "",
              oldPension: "",
              under23Dependent: "",
              earthquake: "10000",
              oldLongTerm: "",
              socialInsurance: "",
              smallBusinessMutualAid: "",
            },
            housingLoanCredit: "",
            previousEmployer: null,
          },
        },
        { actor },
      );
      expect(updated.id).toBe(created.id);
      expect(updated.declaration).toEqual({
        ...officerDeclaration,
        // 16 歳未満 is always under 23: the flag is only kept for 一般.
        dependents: [{ category: "minor", disability: "general", under23: false }],
        otherIncome: 120_000n,
        spouse: { totalIncome: 0n, elderly: false, disability: "none" },
      });
      expect(await getYearEndDeclaration(tx, 2026, officerId)).toEqual(updated);
      expect(await getYearEndDeclaration(tx, 2027, officerId)).toBeNull();

      const audits = await tx.auditLog.findMany({
        where: { action: "payroll_year_end_declaration.save", entityId: created.id },
      });
      expect(audits).toHaveLength(2);
      const first = audits.find((row) => row.before === null);
      const second = audits.find((row) => row.before !== null);
      expect(first?.after).toMatchObject({ year: 2026, employeeId: officerId });
      expect(second?.before).toMatchObject({
        declarations: { insurance: { newGeneral: "50000", earthquake: "10000" } },
      });
      expect(second?.after).toMatchObject({ declarations: { otherIncome: "120000" } });

      const broken = await rejectionOf(
        saveYearEndDeclaration(
          tx,
          {
            year: 2026,
            employeeId: officerId,
            declaration: {
              ...officerDeclaration,
              dependents: [{ category: "cousin", disability: "none", under23: false }],
            },
          },
          { actor },
        ),
      );
      expect(broken).toBeInstanceOf(ZodError);
      expect((broken as ZodError).issues.map((issue) => issue.path.join("."))).toEqual([
        "declaration.dependents.0.category",
      ]);
      const unknown = await rejectionOf(
        saveYearEndDeclaration(
          tx,
          { year: 2026, employeeId: "emp_unknown", declaration: officerDeclaration },
          { actor },
        ),
      );
      expect((unknown as SettingsError).field).toBe("employeeId");
      const noTable = await rejectionOf(
        saveYearEndDeclaration(
          tx,
          { year: 2027, employeeId: officerId, declaration: officerDeclaration },
          { actor },
        ),
      );
      expect(noTable).toBeInstanceOf(PayrollTableMissingError);
    });
  }, 180_000);

  it("adds up the monthly and bonus runs paid in the year and needs the December run", async () => {
    await inScenario({ december: false }, async (tx, scenario) => {
      const { officerId, employeeId, october, decemberBonus } = scenario;
      await saveYearEndDeclaration(
        tx,
        { year: 2026, employeeId, declaration: employeeDeclaration },
        { actor },
      );
      // Without the December run: the totals so far, and 確定 is refused.
      const early = await previewYearEnd(tx, 2026, employeeId);
      expect(early.decemberRun).toBeNull();
      expect(early.blockers).toEqual([
        "2026 年 12 月の支給がまだ確定していません。年末調整は 12 月の支給を確定した後に行います",
      ]);
      const refused = await rejectionOf(confirmYearEnd(tx, 2026, employeeId, { actor }));
      expect(refused).toBeInstanceOf(SettingsError);
      expect((refused as SettingsError).message).toMatch(/12 月の支給がまだ確定していません/);
      expect(await tx.payrollYearEnd.count({ where: { employeeId } })).toBe(0);

      const december = await monthly(tx, "2026-12", "2026-12-25", employeeId);
      const january = await monthly(tx, "2027-01", "2027-01-25", employeeId);
      const preview = await previewYearEnd(tx, 2026, employeeId);

      // By payment date: the October and December bonuses and the December run; not January 2027.
      const item = (run: { items: readonly { employeeId: string }[] }) =>
        run.items.find((row) => row.employeeId === employeeId);
      const monthItem = december.items.find((row) => row.employeeId === employeeId);
      const octoberItem = october.items.find((row) => row.employeeId === employeeId);
      const bonusItem = decemberBonus.items.find((row) => row.employeeId === employeeId);
      if (!monthItem || !octoberItem || !bonusItem || !item(january)) {
        throw new Error("the employee is in every run of the scenario");
      }
      expect(preview.totals.runs.map((line) => [line.kind, line.paymentDate, line.label])).toEqual([
        ["bonus", "2026-10-15", "秋季賞与（2026 年 10 月）"],
        ["bonus", "2026-12-10", "冬季賞与（2026 年 12 月）"],
        ["monthly", "2026-12-25", "2026 年 12 月の給与"],
      ]);
      const bonusSocial = (row: PayrollBonusItem) =>
        row.result.socialInsurance.employeeTotal + (row.result.employmentInsurance?.employee ?? 0n);
      expect(preview.totals).toMatchObject({
        pay: 280_000n,
        bonus: 900_000n,
        socialInsurance:
          monthItem.result.socialInsuranceEmployeeTotal +
          (monthItem.result.employmentInsurance?.employee ?? 0n) +
          bonusSocial(octoberItem) +
          bonusSocial(bonusItem),
        withheld:
          monthItem.result.incomeTaxTotal +
          octoberItem.result.incomeTax +
          bonusItem.result.incomeTax,
      });
      // The December run (社会保険料は 11 月分、資格取得の前) has 雇用保険 only; the adjustment counts.
      expect(monthItem.result.socialInsuranceEmployeeTotal).toBe(0n);
      expect(monthItem.result.incomeTaxTotal).toBe(monthItem.result.incomeTax - 100n);
      expect(bonusItem.result.socialInsurance.employeeTotal).toBeGreaterThan(0n);

      expect(preview.result).toEqual(
        calculateYearEnd({
          year: 2026,
          taxColumn: "kou",
          salary: {
            pay: preview.totals.pay,
            bonus: preview.totals.bonus,
            socialInsurance: preview.totals.socialInsurance,
            withheld: preview.totals.withheld,
          },
          declaration: employeeDeclaration,
        }),
      );
      // 4,780,000 (前職 3,600,000 を含む) → 3,384,000; a 不足 to collect.
      expect(preview.result.totalPay).toBe(4_780_000n);
      expect(preview.result.salaryIncome).toBe(3_384_000n);
      expect(preview.result.settlement.kind).toBe("shortfall");
      expect(preview.blockers).toEqual([]);
      expect(preview.decemberRun).toMatchObject({ id: december.id, paymentDate: "2026-12-25" });
      expect(preview.settlement?.slot.ruleKey).toBe("payroll.withholding.2026-12");
      expect(preview.settlement?.entry?.lines.map((line) => [line.side, line.accountCode])).toEqual(
        [
          ["debit", "2100"],
          ["credit", "2300"],
        ],
      );

      // The form's unsaved values: computed, not saved.
      const unsaved = await previewYearEnd(tx, 2026, employeeId, {
        declaration: { ...employeeDeclaration, dependents: [] },
      });
      expect(unsaved.result.deductions.dependents.total).toBe(0n);
      expect(unsaved.result.annualTax).toBeGreaterThan(preview.result.annualTax);
      expect((await getYearEndDeclaration(tx, 2026, employeeId))?.declaration).toEqual(
        employeeDeclaration,
      );

      // The list: both people, the officer without a declaration yet.
      const overview = await loadYearEnd(tx, 2026);
      const rows = overview.rows.filter((row) => [officerId, employeeId].includes(row.employee.id));
      expect(
        rows.map((row) => [row.employee.id, row.declaration !== null, row.inDecemberRun]),
      ).toEqual([
        [officerId, false, true],
        [employeeId, true, true],
      ]);
      expect(rows[0]?.blockers).toEqual([
        "申告をまだ保存していません。申告を保存してから確定します",
      ]);
      expect(rows[1]?.result.difference).toBe(preview.result.difference);
      expect(overview.decemberRun?.id).toBe(december.id);
      await expect(loadYearEnd(tx, 2027)).rejects.toBeInstanceOf(PayrollTableMissingError);
    });
  }, 180_000);

  it("settles a 不足 and a 過納 with balanced entries and keeps 預り金 equal to the schedule", async () => {
    await inScenario({ december: true }, async (tx, scenario) => {
      const { officerId, employeeId, december } = scenario;
      if (!december) throw new Error("the scenario has the December run");
      await saveYearEndDeclaration(
        tx,
        { year: 2026, employeeId, declaration: employeeDeclaration },
        { actor },
      );
      await saveYearEndDeclaration(
        tx,
        { year: 2026, employeeId: officerId, declaration: officerDeclaration },
        { actor },
      );
      await expectWithholdingMatchesSchedule(tx);

      // The employee: 不足 (collected from the December pay: 未払金〔給与〕 / 預り金〔源泉所得税〕).
      const shown = await previewYearEnd(tx, 2026, employeeId);
      const stale = await rejectionOf(
        confirmYearEnd(tx, 2026, employeeId, {
          actor,
          expected: {
            annualTax: shown.result.annualTax + 100n,
            difference: shown.result.difference,
          },
        }),
      );
      expect((stale as SettingsError).message).toMatch(/計算の結果が確認した内容と変わりました/);
      const shortfall = await confirmYearEnd(tx, 2026, employeeId, {
        actor,
        expected: { annualTax: shown.result.annualTax, difference: shown.result.difference },
      });
      expect(shortfall.result).toEqual(shown.result);
      expect(shortfall.result.difference).toBeGreaterThan(0n);
      expect(shortfall.settledRun).toEqual({
        id: december.id,
        payMonth: "2026-12",
        paymentDate: "2026-12-25",
      });
      expect(shortfall.settlementEntry?.entryDate).toBe("2026-12-25");
      expect(await postedLines(tx, shortfall.settlementEntry?.id ?? "")).toEqual([
        ["debit", "2100〔給与〕", shortfall.result.difference],
        ["credit", "2300〔源泉所得税〕", shortfall.result.difference],
      ]);
      const entry = await tx.journalEntry.findUniqueOrThrow({
        where: { id: shortfall.settlementEntry?.id ?? "" },
      });
      expect(entry).toMatchObject({ sourceKind: "payroll", sourceId: shortfall.id });
      expect(entry.description).toBe("年末調整 2026 年分 年調 二子（不足額の徴収）");
      await expectWithholdingMatchesSchedule(tx);

      // The officer: 過納 (refunded with the December pay: 預り金〔源泉所得税〕 / 未払金〔給与〕).
      const officer = await previewYearEnd(tx, 2026, officerId);
      expect(officer.result.annualTax).toBe(0n);
      expect(officer.result.settlement).toEqual({
        kind: "refund",
        label: "過納",
        amount: officer.totals.withheld,
      });
      const refund = await confirmYearEnd(tx, 2026, officerId, { actor });
      expect(await postedLines(tx, refund.settlementEntry?.id ?? "")).toEqual([
        ["debit", "2300〔源泉所得税〕", officer.totals.withheld],
        ["credit", "2100〔給与〕", officer.totals.withheld],
      ]);
      await expectWithholdingMatchesSchedule(tx);

      // Both settlements are in the December 源泉所得税 deadline, which stays positive.
      const slot = (await listPayrollSchedule(tx)).find(
        (row) => row.ruleKey === "payroll.withholding.2026-12",
      );
      expect(slot).toMatchObject({
        payMonths: ["2026-12"],
        bonusMonths: ["2026-12"],
        yearEndMonths: ["2026-12", "2026-12"],
        refundCarried: 0n,
      });
      const decemberTax = december.totals.incomeTax + scenario.decemberBonus.totals.incomeTax;
      expect(slot?.amount).toBe(
        decemberTax + shortfall.result.difference + refund.result.difference,
      );
      expect(slot?.amount ?? 0n).toBeGreaterThan(0n);

      // The audit log, the second confirmation, the declaration after 確定.
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: "payroll_year_end.confirm", entityId: shortfall.id },
      });
      expect(audit.after).toMatchObject({
        year: 2026,
        employeeId,
        settledRunId: december.id,
        tableId: "year-end-2026",
        difference: shortfall.result.difference.toString(),
        settlementEntryId: shortfall.settlementEntry?.id,
        ruleKey: "payroll.withholding.2026-12",
      });
      const again = await rejectionOf(confirmYearEnd(tx, 2026, employeeId, { actor }));
      expect((again as SettingsError).message).toMatch(/2026 年分の年末調整は確定済みです/);
      const locked = await rejectionOf(
        saveYearEndDeclaration(
          tx,
          { year: 2026, employeeId, declaration: employeeDeclaration },
          { actor },
        ),
      );
      expect((locked as SettingsError).message).toMatch(/確定した後は申告を変えられません/);

      // The list and the screen show the confirmed records.
      const preview = await previewYearEnd(tx, 2026, employeeId);
      expect(preview.confirmed?.id).toBe(shortfall.id);
      expect(preview.blockers).toEqual([]);
      const overview = await loadYearEnd(tx, 2026);
      expect(
        overview.rows
          .filter((row) => [officerId, employeeId].includes(row.employee.id))
          .map((row) => row.confirmed?.id),
      ).toEqual([refund.id, shortfall.id]);

      // 源泉徴収簿: the December pay, both bonuses, and the confirmed 年末調整.
      const ledger = await loadWithholdingLedger(tx, 2026, employeeId);
      if (!ledger) throw new Error("the employee has a 源泉徴収簿");
      expect(ledger.months.map((month) => [month.payMonth, month.adjustment])).toEqual([
        ["2026-12", -100n],
      ]);
      expect(ledger.bonuses.map((row) => [row.title, row.paymentDate])).toEqual([
        ["秋季賞与", "2026-10-15"],
        ["冬季賞与", "2026-12-10"],
      ]);
      expect(ledger.months[0]?.dependents).toBe(1);
      expect(ledger.totals.withheld + ledger.totals.bonusWithheld).toBe(
        shortfall.result.withheld - 20_000n,
      );
      expect(ledger.yearEnd).toMatchObject({ state: "confirmed", result: shortfall.result });
      expect(await loadWithholdingLedger(tx, 2026, "emp_unknown")).toBeNull();
    });
  }, 180_000);

  it("keeps a confirmed 年末調整 append-only and checks its columns", async () => {
    await inScenario({ december: true }, async (tx, { officerId }) => {
      await saveYearEndDeclaration(
        tx,
        { year: 2026, employeeId: officerId, declaration: officerDeclaration },
        { actor },
      );
      const record = await confirmYearEnd(tx, 2026, officerId, { actor });

      /** A statement that must fail, inside a savepoint so the scenario's transaction goes on. */
      async function rejected(sql: string, ...values: unknown[]): Promise<string> {
        await tx.$executeRawUnsafe("SAVEPOINT year_end_guard");
        try {
          await tx.$executeRawUnsafe(sql, ...values);
        } catch (error) {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT year_end_guard");
          return error instanceof Error ? error.message : String(error);
        }
        throw new Error(`expected a rejection: ${sql}`);
      }

      expect(
        await rejected(
          `UPDATE "payroll_year_end" SET "confirmed_by" = 'someone' WHERE "id" = $1`,
          record.id,
        ),
      ).toMatch(/ledger guard: payroll_year_end is append-only \(UPDATE/);
      expect(await rejected(`DELETE FROM "payroll_year_end" WHERE "id" = $1`, record.id)).toMatch(
        /ledger guard: payroll_year_end is append-only \(DELETE/,
      );
      expect(await rejected(`TRUNCATE "payroll_year_end"`)).toMatch(
        /ledger guard: TRUNCATE on payroll_year_end is not allowed/,
      );
      // 過不足 and the settlement entry go together.
      expect(
        await rejected(
          `INSERT INTO "payroll_year_end" ("id", "year", "employee_id", "settled_run_id", "table_id", "snapshot", "annual_tax", "difference", "settlement_entry_id", "confirmed_by")
           SELECT 'year_end_check', 2025, "employee_id", "settled_run_id", "table_id", "snapshot", 0, 100, NULL, 'tester@example.com'
           FROM "payroll_year_end" WHERE "id" = $1`,
          record.id,
        ),
      ).toMatch(/payroll_year_end_settlement_entry_iff_difference/);
      expect(
        await tx.payrollYearEnd.findUnique({ where: { id: record.id }, select: { id: true } }),
      ).toEqual({ id: record.id });
    });
  }, 180_000);
});
