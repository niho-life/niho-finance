/**
 * 年末調整 (22-payroll §11): the 設例 of 「令和８年分 年末調整のしかた」 57 ページ, the boundaries of
 * 給与所得控除後の給与等の金額の表 (別表第五), the deduction formulas and tables, the 2 fixtures of §11.6,
 * the settlement entry and the year's data file. Every person is fictional.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  annualTaxWithSurtax,
  basicDeduction,
  buildYearEndSettlementEntry,
  calculateYearEnd,
  computedIncomeTax,
  dependentDeductions,
  earthquakeDeduction,
  emptyYearEndDeclaration,
  findTableById,
  findYearEndTable,
  formulaAmount,
  incomeAdjustmentDeduction,
  lifeInsuranceDeduction,
  parsePayrollTable,
  parseYearEndTable,
  PayrollInputError,
  PayrollTableFormatError,
  PayrollTableMissingError,
  salaryIncomeAfterDeduction,
  specificRelativeDeduction,
  spouseDeduction,
  type YearEndDeclaration,
  type YearEndInput,
} from "../src";

const table = findYearEndTable(2026);

type Json = Record<string, unknown>;
const json = (): Json =>
  JSON.parse(readFileSync(new URL("../data/2026/year-end.json", import.meta.url), "utf8")) as Json;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

function declaration(patch: Partial<YearEndDeclaration> = {}): YearEndDeclaration {
  const empty = emptyYearEndDeclaration();
  return { ...empty, ...patch, insurance: { ...empty.insurance, ...patch.insurance } };
}

// ---------------------------------------------------------------------------------------------
// 設例 (§11.6)
// ---------------------------------------------------------------------------------------------

/** 「年末調整のしかた」 57 ページの設例. */
const example: YearEndInput = {
  year: 2026,
  taxColumn: "kou",
  salary: { pay: 8_970_000n, bonus: 0n, socialInsurance: 1_386_102n, withheld: 156_670n },
  declaration: declaration({
    dependents: [
      { category: "general", disability: "none", under23: false },
      { category: "specific", disability: "none", under23: false },
      { category: "elderly_cohabiting", disability: "general", under23: false },
    ],
    spouse: { totalIncome: 500_000n, elderly: false, disability: "none" },
    specificRelatives: [{ totalIncome: 1_000_000n }],
    insurance: {
      newGeneral: 80_000n,
      oldGeneral: 35_000n,
      medical: 80_000n,
      newPension: 30_000n,
      oldPension: 90_000n,
      under23Dependent: true,
      earthquake: 42_000n,
      oldLongTerm: 14_800n,
      socialInsurance: 0n,
      smallBusinessMutualAid: 0n,
    },
    housingLoanCredit: 76_500n,
  }),
};

describe("the example of 「年末調整のしかた」 (§11.6)", () => {
  const result = calculateYearEnd(example);

  it("gives every step of the example", () => {
    expect(result).toMatchObject({
      year: 2026,
      eligible: true,
      ineligible: [],
      totalPay: 8_970_000n,
      salaryIncome: 7_020_000n,
      incomeAdjustment: 47_000n,
      salaryIncomeAfterAdjustment: 6_973_000n,
      totalIncome: 6_973_000n,
      taxableIncome: 2_146_000n,
      computedTax: 117_100n,
      housingLoanCredit: 76_500n,
      annualIncomeTax: 40_600n,
      annualTax: 41_400n,
      withheld: 156_670n,
      difference: -115_270n,
      settlement: { kind: "refund", label: "過納", amount: 115_270n },
    });
    expect(result.deductions).toMatchObject({
      socialInsurance: 1_386_102n,
      smallBusinessMutualAid: 0n,
      lifeInsurance: { total: 120_000n },
      earthquake: 50_000n,
      spouse: 380_000n,
      spouseKind: "spouse",
      specificRelative: 410_000n,
      dependents: { total: 1_860_000n },
      basic: 620_000n,
      total: 4_826_102n,
    });
    expect(result.table.id).toBe("year-end-2026");
  });

  it("explains the parts of 生命保険料 and 扶養等", () => {
    // 一般: 新 80,000 (計算式Ⅱ 50,000) + 旧 35,000 (Ⅲ 30,000) → 6 万円まで; 介護医療 40,000;
    // 個人年金: 新 30,000 (Ⅰ 25,000) + 旧 90,000 (Ⅲ 47,500) → 旧だけの 47,500 が大きい.
    expect(result.deductions.lifeInsurance).toEqual({
      general: 60_000n,
      medical: 40_000n,
      pension: 47_500n,
      total: 120_000n,
    });
    // 一般 38 万 + 特定 63 万 + 同居老親等 58 万 + 障害者 27 万.
    expect(result.deductions.dependents).toEqual({
      dependents: 1_590_000n,
      disability: 270_000n,
      widowOrSingleParent: 0n,
      workingStudent: 0n,
      total: 1_860_000n,
    });
  });

  it("derives the 23 歳未満 rules from the 特定扶養親族", () => {
    const withoutCheck = calculateYearEnd({
      ...example,
      declaration: {
        ...example.declaration,
        insurance: { ...example.declaration.insurance, under23Dependent: false },
      },
    });
    expect(withoutCheck.incomeAdjustment).toBe(47_000n);
    expect(withoutCheck.deductions.lifeInsurance.general).toBe(60_000n);
    expect(withoutCheck.annualTax).toBe(41_400n);
  });
});

// ---------------------------------------------------------------------------------------------
// 給与所得控除後の給与等の金額の表
// ---------------------------------------------------------------------------------------------

describe("給与所得控除後の給与等の金額 (別表第五・令和 8 年分)", () => {
  it.each([
    [0n, 0n],
    [740_999n, 0n],
    [741_000n, 1_000n],
    [2_190_999n, 1_450_999n],
    [2_191_000n, 1_451_000n],
    [2_192_999n, 1_451_000n],
    [2_193_000n, 1_453_000n],
    [2_196_000n, 1_456_000n],
    [2_199_999n, 1_456_000n],
    [2_200_000n, 1_460_000n],
    [2_203_999n, 1_460_000n],
    [2_584_000n, 1_728_800n],
    [3_599_999n, 2_437_200n],
    [3_600_000n, 2_440_000n],
    [4_384_000n, 3_067_200n],
    [6_184_000n, 4_507_200n],
    [6_599_999n, 4_836_800n],
    [6_600_000n, 4_840_000n],
    [6_600_001n, 4_840_000n],
    [8_499_999n, 6_549_999n],
    [8_500_000n, 6_550_000n],
    [8_970_000n, 7_020_000n],
    [20_000_000n, 18_050_000n],
  ])("%s → %s", (income, expected) => {
    expect(salaryIncomeAfterDeduction(table, income)).toBe(expected);
  });

  it("never decreases and never gives more than the income", () => {
    let previous = 0n;
    for (let income = 0n; income <= 9_000_000n; income += 997n) {
      const value = salaryIncomeAfterDeduction(table, income);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(income);
      previous = value;
    }
    expect(() => salaryIncomeAfterDeduction(table, -1n)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// The fixtures of §11.6
// ---------------------------------------------------------------------------------------------

describe("the fixtures of §11.6", () => {
  it("A: an officer (甲欄 0 人) with 1,200,000 円", () => {
    const result = calculateYearEnd({
      year: 2026,
      taxColumn: "kou",
      salary: { pay: 1_200_000n, bonus: 0n, socialInsurance: 135_315n, withheld: 45_479n },
      declaration: declaration(),
    });
    expect(result).toMatchObject({
      eligible: true,
      salaryIncome: 460_000n,
      incomeAdjustment: 0n,
      totalIncome: 460_000n,
      deductions: { basic: 1_040_000n, total: 135_315n + 1_040_000n },
      taxableIncome: 0n,
      computedTax: 0n,
      annualTax: 0n,
      difference: -45_479n,
      settlement: { kind: "refund", label: "過納", amount: 45_479n },
    });
  });

  it("B: an employee (甲欄, 一般の扶養 1 人) with insurance premiums", () => {
    const result = calculateYearEnd({
      year: 2026,
      taxColumn: "kou",
      salary: { pay: 2_400_000n, bonus: 600_000n, socialInsurance: 450_000n, withheld: 60_000n },
      declaration: declaration({
        dependents: [{ category: "general", disability: "none", under23: false }],
        insurance: {
          ...emptyYearEndDeclaration().insurance,
          newGeneral: 100_000n,
          earthquake: 30_000n,
        },
      }),
    });
    expect(result).toMatchObject({
      totalPay: 3_000_000n,
      salaryIncome: 2_020_000n,
      deductions: {
        socialInsurance: 450_000n,
        lifeInsurance: { general: 40_000n, total: 40_000n },
        earthquake: 30_000n,
        dependents: { dependents: 380_000n, total: 380_000n },
        basic: 1_040_000n,
        total: 1_940_000n,
      },
      taxableIncome: 80_000n,
      computedTax: 4_000n,
      annualIncomeTax: 4_000n,
      annualTax: 4_000n,
      difference: -56_000n,
      settlement: { kind: "refund", amount: 56_000n },
    });
  });

  it("collects a shortfall and adds the previous employer", () => {
    const result = calculateYearEnd({
      year: 2026,
      taxColumn: "kou",
      salary: { pay: 1_000_000n, bonus: 0n, socialInsurance: 100_000n, withheld: 10_000n },
      declaration: declaration({
        previousEmployer: { paid: 3_000_000n, socialInsurance: 400_000n, withheld: 20_000n },
      }),
    });
    // 4,000,000 → 2,760,000 (4,000,000 × 80% − 440,000); 社保 500,000・基礎 1,040,000 → 1,220,000.
    expect(result).toMatchObject({
      totalPay: 4_000_000n,
      salaryIncome: 2_760_000n,
      deductions: { socialInsurance: 500_000n, total: 1_540_000n },
      taxableIncome: 1_220_000n,
      computedTax: 61_000n,
      annualTax: 62_200n,
      withheld: 30_000n,
      difference: 32_200n,
      settlement: { kind: "shortfall", label: "不足", amount: 32_200n },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The deductions
// ---------------------------------------------------------------------------------------------

describe("生命保険料控除 and 地震保険料控除", () => {
  const life = table.lifeInsurance;

  it.each([
    [0n, 0n],
    [1n, 1n],
    [20_000n, 20_000n],
    [20_001n, 20_001n],
    [40_000n, 30_000n],
    [40_001n, 30_001n],
    [80_000n, 40_000n],
    [80_001n, 40_000n],
  ])("計算式Ⅰ: %s → %s (1 円未満切り上げ)", (premium, expected) => {
    expect(formulaAmount(life.newFormula, premium)).toBe(expected);
  });

  it.each([
    [30_000n, 30_000n],
    [30_001n, 30_001n],
    [60_000n, 45_000n],
    [60_001n, 45_001n],
    [120_000n, 60_000n],
    [120_001n, 60_000n],
  ])("計算式Ⅱ (23 歳未満の扶養親族あり): %s → %s", (premium, expected) => {
    expect(formulaAmount(life.newUnder23Formula, premium)).toBe(expected);
  });

  it.each([
    [25_000n, 25_000n],
    [25_001n, 25_001n],
    [50_000n, 37_500n],
    [50_001n, 37_501n],
    [100_000n, 50_000n],
    [100_001n, 50_000n],
  ])("計算式Ⅲ (旧): %s → %s", (premium, expected) => {
    expect(formulaAmount(life.oldFormula, premium)).toBe(expected);
  });

  it("caps each category and the total", () => {
    const none = { newGeneral: 0n, oldGeneral: 0n, medical: 0n, newPension: 0n, oldPension: 0n };
    // 新だけ: 4 万円 (23 歳未満の扶養親族ありは 6 万円).
    expect(lifeInsuranceDeduction(table, { ...none, newGeneral: 200_000n }, false).general).toBe(
      40_000n,
    );
    expect(lifeInsuranceDeduction(table, { ...none, newGeneral: 200_000n }, true).general).toBe(
      60_000n,
    );
    // 旧だけ: 5 万円.
    expect(lifeInsuranceDeduction(table, { ...none, oldGeneral: 200_000n }, false).general).toBe(
      50_000n,
    );
    // 新旧: 合計は 4 万円まで、旧だけの方が大きければ旧だけ (5 万円); 23 歳未満ありは 6 万円まで.
    const both = { ...none, newGeneral: 100_000n, oldGeneral: 100_000n };
    expect(lifeInsuranceDeduction(table, both, false).general).toBe(50_000n);
    expect(lifeInsuranceDeduction(table, both, true).general).toBe(60_000n);
    const small = { ...none, newGeneral: 10_000n, oldGeneral: 10_000n };
    expect(lifeInsuranceDeduction(table, small, false).general).toBe(20_000n);
    const nearCap = { ...none, newGeneral: 30_000n, oldGeneral: 20_000n };
    expect(lifeInsuranceDeduction(table, nearCap, false).general).toBe(40_000n);
    // 個人年金: 新旧で 4 万円まで; 介護医療は計算式Ⅰ.
    const pension = { ...none, newPension: 30_000n, oldPension: 30_000n, medical: 100_000n };
    expect(lifeInsuranceDeduction(table, pension, false)).toMatchObject({
      pension: 40_000n,
      medical: 40_000n,
    });
    // 合計 12 万円.
    const all = {
      newGeneral: 200_000n,
      oldGeneral: 0n,
      medical: 200_000n,
      newPension: 200_000n,
      oldPension: 0n,
    };
    expect(lifeInsuranceDeduction(table, all, true)).toEqual({
      general: 60_000n,
      medical: 40_000n,
      pension: 40_000n,
      total: 120_000n,
    });
  });

  it("gives 地震保険料 in full up to 5 万円 and 旧長期損害保険料 by its formula", () => {
    const earthquake = (premium: bigint, oldLongTerm = 0n) =>
      earthquakeDeduction(table, { earthquake: premium, oldLongTerm });
    expect(earthquake(50_000n)).toBe(50_000n);
    expect(earthquake(60_000n)).toBe(50_000n);
    expect(earthquake(0n, 10_000n)).toBe(10_000n);
    expect(earthquake(0n, 10_001n)).toBe(10_001n);
    expect(earthquake(0n, 20_000n)).toBe(15_000n);
    expect(earthquake(0n, 20_001n)).toBe(15_000n);
    expect(earthquake(0n, 14_800n)).toBe(12_400n);
    expect(earthquake(40_000n, 30_000n)).toBe(50_000n);
  });
});

describe("配偶者控除・配偶者特別控除", () => {
  const spouse = (earner: bigint, income: bigint, elderly = false) =>
    spouseDeduction(table, earner, { totalIncome: income, elderly });

  it("takes the column of 所得者の合計所得金額", () => {
    expect(spouse(9_000_000n, 620_000n)).toEqual({ amount: 380_000n, kind: "spouse" });
    expect(spouse(9_000_000n, 620_000n, true)).toEqual({ amount: 480_000n, kind: "spouse" });
    expect(spouse(9_000_001n, 620_000n)).toEqual({ amount: 260_000n, kind: "spouse" });
    expect(spouse(9_500_000n, 0n, true)).toEqual({ amount: 320_000n, kind: "spouse" });
    expect(spouse(9_500_001n, 0n)).toEqual({ amount: 130_000n, kind: "spouse" });
    expect(spouse(10_000_000n, 0n, true)).toEqual({ amount: 160_000n, kind: "spouse" });
    expect(spouse(10_000_001n, 0n)).toEqual({ amount: 0n, kind: null });
    expect(spouseDeduction(table, 1_000_000n, null)).toEqual({ amount: 0n, kind: null });
  });

  it.each([
    [620_001n, 380_000n, 130_000n],
    [950_000n, 380_000n, 130_000n],
    [950_001n, 360_000n, 120_000n],
    [1_000_000n, 360_000n, 120_000n],
    [1_000_001n, 310_000n, 110_000n],
    [1_050_001n, 260_000n, 90_000n],
    [1_100_001n, 210_000n, 70_000n],
    [1_150_001n, 160_000n, 60_000n],
    [1_200_001n, 110_000n, 40_000n],
    [1_250_001n, 60_000n, 20_000n],
    [1_300_001n, 30_000n, 10_000n],
    [1_330_000n, 30_000n, 10_000n],
  ])("配偶者の合計所得 %s → 配偶者特別控除 %s (1,000 万円以下の列 %s)", (income, first, third) => {
    expect(spouse(5_000_000n, income, true)).toEqual({ amount: first, kind: "special" });
    expect(spouse(10_000_000n, income)).toEqual({ amount: third, kind: "special" });
  });

  it("gives nothing above 133 万円", () => {
    expect(spouse(5_000_000n, 1_330_001n)).toEqual({ amount: 0n, kind: null });
  });
});

describe("特定親族特別控除・扶養控除・障害者等・基礎控除・所得金額調整控除", () => {
  it.each([
    [620_000n, 0n],
    [620_001n, 630_000n],
    [850_000n, 630_000n],
    [850_001n, 610_000n],
    [900_001n, 510_000n],
    [950_001n, 410_000n],
    [1_000_000n, 410_000n],
    [1_000_001n, 310_000n],
    [1_050_001n, 210_000n],
    [1_100_001n, 110_000n],
    [1_150_001n, 60_000n],
    [1_200_001n, 30_000n],
    [1_230_000n, 30_000n],
    [1_230_001n, 0n],
  ])("特定親族の合計所得 %s → %s", (income, expected) => {
    expect(specificRelativeDeduction(table, income)).toBe(expected);
  });

  it("adds each dependent, the disabilities and the person's own statuses", () => {
    const result = dependentDeductions(
      table,
      {
        dependents: [
          { category: "general", disability: "none", under23: true },
          { category: "specific", disability: "special", under23: false },
          { category: "elderly", disability: "none", under23: false },
          { category: "elderly_cohabiting", disability: "special_cohabiting", under23: false },
          { category: "minor", disability: "general", under23: false },
        ],
        spouse: { totalIncome: 620_000n, elderly: false, disability: "special" },
        self: { disability: "general", widowStatus: "single_parent", workingStudent: false },
      },
      5_000_000n,
    );
    expect(result).toEqual({
      dependents: 380_000n + 630_000n + 480_000n + 580_000n,
      // 特別 40 万 + 同居特別 75 万 + 一般 27 万 (16 歳未満) + 配偶者 特別 40 万 + 本人 一般 27 万.
      disability: 400_000n + 750_000n + 270_000n + 400_000n + 270_000n,
      widowOrSingleParent: 350_000n,
      workingStudent: 0n,
      total: 2_070_000n + 2_090_000n + 350_000n,
    });
    // A spouse above 62 万円 is not a 同一生計配偶者: no 障害者控除 for them.
    const earning = dependentDeductions(
      table,
      {
        dependents: [],
        spouse: { totalIncome: 620_001n, elderly: false, disability: "special" },
        self: { disability: "none", widowStatus: "widow", workingStudent: true },
      },
      890_000n,
    );
    expect(earning).toEqual({
      dependents: 0n,
      disability: 0n,
      widowOrSingleParent: 270_000n,
      workingStudent: 270_000n,
      total: 540_000n,
    });
    // 合計所得金額の要件: 寡婦・ひとり親 500 万円、勤労学生 89 万円.
    const over = dependentDeductions(
      table,
      {
        dependents: [],
        spouse: null,
        self: { disability: "none", widowStatus: "widow", workingStudent: true },
      },
      5_000_001n,
    );
    expect(over.total).toBe(0n);
  });

  it.each([
    [4_890_000n, 1_040_000n],
    [4_890_001n, 670_000n],
    [6_550_000n, 670_000n],
    [6_550_001n, 620_000n],
    [23_500_000n, 620_000n],
    [23_500_001n, 480_000n],
    [24_000_001n, 320_000n],
    [24_500_001n, 160_000n],
    [25_000_000n, 160_000n],
    [25_000_001n, 0n],
  ])("基礎控除: 合計所得 %s → %s", (income, expected) => {
    expect(basicDeduction(table, income)).toBe(expected);
  });

  it("所得金額調整控除: above 850 万円, capped at 1,000 万円, rounded up", () => {
    expect(incomeAdjustmentDeduction(table, 8_500_000n, true)).toBe(0n);
    expect(incomeAdjustmentDeduction(table, 8_500_001n, true)).toBe(1n);
    expect(incomeAdjustmentDeduction(table, 8_500_010n, true)).toBe(1n);
    expect(incomeAdjustmentDeduction(table, 8_500_011n, true)).toBe(2n);
    expect(incomeAdjustmentDeduction(table, 10_000_000n, true)).toBe(150_000n);
    expect(incomeAdjustmentDeduction(table, 15_000_000n, true)).toBe(150_000n);
    expect(incomeAdjustmentDeduction(table, 15_000_000n, false)).toBe(0n);
  });

  it("所得金額調整控除の要件: the person's check, a 特別障害者, a 23 歳未満の扶養親族", () => {
    const at = (patch: Partial<YearEndDeclaration>) =>
      calculateYearEnd({
        year: 2026,
        taxColumn: "kou",
        salary: { pay: 9_000_000n, bonus: 0n, socialInsurance: 0n, withheld: 0n },
        declaration: declaration(patch),
      }).incomeAdjustment;
    expect(at({})).toBe(0n);
    expect(at({ incomeAdjustment: true })).toBe(50_000n);
    expect(
      at({ self: { disability: "special", widowStatus: "none", workingStudent: false } }),
    ).toBe(50_000n);
    expect(at({ dependents: [{ category: "general", disability: "none", under23: true }] })).toBe(
      50_000n,
    );
    expect(at({ dependents: [{ category: "minor", disability: "none", under23: false }] })).toBe(
      50_000n,
    );
    expect(at({ dependents: [{ category: "elderly", disability: "none", under23: false }] })).toBe(
      0n,
    );
    expect(
      at({ spouse: { totalIncome: 0n, elderly: false, disability: "special_cohabiting" } }),
    ).toBe(50_000n);
    expect(
      at({ spouse: { totalIncome: 700_000n, elderly: false, disability: "special_cohabiting" } }),
    ).toBe(0n);
  });
});

describe("税額と対象者", () => {
  it.each([
    [0n, 0n],
    [1_000n, 50n],
    [1_950_000n, 97_500n],
    [1_951_000n, 97_600n],
    [3_300_000n, 232_500n],
    [3_301_000n, 232_700n],
    [6_950_000n, 962_500n],
    [9_000_000n, 1_434_000n],
    [18_000_000n, 4_404_000n],
    [18_050_000n, 4_424_000n],
  ])("算出所得税額 (速算表): %s → %s", (taxable, expected) => {
    expect(computedIncomeTax(table, taxable)).toBe(expected);
  });

  it("年調年税額: × 102.1%, 100 円未満切り捨て", () => {
    expect(annualTaxWithSurtax(table, 40_600n)).toBe(41_400n);
    expect(annualTaxWithSurtax(table, 4_000n)).toBe(4_000n);
    expect(annualTaxWithSurtax(table, 0n)).toBe(0n);
    expect(annualTaxWithSurtax(table, 97_943n)).toBe(99_900n);
    expect(annualTaxWithSurtax(table, 97_944n)).toBe(100_000n);
  });

  it("caps 住宅借入金等特別控除 at the computed tax", () => {
    const result = calculateYearEnd({
      ...example,
      declaration: { ...example.declaration, housingLoanCredit: 200_000n },
    });
    expect(result).toMatchObject({
      housingLoanCredit: 117_100n,
      annualIncomeTax: 0n,
      annualTax: 0n,
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual(["housing_loan_over"]);
  });

  it("tells why a person is not adjusted (乙欄・2,000 万円超・課税給与所得 1,805 万円超)", () => {
    const base: YearEndInput = {
      year: 2026,
      taxColumn: "kou",
      salary: { pay: 20_000_000n, bonus: 0n, socialInsurance: 0n, withheld: 0n },
      declaration: declaration(),
    };
    expect(calculateYearEnd(base).eligible).toBe(true);
    expect(calculateYearEnd({ ...base, taxColumn: "otsu" }).ineligible.map((r) => r.code)).toEqual([
      "otsu",
    ]);
    const over = calculateYearEnd({
      ...base,
      salary: { ...base.salary, pay: 20_000_001n },
    });
    expect(over.eligible).toBe(false);
    expect(over.ineligible.map((reason) => reason.code)).toEqual(["income_over"]);
    // 2,000 万円の給与なら、基礎控除が 0 になっても課税給与所得は 1,805 万円を超えない.
    const taxable = calculateYearEnd({
      ...base,
      declaration: declaration({ otherIncome: 10_000_000n }),
    });
    expect(taxable.taxableIncome).toBe(18_050_000n);
    expect(taxable.eligible).toBe(true);
    const high = calculateYearEnd({
      ...base,
      salary: { ...base.salary, pay: 20_100_000n },
      declaration: declaration({ otherIncome: 10_000_000n }),
    });
    expect(high.taxableIncome).toBe(18_150_000n);
    expect(high.ineligible.map((reason) => reason.code)).toEqual(["income_over", "taxable_over"]);
  });

  it("rejects broken input and a year without data", () => {
    const broken = { ...example, salary: { ...example.salary, withheld: -1n } };
    expect(() => calculateYearEnd(broken)).toThrow(PayrollInputError);
    const amount = thrown(() =>
      calculateYearEnd({
        ...example,
        declaration: {
          ...example.declaration,
          insurance: { ...example.declaration.insurance, earthquake: -5n },
        },
      }),
    );
    expect((amount as PayrollInputError).issues).toEqual([
      expect.objectContaining({ code: "INVALID_AMOUNT", field: "insurance.earthquake" }),
    ]);
    expect(() => calculateYearEnd({ ...example, year: 2027 })).toThrow(PayrollTableMissingError);
    expect(() => calculateYearEnd({ ...example, year: 2027, table })).toThrow(PayrollInputError);
    expect(() => findYearEndTable(1999)).toThrow(PayrollInputError);
    const missing = thrown(() => findYearEndTable(2027));
    expect(missing).toBeInstanceOf(PayrollTableMissingError);
    expect((missing as PayrollTableMissingError).tableKind).toBe("year-end");
    expect((missing as PayrollTableMissingError).message).toMatch(/2027 年分の年末調整の表/);
  });
});

// ---------------------------------------------------------------------------------------------
// The settlement entry
// ---------------------------------------------------------------------------------------------

describe("精算の仕訳 (§11.4)", () => {
  it("refunds a 過納 from 預り金〔源泉所得税〕 to 未払金〔給与〕 or the wallet", () => {
    const refund = buildYearEndSettlementEntry({
      year: 2026,
      name: "年調 一郎",
      difference: -115_270n,
      payFrom: "accrued",
    });
    expect(refund).toEqual({
      description: "年末調整 2026 年分 年調 一郎（過納額の還付）",
      lines: [
        {
          side: "debit",
          target: { kind: "account", accountCode: "2300", subAccountName: "源泉所得税" },
          amount: 115_270n,
          taxCategoryCode: "na",
        },
        {
          side: "credit",
          target: { kind: "account", accountCode: "2100", subAccountName: "給与" },
          amount: 115_270n,
          taxCategoryCode: "na",
        },
      ],
    });
    const shortfall = buildYearEndSettlementEntry({
      year: 2026,
      name: "年調 二子",
      difference: 32_200n,
      payFrom: "wallet",
    });
    expect(shortfall?.lines.map((line) => [line.side, line.target.kind, line.amount])).toEqual([
      ["debit", "wallet", 32_200n],
      ["credit", "account", 32_200n],
    ]);
    expect(shortfall?.description).toMatch(/不足額の徴収/);
    expect(
      buildYearEndSettlementEntry({ year: 2026, name: "x", difference: 0n, payFrom: "accrued" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The data file
// ---------------------------------------------------------------------------------------------

describe("data/2026/year-end.json", () => {
  it("is registered and read the same way by kind", () => {
    expect(findTableById("year-end-2026")).toBe(table);
    expect(parsePayrollTable(json())).toEqual(table);
    expect(table).toMatchObject({
      title: "令和８年分 年末調整のしかた",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
      year: 2026,
      source: {
        url: "https://www.nta.go.jp/publication/pamph/gensen/nencho2026/pdf/nencho_all.pdf",
        fetchedAt: "2026-10-29",
        sha256: "337bd78fdc3f6dc74e9fe7b3a5998e95fc690b144742d0f0b32044dbbca65498",
      },
      birthDates: {
        specificFrom: "2004-01-02",
        specificTo: "2008-01-01",
        elderlyTo: "1957-01-01",
        age16To: "2011-01-01",
        under23From: "2004-01-02",
      },
    });
  });

  function expectBroken(mutate: (value: Json) => void, message: RegExp): void {
    const value = json();
    mutate(value);
    expect(() => parseYearEndTable(value)).toThrow(PayrollTableFormatError);
    expect(() => parseYearEndTable(value)).toThrow(message);
  }

  type Rows = Record<string, unknown>[];

  it("rejects broken data", () => {
    expectBroken((t) => (t.effectiveTo = "2027-12-31"), /effectiveTo/);
    expectBroken((t) => (t.year = 2025), /effectiveFrom/);
    expectBroken((t) => ((t.salaryIncome as Rows)[1]!.from = 742_000), /salaryIncome\[1\]\.from/);
    expectBroken((t) => ((t.salaryIncome as Rows)[2]!.amount = 1_000_000), /salaryIncome\[2\]/);
    expectBroken((t) => ((t.salaryIncome as Rows)[8]!.to = 30_000_000), /salaryIncome\[8\]\.to/);
    expectBroken((t) => ((t.salaryIncome as Rows)[5]!.kind = "steps"), /salaryIncome\[5\]\.kind/);
    expectBroken((t) => ((t.taxBrackets as Rows)[1]!.deduction = 97_000), /taxBrackets\[1\]/);
    expectBroken(
      (t) => (((t.lifeInsurance as Json).newFormula as Rows)[1]!.add = 11_000),
      /lifeInsurance\.newFormula\[1\]/,
    );
    expectBroken((t) => ((t.basicDeduction as Rows)[1]!.amount = 2_000_000), /basicDeduction\[1\]/);
    expectBroken(
      (t) => (((t.spouse as Json).special as Rows)[0]!.upTo = 600_000),
      /spouse\.special\[0\]\.upTo/,
    );
    expectBroken((t) => ((t.surtax as Json).ratePercent = "1.021"), /surtax\.ratePercent/);
    expectBroken((t) => ((t.dependents as Json).extra = 1), /dependents\.extra/);
  });
});
