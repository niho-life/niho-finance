import { describe, expect, it } from "vitest";
import {
  exclusiveTaxAmount,
  exclusiveToInclusive,
  inclusiveTaxAmount,
  resolveTaxRule,
  STANDARD_TAX_RATE_RULES,
  sumByRateWithSingleRounding,
  TAX_CATEGORIES,
  TAX_CATEGORY_CODES,
  type TaxRateRule,
} from "../src";

describe("consumption tax arithmetic", () => {
  it("inclusive tax = amount × rate ÷ (100 + rate), truncated", () => {
    expect(inclusiveTaxAmount(1_100n, 10)).toBe(100n);
    expect(inclusiveTaxAmount(1_080n, 8)).toBe(80n);
    expect(inclusiveTaxAmount(1_000n, 10)).toBe(90n); // 90.90…
    expect(inclusiveTaxAmount(396n, 10)).toBe(36n);
    expect(inclusiveTaxAmount(99n, 8)).toBe(7n); // 7.33…
    expect(inclusiveTaxAmount(1_000n, 0)).toBe(0n);
    expect(inclusiveTaxAmount(-1_100n, 10)).toBe(-100n);
    expect(() => inclusiveTaxAmount(100n, 8.5)).toThrow(/INVALID_TAX_RATE/);
    expect(() => inclusiveTaxAmount(100n, -1)).toThrow(/INVALID_TAX_RATE/);
  });

  it("exclusive amounts", () => {
    expect(exclusiveTaxAmount(1_000n, 10)).toBe(100n);
    expect(exclusiveTaxAmount(999n, 8)).toBe(79n); // 79.92
    expect(exclusiveToInclusive(1_000n, 10)).toBe(1_100n);
    expect(exclusiveToInclusive(999n, 8)).toBe(1_078n);
  });

  it("invoices round once per rate", () => {
    const lines = [
      { amount: 1_000n, ratePercent: 10 },
      { amount: 1_000n, ratePercent: 10 },
      { amount: 1_000n, ratePercent: 10 },
      { amount: 540n, ratePercent: 8 },
    ];
    expect(sumByRateWithSingleRounding(lines)).toEqual([
      {
        ratePercent: 10,
        lineCount: 3,
        amount: 3_000n,
        taxAmount: 272n,
        amountInclusive: 3_000n,
        amountExclusive: 2_728n,
      },
      {
        ratePercent: 8,
        lineCount: 1,
        amount: 540n,
        taxAmount: 40n,
        amountInclusive: 540n,
        amountExclusive: 500n,
      },
    ]);
    // per-line rounding would give 90 × 3 = 270
    expect(
      lines.slice(0, 3).reduce((t, l) => t + inclusiveTaxAmount(l.amount, l.ratePercent), 0n),
    ).toBe(270n);
  });
});

describe("tax rate rules", () => {
  const rule = (code: string, date: string) =>
    resolveTaxRule(code, date as never, STANDARD_TAX_RATE_RULES);

  it("has a rule for every standard tax category code", () => {
    for (const code of TAX_CATEGORY_CODES) {
      expect(rule(code, "2026-11-02"), code).toBeDefined();
    }
    expect(TAX_CATEGORIES.map((category) => category.code)).toEqual([...TAX_CATEGORY_CODES]);
  });

  it("resolves the standard and reduced rates", () => {
    expect(rule("sales_10", "2026-11-02")?.ratePercent).toBe(10);
    expect(rule("purchase_8r", "2026-11-02")?.ratePercent).toBe(8);
    expect(rule("purchase_10", "2026-11-02")?.deductiblePercent).toBe(100);
    expect(rule("na", "2026-11-02")?.ratePercent).toBe(0);
  });

  it("follows the transitional credit ratio for purchases without an invoice", () => {
    const ratio = (date: string) => rule("purchase_10_ni", date)?.deductiblePercent;
    expect(ratio("2026-09-30")).toBe(80);
    expect(ratio("2026-10-01")).toBe(70);
    expect(ratio("2028-09-30")).toBe(70);
    expect(ratio("2028-10-01")).toBe(50);
    expect(ratio("2030-09-30")).toBe(50);
    expect(ratio("2030-10-01")).toBe(30);
    expect(ratio("2031-09-30")).toBe(30);
    expect(ratio("2031-10-01")).toBe(0);
    expect(rule("purchase_8r_ni", "2027-06-01")).toMatchObject({
      ratePercent: 8,
      deductiblePercent: 70,
    });
  });

  it("keeps the proposed 1% food rate disabled until it is enacted", () => {
    expect(rule("sales_8r", "2027-06-01")?.ratePercent).toBe(8);
    const enacted: TaxRateRule[] = STANDARD_TAX_RATE_RULES.map((r) =>
      r.ratePercent === 1 ? { ...r, enabled: true } : r,
    );
    const enactedRule = (code: string, date: string) =>
      resolveTaxRule(code, date as never, enacted);
    expect(enactedRule("sales_8r", "2027-03-31")?.ratePercent).toBe(8);
    expect(enactedRule("sales_8r", "2027-04-01")?.ratePercent).toBe(1);
    expect(enactedRule("sales_8r", "2029-04-01")?.ratePercent).toBe(8);
    expect(enactedRule("purchase_8r_ni", "2027-06-01")).toMatchObject({
      ratePercent: 1,
      deductiblePercent: 70,
    });
    expect(enactedRule("purchase_8r_ni", "2028-11-01")).toMatchObject({
      ratePercent: 1,
      deductiblePercent: 50,
    });
    expect(enactedRule("purchase_8r_ni", "2029-04-01")).toMatchObject({
      ratePercent: 8,
      deductiblePercent: 50,
    });
  });

  it("returns undefined before any rule and rejects ambiguous data", () => {
    expect(rule("sales_10", "2019-09-30")).toBeUndefined();
    const duplicated: TaxRateRule[] = [
      {
        taxCategoryCode: "x",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        ratePercent: 10,
        deductiblePercent: null,
        enabled: true,
      },
      {
        taxCategoryCode: "x",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        ratePercent: 8,
        deductiblePercent: null,
        enabled: true,
      },
    ];
    expect(() => resolveTaxRule("x", "2026-06-01", duplicated)).toThrow(/TAX_RULE_AMBIGUOUS/);
  });
});
