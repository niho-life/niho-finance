import { describe, expect, it } from "vitest";
import {
  CHART_TEMPLATE,
  findTemplateAccount,
  isTaxCategoryCode,
  SEGMENT_CODES,
  STANDARD_SEGMENTS,
} from "../src";

const KIND_BY_PREFIX = {
  "1": "asset",
  "2": "liability",
  "3": "equity",
  "4": "revenue",
  "5": "expense",
  "8": "expense",
  "9": "internal",
} as const;

describe("standard chart of accounts", () => {
  it("has unique 4-digit codes in ascending order", () => {
    const codes = CHART_TEMPLATE.map((account) => account.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^\d{4}$/);
    expect([...codes].sort()).toEqual(codes);
  });

  it("derives the kind from the code prefix", () => {
    for (const account of CHART_TEMPLATE) {
      const prefix = account.code[0] as keyof typeof KIND_BY_PREFIX;
      expect(account.kind, account.code).toBe(KIND_BY_PREFIX[prefix]);
    }
  });

  it("uses known tax categories and segments", () => {
    for (const account of CHART_TEMPLATE) {
      expect(isTaxCategoryCode(account.defaultTaxCategoryCode), account.code).toBe(true);
      if (account.defaultSegmentCode) expect(SEGMENT_CODES).toContain(account.defaultSegmentCode);
    }
    expect(STANDARD_SEGMENTS.map((segment) => segment.code)).toEqual([...SEGMENT_CODES]);
  });

  it("matches the key rows of 02-accounting-rules §2", () => {
    expect(findTemplateAccount("1100")).toMatchObject({
      name: "普通預金",
      group: "current_assets",
      isCashLike: true,
    });
    expect(findTemplateAccount("1150")).toMatchObject({ name: "Stripe 残高", isCashLike: true });
    expect(findTemplateAccount("1700")).toMatchObject({ name: "創立費", group: "deferred_assets" });
    expect(findTemplateAccount("2600")).toMatchObject({
      name: "長期借入金",
      group: "fixed_liabilities",
    });
    expect(findTemplateAccount("3000")).toMatchObject({ name: "資本金", kind: "equity" });
    expect(findTemplateAccount("4030")).toMatchObject({
      defaultTaxCategoryCode: "sales_10",
      defaultSegmentCode: "platform",
    });
    expect(findTemplateAccount("4500")).toMatchObject({
      defaultTaxCategoryCode: "sales_exempt",
      group: "non_operating_income",
    });
    expect(findTemplateAccount("5450")).toMatchObject({
      defaultTaxCategoryCode: "purchase_exempt",
    });
    expect(findTemplateAccount("8000")).toMatchObject({ kind: "expense", group: "income_taxes" });
    expect(findTemplateAccount("9000")).toMatchObject({
      name: "内部取引",
      kind: "internal",
      group: "internal",
    });
    expect(
      CHART_TEMPLATE.filter((account) => account.isCashLike).map((account) => account.code),
    ).toEqual(["1000", "1100", "1150"]);
  });
});
