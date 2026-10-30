import type { InvoiceFormOptions } from "@niho-finance/db";
import { STANDARD_TAX_RATE_RULES } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import {
  defaultRevenueAccountId,
  defaultSegmentId,
  draftLineTotals,
} from "@/app/(app)/invoices/_lib/line-totals";

/** 18 §3.2's fixture as the form holds it (text). */
const LINES = [
  { quantity: "1", unitPrice: "100,000", taxCategoryCode: "sales_10" },
  { quantity: "2", unitPrice: "15005", taxCategoryCode: "sales_10" },
  { quantity: "3", unitPrice: "345", taxCategoryCode: "sales_8r" },
  { quantity: "1", unitPrice: "-5,005", taxCategoryCode: "sales_10" },
];

const options = {
  partners: [
    { id: "p-revenue", defaultAccountId: "a-other", defaultSegmentId: "s-platform" },
    { id: "p-expense", defaultAccountId: "a-expense", defaultSegmentId: "s-off" },
  ],
  revenueAccounts: [
    { id: "a-4040", defaultSegmentId: null, isActive: true },
    { id: "a-other", defaultSegmentId: "s-contract", isActive: true },
  ],
  segments: [
    { id: "s-contract", isActive: true },
    { id: "s-platform", isActive: true },
    { id: "s-off", isActive: false },
  ],
  defaults: { revenueAccountId: "a-4040", segmentId: "s-contract", taxCategoryCode: "sales_10" },
} as unknown as InvoiceFormOptions;

describe("draftLineTotals (the forms' totals, 18 §3.2)", () => {
  it("rounds once per rate like the server", () => {
    const result = draftLineTotals(LINES, {
      pricesIncludeTax: false,
      date: "2026-12-01",
      taxRules: STANDARD_TAX_RATE_RULES,
    });
    expect(result.totals?.total).toBe(138_622n);
    expect(result.totals?.rates.map((rate) => rate.taxAmount)).toEqual([12_500n, 82n]);
    expect(result.incomplete).toBe(false);
    expect(result.parsed[3]).toEqual({
      quantity: 100n,
      unitPrice: -5_005n,
      taxCategoryCode: "sales_10",
    });
  });

  it("leaves out incomplete lines and computes nothing without a date", () => {
    const partial = draftLineTotals(
      [...LINES, { quantity: "", unitPrice: "", taxCategoryCode: "sales_10" }],
      {
        pricesIncludeTax: false,
        date: "2026-12-01",
        taxRules: STANDARD_TAX_RATE_RULES,
      },
    );
    expect(partial.incomplete).toBe(true);
    expect(partial.parsed[4]).toBeNull();
    expect(partial.totals?.total).toBe(138_622n);
    const undated = draftLineTotals(LINES, {
      pricesIncludeTax: false,
      date: null,
      taxRules: STANDARD_TAX_RATE_RULES,
    });
    expect(undated.totals).toBeNull();
    expect(undated.ruleProblems.size).toBe(0);
  });

  it("names the line whose category has no rule on the date", () => {
    const result = draftLineTotals(LINES, {
      pricesIncludeTax: false,
      date: "2026-12-01",
      taxRules: [],
    });
    expect(result.totals).toBeNull();
    expect([...result.ruleProblems.keys()]).toEqual(expect.arrayContaining([0]));
  });
});

describe("the defaults of 会計 (18 §8)", () => {
  it("takes the partner's revenue account, else 4040", () => {
    expect(defaultRevenueAccountId(options, "p-revenue")).toBe("a-other");
    expect(defaultRevenueAccountId(options, "p-expense")).toBe("a-4040");
    expect(defaultRevenueAccountId(options, "")).toBe("a-4040");
  });

  it("takes the account's segment, then the partner's, then 受託 (active only)", () => {
    expect(defaultSegmentId(options, "a-other", "p-revenue")).toBe("s-contract");
    expect(defaultSegmentId(options, "a-4040", "p-revenue")).toBe("s-platform");
    expect(defaultSegmentId(options, "a-4040", "p-expense")).toBe("s-contract");
  });
});
