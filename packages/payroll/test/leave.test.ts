/**
 * 退職 (22-payroll §12.3・§12.4): the 資格喪失日 and the premium months, who a month's run includes,
 * the second premium month of a final pay under 翌月控除 (its snapshot, entries and deadlines), a
 * bonus in the 資格喪失月, the 年末調整 of a leaver and the filing deadlines. Every person is fictional.
 */
import { describe, expect, it } from "vitest";
import {
  addMonthsClamped,
  annualReportDueDate,
  annualReportSlot,
  buildPayrollEntries,
  calculateBonus,
  calculatePayroll,
  employedInPayMonth,
  finalPayExtraPremiumMonth,
  leaveFilingSlots,
  lossMonthOf,
  parsePayrollRunItems,
  paymentCategoryOfRuleKey,
  payrollInputOf,
  pinnedExtraPremiumTables,
  premiumDueForMonth,
  premiumSharesOf,
  runPaymentSlots,
  scheduleAmount,
  serializePayrollRunItems,
  socialInsuranceLossDate,
  summarizePayrollRun,
  yearEndRetirementReason,
  type PayrollRunItem,
  type PayrollRunItemInput,
} from "../src";

describe("資格喪失日 and the premium months (§12.3)", () => {
  it("is the day after leaving; a month-end leaver's 資格喪失月 is the next month", () => {
    expect(socialInsuranceLossDate("2026-11-15")).toBe("2026-11-16");
    expect(socialInsuranceLossDate("2026-11-30")).toBe("2026-12-01");
    expect(lossMonthOf("2026-11-15")).toBe("2026-11");
    expect(lossMonthOf("2026-11-30")).toBe("2026-12");
    expect(lossMonthOf("2026-12-31")).toBe("2027-01");
  });

  it("owes the months before the 資格喪失月 only", () => {
    // Mid-month: October is the last month with premiums.
    expect(premiumDueForMonth("2026-11-15", "2026-10")).toBe(true);
    expect(premiumDueForMonth("2026-11-15", "2026-11")).toBe(false);
    // Month-end: the leaving month too.
    expect(premiumDueForMonth("2026-11-30", "2026-11")).toBe(true);
    expect(premiumDueForMonth("2026-11-30", "2026-12")).toBe(false);
    expect(premiumDueForMonth(null, "2030-01")).toBe(true);
  });

  it("leaves a person out of the runs after the leaving month", () => {
    expect(employedInPayMonth("2026-11-15", "2026-11")).toBe(true);
    expect(employedInPayMonth("2026-11-30", "2026-12")).toBe(false);
    expect(employedInPayMonth("2026-12-01", "2026-11")).toBe(true);
    expect(employedInPayMonth(null, "2026-12")).toBe(true);
  });

  it("gives a final pay under 翌月控除 the leaving month of a month-end leaver", () => {
    const final = (
      leftOn: string | null,
      premiumTiming: "next_month" | "same_month" = "next_month",
    ) =>
      finalPayExtraPremiumMonth({
        payMonth: "2026-11",
        premiumTiming,
        leftOn: leftOn as `${number}-${number}-${number}` | null,
      });
    expect(final("2026-11-30")).toBe("2026-11");
    // Mid-month: the 資格喪失月 is November itself, nothing more to deduct.
    expect(final("2026-11-15")).toBeNull();
    // Not the final pay (leaves next month), 当月控除, not leaving.
    expect(final("2026-12-31")).toBeNull();
    expect(final("2026-11-30", "same_month")).toBeNull();
    expect(final(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The final pay with two premium months
// ---------------------------------------------------------------------------------------------

const BASE: PayrollRunItemInput = {
  taxablePay: 300_000n,
  nonTaxablePay: 0n,
  residentTax: 10_000n,
  standardRemuneration: { health: 300_000n, pension: 300_000n },
  coverage: { health: true, care: false, pension: true, employment: true },
  taxColumn: { column: "kou", dependents: 0 },
  adjustments: { incomeTax: 0n, socialInsurance: 0n },
};

function item(
  employeeId: string,
  input: PayrollRunItemInput,
  run: { paymentDate: "2026-11-25" | "2026-12-25"; premiumMonth: "2026-10" | "2026-11" },
): PayrollRunItem {
  return {
    employeeId,
    name: employeeId === "emp_leaver" ? "テスト 花子" : "テスト 太郎",
    kind: "employee",
    input,
    adjustmentNote: null,
    result: calculatePayroll(payrollInputOf(run, { kind: "employee", input })),
  };
}

const NOVEMBER = { paymentDate: "2026-11-25", premiumMonth: "2026-10" } as const;
const DECEMBER = { paymentDate: "2026-12-25", premiumMonth: "2026-11" } as const;

describe("the final pay of a month-end leaver (翌月控除, §12.3)", () => {
  const leaverInput: PayrollRunItemInput = {
    ...BASE,
    extraPremium: {
      premiumMonth: "2026-11",
      coverage: { health: true, care: false, pension: true },
    },
  };
  const leaver = item("emp_leaver", leaverInput, NOVEMBER);
  const stayer = item("emp_stayer", BASE, NOVEMBER);
  const single = calculatePayroll(payrollInputOf(NOVEMBER, { kind: "employee", input: BASE }));

  it("deducts both premium months and lowers the withholding base by both", () => {
    const extra = leaver.result.extraPremium;
    expect(extra?.premiumMonth).toBe("2026-11");
    expect(extra?.socialInsurance.employeeTotal).toBe(single.socialInsurance.employeeTotal);
    expect(leaver.result.socialInsuranceEmployeeTotal).toBe(
      2n * single.socialInsurance.employeeTotal,
    );
    expect(leaver.result.withholdingBase).toBe(
      300_000n -
        2n * single.socialInsurance.employeeTotal -
        (single.employmentInsurance?.employee ?? 0n),
    );
    expect(leaver.result.netPay).toBe(leaver.result.grossPay - leaver.result.totalDeductions);
    expect(leaver.result.incomeTax).toBeLessThanOrEqual(single.incomeTax);
  });

  it("keeps the second month in the snapshot and recalculates it with its pinned tables", () => {
    const [stored] = parsePayrollRunItems(serializePayrollRunItems([leaver]));
    expect(stored).toEqual(leaver);
    const again = calculatePayroll(
      payrollInputOf(NOVEMBER, stored!, undefined, pinnedExtraPremiumTables(stored!.result)),
    );
    expect(again).toEqual(leaver.result);
    // Old snapshots (no extraPremium) still read.
    const [plain] = parsePayrollRunItems(serializePayrollRunItems([stayer]));
    expect(plain?.result.extraPremium).toBeUndefined();
    expect(plain?.input.extraPremium).toBeUndefined();
  });

  it("puts each premium month's share on its own 社会保険料 deadline", () => {
    const summary = summarizePayrollRun({
      payMonth: "2026-11",
      premiumMonth: "2026-10",
      withholdingSpecialDue: false,
      residentTaxSpecialDue: false,
      items: [stayer, leaver],
    });
    const shares = premiumSharesOf(summary);
    expect(shares.map((share) => share.premiumMonth)).toEqual(["2026-10", "2026-11"]);
    expect(shares[0]!.employee).toBe(2n * single.socialInsurance.employeeTotal);
    expect(shares[1]!.employee).toBe(single.socialInsurance.employeeTotal);
    expect(shares[0]!.employee + shares[1]!.employee).toBe(summary.socialInsuranceEmployee);
    expect(shares[0]!.employer + shares[1]!.employer).toBe(summary.socialInsuranceEmployer);

    const slots = runPaymentSlots(summary).filter(
      ({ slot }) => slot.category === "social_insurance",
    );
    expect(slots.map(({ slot }) => slot.ruleKey)).toEqual([
      "payroll.social_insurance.2026-10",
      "payroll.social_insurance.2026-11",
    ]);
    expect(slots[1]!.amount.withheld).toBe(single.socialInsurance.employeeTotal);

    // December (premium month November) without the leaver: the November deadline adds both.
    const december = summarizePayrollRun({
      payMonth: "2026-12",
      premiumMonth: "2026-11",
      withholdingSpecialDue: false,
      residentTaxSpecialDue: false,
      items: [item("emp_stayer", BASE, DECEMBER)],
    });
    const november = scheduleAmount("payroll.social_insurance.2026-11", [summary, december]);
    expect(november.withheld).toBe(
      single.socialInsurance.employeeTotal + december.socialInsuranceEmployee,
    );
    expect(november.employer).toBe(shares[1]!.employer + december.socialInsuranceEmployer);
    expect(november.payMonths).toEqual(["2026-11", "2026-12"]);
    const october = scheduleAmount("payroll.social_insurance.2026-10", [summary, december]);
    expect(october.withheld).toBe(shares[0]!.employee);
    expect(october.payMonths).toEqual(["2026-11"]);
  });

  it("posts both months in the entries and names them", () => {
    const entries = buildPayrollEntries({
      payMonth: "2026-11",
      premiumMonth: "2026-10",
      items: [stayer, leaver],
      payFrom: "accrued",
      commuteTaxCategoryCode: "purchase_10",
    });
    expect(entries.employer?.description).toBe("法定福利費 2026 年 10 月分・11 月分");
    expect(entries.extraSocialInsurance.map((extra) => extra.premiumMonth)).toEqual(["2026-11"]);
    const summary = summarizePayrollRun({
      payMonth: "2026-11",
      premiumMonth: "2026-10",
      withholdingSpecialDue: false,
      residentTaxSpecialDue: false,
      items: [stayer, leaver],
    });
    expect(entries.employer?.lines[0]?.amount).toBe(summary.socialInsuranceEmployer);
    const credit = entries.pay.lines.find(
      (line) => line.target.kind === "account" && line.target.subAccountName === "社会保険料",
    );
    expect(credit?.amount).toBe(summary.socialInsuranceEmployee);
    let debit = 0n;
    let creditTotal = 0n;
    for (const line of entries.pay.lines) {
      if (line.side === "debit") debit += line.amount;
      else creditTotal += line.amount;
    }
    expect(debit).toBe(creditTotal);
  });

  it("refuses a second month equal to the run's own", () => {
    expect(() =>
      calculatePayroll(
        payrollInputOf(NOVEMBER, {
          kind: "employee",
          input: {
            ...BASE,
            extraPremium: {
              premiumMonth: "2026-10",
              coverage: { health: true, care: false, pension: true },
            },
          },
        }),
      ),
    ).toThrow(/同じ/);
  });
});

describe("a mid-month leaver (§12.3)", () => {
  it("has no second month; 当月控除 deducts nothing in the 資格喪失月", () => {
    expect(
      finalPayExtraPremiumMonth({
        payMonth: "2026-11",
        premiumTiming: "next_month",
        leftOn: "2026-11-15",
      }),
    ).toBeNull();
    // 当月控除: the November premium is not due for a November 15 leaver → coverage off.
    expect(premiumDueForMonth("2026-11-15", "2026-11")).toBe(false);
    const result = calculatePayroll(
      payrollInputOf(
        { paymentDate: "2026-11-25", premiumMonth: "2026-11" },
        {
          kind: "employee",
          input: {
            ...BASE,
            coverage: { health: false, care: false, pension: false, employment: true },
          },
        },
      ),
    );
    expect(result.socialInsurance.employeeTotal).toBe(0n);
    expect(result.employmentInsurance?.employee).toBeGreaterThan(0n);
  });
});

describe("a bonus in the 資格喪失月 (§10.2・§12.3)", () => {
  it("gets no social insurance premiums", () => {
    // Leaves 2026-12-15 (資格喪失日 12-16): a bonus paid 2026-12-10 is in the 資格喪失月.
    const insured = premiumDueForMonth("2026-12-15", "2026-12");
    expect(insured).toBe(false);
    const result = calculateBonus({
      paymentDate: "2026-12-10",
      worker: "employee",
      bonus: 500_000n,
      coverage: { health: insured, care: false, pension: insured, employment: true },
      taxColumn: { column: "kou", dependents: 0 },
      previousMonth: { pay: 280_000n, incomeTax: 5_000n },
      calcPeriodOver6Months: false,
      priorHealthStandardBonus: 0n,
    });
    expect(result.socialInsurance.employeeTotal).toBe(0n);
    expect(result.employmentInsurance?.employee).toBeGreaterThan(0n);
    // A month-end leaver's bonus of the leaving month still gets them.
    expect(premiumDueForMonth("2026-12-31", "2026-12")).toBe(true);
  });
});

describe("年末調整 of a leaver (§11.2・§12.3)", () => {
  it("rules out a leaver before the last pay, not one after it", () => {
    expect(yearEndRetirementReason("2026-11-30", 2026, "2026-12-25")).toMatch(/対象外/);
    expect(yearEndRetirementReason("2026-12-25", 2026, "2026-12-25")).toMatch(/対象外/);
    expect(yearEndRetirementReason("2026-12-31", 2026, "2026-12-25")).toBeNull();
    // No December run yet: a leaver before December is out, one in December not decided here.
    expect(yearEndRetirementReason("2026-11-30", 2026, null)).toMatch(/対象外/);
    expect(yearEndRetirementReason("2026-12-20", 2026, null)).toBeNull();
    // Left in an earlier year: out; leaves next year: in.
    expect(yearEndRetirementReason("2025-12-31", 2026, "2026-12-25")).toMatch(/対象外/);
    expect(yearEndRetirementReason("2027-01-31", 2026, "2026-12-25")).toBeNull();
    expect(yearEndRetirementReason(null, 2026, null)).toBeNull();
  });
});

describe("the filing deadlines (§12.3・§12.4)", () => {
  it("adds the 4 filings of an insured employee with 住民税", () => {
    const slots = leaveFilingSlots({
      employeeId: "emp_leaver",
      name: "テスト 花子",
      leftOn: "2026-11-30",
      socialInsured: true,
      employmentInsured: true,
      residentTax: 10_000n,
    });
    expect(slots.map((slot) => [slot.type, slot.ruleKey, slot.dueDate])).toEqual([
      ["social_insurance_loss", "payroll.leave.emp_leaver.social_insurance_loss", "2026-12-06"],
      ["resident_tax_change", "payroll.leave.emp_leaver.resident_tax_change", "2026-12-10"],
      [
        "employment_insurance_loss",
        "payroll.leave.emp_leaver.employment_insurance_loss",
        "2026-12-11",
      ],
      ["withholding_slip", "payroll.leave.emp_leaver.withholding_slip", "2026-12-30"],
    ]);
    expect(slots[0]!.title).toBe(
      "健康保険・厚生年金保険 被保険者資格喪失届の提出（テスト 花子さん・2026/11/30 退職）",
    );
    // Filings, not payments: completed from the deadlines screen.
    for (const slot of slots) expect(paymentCategoryOfRuleKey(slot.ruleKey)).toBeNull();
  });

  it("adds only the 源泉徴収票 for an officer without insurance or 住民税", () => {
    const slots = leaveFilingSlots({
      employeeId: "emp_officer",
      name: "テスト 太郎",
      leftOn: "2027-01-31",
      socialInsured: false,
      employmentInsured: false,
      residentTax: 0n,
    });
    expect(slots.map((slot) => [slot.type, slot.dueDate])).toEqual([
      ["withholding_slip", "2027-02-28"],
    ]);
  });

  it("clamps 1 か月 to the month's end", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("files 給与支払報告書 and 合計表 by 1 月 31 日, a weekend moved to Monday", () => {
    // 2027-01-31 is a Sunday.
    expect(annualReportDueDate(2026)).toBe("2027-02-01");
    // 2026-01-31 is a Saturday, 2029-01-31 a Wednesday.
    expect(annualReportDueDate(2025)).toBe("2026-02-02");
    expect(annualReportDueDate(2028)).toBe("2029-01-31");
    expect(annualReportSlot(2026)).toEqual({
      ruleKey: "payroll.annual_report.2026",
      title: "給与支払報告書（市区町村）・法定調書合計表（税務署）の提出（2026 年分）",
      dueDate: "2027-02-01",
    });
    expect(paymentCategoryOfRuleKey("payroll.annual_report.2026")).toBeNull();
  });
});
