import { describe, expect, it } from "vitest";
import {
  ACCOUNT_GROUP_LABELS,
  ACCOUNT_GROUPS,
  ACCOUNT_GROUPS_BY_KIND,
  ACCOUNT_KINDS,
  accountKindForCode,
  CHART_TEMPLATE,
  defaultAccountingMethod,
  findTemplateAccount,
  formatYenInput,
  isAccountGroupOf,
  isStandardSegmentCode,
  parseYenInput,
  WALLET_DEFAULT_ACCOUNT_CODES,
  WALLET_KINDS,
} from "../src";

describe("account kinds and statement groups", () => {
  it("puts every statement group under exactly one kind", () => {
    const grouped = ACCOUNT_KINDS.flatMap((kind) => ACCOUNT_GROUPS_BY_KIND[kind]);
    expect([...grouped].sort()).toEqual([...ACCOUNT_GROUPS].sort());
    for (const group of ACCOUNT_GROUPS) expect(ACCOUNT_GROUP_LABELS[group]).toBeTruthy();
  });

  it("agrees with the standard chart", () => {
    for (const account of CHART_TEMPLATE) {
      expect(isAccountGroupOf(account.kind, account.group), account.code).toBe(true);
      expect(accountKindForCode(account.code), account.code).toBe(account.kind);
    }
    expect(accountKindForCode("0100")).toBeNull();
    expect(accountKindForCode("123")).toBeNull();
    expect(accountKindForCode("6100")).toBe("expense");
  });
});

describe("wallet kinds", () => {
  it("map to the accounts of 02-accounting-rules §2", () => {
    const names = Object.fromEntries(
      WALLET_KINDS.map((kind) => {
        const code = WALLET_DEFAULT_ACCOUNT_CODES[kind];
        return [kind, code ? findTemplateAccount(code)?.name : null];
      }),
    );
    expect(names).toEqual({
      bank: "普通預金",
      card: "未払金",
      cash: "現金",
      stripe: "Stripe 残高",
      owner: "役員借入金",
      other: null,
    });
  });
});

describe("fiscal year methods and segments", () => {
  it("fixes exempt years to tax-inclusive and defaults taxable years to tax-exclusive", () => {
    expect(defaultAccountingMethod("exempt")).toBe("tax_inclusive");
    expect(defaultAccountingMethod("general")).toBe("tax_exclusive");
    expect(defaultAccountingMethod("simplified")).toBe("tax_exclusive");
  });

  it("knows the standard segments", () => {
    expect(isStandardSegmentCode("corporate")).toBe(true);
    expect(isStandardSegmentCode("kamakura")).toBe(true);
    expect(isStandardSegmentCode("hayama")).toBe(false);
  });
});

describe("amount input", () => {
  it("accepts plain digits, 3-digit groups and full-width input", () => {
    expect(parseYenInput("50000")).toBe(50_000n);
    expect(parseYenInput("50,000")).toBe(50_000n);
    expect(parseYenInput(" ５０，０００ ")).toBe(50_000n);
    expect(parseYenInput("¥150,000")).toBe(150_000n);
    expect(parseYenInput("15,000円")).toBe(15_000n);
    expect(parseYenInput("0")).toBe(0n);
  });

  it("rejects blanks, decimals and words", () => {
    expect(parseYenInput("")).toBeNull();
    expect(parseYenInput("  ")).toBeNull();
    expect(parseYenInput("1.5")).toBeNull();
    expect(parseYenInput("5万")).toBeNull();
    expect(parseYenInput("abc")).toBeNull();
    expect(parseYenInput("1234567890123456")).toBeNull();
  });

  it("accepts a minus only when allowed", () => {
    expect(parseYenInput("-3,000")).toBeNull();
    expect(parseYenInput("-3,000", { allowNegative: true })).toBe(-3_000n);
    expect(parseYenInput("－３０００", { allowNegative: true })).toBe(-3_000n);
  });

  it("formats with 3-digit grouping", () => {
    expect(formatYenInput(50_000n)).toBe("50,000");
    expect(formatYenInput(-1_234n)).toBe("-1,234");
    expect(formatYenInput(null)).toBe("");
  });
});
