import { formatYen } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatAmountDisplay,
  formatYenDisplay,
  withDisplayMinus,
} from "@/lib/format";

const MINUS = "\u2212";

describe("formatYenDisplay", () => {
  it("groups by 3 digits like formatYen", () => {
    expect(formatYenDisplay(0n)).toBe("0");
    expect(formatYenDisplay(999n)).toBe("999");
    expect(formatYenDisplay(1000n)).toBe("1,000");
    expect(formatYenDisplay(1234567n)).toBe("1,234,567");
  });

  it("shows a negative with U+2212, not the ASCII hyphen", () => {
    expect(formatYenDisplay(-1n)).toBe(`${MINUS}1`);
    expect(formatYenDisplay(-120000n)).toBe(`${MINUS}120,000`);
    expect(formatYenDisplay(-1234567n)).toBe(`${MINUS}1,234,567`);
    expect(formatYenDisplay(-120000n)).not.toContain("-");
  });

  it("keeps amounts beyond Number.MAX_SAFE_INTEGER exact", () => {
    expect(formatYenDisplay(-9007199254740993n)).toBe(`${MINUS}9,007,199,254,740,993`);
  });

  it("differs from formatYen only in the sign", () => {
    for (const value of [0n, 5n, 1000n, -5n, -1000n, -987654321n]) {
      expect(formatYenDisplay(value).replace(MINUS, "-")).toBe(formatYen(value));
    }
  });
});

describe("formatAmountDisplay", () => {
  it("shows — for no amount", () => {
    expect(formatAmountDisplay(null)).toBe("—");
    expect(formatAmountDisplay(undefined)).toBe("—");
  });

  it("shows an amount like formatYenDisplay", () => {
    expect(formatAmountDisplay(0n)).toBe("0");
    expect(formatAmountDisplay(-3500n)).toBe(`${MINUS}3,500`);
  });
});

describe("withDisplayMinus", () => {
  it("replaces only a leading ASCII hyphen", () => {
    expect(withDisplayMinus("-1.2万")).toBe(`${MINUS}1.2万`);
    expect(withDisplayMinus("1.2万")).toBe("1.2万");
    expect(withDisplayMinus("0")).toBe("0");
    expect(withDisplayMinus("2026-11-02")).toBe("2026-11-02");
  });
});

describe("formatAmount", () => {
  it("keeps the ASCII hyphen for PDF, aria and other text that leaves the screen", () => {
    expect(formatAmount(-3500n)).toBe("-3,500");
    expect(formatAmount(null)).toBe("—");
  });
});
