import { describe, expect, it } from "vitest";
import { compareWithExpected, normalizeIssuerName, sameRates } from "../src/match";
import {
  costNanoUsd,
  estimatedCostPerDocumentNanoUsd,
  formatUsd,
  readingCostNanoUsd,
} from "../src/pricing";
import { parseReading } from "../src/reading";
import { estimatePurchaseTaxCategory } from "../src/tax-estimate";

describe("estimatePurchaseTaxCategory (20-reader §6)", () => {
  it("maps registered issuers to the ordinary purchase categories", () => {
    expect(estimatePurchaseTaxCategory(10, "registered")).toBe("purchase_10");
    expect(estimatePurchaseTaxCategory(8, "registered")).toBe("purchase_8r");
  });

  it("maps unregistered issuers to the transitional categories", () => {
    expect(estimatePurchaseTaxCategory(10, "not_registered")).toBe("purchase_10_ni");
    expect(estimatePurchaseTaxCategory(8, "not_registered")).toBe("purchase_8r_ni");
  });

  it("estimates nothing without a lookup or for 0%", () => {
    expect(estimatePurchaseTaxCategory(10, "unknown")).toBeNull();
    expect(estimatePurchaseTaxCategory(8, "unknown")).toBeNull();
    expect(estimatePurchaseTaxCategory(0, "registered")).toBeNull();
    expect(estimatePurchaseTaxCategory(0, "not_registered")).toBeNull();
  });
});

describe("normalizeIssuerName", () => {
  it("drops whitespace, width and legal entity forms", () => {
    const expected = normalizeIssuerName("架空商事");
    for (const name of [
      "架空商事株式会社",
      "株式会社 架空商事",
      "㈱架空商事",
      "（株）架空商事",
      "(株) 架空　商事",
      "合同会社架空商事",
      "一般社団法人 架空商事",
    ]) {
      expect(normalizeIssuerName(name)).toBe(expected);
    }
    expect(normalizeIssuerName("ＡＢＣ　Ｍａｒｔ")).toBe("abcmart");
    expect(normalizeIssuerName("架空商事")).not.toBe(normalizeIssuerName("架空商店"));
  });
});

describe("sameRates and compareWithExpected", () => {
  const base = {
    documentType: "receipt",
    legible: true,
    issuerName: "架空マート",
    registrationNumber: "T7999999999902",
    transactionDate: "2026-10-05",
    currency: "JPY",
    totalAmount: 1350,
    rates: [
      { ratePercent: 8, amount: 470, taxIncluded: true, taxAmount: 34 },
      { ratePercent: 10, amount: 880, taxIncluded: true, taxAmount: 80 },
    ],
    description: null,
  };
  const expected = parseReading(base);

  it("compares the tax-inclusive amount and the tax per rate, in any order or split", () => {
    const reordered = parseReading({ ...base, rates: [...base.rates].reverse() });
    expect(sameRates(reordered.rates, expected.rates)).toBe(true);
    const split = parseReading({
      ...base,
      rates: [
        { ratePercent: 8, amount: 470, taxIncluded: true, taxAmount: 34 },
        { ratePercent: 10, amount: 800, taxIncluded: true, taxAmount: 72 },
        { ratePercent: 10, amount: 80, taxIncluded: true, taxAmount: 8 },
      ],
    });
    expect(sameRates(split.rates, expected.rates)).toBe(true);
    // The same rate written tax-exclusive with its tax is the same breakdown.
    const exclusive = parseReading({
      ...base,
      rates: [
        { ratePercent: 8, amount: 436, taxIncluded: false, taxAmount: 34 },
        { ratePercent: 10, amount: 800, taxIncluded: false, taxAmount: 80 },
      ],
    });
    expect(sameRates(exclusive.rates, expected.rates)).toBe(true);
  });

  it("differs on an amount, a tax, a missing tax or a missing rate", () => {
    const variant = (rates: typeof base.rates) => parseReading({ ...base, rates }).rates;
    expect(sameRates(variant([base.rates[0]!]), expected.rates)).toBe(false);
    expect(
      sameRates(variant([{ ...base.rates[0]!, amount: 570 }, base.rates[1]!]), expected.rates),
    ).toBe(false);
    expect(
      sameRates(variant([{ ...base.rates[0]!, taxAmount: 35 }, base.rates[1]!]), expected.rates),
    ).toBe(false);
    expect(
      sameRates(
        parseReading({ ...base, rates: [{ ...base.rates[0], taxAmount: null }, base.rates[1]] })
          .rates,
        expected.rates,
      ),
    ).toBe(false);
  });

  it("reports date, total and breakdown, and all only when the three match", () => {
    expect(compareWithExpected(expected, expected)).toEqual({
      date: true,
      total: true,
      rates: true,
      registrationNumber: true,
      issuerName: true,
      all: true,
    });
    const misread = parseReading({
      ...base,
      totalAmount: 1850,
      issuerName: "架空マート株式会社",
      registrationNumber: null,
    });
    expect(compareWithExpected(misread, expected)).toEqual({
      date: true,
      total: false,
      rates: true,
      registrationNumber: false,
      issuerName: true,
      all: false,
    });
  });
});

describe("pricing (20-reader §9)", () => {
  it("prices tokens in 10⁻⁹ USD", () => {
    expect(costNanoUsd("claude-haiku-5-5", { inputTokens: 2000, outputTokens: 1000 })).toBe(
      700_000n,
    );
    expect(costNanoUsd("claude-sonnet-5-5", { inputTokens: 2000, outputTokens: 1000 })).toBe(
      14_000_000n,
    );
    expect(costNanoUsd("recorded", { inputTokens: 2000, outputTokens: 1000 })).toBe(0n);
    expect(costNanoUsd("claude-haiku-5-5", { inputTokens: 0, outputTokens: 0 })).toBe(0n);
  });

  it("estimates a document at 2,000 input and 1,000 output tokens", () => {
    expect(estimatedCostPerDocumentNanoUsd("claude-haiku-5-5")).toBe(700_000n);
    expect(formatUsd(estimatedCostPerDocumentNanoUsd("claude-haiku-5-5"))).toBe("$0.0007");
    expect(formatUsd(estimatedCostPerDocumentNanoUsd("claude-sonnet-5-5"))).toBe("$0.0140");
  });

  it("charges nothing for recorded answers, whatever model recorded them", () => {
    const usage = { inputTokens: 1800, outputTokens: 600 };
    expect(readingCostNanoUsd({ provider: "recorded", model: "claude-sonnet-5-5" }, usage)).toBe(
      0n,
    );
    expect(readingCostNanoUsd({ provider: "recorded", model: "synthetic" }, usage)).toBe(0n);
    expect(readingCostNanoUsd({ provider: "anthropic", model: "claude-haiku-5-5" }, usage)).toBe(
      480_000n,
    );
  });

  it("rejects an unknown model and token counts that are not whole", () => {
    expect(() => costNanoUsd("claude-unknown", { inputTokens: 1, outputTokens: 1 })).toThrow(
      RangeError,
    );
    expect(() => costNanoUsd("claude-haiku-5-5", { inputTokens: -1, outputTokens: 1 })).toThrow(
      RangeError,
    );
    expect(() => costNanoUsd("claude-haiku-5-5", { inputTokens: 1.5, outputTokens: 1 })).toThrow(
      RangeError,
    );
  });

  it("formats USD with four decimals, rounding half up", () => {
    expect(formatUsd(0n)).toBe("$0.0000");
    expect(formatUsd(49_999n)).toBe("$0.0000");
    expect(formatUsd(50_000n)).toBe("$0.0001");
    expect(formatUsd(8_400_000n)).toBe("$0.0084");
    expect(formatUsd(1_234_567_890_000n)).toBe("$1,234.5679");
    expect(formatUsd(-700_000n)).toBe("-$0.0007");
  });
});
