/**
 * 法人税等の概算・繰越欠損金・納付期限 (docs/design/16-year-end.md §9).
 */
import { describe, expect, it } from "vitest";
import {
  corporateTaxDueDate,
  corporateTaxRates,
  DEFAULT_LOCAL_TAX,
  estimateCorporateTax,
  lossCarryforward,
  type CorporateTaxEstimate,
  type CorporateTaxLineKey,
} from "../src";

const FIRST_YEAR = { startDate: "2026-11-02", endDate: "2027-03-31" } as const;
const SECOND_YEAR = { startDate: "2027-04-01", endDate: "2028-03-31" } as const;

function amountsOf(estimate: CorporateTaxEstimate): Partial<Record<CorporateTaxLineKey, bigint>> {
  return Object.fromEntries(estimate.lines.map((line) => [line.key, line.amount]));
}

describe("estimateCorporateTax", () => {
  it("第 1 期が赤字なら均等割だけ: 4 か月 → 県 6,600 + 市 16,600 = 23,200", () => {
    const estimate = estimateCorporateTax({
      period: FIRST_YEAR,
      pretaxIncome: -800_000n,
      lossCarryforward: 0n,
    });
    expect(estimate.months).toBe(5);
    expect(estimate.localMonths).toBe(4);
    expect(estimate.taxableIncome).toBe(0n);
    expect(estimate.carryforwardUsed).toBe(0n);
    expect(amountsOf(estimate)).toEqual({
      corporate_tax: 0n,
      local_corporate_tax: 0n,
      defense_tax: 0n,
      prefecture_tax: 0n,
      municipal_tax: 0n,
      prefecture_per_capita: 6_600n,
      municipal_per_capita: 16_600n,
      enterprise_tax: 0n,
      special_enterprise_tax: 0n,
    });
    expect(estimate.total).toBe(23_200n);
    expect(estimate.lines.map((line) => line.label)).toEqual([
      "法人税",
      "地方法人税",
      "防衛特別法人税",
      "法人住民税 法人税割（神奈川県）",
      "法人住民税 法人税割（鎌倉市）",
      "均等割（神奈川県）",
      "均等割（鎌倉市）",
      "事業税（所得割）",
      "特別法人事業税",
    ]);
  });

  it("12 か月の黒字の期 (第 2 期、所得 10,000,000・繰越欠損金 1,200,000)", () => {
    // 所得 = 10,000,000 − 1,200,000 = 8,800,000。
    // 法人税: 8,000,000 × 19% + 800,000 × 23.2% = 1,520,000 + 185,600 = 1,705,600。
    // 地方法人税: 1,705,000 × 10.3% = 175,615 → 175,600。
    // 防衛特別法人税: 1,705,600 − 5,000,000 < 0 → 0。
    // 法人税割: 県 1,705,000 × 1.0% = 17,050 → 17,000、市 × 6.0% = 102,300。
    // 均等割: 県 20,000、市 50,000。
    // 事業税: 4,000,000 × 3.5% + 4,000,000 × 5.3% + 800,000 × 7.0% = 140,000 + 212,000 + 56,000 = 408,000。
    // 特別法人事業税: 408,000 × 37% = 150,960 → 150,900。
    const estimate = estimateCorporateTax({
      period: SECOND_YEAR,
      pretaxIncome: 10_000_000n,
      lossCarryforward: 1_200_000n,
    });
    expect(estimate.months).toBe(12);
    expect(estimate.localMonths).toBe(12);
    expect(estimate.carryforwardUsed).toBe(1_200_000n);
    expect(estimate.taxableIncome).toBe(8_800_000n);
    expect(amountsOf(estimate)).toEqual({
      corporate_tax: 1_705_600n,
      local_corporate_tax: 175_600n,
      defense_tax: 0n,
      prefecture_tax: 17_000n,
      municipal_tax: 102_300n,
      prefecture_per_capita: 20_000n,
      municipal_per_capita: 50_000n,
      enterprise_tax: 408_000n,
      special_enterprise_tax: 150_900n,
    });
    expect(estimate.total).toBe(2_629_400n);
    expect(estimate.lines.find((line) => line.key === "local_corporate_tax")?.base).toBe(
      1_705_000n,
    );
  });

  it("1 年に満たない期は段階の金額を月割りする (第 1 期、所得 5,000,000)", () => {
    // 5 か月: 800 万円 × 5 / 12 = 3,333,333 → 3,333,000、400 万円 × 5 / 12 → 1,666,000。
    // 法人税: 3,333,000 × 15% + 1,667,000 × 23.2% = 499,950 + 386,744 = 886,694 → 886,600。
    // 事業税: 1,666,000 × 3.5% + 1,667,000 × 5.3% + 1,667,000 × 7.0% = 263,351 → 263,300。
    const estimate = estimateCorporateTax({
      period: FIRST_YEAR,
      pretaxIncome: 5_000_400n,
      lossCarryforward: 0n,
    });
    expect(estimate.taxableIncome).toBe(5_000_000n);
    const amounts = amountsOf(estimate);
    expect(amounts.corporate_tax).toBe(886_600n);
    expect(amounts.defense_tax).toBe(0n);
    expect(amounts.local_corporate_tax).toBe(91_200n);
    expect(amounts.enterprise_tax).toBe(263_300n);
    expect(amounts.special_enterprise_tax).toBe(97_400n);
    expect(estimate.total).toBe(1_423_600n);
  });

  it("軽減税率は 2027-03-31 までに開始する期が 15%、以後は 19%", () => {
    const before = estimateCorporateTax({
      period: { startDate: "2026-04-01", endDate: "2027-03-31" },
      pretaxIncome: 5_000_000n,
      lossCarryforward: 0n,
    });
    const after = estimateCorporateTax({
      period: SECOND_YEAR,
      pretaxIncome: 5_000_000n,
      lossCarryforward: 0n,
    });
    expect(amountsOf(before).corporate_tax).toBe(750_000n);
    expect(amountsOf(after).corporate_tax).toBe(950_000n);
    expect(corporateTaxRates("2027-03-31").reducedRateBp).toBe(1500);
    expect(corporateTaxRates("2027-04-01").reducedRateBp).toBe(1900);
  });

  it("防衛特別法人税は 2026-04-01 以後に開始する期: (法人税額 − 500 万円) × 4%", () => {
    // 法人税: 8,000,000 × 15% + 32,000,000 × 23.2% = 1,200,000 + 7,424,000 = 8,624,000。
    // 防衛特別法人税: (8,624,000 − 5,000,000) × 4% = 144,960 → 144,900。
    const estimate = estimateCorporateTax({
      period: { startDate: "2026-04-01", endDate: "2027-03-31" },
      pretaxIncome: 40_000_000n,
      lossCarryforward: 0n,
    });
    expect(amountsOf(estimate).corporate_tax).toBe(8_624_000n);
    expect(amountsOf(estimate).defense_tax).toBe(144_900n);

    const earlier = estimateCorporateTax({
      period: { startDate: "2025-04-01", endDate: "2026-03-31" },
      pretaxIncome: 40_000_000n,
      lossCarryforward: 0n,
    });
    expect(earlier.lines.some((line) => line.key === "defense_tax")).toBe(false);
  });

  it("繰越欠損金は所得まで使い、所得は 1,000 円未満を切り捨てる", () => {
    const estimate = estimateCorporateTax({
      period: SECOND_YEAR,
      pretaxIncome: 300_999n,
      lossCarryforward: 800_000n,
    });
    expect(estimate.carryforwardUsed).toBe(300_999n);
    expect(estimate.taxableIncome).toBe(0n);
    expect(estimate.total).toBe(70_000n);
  });

  it("uses the local tax setting's rates, amounts and names", () => {
    const estimate = estimateCorporateTax({
      period: SECOND_YEAR,
      pretaxIncome: 1_000_000n,
      lossCarryforward: 0n,
      local: {
        prefecture: { name: "架空県", perCapitaAnnual: 21_000n, corporateTaxRateBp: 180 },
        municipality: { name: "", perCapitaAnnual: 60_000n, corporateTaxRateBp: 840 },
      },
    });
    // 法人税 1,000,000 × 19% = 190,000。県 190,000 × 1.8% = 3,420 → 3,400、市 × 8.4% = 15,960 → 15,900。
    const amounts = amountsOf(estimate);
    expect(amounts.prefecture_tax).toBe(3_400n);
    expect(amounts.municipal_tax).toBe(15_900n);
    expect(amounts.prefecture_per_capita).toBe(21_000n);
    expect(amounts.municipal_per_capita).toBe(60_000n);
    const labels = estimate.lines.map((line) => line.label);
    expect(labels).toContain("均等割（架空県）");
    expect(labels).toContain("均等割（市）");
    expect(DEFAULT_LOCAL_TAX.municipality.perCapitaAnnual).toBe(50_000n);
  });
});

describe("lossCarryforward", () => {
  it("profits use the oldest losses first", () => {
    const prior = [
      { ...FIRST_YEAR, pretaxIncome: -800_000n },
      { ...SECOND_YEAR, pretaxIncome: -500_000n },
      { startDate: "2028-04-01", endDate: "2029-03-31", pretaxIncome: 1_000_000n },
    ] as const;
    expect(lossCarryforward(prior, "2029-04-01")).toBe(300_000n);
    expect(lossCarryforward(prior.slice(0, 2), "2028-04-01")).toBe(1_300_000n);
    // Unsorted input and years from the current year on are ignored.
    expect(lossCarryforward([...prior].reverse(), "2029-04-01")).toBe(300_000n);
    expect(lossCarryforward(prior, "2028-04-01")).toBe(1_300_000n);
  });

  it("a loss is usable by years starting within 10 years after the loss year started", () => {
    const prior = [{ ...FIRST_YEAR, pretaxIncome: -800_000n }];
    // 第 1 期 (2026-11-02 開始) の欠損は 2036-04-01 開始の期 (10 期後) まで使える。
    expect(lossCarryforward(prior, "2036-04-01")).toBe(800_000n);
    expect(lossCarryforward(prior, "2037-04-01")).toBe(0n);

    const twelveMonths = [{ ...SECOND_YEAR, pretaxIncome: -500_000n }];
    expect(lossCarryforward(twelveMonths, "2037-04-01")).toBe(500_000n);
    expect(lossCarryforward(twelveMonths, "2038-04-01")).toBe(0n);
  });

  it("an expired loss is not used by a later profit", () => {
    const prior = [
      { startDate: "2010-04-01", endDate: "2011-03-31", pretaxIncome: -400_000n },
      { startDate: "2015-04-01", endDate: "2016-03-31", pretaxIncome: -300_000n },
      { startDate: "2021-04-01", endDate: "2022-03-31", pretaxIncome: 500_000n },
    ] as const;
    // 2021-04-01 開始の期では 2010 年の欠損は期限切れ。2015 年の 300,000 だけを使う。
    expect(lossCarryforward(prior, "2022-04-01")).toBe(0n);
    expect(lossCarryforward(prior.slice(0, 2), "2020-04-01")).toBe(700_000n);
    expect(lossCarryforward(prior.slice(0, 2), "2021-04-01")).toBe(300_000n);
  });
});

describe("corporateTaxDueDate", () => {
  it.each([
    ["2027-03-31", "2027-05-31"],
    ["2026-12-31", "2027-02-28"],
    ["2027-12-31", "2028-02-29"],
    ["2026-12-30", "2027-02-28"],
    ["2027-06-30", "2027-08-31"],
  ] as const)("%s → %s", (endDate, due) => {
    expect(corporateTaxDueDate(endDate)).toBe(due);
  });
});
