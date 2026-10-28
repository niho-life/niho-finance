/**
 * Input validation of calculatePayroll (22-payroll §4) and the `tables` option.
 */
import { describe, expect, it } from "vitest";
import {
  calculatePayroll,
  findEmploymentInsuranceTable,
  findKenpoTable,
  findPensionTable,
  findWithholdingTable,
  PayrollInputError,
  type PayrollInput,
  type PayrollInputErrorCode,
} from "../src";

function input(overrides: Partial<PayrollInput> = {}): PayrollInput {
  return {
    paymentDate: "2026-12-25",
    premiumMonth: "2026-11",
    worker: "employee",
    taxablePay: 250_000n,
    nonTaxablePay: 10_000n,
    standardRemuneration: { health: 260_000n, pension: 260_000n },
    coverage: { health: true, care: false, pension: true, employment: true },
    taxColumn: { column: "kou", dependents: 0 },
    residentTax: 10_000n,
    ...overrides,
  };
}

/** The codes and fields of the PayrollInputError thrown for `value`. */
function issuesOf(value: PayrollInput): { code: PayrollInputErrorCode; field: string }[] {
  try {
    calculatePayroll(value);
  } catch (error) {
    if (!(error instanceof PayrollInputError)) throw error;
    for (const issue of error.issues) expect(issue.message).not.toBe("");
    return error.issues.map(({ code, field }) => ({ code, field }));
  }
  throw new Error("expected a PayrollInputError");
}

/** Lets a test pass a value the types forbid, as an untyped caller could. */
const untyped = <T>(value: unknown): T => value as T;

describe("calculatePayroll input validation", () => {
  it("accepts the valid input", () => {
    expect(calculatePayroll(input()).netPay).toBe(206_945n);
  });

  it("rejects negative and non-integer amounts", () => {
    expect(issuesOf(input({ taxablePay: -1n }))).toEqual([
      { code: "INVALID_AMOUNT", field: "taxablePay" },
    ]);
    expect(issuesOf(input({ nonTaxablePay: untyped(10_000) }))).toEqual([
      { code: "INVALID_AMOUNT", field: "nonTaxablePay" },
    ]);
    expect(issuesOf(input({ residentTax: untyped(0.5) }))).toEqual([
      { code: "INVALID_AMOUNT", field: "residentTax" },
    ]);
    expect(
      issuesOf(input({ standardRemuneration: { health: -260_000n, pension: untyped("260000") } })),
    ).toEqual([
      { code: "INVALID_AMOUNT", field: "standardRemuneration.health" },
      { code: "INVALID_AMOUNT", field: "standardRemuneration.pension" },
    ]);
  });

  it("rejects a non-integer or negative number of dependents", () => {
    expect(issuesOf(input({ taxColumn: { column: "kou", dependents: 1.5 } }))).toEqual([
      { code: "INVALID_DEPENDENTS", field: "taxColumn.dependents" },
    ]);
    expect(issuesOf(input({ taxColumn: { column: "kou", dependents: -1 } }))).toEqual([
      { code: "INVALID_DEPENDENTS", field: "taxColumn.dependents" },
    ]);
    expect(issuesOf(input({ taxColumn: { column: "otsu", secondaryDependents: 0.5 } }))).toEqual([
      { code: "INVALID_DEPENDENTS", field: "taxColumn.secondaryDependents" },
    ]);
    expect(issuesOf(input({ taxColumn: untyped({ column: "hei" }) }))).toEqual([
      { code: "INVALID_DEPENDENTS", field: "taxColumn.column" },
    ]);
  });

  it("rejects an officer with employment insurance, and care without health insurance", () => {
    expect(issuesOf(input({ worker: "officer" }))).toEqual([
      { code: "OFFICER_EMPLOYMENT_INSURANCE", field: "coverage.employment" },
    ]);
    expect(
      issuesOf(input({ coverage: { health: false, care: true, pension: true, employment: true } })),
    ).toEqual([{ code: "CARE_WITHOUT_HEALTH", field: "coverage.care" }]);
  });

  it("rejects a standard remuneration that is not a grade amount of a covered insurance", () => {
    expect(
      issuesOf(input({ standardRemuneration: { health: 255_000n, pension: 260_000n } })),
    ).toEqual([{ code: "UNKNOWN_STANDARD_REMUNERATION", field: "standardRemuneration.health" }]);
    expect(
      issuesOf(input({ standardRemuneration: { health: 260_000n, pension: 58_000n } })),
    ).toEqual([{ code: "UNKNOWN_STANDARD_REMUNERATION", field: "standardRemuneration.pension" }]);
    // Not covered: the recorded amount is not used and not checked.
    const notCovered = calculatePayroll(
      input({
        standardRemuneration: { health: 260_000n, pension: 0n },
        coverage: { health: true, care: false, pension: false, employment: true },
      }),
    );
    expect(notCovered.socialInsurance.pension.employee).toBe(0n);
    expect(notCovered.socialInsurance.childContribution).toEqual({ num: 0n, den: 1n });
  });

  it("collects every problem in one error", () => {
    const codes = issuesOf(
      input({
        paymentDate: untyped("2026-02-30"),
        premiumMonth: untyped("2026-13"),
        worker: untyped("contractor"),
        taxablePay: -1n,
        coverage: untyped({ health: true, care: "yes", pension: true, employment: true }),
      }),
    ).map((issue) => issue.code);
    expect(codes).toEqual([
      "INVALID_DATE",
      "INVALID_PREMIUM_MONTH",
      "INVALID_WORKER",
      "INVALID_AMOUNT",
      "INVALID_COVERAGE",
    ]);
  });
});

describe("the tables option", () => {
  it("pins any subset of tables and takes the rest from the registry", () => {
    const pinned = calculatePayroll(input({ tables: { kenpo: findKenpoTable("2026-11") } }));
    expect(pinned).toStrictEqual(calculatePayroll(input()));
    const all = calculatePayroll(
      input({
        tables: {
          withholding: findWithholdingTable("2026-12-25"),
          kenpo: findKenpoTable("2026-11"),
          pension: findPensionTable("2026-11"),
          employment: findEmploymentInsuranceTable("2026-11"),
        },
      }),
    );
    expect(all).toStrictEqual(calculatePayroll(input()));
  });

  it("rejects a pinned table that is not in force or of another kind", () => {
    expect(
      issuesOf(input({ tables: { withholding: findWithholdingTable("2027-01-01") } })),
    ).toEqual([{ code: "TABLE_NOT_EFFECTIVE", field: "tables.withholding" }]);
    expect(issuesOf(input({ tables: { pension: untyped(findKenpoTable("2026-11")) } }))).toEqual([
      { code: "TABLE_NOT_EFFECTIVE", field: "tables.pension" },
    ]);
  });

  it("ignores the employment table when not insured", () => {
    const result = calculatePayroll(
      input({
        coverage: { health: true, care: false, pension: true, employment: false },
        tables: { employment: findEmploymentInsuranceTable("2026-11") },
      }),
    );
    expect(result.employmentInsurance).toBeNull();
    expect(result.tables.employment).toBeNull();
  });
});
