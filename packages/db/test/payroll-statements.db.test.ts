/**
 * 法定調書・退職 (22-payroll §12): the 退職日 and its filing deadlines (idempotent), the final pay of a
 * month-end leaver deducting two premium months (snapshot, entries, schedule), a leaver left out of
 * later runs and of 年末調整, the 源泉徴収票 of an adjusted officer and of leavers (the 30 万円 rule of
 * 給与支払報告書), the 法定調書の欄 kept through a later save of the 申告, 報酬の支払調書 with a voided
 * entry, and no マイナンバー in any stored row. Every name, address and amount is fictional.
 *
 * Every scenario runs in a transaction that is rolled back, as in payroll-year-end.db.test.ts: the
 * runs are append-only and one per month, and a 2026 年末調整 needs the December 2026 run in the
 * seeded 第 1 期. Nothing of this file stays in the database (so no payroll.* deadline is left open).
 * The months avoid every deadline another payroll file completes: the leaver's final pay is February
 * 2027 (源泉 2027-02, 住民税 2027-02, 社保 2027-01・2027-02), and the 2026 scenario repeats the one of
 * payroll-year-end.db.test.ts (October and December bonuses, the December run, 社会保険 from 12 月).
 */
import { CORPORATE_SEGMENT_CODE, type CalendarDate } from "@niho-finance/ledger";
import {
  emptyYearEndDeclaration,
  unifiedCsvRow,
  type YearEndDeclaration,
} from "@niho-finance/payroll";
import type { FiscalYear, Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  confirmBonusRun,
  confirmPayrollRun,
  confirmYearEnd,
  createEmployee,
  createPartner,
  getYearEndDeclaration,
  listEmployees,
  listPayrollSchedule,
  loadBonusDraft,
  loadFeeReports,
  loadPayrollDraft,
  loadStatements,
  loadWithholdingSlip,
  loadYearEnd,
  postVoucherEntry,
  previewBonusRun,
  previewPayrollRun,
  previewYearEnd,
  recordExport,
  saveStatementFields,
  saveYearEndDeclaration,
  setEmployeeActive,
  setPartnerIndividual,
  SettingsError,
  updateEmployee,
  voidJournalEntryInTransaction,
  type BonusRunDetail,
  type EmployeeCreateInput,
  type PayrollRunDetail,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs } from "./support/refs";

type Tx = Prisma.TransactionClient;

const actor = "tester@example.com";
const TODAY = "2026-10-29";
/** A マイナンバー-shaped number typed on the export form (fictional; must never be stored). */
const MY_NUMBER = "987654321098";

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

const person = (overrides: Partial<EmployeeCreateInput>): EmployeeCreateInput => ({
  name: "法定 太郎",
  kind: "employee",
  birthDate: "1990-04-01",
  basePay: 280_000n,
  commuteAllowance: 0n,
  socialInsured: true,
  insuredFrom: "2026-12-01",
  healthSmr: 280_000n,
  pensionSmr: 280_000n,
  employmentInsured: true,
  taxColumn: "kou",
  dependents: 0,
  residentTax: 10_000n,
  ...overrides,
});

class Rollback extends Error {}

async function deactivateAll(tx: Tx): Promise<void> {
  for (const employee of await listEmployees(tx)) {
    if (employee.isActive) {
      await setEmployeeActive(tx, { id: employee.id, isActive: false }, { actor });
    }
  }
}

async function monthly(
  tx: Tx,
  payMonth: string,
  paymentDate: CalendarDate,
): Promise<PayrollRunDetail> {
  const draft = await loadPayrollDraft(tx, payMonth);
  const input = {
    ...draft.input,
    paymentDate,
    payFromWalletId: null,
    withholdingSpecialDue: false,
    residentTaxSpecialDue: false,
  };
  const shown = await previewPayrollRun(tx, input);
  return confirmPayrollRun(
    tx,
    { ...input, tableIds: shown.tableIds, expected: shown.expected },
    { actor },
  );
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
      const row = draft.employees.find((candidate) => candidate.employee.id === item.employeeId);
      // An officer without a bonus has no filing (a filed amount is 1 円 or more).
      return row?.employee.kind === "officer" && amount > 0n
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

describe.skipIf(!hasTestDatabase)("法定調書・退職 (§12)", () => {
  let prisma: PrismaClient;

  async function rolledBack(check: (tx: Tx) => Promise<void>): Promise<void> {
    const error = await rejectionOf(
      prisma.$transaction(
        async (tx) => {
          await check(tx);
          throw new Rollback();
        },
        { maxWait: 20_000, timeout: 170_000 },
      ),
    );
    if (!(error instanceof Rollback)) throw error;
  }

  beforeAll(async () => {
    prisma = testPrisma();
    await payrollYear(prisma);
  });

  afterAll(async () => {
    // Rolled back: no 退職 filing, no 2026 年末調整 and no 提出 deadline of this file stays.
    expect(
      await prisma.calendarItem.count({ where: { ruleKey: { startsWith: "payroll.leave." } } }),
    ).toBe(0);
    expect(await prisma.payrollYearEnd.count({ where: { year: 2026 } })).toBe(0);
  });

  it("puts the 退職 filings on the calendar once and keeps them when the 退職日 is cleared", async () => {
    await rolledBack(async (tx) => {
      await deactivateAll(tx);
      const created = await createEmployee(tx, person({ name: "退職 花子" }), {
        actor,
        today: TODAY,
      });
      const id = created.employee.id;
      expect(created.leaveFilings).toEqual([]);
      const values = (leftOn: string | null) => ({ id, ...person({ name: "退職 花子" }), leftOn });

      const first = await updateEmployee(tx, values("2027-02-28"), { actor, today: TODAY });
      expect(first.employee.leftOn).toBe("2027-02-28");
      expect(first.leaveFilings.map((row) => [row.ruleKey, row.dueDate, row.state])).toEqual([
        [`payroll.leave.${id}.social_insurance_loss`, "2027-03-06", "created"],
        [`payroll.leave.${id}.resident_tax_change`, "2027-03-10", "created"],
        [`payroll.leave.${id}.employment_insurance_loss`, "2027-03-11", "created"],
        [`payroll.leave.${id}.withholding_slip`, "2027-03-28", "created"],
      ]);
      const items = await tx.calendarItem.findMany({
        where: { ruleKey: { startsWith: `payroll.leave.${id}.` } },
      });
      expect(items).toHaveLength(4);
      expect(items.every((item) => item.kind === "filing" && item.fiscalYearId === null)).toBe(
        true,
      );

      // The same values: nothing changes. Cleared: the filings stay. Set again: no duplicates.
      expect(
        (await updateEmployee(tx, values("2027-02-28"), { actor, today: TODAY })).leaveFilings,
      ).toEqual([]);
      const cleared = await updateEmployee(tx, values(null), { actor, today: TODAY });
      expect(cleared.employee.leftOn).toBeNull();
      expect(cleared.leaveFilings).toEqual([]);
      const again = await updateEmployee(tx, values("2027-02-28"), { actor, today: TODAY });
      expect(again.leaveFilings.map((row) => row.state)).toEqual(["kept", "kept", "kept", "kept"]);
      // A new 退職日 moves the open ones.
      const moved = await updateEmployee(tx, values("2027-02-27"), { actor, today: TODAY });
      expect(moved.leaveFilings.map((row) => row.state)).toEqual([
        "moved",
        "moved",
        "moved",
        "moved",
      ]);
      expect(
        await tx.calendarItem.count({ where: { ruleKey: { startsWith: `payroll.leave.${id}.` } } }),
      ).toBe(4);
      const audit = await tx.auditLog.findMany({
        where: { entity: "employee", entityId: id, action: "employee.update" },
      });
      expect(audit.length).toBe(4);
      expect(audit.some((row) => JSON.stringify(row.after).includes("withholding_slip"))).toBe(
        true,
      );
    });
  }, 180_000);

  it("deducts the leaving month too in a month-end leaver's final pay (翌月控除)", async () => {
    await rolledBack(async (tx) => {
      await deactivateAll(tx);
      const stayer = (
        await createEmployee(tx, person({ name: "在職 一郎", residentTax: 0n }), {
          actor,
          today: TODAY,
        })
      ).employee;
      const leaver = (
        await createEmployee(tx, person({ name: "退職 二子", leftOn: "2027-02-28" }), {
          actor,
          today: TODAY,
        })
      ).employee;

      const draft = await loadPayrollDraft(tx, "2027-02");
      expect(draft.premiumMonth).toBe("2027-01");
      expect(draft.employees.map((row) => [row.employee.name, row.extraPremiumMonth])).toEqual([
        ["在職 一郎", null],
        ["退職 二子", "2027-02"],
      ]);
      const input = {
        ...draft.input,
        paymentDate: "2027-02-25" as CalendarDate,
        payFromWalletId: null,
        withholdingSpecialDue: false,
        residentTaxSpecialDue: false,
      };
      const shown = await previewPayrollRun(tx, input);
      const shownLeaver = shown.items.find((item) => item.employeeId === leaver.id)!;
      const shownStayer = shown.items.find((item) => item.employeeId === stayer.id)!;
      expect(shownLeaver.input.extraPremium).toEqual({
        premiumMonth: "2027-02",
        coverage: { health: true, care: false, pension: true },
      });
      // Same 標準報酬月額 and coverage: the leaver pays the stayer's premium twice.
      expect(shownLeaver.result.socialInsuranceEmployeeTotal).toBe(
        2n * shownStayer.result.socialInsuranceEmployeeTotal,
      );
      expect(shown.extraSocialInsurance.map((row) => row.premiumMonth)).toEqual(["2027-02"]);
      const socialRows = shown.schedule.filter((row) => row.category === "social_insurance");
      expect(socialRows.map((row) => row.ruleKey)).toEqual([
        "payroll.social_insurance.2027-01",
        "payroll.social_insurance.2027-02",
      ]);

      const run = await confirmPayrollRun(
        tx,
        { ...input, tableIds: shown.tableIds, expected: shown.expected },
        { actor },
      );
      expect(run.premiumMonth).toBe("2027-01");
      const stored = run.items.find((item) => item.employeeId === leaver.id)!;
      expect(stored.result.extraPremium?.premiumMonth).toBe("2027-02");
      const employer = await tx.journalEntry.findUniqueOrThrow({
        where: { id: run.employerEntry!.id },
      });
      expect(employer.description).toBe("法定福利費 2027 年 1 月分・2 月分");

      const schedule = await listPayrollSchedule(tx);
      const february = schedule.find((row) => row.ruleKey === "payroll.social_insurance.2027-02");
      const january = schedule.find((row) => row.ruleKey === "payroll.social_insurance.2027-01");
      expect(february?.withheld).toBe(stored.result.extraPremium!.socialInsurance.employeeTotal);
      expect(february?.payMonths).toEqual(["2027-02"]);
      expect(february?.dueDate).toBe("2027-03-31");
      expect((january?.withheld ?? 0n) + (february?.withheld ?? 0n)).toBe(
        run.totals.socialInsuranceEmployee,
      );
      expect((january?.employer ?? 0n) + (february?.employer ?? 0n)).toBe(run.totals.employerTotal);

      // The leaver is not in March; a 退職日 before the confirmed February run is refused.
      const march = await loadPayrollDraft(tx, "2027-03");
      expect(march.employees.map((row) => row.employee.id)).toEqual([stayer.id]);
      const refused = await rejectionOf(
        updateEmployee(
          tx,
          { id: leaver.id, ...person({ name: "退職 二子", leftOn: "2027-01-31" }) },
          { actor, today: TODAY },
        ),
      );
      expect(refused).toBeInstanceOf(SettingsError);
      expect((refused as SettingsError).field).toBe("leftOn");
    });
  }, 180_000);

  it("makes the 源泉徴収票 of the year, the 30 万円 rule and keeps no マイナンバー", async () => {
    await rolledBack(async (tx) => {
      await deactivateAll(tx);
      const officer = (
        await createEmployee(
          tx,
          person({
            name: "法定 一郎",
            kind: "officer",
            birthDate: "1985-05-05",
            basePay: 300_000n,
            healthSmr: 300_000n,
            pensionSmr: 300_000n,
            employmentInsured: false,
            residentTax: 0n,
          }),
          { actor, today: TODAY },
        )
      ).employee;
      const employee = (
        await createEmployee(tx, person({ name: "法定 二子", dependents: 1 }), {
          actor,
          today: TODAY,
        })
      ).employee;
      const smallLeaver = (
        await createEmployee(
          tx,
          person({
            name: "退職 三郎",
            socialInsured: false,
            insuredFrom: null,
            healthSmr: null,
            pensionSmr: null,
            leftOn: "2026-10-31",
          }),
          { actor, today: TODAY },
        )
      ).employee;
      const leaver = (
        await createEmployee(
          tx,
          person({
            name: "退職 四子",
            socialInsured: false,
            insuredFrom: null,
            healthSmr: null,
            pensionSmr: null,
            leftOn: "2026-10-31",
          }),
          { actor, today: TODAY },
        )
      ).employee;

      // The officer is paid in December only: the 過納 stays within the December deadline.
      await bonus(tx, "2026-10", "2026-10-15", "秋季賞与", {
        [employee.id]: 400_000n,
        [smallLeaver.id]: 250_000n,
        [leaver.id]: 400_000n,
      });
      // 12 月: the leavers are left out of the drafts.
      const decemberBonus = await loadBonusDraft(tx, "2026-12");
      expect(decemberBonus.employees.map((row) => row.employee.id)).toEqual([
        officer.id,
        employee.id,
      ]);
      await bonus(tx, "2026-12", "2026-12-10", "冬季賞与", { [employee.id]: 500_000n });
      await monthly(tx, "2026-12", "2026-12-25");

      // The leavers are not adjusted, with the reason.
      const yearEnd = await previewYearEnd(tx, 2026, leaver.id);
      expect(yearEnd.blockers[0]).toMatch(
        /2026\/10\/31 に退職した人は、2026 年分の年末調整の対象外/,
      );

      // The employee's names, then a save from the 年末調整 screen that does not send them.
      const dependents: YearEndDeclaration["dependents"] = [
        { category: "general", disability: "none", under23: false },
      ];
      await saveYearEndDeclaration(
        tx,
        {
          year: 2026,
          employeeId: employee.id,
          declaration: { ...emptyYearEndDeclaration(), dependents },
        },
        { actor },
      );
      await saveStatementFields(
        tx,
        {
          year: 2026,
          employeeId: employee.id,
          recipient: {
            furigana: "ホウテイ フタコ",
            address: "架空県架空市中町4-5-6",
            municipalityCode: "149999",
            recipientNo: "",
          },
          spouse: null,
          dependents: [{ name: "法定 小一", furigana: "ホウテイ ショウイチ", nonResident: false }],
          specificRelatives: [],
          previousPayer: null,
        },
        { actor },
      );
      await saveYearEndDeclaration(
        tx,
        {
          year: 2026,
          employeeId: employee.id,
          declaration: { ...emptyYearEndDeclaration(), dependents, otherIncome: "10000" },
        },
        { actor },
      );
      const kept = await getYearEndDeclaration(tx, 2026, employee.id);
      expect(kept?.declaration.dependents[0]?.person?.name).toBe("法定 小一");
      expect(kept?.declaration.recipient?.municipalityCode).toBe("149999");
      expect(kept?.declaration.otherIncome).toBe(10_000n);

      // The officer: 年末調整 confirmed, then the names (allowed after 確定).
      await saveYearEndDeclaration(
        tx,
        { year: 2026, employeeId: officer.id, declaration: emptyYearEndDeclaration() },
        { actor },
      );
      const officerFields = (recipientNo: string) => ({
        year: 2026,
        employeeId: officer.id,
        recipient: {
          furigana: "ﾎｳﾃｲ ｲﾁﾛｳ",
          address: "架空県架空市本町1-2-3",
          municipalityCode: "149998",
          recipientNo,
        },
        spouse: null,
        dependents: [],
        specificRelatives: [],
        previousPayer: null,
      });
      // Before 確定 (the snapshot must not take them) and after it (allowed: no number changes).
      await saveStatementFields(tx, officerFields(""), { actor });
      const record = await confirmYearEnd(tx, 2026, officer.id, { actor });
      await saveStatementFields(tx, officerFields("A-001"), { actor });
      const annual = await tx.calendarItem.findFirst({
        where: { fiscalYearId: null, ruleKey: "payroll.annual_report.2026" },
      });
      expect(annual?.kind).toBe("filing");
      expect(annual?.dueDate.toISOString().slice(0, 10)).toBe("2027-02-01");

      // A leaver's fields without a 申告: kept, and the 年末調整 still says 未入力.
      await saveStatementFields(
        tx,
        {
          year: 2026,
          employeeId: leaver.id,
          recipient: {
            furigana: "タイショク ヨンコ",
            address: "架空県架空市西町7-8-9",
            municipalityCode: "149997",
            recipientNo: "",
          },
          spouse: null,
          dependents: [],
          specificRelatives: [],
          previousPayer: null,
        },
        { actor },
      );
      const list = await loadYearEnd(tx, 2026);
      expect(list.rows.find((row) => row.employee.id === leaver.id)?.declaration).toBeNull();

      const statements = await loadStatements(tx, 2026);
      const byId = new Map(statements.recipients.map((row) => [row.employee.id, row]));
      expect([...byId.keys()].sort()).toEqual(
        [officer.id, employee.id, smallLeaver.id, leaver.id].sort(),
      );
      const officerSlip = byId.get(officer.id)!;
      expect(officerSlip.state).toBe("adjusted");
      expect(officerSlip.slip).toMatchObject({
        adjusted: true,
        kindLabel: "役員報酬",
        paid: 300_000n,
        withheld: record.result.annualTax,
        salaryIncomeAfterAdjustment: record.result.salaryIncomeAfterAdjustment,
        totalDeductions: record.result.deductions.total,
        basicDeduction: record.result.deductions.basic,
        recipient: { furigana: "ﾎｳﾃｲ ｲﾁﾛｳ", recipientNo: "A-001", municipalityCode: "149998" },
        employmentChange: { kind: "joined", date: "2026-12-01" },
      });
      expect(officerSlip.missing).toEqual([]);
      expect(byId.get(employee.id)?.state).toBe("pending");

      const small = byId.get(smallLeaver.id)!;
      expect(small.state).toBe("not_adjusted");
      expect(small.slip).toMatchObject({
        adjusted: false,
        paid: 250_000n,
        salaryIncomeAfterAdjustment: null,
        employmentChange: { kind: "left", date: "2026-10-31" },
      });
      expect(small.inSalaryReport).toBe(false);
      const big = byId.get(leaver.id)!;
      expect(big.inSalaryReport).toBe(true);
      expect(big.slip.recipient.address).toBe("架空県架空市西町7-8-9");
      expect(statements.totals.all.people).toBe(4);
      expect(statements.totals.salaryReport.people).toBe(3);
      expect(statements.pending).toBe(1);

      const one = await loadWithholdingSlip(tx, 2026, officer.id);
      expect(one?.slip).toEqual(officerSlip.slip);
      expect(await loadWithholdingSlip(tx, 2026, "emp_unknown")).toBeNull();

      // A CSV with typed マイナンバー: in that response only, never in a stored row.
      const row = unifiedCsvRow(officerSlip.slip, { myNumbers: { recipient: MY_NUMBER } });
      expect(row[94]).toBe(MY_NUMBER);
      await recordExport(
        tx,
        { kind: "salary-report-csv", format: "csv", from: "2026-01-01", to: "2026-12-31" },
        { actor },
      );
      const leaks = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT
          (SELECT count(*) FROM "audit_log"
            WHERE coalesce("before"::text, '') LIKE ${`%${MY_NUMBER}%`}
               OR coalesce("after"::text, '') LIKE ${`%${MY_NUMBER}%`})
          + (SELECT count(*) FROM "payroll_year_end_declaration"
            WHERE "declarations"::text LIKE ${`%${MY_NUMBER}%`})
          + (SELECT count(*) FROM "payroll_year_end" WHERE "snapshot"::text LIKE ${`%${MY_NUMBER}%`})
          AS n`;
      expect(leaks[0]?.n).toBe(0n);
      // The confirmed snapshot keeps the calculation only (the names stay in the declaration).
      const snapshot = await tx.payrollYearEnd.findUniqueOrThrow({ where: { id: record.id } });
      expect(JSON.stringify(snapshot.snapshot)).not.toContain("recipient");
    });
  }, 180_000);

  it("adds up the 報酬 of individuals with a voided entry counted once", async () => {
    await rolledBack(async (tx) => {
      const refs = await seededRefs(prisma);
      const segment = refs.segment(CORPORATE_SEGMENT_CODE);
      const accountant = await createPartner(
        tx,
        { name: "架空 税理士事務所（法定調書）", kind: "vendor" },
        { actor },
      );
      const company = await createPartner(
        tx,
        { name: "架空商事株式会社（法定調書）", kind: "vendor" },
        { actor },
      );
      const fee = async (partnerId: string, date: CalendarDate, amount: bigint, tax: bigint) =>
        postVoucherEntry(
          tx,
          {
            kind: "normal",
            entryDate: date,
            description: "税理士報酬（法定調書のテスト）",
            partnerId,
            lines: [
              {
                side: "debit",
                accountId: refs.account("5410"),
                amount: String(amount),
                taxCategoryCode: "purchase_10",
                segmentId: segment,
                partnerId,
                description: "",
              },
              {
                side: "credit",
                accountId: refs.account("2300"),
                amount: String(tax),
                taxCategoryCode: "na",
                segmentId: "",
                partnerId,
                description: "",
              },
              {
                side: "credit",
                accountId: refs.account("2100"),
                amount: String(amount - tax),
                taxCategoryCode: "na",
                segmentId: "",
                partnerId,
                description: "",
              },
            ],
          },
          { actor },
        );
      const wrong = await fee(accountant.id, "2026-08-10", 110_000n, 11_231n);
      await voidJournalEntryInTransaction(tx, wrong.id, { actor, reason: "金額の誤り" });
      await fee(accountant.id, "2026-08-10", 165_000n, 16_846n);
      await fee(accountant.id, "2026-09-10", 33_000n, 3_369n);
      await fee(company.id, "2026-09-10", 220_000n, 0n);

      const before = await loadFeeReports(tx, 2026);
      const mine = (overview: typeof before, id: string) =>
        overview.aggregation.payees.find((payee) => payee.partner.id === id);
      expect(mine(before, accountant.id)).toMatchObject({
        // Tax-inclusive in the 税抜経理 year: 165,000 + 33,000 (the voided 110,000 left out).
        paid: 198_000n,
        withheld: 20_215n,
        reportable: false,
      });
      expect(before.undecided.map((payee) => payee.partner.id)).toEqual(
        expect.arrayContaining([accountant.id, company.id]),
      );

      await setPartnerIndividual(tx, { id: accountant.id, choice: "individual" }, { actor });
      await setPartnerIndividual(tx, { id: company.id, choice: "corporation" }, { actor });
      const after = await loadFeeReports(tx, 2026, { [`${accountant.id}.5410`]: "lawyer" });
      expect(mine(after, accountant.id)).toMatchObject({
        reportable: true,
        items: [{ accountCode: "5410", category: "lawyer", paid: 198_000n, withheld: 20_215n }],
      });
      expect(mine(after, company.id)?.reportable).toBe(false);
      expect(after.undecided.map((payee) => payee.partner.id)).not.toContain(accountant.id);
      const audit = await tx.auditLog.findFirst({
        where: { entity: "partner", entityId: accountant.id, action: "partner.update" },
        orderBy: { at: "desc" },
      });
      expect(audit?.after).toEqual({ isIndividual: true });
    });
  }, 180_000);
});
