import { describe, expect, it } from "vitest";
import {
  allocateByWeights,
  buildConsumptionTaxSummary,
  consumptionTaxCsv,
  consumptionTaxCsvRows,
  type ConsumptionTaxEstimate,
  type ConsumptionTaxSummary,
} from "../../src";
import { BOOK, entry, FY1, FY1_ENTRIES, FY2, FY2_ENTRIES, withSource } from "./fixture";

function category(summary: ConsumptionTaxSummary, code: string) {
  const row = summary.categories.find((r) => r.code === code);
  if (!row)
    throw new Error(`${code} is not in ${summary.categories.map((r) => r.code).join(", ")}`);
  return row;
}

function rows(estimate: ConsumptionTaxEstimate) {
  return Object.fromEntries(estimate.rows.map((row) => [row.key, row.total]));
}

function sumOf(summary: ConsumptionTaxSummary, direction: "sales" | "purchase") {
  const list = summary.categories.filter((r) => r.direction === direction);
  return {
    lineCount: list.reduce((a, r) => a + r.lineCount, 0),
    amountInclusive: list.reduce((a, r) => a + r.amountInclusive, 0n),
    amountExclusive: list.reduce((a, r) => a + r.amountExclusive, 0n),
    taxAmount: list.reduce((a, r) => a + r.taxAmount, 0n),
  };
}

describe("allocateByWeights", () => {
  it("splits by the largest remainder and keeps the total", () => {
    expect(allocateByWeights(1_001n, [300n, 700n])).toEqual([300n, 701n]);
    expect(allocateByWeights(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateByWeights(-100n, [1n, 1n, 1n])).toEqual([-33n, -33n, -34n]);
    expect(allocateByWeights(10n, [0n, 0n])).toEqual([5n, 5n]);
    expect(allocateByWeights(7n, [5n])).toEqual([7n]);
    expect(allocateByWeights(-110n, [-1000n, -100n])).toEqual([-100n, -10n]);
    const parts = allocateByWeights(9_999n, [3n, 5n, 7n, 11n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(9_999n);
  });
});

describe("消費税の集計 — 第 1 期 (exempt, tax-inclusive)", () => {
  const summary = buildConsumptionTaxSummary(BOOK, FY1.id);

  it("is a reference only", () => {
    expect(summary.reference).toBe(true);
    expect(summary.methodLabel).toBe("免税");
    expect(summary.accountingMethodLabel).toBe("税込経理");
    expect(summary.referenceNote).toContain("参考値");
    expect(summary.general.current).toBe(false);
    expect(summary.simplified.current).toBe(false);
    expect(summary.taxAccounts).toBeNull();
  });

  it("totals the categories from the lines' taxAmount", () => {
    expect(category(summary, "sales_10")).toMatchObject({
      lineCount: 2,
      amountInclusive: 33_000n,
      amountExclusive: 30_000n,
      taxAmount: 3_000n,
    });
    expect(category(summary, "sales_exempt")).toMatchObject({
      amountInclusive: 12n,
      taxAmount: 0n,
    });
    // The voided entry and its reversal net to 0; the corrected one counts.
    expect(category(summary, "purchase_10")).toMatchObject({
      lineCount: 6,
      amountInclusive: 338_096n,
      taxAmount: 30_736n,
    });
    expect(category(summary, "purchase_exempt").amountInclusive).toBe(20_000n);
    expect(category(summary, "purchase_out").amountInclusive).toBe(150_000n);
    expect(summary.sales).toEqual(sumOf(summary, "sales"));
    expect(summary.purchases).toEqual(sumOf(summary, "purchase"));
  });

  it("matches the taxAmount of the lines", () => {
    let sales = 0n;
    let purchases = 0n;
    for (const e of FY1_ENTRIES) {
      for (const line of e.lines) {
        if (line.taxCategoryCode.startsWith("sales_"))
          sales += line.side === "credit" ? line.taxAmount : -line.taxAmount;
        if (line.taxCategoryCode === "purchase_10")
          purchases += line.side === "debit" ? line.taxAmount : -line.taxAmount;
      }
    }
    expect(summary.sales.taxAmount).toBe(sales);
    expect(category(summary, "purchase_10").taxAmount).toBe(purchases);
  });

  it("credits 70% of the tax of purchases without an invoice (経過措置, 2027-01)", () => {
    expect(category(summary, "purchase_10_ni")).toMatchObject({
      lineCount: 1,
      amountInclusive: 2_200n,
      amountExclusive: 2_000n,
      taxAmount: 140n,
    });
  });

  it("estimates both methods with the rounding of 8.4", () => {
    expect(summary.ratio).toMatchObject({
      numerator: 30_000n,
      denominator: 30_012n,
      label: "99.96%",
    });
    expect(rows(summary.general)).toEqual({
      taxableBase: 30_000n,
      consumptionTax: 2_340n,
      deductibleTax: 24_083n, // (30,736 + 140) × 78/100 = 24,083.28
      netTax: -21_743n, // a refund stays as it is
      localTax: -6_132n,
      payable: -27_875n,
    });
    expect(rows(summary.simplified)).toEqual({
      taxableBase: 30_000n,
      consumptionTax: 2_340n,
      deductibleTax: 1_170n, // 第 5 種 50%
      netTax: 1_100n,
      localTax: 300n,
      payable: 1_400n,
    });
  });
});

describe("消費税の集計 — 第 2 期 (general, tax-exclusive)", () => {
  const summary = buildConsumptionTaxSummary(BOOK, FY2.id);

  it("takes the tax from 仮受・仮払消費税, the settlement left out", () => {
    expect(summary.reference).toBe(false);
    expect(summary.general.current).toBe(true);
    expect(summary.taxAccounts).toEqual({ output: 50_900n, input: 9_177n });
    expect(summary.excludedTaxLines).toEqual({ output: -50_900n, input: -9_177n });
    expect(summary.sales.taxAmount).toBe(summary.taxAccounts!.output);
    expect(summary.purchases.taxAmount).toBe(summary.taxAccounts!.input);
    expect(summary.issues).toEqual([]);
  });

  it("nets the refund and allocates the voucher's hand-written 仮払消費税", () => {
    expect(category(summary, "sales_10")).toMatchObject({
      lineCount: 3,
      amountExclusive: 509_000n,
      taxAmount: 50_900n,
      amountInclusive: 559_900n,
    });
    // 36 + 8,000 + (1,001 split 300 / 701 over the voucher's two rows).
    expect(category(summary, "purchase_10")).toMatchObject({
      lineCount: 4,
      amountExclusive: 90_360n,
      taxAmount: 9_037n,
      amountInclusive: 99_397n,
    });
    expect(category(summary, "purchase_10_ni")).toMatchObject({
      amountExclusive: 2_060n,
      taxAmount: 140n,
      amountInclusive: 2_200n,
    });
  });

  it("estimates with hand-computed rounding", () => {
    expect(summary.ratio.label).toBe("99.99%");
    expect(summary.ratio.belowNinetyFivePercent).toBe(false);
    expect(rows(summary.general)).toEqual({
      taxableBase: 509_000n, // 559,900 × 100/110, to 1,000
      consumptionTax: 39_702n, // × 7.8%
      deductibleTax: 7_158n, // 9,177 × 78/100 = 7,158.06
      netTax: 32_500n, // 32,544 to 100
      localTax: 9_100n, // 32,500 × 22/78 = 9,166.6 to 100
      payable: 41_600n,
    });
    expect(rows(summary.simplified)).toEqual({
      taxableBase: 509_000n,
      consumptionTax: 39_702n,
      deductibleTax: 19_851n,
      netTax: 19_800n,
      localTax: 5_500n,
      payable: 25_300n,
    });
  });

  it("applies 課税売上割合 below 95% (一括比例配分)", () => {
    const exempt = entry({
      id: "f95",
      fy: FY2,
      no: 95,
      date: "2027-12-15",
      description: "非課税の売上",
      lines: [
        { side: "debit", account: "1100", amount: 100_000n, sub: "bank" },
        { side: "credit", account: "4090", amount: 100_000n, tax: "sales_exempt" },
      ],
    });
    const result = buildConsumptionTaxSummary(
      withSource({ entries: [...BOOK.entries, exempt] }),
      FY2.id,
    );
    expect(result.ratio).toMatchObject({
      numerator: 509_000n,
      denominator: 609_015n,
      label: "83.57%",
      belowNinetyFivePercent: true,
    });
    // 7,158 × 509,000 / 609,015 = 5,982.4
    expect(rows(result.general).deductibleTax).toBe(5_982n);
  });

  it("leaves out the lines before a registration within the year", () => {
    const registered = withSource({
      company: { ...BOOK.company, invoiceRegisteredOn: "2027-06-01" },
    });
    const result = buildConsumptionTaxSummary(registered, FY2.id);
    expect(result.excludedBefore).toBe("2027-06-01");
    expect(category(result, "sales_10")).toMatchObject({
      lineCount: 2,
      amountExclusive: 499_000n,
      taxAmount: 49_900n,
    });
    expect(category(result, "purchase_10_ni").lineCount).toBe(1);
    expect(result.categories.some((r) => r.code === "purchase_10")).toBe(false);
    // Not in an exempt year.
    const exemptYear = buildConsumptionTaxSummary(
      withSource({ company: { ...BOOK.company, invoiceRegisteredOn: "2027-01-01" } }),
      FY1.id,
    );
    expect(exemptYear.excludedBefore).toBeNull();
  });

  it("warns about a taxable line without its 仮受消費税 line", () => {
    const missing = entry({
      id: "f96",
      fy: FY2,
      no: 96,
      date: "2027-12-20",
      description: "月会費",
      lines: [
        { side: "debit", account: "1100", amount: 1_100n, sub: "bank" },
        { side: "credit", account: "4010", amount: 1_100n, tax: "sales_10", taxAmount: 100n },
      ],
    });
    const result = buildConsumptionTaxSummary(
      withSource({ entries: [...FY1_ENTRIES, ...FY2_ENTRIES, missing] }),
      FY2.id,
    );
    expect(result.issues).toEqual(["仮受消費税の行がない課税売上があります（2027/12/20 No.96）"]);
  });

  it("writes tables 1–3 in one CSV", () => {
    const csv = consumptionTaxCsv(summary);
    expect(csv.fileName).toBe("consumption-tax_20270401-20280331.csv");
    expect([...csv.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const table = consumptionTaxCsvRows(summary);
    expect(table[0]).toEqual([
      "表",
      "項目",
      "件数",
      "税込金額",
      "税抜金額",
      "消費税額",
      "標準税率 10%",
      "軽減税率 8%",
      "合計",
    ]);
    const names = new Set(table.slice(1).map((row) => row[0]));
    expect([...names]).toEqual([
      "税区分別の集計",
      "本則課税（一般課税）の概算",
      "簡易課税の概算（第5種（サービス業等））",
    ]);
    expect(
      table.find(
        (row) => row[1] === "納付税額（概算）" && row[0] === "本則課税（一般課税）の概算",
      )?.[8],
    ).toBe(41_600n);
    expect(table.find((row) => row[1] === "課税売上割合")?.[8]).toBe("99.99%");
  });
});
