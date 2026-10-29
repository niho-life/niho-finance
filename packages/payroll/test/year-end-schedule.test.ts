/**
 * The 年末調整's settlement in the payment schedule (22-payroll §11.4): it is added to the 源泉所得税
 * deadline of the last pay run's month (a refund is taken off), a deadline that would be negative
 * is 0 with the rest of the refund applied to the next 源泉所得税 deadlines in due-date order, and
 * the amounts always add up to what was withheld minus the refund still to apply.
 */
import { describe, expect, it } from "vitest";
import {
  payrollSchedule,
  runPaymentSlots,
  scheduledPayments,
  summarizeYearEndSettlement,
  withholdingSlot,
  type PayrollRunSummary,
  type PayrollScheduleSlotRef,
  type YearMonth,
} from "../src";

/** A run that only withheld 源泉所得税 (the other categories do not matter here). */
function run(payMonth: YearMonth, incomeTax: bigint, specialDue = false): PayrollRunSummary {
  return {
    payMonth,
    premiumMonth: payMonth,
    withholdingSpecialDue: specialDue,
    residentTaxSpecialDue: false,
    headcount: 1,
    grossPay: 0n,
    totalDeductions: 0n,
    netPay: 0n,
    incomeTax,
    residentTax: 0n,
    socialInsuranceEmployee: 0n,
    socialInsuranceEmployer: 0n,
    employmentInsuranceEmployee: 0n,
  };
}

const settlement = (payMonth: YearMonth, difference: bigint, specialDue = false) =>
  summarizeYearEndSettlement({ payMonth, withholdingSpecialDue: specialDue, difference });

const slotsOf = (runs: readonly PayrollRunSummary[]) => {
  const slots = new Map<string, PayrollScheduleSlotRef>();
  for (const summary of runs) {
    for (const { slot } of runPaymentSlots(summary)) slots.set(slot.ruleKey, slot);
  }
  return [...slots.values()];
};

function amounts(runs: readonly PayrollRunSummary[]) {
  const result = scheduledPayments(slotsOf(runs), runs);
  return [...result.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([ruleKey, payment]) => [
      ruleKey,
      payment.derived,
      payment.total,
      payment.refundApplied,
      payment.refundCarried,
    ]);
}

describe("the settlement in the schedule", () => {
  it("adds a shortfall to the December deadline and takes a refund off it", () => {
    expect(runPaymentSlots(settlement("2026-12", 0n))).toEqual([]);
    const [only] = runPaymentSlots(settlement("2026-12", -1_000n));
    expect(only?.slot).toEqual(withholdingSlot("2026-12", false));
    expect(only?.amount).toEqual({ total: -1_000n, withheld: -1_000n, employer: 0n });
    expect(
      amounts([
        run("2026-12", 50_000n),
        settlement("2026-12", 3_000n),
        settlement("2026-12", -8_000n),
      ]),
    ).toEqual([["payroll.withholding.2026-12", 45_000n, 45_000n, 0n, 0n]]);
    const schedule = payrollSchedule([run("2026-12", 50_000n), settlement("2026-12", -8_000n)]);
    expect(schedule).toEqual([
      expect.objectContaining({
        ruleKey: "payroll.withholding.2026-12",
        total: 42_000n,
        withheld: 42_000n,
        payMonths: ["2026-12"],
        yearEndMonths: ["2026-12"],
      }),
    ]);
  });

  it("goes into the half year with 納期の特例", () => {
    expect(
      amounts([
        run("2026-07", 10_000n, true),
        run("2026-12", 10_000n, true),
        settlement("2026-12", -15_000n, true),
      ]),
    ).toEqual([["payroll.withholding.2026-H2", 5_000n, 5_000n, 0n, 0n]]);
  });

  it("shows a negative deadline as 0 and applies the rest to the next deadlines in due-date order", () => {
    const runs = [
      run("2026-12", 10_000n),
      settlement("2026-12", -30_000n),
      run("2027-01", 5_000n),
      run("2027-02", 40_000n),
      run("2027-03", 7_000n),
    ];
    expect(amounts(runs)).toEqual([
      // 「納付なし。過納 20,000 円は翌月以降の源泉所得税から充当」.
      ["payroll.withholding.2026-12", -20_000n, 0n, 0n, 20_000n],
      ["payroll.withholding.2027-01", 5_000n, 0n, 5_000n, 15_000n],
      ["payroll.withholding.2027-02", 40_000n, 25_000n, 15_000n, 0n],
      ["payroll.withholding.2027-03", 7_000n, 7_000n, 0n, 0n],
    ]);
    const result = scheduledPayments(slotsOf(runs), runs);
    const sum = [...result.values()].reduce((total, payment) => total + payment.total, 0n);
    const withheld = runs.reduce((total, summary) => total + summary.incomeTax, 0n);
    expect(sum).toBe(withheld);
  });

  it("keeps the refund still to apply when no later deadline can take it", () => {
    const runs = [run("2026-12", 10_000n), settlement("2026-12", -30_000n), run("2027-01", 5_000n)];
    const result = scheduledPayments(slotsOf(runs), runs);
    const last = result.get("payroll.withholding.2027-01");
    expect(last).toMatchObject({ total: 0n, refundApplied: 5_000n, refundCarried: 15_000n });
    const sum = [...result.values()].reduce((total, payment) => total + payment.total, 0n);
    // The amounts minus the refund still to apply = what the runs withheld (−15,000).
    expect(sum - (last?.refundCarried ?? 0n)).toBe(10_000n - 30_000n + 5_000n);
  });

  it("orders by due date across 納期の特例 and monthly deadlines and leaves the other categories alone", () => {
    const social: PayrollRunSummary = {
      ...run("2027-01", 0n),
      premiumMonth: "2026-12",
      socialInsuranceEmployee: 1_000n,
      socialInsuranceEmployer: 1_000n,
    };
    const runs = [
      run("2026-12", 1_000n),
      settlement("2026-12", -4_000n),
      // 2026-H2 is due 2027-01-20: after 2026-12 (2027-01-10), before 2027-01 (2027-02-10).
      run("2026-10", 2_000n, true),
      run("2027-01", 6_000n),
      social,
    ];
    expect(amounts(runs)).toEqual([
      ["payroll.social_insurance.2026-12", 2_000n, 2_000n, 0n, 0n],
      ["payroll.withholding.2026-12", -3_000n, 0n, 0n, 3_000n],
      ["payroll.withholding.2026-H2", 2_000n, 0n, 2_000n, 1_000n],
      ["payroll.withholding.2027-01", 6_000n, 5_000n, 1_000n, 0n],
    ]);
  });
});
