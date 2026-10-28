/**
 * Invariants of 22-payroll §8.5 over a sweep of inputs (a deterministic grid instead of random
 * cases, so a failure always reproduces):
 * - 差引支給額 + 控除の合計 = 総支給額, and every employee share is a non-negative integer;
 * - pinning the versions a result names reproduces it exactly, and another version only changes
 *   the results it is pinned into;
 * - the tax never falls as the amount grows.
 */
import { describe, expect, it } from "vitest";
import {
  add,
  aggregateSocialInsurance,
  calculatePayroll,
  compare,
  determineStandardRemuneration,
  findKenpoTable,
  findPensionTable,
  findTableById,
  findWithholdingTable,
  half,
  ratio,
  subtract,
  withholdingTax,
  type PayrollCoverage,
  type PayrollInput,
  type PayrollResult,
  type PayrollTables,
  type Rational,
  type TaxColumn,
  type WithholdingTable,
} from "../src";

const AMOUNTS = [
  0n,
  1n,
  58_000n,
  88_000n,
  104_999n,
  105_000n,
  110_999n,
  111_000n,
  199_999n,
  211_715n,
  257_325n,
  739_999n,
  740_000n,
  740_001n,
  790_000n,
  1_709_999n,
  1_710_000n,
  1_720_000n,
  3_499_999n,
  3_500_000n,
  3_500_001n,
  5_000_000n,
  ...Array.from({ length: 60 }, (_, index) => BigInt(index) * 61_717n + 9_999n),
];

const COVERAGES: { worker: "officer" | "employee"; coverage: PayrollCoverage }[] = [
  { worker: "officer", coverage: { health: true, care: false, pension: true, employment: false } },
  { worker: "officer", coverage: { health: true, care: true, pension: true, employment: false } },
  { worker: "officer", coverage: { health: true, care: false, pension: false, employment: false } },
  {
    worker: "officer",
    coverage: { health: false, care: false, pension: false, employment: false },
  },
  { worker: "employee", coverage: { health: true, care: false, pension: true, employment: true } },
  { worker: "employee", coverage: { health: true, care: true, pension: true, employment: true } },
];

const COLUMNS: TaxColumn[] = [
  { column: "kou", dependents: 0 },
  { column: "kou", dependents: 2 },
  { column: "kou", dependents: 7 },
  { column: "kou", dependents: 9 },
  { column: "otsu" },
  { column: "otsu", secondaryDependents: 1 },
];

const PAYMENTS = [
  { paymentDate: "2026-12-25", premiumMonth: "2026-11" },
  { paymentDate: "2027-01-25", premiumMonth: "2026-12" },
] as const;

function* inputs(): Generator<PayrollInput> {
  let index = 0;
  for (const { paymentDate, premiumMonth } of PAYMENTS) {
    const tables = { kenpo: findKenpoTable(premiumMonth), pension: findPensionTable(premiumMonth) };
    for (const taxablePay of AMOUNTS) {
      const nonTaxablePay = index % 3 === 0 ? 15_000n : 0n;
      const smr = determineStandardRemuneration(tables, taxablePay + nonTaxablePay);
      for (const { worker, coverage } of COVERAGES) {
        for (const taxColumn of COLUMNS) {
          index += 1;
          yield {
            paymentDate,
            premiumMonth,
            worker,
            taxablePay,
            nonTaxablePay,
            standardRemuneration: { health: smr.health.smr, pension: smr.pension.smr },
            coverage,
            taxColumn,
            residentTax: index % 2 === 0 ? 12_300n : 0n,
          };
        }
      }
    }
  }
}

/** |employee − full ÷ 2| ≤ 50 銭, a tie rounding down. */
function expectHalfDown(full: Rational, employee: bigint): void {
  const difference = subtract(half(full), ratio(employee));
  expect(compare(difference, ratio(1n, 2n))).toBeLessThanOrEqual(0);
  expect(compare(difference, ratio(-1n, 2n))).toBe(1);
}

function pinned(result: PayrollResult): Partial<PayrollTables> {
  const byId = <T>(id: string | undefined): T | undefined =>
    id === undefined ? undefined : (findTableById(id) as T | undefined);
  return {
    withholding: byId(result.tables.withholding.id),
    kenpo: byId(result.tables.kenpo.id),
    pension: byId(result.tables.pension.id),
    employment: byId(result.tables.employment?.id),
  };
}

describe("§8.5 invariants of calculatePayroll", () => {
  const cases = [...inputs()];
  const results = cases.map((input) => calculatePayroll(input));

  it(`net pay + deductions = gross pay over ${cases.length} inputs`, () => {
    cases.forEach((input, index) => {
      const result = results[index]!;
      const insurance =
        result.socialInsurance.employeeTotal + (result.employmentInsurance?.employee ?? 0n);
      expect(result.grossPay).toBe(input.taxablePay + input.nonTaxablePay);
      expect(result.netPay + result.totalDeductions).toBe(result.grossPay);
      expect(result.totalDeductions).toBe(insurance + result.incomeTax + input.residentTax);
      expect(result.withholdingBase).toBe(input.taxablePay - insurance);
    });
  });

  it("every employee share is a non-negative integer and rounds by the 50 銭 rule", () => {
    for (const result of results) {
      const { health, pension } = result.socialInsurance;
      for (const value of [health.employee, pension.employee, result.incomeTax]) {
        expect(typeof value).toBe("bigint");
        expect(value >= 0n).toBe(true);
      }
      expectHalfDown(health.full, health.employee);
      expectHalfDown(pension.full, pension.employee);
      expect(add(health.employer, ratio(health.employee))).toEqual(health.full);
      expect(add(pension.employer, ratio(pension.employee))).toEqual(pension.full);
      const { breakdown } = health;
      expect(add(add(breakdown.health, breakdown.care), breakdown.childSupport)).toEqual(
        health.full,
      );
      const employment = result.employmentInsurance;
      if (employment) {
        expect(employment.employee >= 0n).toBe(true);
        expect(employment.base).toBe(result.grossPay);
      }
    }
  });

  it("pinning the versions a result names reproduces it exactly", () => {
    cases.forEach((input, index) => {
      if (index % 5 !== 0) return;
      expect(calculatePayroll({ ...input, tables: pinned(results[index]!) })).toStrictEqual(
        results[index],
      );
    });
  });

  it("another version changes only the results it is pinned into", () => {
    const original = findWithholdingTable("2026-12-25");
    const corrected: WithholdingTable = {
      ...original,
      id: "withholding-monthly-2026-corrected-fixture",
      bands: original.bands.map((band) => ({ ...band, kou: band.kou.map((tax) => tax + 10n) })),
    };
    const input = cases[0]!;
    const before = calculatePayroll({ ...input, taxablePay: 300_000n });
    const withCorrection = calculatePayroll({
      ...input,
      taxablePay: 300_000n,
      tables: { withholding: corrected },
    });
    expect(withCorrection.tables.withholding.id).toBe(corrected.id);
    expect(withCorrection.incomeTax).toBe(before.incomeTax + 10n);
    expect(calculatePayroll({ ...input, taxablePay: 300_000n })).toStrictEqual(before);
    expect(
      calculatePayroll({ ...input, taxablePay: 300_000n, tables: pinned(before) }),
    ).toStrictEqual(before);
  });

  it("the office aggregate splits the truncated total into employee and employer shares", () => {
    const people = results.slice(0, 40).map((result) => result.socialInsurance);
    const aggregate = aggregateSocialInsurance(people);
    expect(aggregate.employeeTotal + aggregate.employerTotal).toBe(aggregate.total);
    expect(aggregate.health.employer >= 0n).toBe(true);
    expect(aggregate.pension.employer >= 0n).toBe(true);
    expect(aggregate.employeeTotal).toBe(people.reduce((sum, p) => sum + p.employeeTotal, 0n));
  });
});

describe("§8.5 the tax never falls as the amount grows", () => {
  const columns: TaxColumn[] = [
    ...Array.from({ length: 10 }, (_, dependents): TaxColumn => ({ column: "kou", dependents })),
    { column: "otsu" },
    { column: "otsu", secondaryDependents: 2 },
  ];
  it.each([findWithholdingTable("2026-06-30"), findWithholdingTable("2027-06-30")])(
    "$id",
    (table) => {
      const falls: string[] = [];
      for (const column of columns) {
        let previous = -1n;
        for (let amount = 0n; amount <= 4_000_000n; amount += 997n) {
          const tax = withholdingTax(table, column, amount);
          if (tax < previous) falls.push(`${JSON.stringify(column)} at ${amount}`);
          previous = tax;
        }
      }
      expect(falls).toEqual([]);
    },
  );
});
