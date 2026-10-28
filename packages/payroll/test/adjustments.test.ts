/**
 * 調整 (22-payroll §4, stage 2): signed corrections added to the deductions of a month.
 */
import { describe, expect, it } from "vitest";
import {
  calculatePayroll,
  PayrollInputError,
  type PayrollInput,
  type PayrollInputErrorCode,
} from "../src";

/** §8.4 役員報酬 300,000 円・扶養 0 人: 社会保険 42,675 円、源泉 6,430 円、差引 250,895 円. */
function officer(overrides: Partial<PayrollInput> = {}): PayrollInput {
  return {
    paymentDate: "2026-12-25",
    premiumMonth: "2026-11",
    worker: "officer",
    taxablePay: 300_000n,
    nonTaxablePay: 0n,
    standardRemuneration: { health: 300_000n, pension: 300_000n },
    coverage: { health: true, care: false, pension: true, employment: false },
    taxColumn: { column: "kou", dependents: 0 },
    residentTax: 0n,
    ...overrides,
  };
}

const untyped = <T>(value: unknown): T => value as T;

function issuesOf(value: PayrollInput): { code: PayrollInputErrorCode; field: string }[] {
  try {
    calculatePayroll(value);
  } catch (error) {
    if (!(error instanceof PayrollInputError)) throw error;
    return error.issues.map(({ code, field }) => ({ code, field }));
  }
  throw new Error("expected a PayrollInputError");
}

describe("calculatePayroll adjustments (調整)", () => {
  it("without adjustments the totals equal the table values", () => {
    const result = calculatePayroll(officer());
    expect(result.adjustments).toEqual({ incomeTax: 0n, socialInsurance: 0n });
    expect(result.incomeTax).toBe(6_430n);
    expect(result.incomeTaxTotal).toBe(6_430n);
    expect(result.socialInsuranceEmployeeTotal).toBe(42_675n);
    expect(result.totalDeductions).toBe(49_105n);
    expect(result.netPay).toBe(250_895n);
    expect(
      calculatePayroll(officer({ adjustments: { incomeTax: 0n, socialInsurance: 0n } })),
    ).toEqual(result);
  });

  it("adds the income tax adjustment to the table tax only", () => {
    const result = calculatePayroll(
      officer({ adjustments: { incomeTax: -2_000n, socialInsurance: 0n } }),
    );
    expect(result.withholdingBase).toBe(257_325n);
    expect(result.incomeTax).toBe(6_430n);
    expect(result.incomeTaxTotal).toBe(4_430n);
    expect(result.totalDeductions).toBe(42_675n + 4_430n);
    expect(result.netPay).toBe(252_895n);
  });

  it("adds the social insurance adjustment to the deduction and lowers the withholding base", () => {
    const result = calculatePayroll(
      officer({ adjustments: { incomeTax: 0n, socialInsurance: 3_000n } }),
    );
    expect(result.socialInsurance.employeeTotal).toBe(42_675n);
    expect(result.socialInsuranceEmployeeTotal).toBe(45_675n);
    expect(result.withholdingBase).toBe(254_325n);
    const tax = 6_320n; // 254,000〜257,000 の行（甲 0 人）
    expect(result.incomeTax).toBe(tax);
    expect(result.incomeTaxTotal).toBe(tax);
    expect(result.totalDeductions).toBe(45_675n + tax);
    expect(result.netPay).toBe(300_000n - 45_675n - tax);
  });

  it("a negative social insurance adjustment raises the withholding base", () => {
    const result = calculatePayroll(
      officer({ adjustments: { incomeTax: 0n, socialInsurance: -2_675n } }),
    );
    expect(result.socialInsuranceEmployeeTotal).toBe(40_000n);
    expect(result.withholdingBase).toBe(260_000n);
    expect(result.netPay + result.totalDeductions).toBe(result.grossPay);
  });

  it("lets the deductions become negative: the net pay then exceeds the gross pay", () => {
    const result = calculatePayroll(
      officer({ adjustments: { incomeTax: -60_000n, socialInsurance: -50_000n } }),
    );
    expect(result.socialInsuranceEmployeeTotal).toBe(-7_325n);
    expect(result.withholdingBase).toBe(307_325n);
    expect(result.incomeTaxTotal).toBe(result.incomeTax - 60_000n);
    expect(result.totalDeductions < 0n).toBe(true);
    expect(result.netPay > result.grossPay).toBe(true);
    expect(result.netPay + result.totalDeductions).toBe(result.grossPay);
  });

  it("rejects adjustments that are not bigint yen, naming each field", () => {
    expect(
      issuesOf(officer({ adjustments: untyped({ incomeTax: 100, socialInsurance: "1" }) })),
    ).toEqual([
      { code: "INVALID_ADJUSTMENT", field: "adjustments.incomeTax" },
      { code: "INVALID_ADJUSTMENT", field: "adjustments.socialInsurance" },
    ]);
    expect(issuesOf(officer({ adjustments: untyped({ incomeTax: 0n }) }))).toEqual([
      { code: "INVALID_ADJUSTMENT", field: "adjustments.socialInsurance" },
    ]);
    expect(issuesOf(officer({ adjustments: untyped(null) }))).toEqual([
      { code: "INVALID_ADJUSTMENT", field: "adjustments.incomeTax" },
      { code: "INVALID_ADJUSTMENT", field: "adjustments.socialInsurance" },
    ]);
  });
});
