/**
 * Golden values of docs/design/22-payroll.md §8.1–§8.4, taken from the published tables
 * (fetched 2026-10-28, docs/research/payroll-sources.md).
 */
import { describe, expect, it } from "vitest";
import {
  add,
  aggregateSocialInsurance,
  calculatePayroll,
  determineStandardRemuneration,
  employmentInsurancePremium,
  findEmploymentInsuranceTable,
  findKenpoTable,
  findPensionTable,
  findWithholdingTable,
  formatRational,
  fromDecimalString,
  PayrollInputError,
  PayrollTableMissingError,
  ratio,
  socialInsurancePremiums,
  withholdingTax,
  type PayrollInput,
  type Rational,
  type TaxColumn,
} from "../src";

const R8 = findWithholdingTable("2026-12-25");
const R9 = findWithholdingTable("2027-01-25");
const kou = (dependents: number): TaxColumn => ({ column: "kou", dependents });
const otsu = (secondaryDependents?: number): TaxColumn =>
  secondaryDependents === undefined ? { column: "otsu" } : { column: "otsu", secondaryDependents };
const decimal = (text: string): Rational => fromDecimalString(text.replace(/,/g, ""));

describe("§8.1 源泉徴収税額表 月額表", () => {
  it("uses the 令和 8 年分 table for 2026 payments and 令和 9 年分 for 2027", () => {
    expect(R8.id).toBe("withholding-monthly-2026");
    expect(R9.id).toBe("withholding-monthly-2027");
    expect(findWithholdingTable("2026-01-01").id).toBe(R8.id);
    expect(findWithholdingTable("2026-12-31").id).toBe(R8.id);
    expect(findWithholdingTable("2027-01-01").id).toBe(R9.id);
  });

  // [amount, 甲 0 人, 甲 1 人, 甲 2 人 (null = not in the design table), 乙]
  const reiwa8: [bigint, bigint, bigint, bigint | null, bigint][] = [
    [100_000n, 0n, 0n, 0n, 3_063n],
    [200_000n, 4_340n, 2_730n, 1_100n, 19_700n],
    [250_000n, 6_110n, 4_490n, 2_880n, 35_500n],
    [300_000n, 7_930n, 6_320n, 4_700n, 53_600n],
    [740_000n, 71_680n, 65_210n, 58_750n, 259_200n],
    [750_000n, 73_722n, 67_252n, null, 263_284n],
    [1_710_000n, 374_520n, 368_040n, null, 655_400n],
    [3_500_000n, 1_125_270n, 1_118_800n, null, 1_477_815n],
    [4_000_000n, 1_354_995n, 1_348_525n, null, 1_707_540n],
  ];
  it.each(reiwa8)("令和 8 年分 %s 円", (amount, kou0, kou1, kou2, otsuTax) => {
    expect(withholdingTax(R8, kou(0), amount)).toBe(kou0);
    expect(withholdingTax(R8, kou(1), amount)).toBe(kou1);
    if (kou2 !== null) expect(withholdingTax(R8, kou(2), amount)).toBe(kou2);
    expect(withholdingTax(R8, otsu(), amount)).toBe(otsuTax);
  });

  const reiwa9: [bigint, bigint, bigint, bigint | null, bigint][] = [
    [100_000n, 0n, 0n, 0n, 3_063n],
    [300_000n, 7_760n, 6_150n, 4_530n, 53_200n],
    [740_000n, 71_000n, 64_540n, null, 259_000n],
    [1_720_000n, 377_200n, 370_740n, null, 659_300n],
  ];
  it.each(reiwa9)("令和 9 年分 %s 円", (amount, kou0, kou1, kou2, otsuTax) => {
    expect(withholdingTax(R9, kou(0), amount)).toBe(kou0);
    expect(withholdingTax(R9, kou(1), amount)).toBe(kou1);
    if (kou2 !== null) expect(withholdingTax(R9, kou(2), amount)).toBe(kou2);
    expect(withholdingTax(R9, otsu(), amount)).toBe(otsuTax);
  });

  it("selects the row by 以上・未満", () => {
    // 200,000 is in the row 199,000〜201,000 and 300,000 in 299,000〜302,000.
    expect(withholdingTax(R8, kou(0), 199_000n)).toBe(4_340n);
    expect(withholdingTax(R8, kou(0), 200_999n)).toBe(4_340n);
    expect(withholdingTax(R8, kou(0), 201_000n)).not.toBe(4_340n);
    expect(withholdingTax(R8, kou(0), 299_000n)).toBe(7_930n);
    expect(withholdingTax(R8, kou(0), 301_999n)).toBe(7_930n);
    expect(withholdingTax(R8, kou(0), 302_000n)).not.toBe(7_930n);
    // The low band ends at 105,000 (令和 8) / 111,000 (令和 9).
    expect(withholdingTax(R8, kou(0), 104_999n)).toBe(0n);
    expect(withholdingTax(R8, kou(0), 105_000n)).toBe(170n);
    expect(withholdingTax(R9, kou(0), 110_999n)).toBe(0n);
    expect(withholdingTax(R9, kou(0), 111_000n)).toBe(140n);
    expect(withholdingTax(R8, otsu(), 104_999n)).toBe(3_216n); // 104,999 × 3.063% = 3,216.1… → 3,216
    expect(withholdingTax(R8, otsu(), 105_000n)).toBe(3_800n);
  });

  it("uses the table value at a point and the formula inside a segment", () => {
    // Just below the first point the last row applies; at 740,000 the point; above it the formula.
    expect(withholdingTax(R8, kou(0), 739_999n)).toBe(71_380n);
    expect(withholdingTax(R8, kou(0), 740_000n)).toBe(71_680n);
    expect(withholdingTax(R8, kou(0), 740_001n)).toBe(71_680n); // 71,680 + 0.2042 → truncated
    expect(withholdingTax(R8, kou(0), 790_000n)).toBe(81_890n);
    // 乙欄 at 3,500,000: 655,400 + 1,790,000 × 45.945% = 1,477,815.5 → 1,477,815.
    expect(withholdingTax(R8, otsu(), 3_500_000n)).toBe(1_477_815n);
  });

  it("7 dependents at 3,500,000 is the table value 1,080,000", () => {
    expect(withholdingTax(R8, kou(7), 3_500_000n)).toBe(1_080_000n);
  });

  it("deducts 1,610 円 per dependent beyond 7, never below 0", () => {
    expect(withholdingTax(R8, kou(8), 740_000n)).toBe(24_800n); // 26,410 − 1,610
    expect(withholdingTax(R8, kou(9), 740_000n)).toBe(23_190n);
    expect(withholdingTax(R8, kou(8), 300_000n)).toBe(0n);
    expect(withholdingTax(R8, kou(20), 100_000n)).toBe(0n);
  });

  it("乙欄 deducts 1,610 円 per secondary dependent", () => {
    expect(withholdingTax(R8, otsu(1), 300_000n)).toBe(51_990n); // 53,600 − 1,610
    expect(withholdingTax(R8, otsu(0), 300_000n)).toBe(53_600n);
    expect(withholdingTax(R8, otsu(3), 50_000n)).toBe(0n); // 1,531 − 4,830 → 0
  });

  it("has no tax on 0 or a negative amount", () => {
    expect(withholdingTax(R8, kou(0), 0n)).toBe(0n);
    expect(withholdingTax(R8, otsu(), 0n)).toBe(0n);
    expect(withholdingTax(R8, otsu(), -5_000n)).toBe(0n);
  });

  it("rejects a non-integer number of dependents", () => {
    expect(() => withholdingTax(R8, kou(1.5), 300_000n)).toThrow(PayrollInputError);
    expect(() => withholdingTax(R8, kou(-1), 300_000n)).toThrow(PayrollInputError);
    expect(() => withholdingTax(R8, otsu(0.5), 300_000n)).toThrow(PayrollInputError);
  });
});

describe("§8.2 協会けんぽ 神奈川 令和 8 年度（対象月 2026-11）", () => {
  const kenpo = findKenpoTable("2026-11");
  const pension = findPensionTable("2026-11");
  const noCare = { health: true, care: false, pension: true };
  const withCare = { health: true, care: true, pension: true };

  it("selects the 令和 8 年度 tables", () => {
    expect(kenpo.id).toBe("kyokai-kenpo-kanagawa-2026");
    expect(pension.id).toBe("pension-2020");
  });

  // [smr health, health full, care full (health + care), support full, employee w/o care, with care]
  const rows: [bigint, string, string, string, bigint, bigint][] = [
    [58_000n, "5,753.6", "6,693.2", "133.4", 2_943n, 3_413n],
    [300_000n, "29,760.0", "34,620.0", "690.0", 15_225n, 17_655n],
    [410_000n, "40,672.0", "47,314.0", "943.0", 20_807n, 24_128n],
  ];
  it.each(rows)("標準報酬月額 %s 円", (smr, health, care, support, employee, employeeCare) => {
    const premiums = socialInsurancePremiums(
      kenpo,
      pension,
      "2026-11",
      { health: smr, pension: 0n },
      {
        ...noCare,
        pension: false,
      },
    );
    expect(formatRational(premiums.health.breakdown.health, 1)).toBe(health);
    expect(formatRational(premiums.health.breakdown.childSupport, 1)).toBe(support);
    expect(premiums.health.breakdown.care).toEqual(ratio(0n));
    expect(premiums.health.employee).toBe(employee);

    const cared = socialInsurancePremiums(
      kenpo,
      pension,
      "2026-11",
      { health: smr, pension: 0n },
      {
        ...withCare,
        pension: false,
      },
    );
    const { breakdown } = cared.health;
    expect(formatRational(add(breakdown.health, breakdown.care), 1)).toBe(care);
    expect(cared.health.full).toEqual(add(decimal(care), decimal(support)));
    expect(cared.health.employee).toBe(employeeCare);
  });

  it("rounds the combined rate once: (5,753.6 + 133.4) ÷ 2 = 2,943.5 → 2,943", () => {
    const premiums = socialInsurancePremiums(
      kenpo,
      pension,
      "2026-11",
      { health: 58_000n, pension: 0n },
      {
        health: true,
        care: false,
        pension: false,
      },
    );
    expect(premiums.health.full).toEqual(decimal("5887"));
    expect(formatRational(premiums.health.full, 1)).toBe("5,887.0");
    expect(premiums.health.employee).toBe(2_943n);
    expect(premiums.health.employer).toEqual(decimal("2944"));
  });

  it("厚生年金: 300,000 → 54,900 / 27,450, 410,000 → 75,030 / 37,515, 88,000 → 16,104 / 8,052", () => {
    for (const [smr, full, half] of [
      [300_000n, "54900", 27_450n],
      [410_000n, "75030", 37_515n],
      [88_000n, "16104", 8_052n],
    ] as const) {
      const premiums = socialInsurancePremiums(
        kenpo,
        pension,
        "2026-11",
        { health: 0n, pension: smr },
        {
          health: false,
          care: false,
          pension: true,
        },
      );
      expect(premiums.pension.full).toEqual(decimal(full));
      expect(premiums.pension.employee).toBe(half);
      expect(premiums.pension.employer).toEqual(ratio(half));
    }
  });

  it("厚生年金 starts at 88,000 (grade 1): 58,000 is not a pension grade", () => {
    expect(() =>
      socialInsurancePremiums(
        kenpo,
        pension,
        "2026-11",
        { health: 58_000n, pension: 58_000n },
        noCare,
      ),
    ).toThrow(PayrollInputError);
  });

  it("対象月 2026-03 (before 子ども・子育て支援金): 300,000 → 14,880 and 27,450", () => {
    const march = findKenpoTable("2026-03");
    expect(march.id).toBe(kenpo.id);
    const premiums = socialInsurancePremiums(
      march,
      findPensionTable("2026-03"),
      "2026-03",
      { health: 300_000n, pension: 300_000n },
      noCare,
    );
    expect(premiums.health.breakdown.childSupport).toEqual(ratio(0n));
    expect(premiums.health.employee).toBe(14_880n);
    expect(premiums.pension.employee).toBe(27_450n);
    // 2026-04 is the first month with 支援金.
    const april = socialInsurancePremiums(
      march,
      pension,
      "2026-04",
      { health: 300_000n, pension: 300_000n },
      noCare,
    );
    expect(april.health.employee).toBe(15_225n);
  });

  it("子ども・子育て拠出金: 300,000 × 0.36% = 1,080, employer only", () => {
    const premiums = socialInsurancePremiums(
      kenpo,
      pension,
      "2026-11",
      { health: 300_000n, pension: 300_000n },
      noCare,
    );
    expect(premiums.childContribution).toEqual(ratio(1_080n));
    expect(premiums.employeeTotal).toBe(15_225n + 27_450n);
  });

  it("derives the grades from the monthly remuneration", () => {
    const tables = { kenpo, pension };
    expect(determineStandardRemuneration(tables, 295_000n)).toEqual({
      health: { grade: 22, smr: 300_000n },
      pension: { grade: 19, smr: 300_000n },
    });
    expect(determineStandardRemuneration(tables, 60_000n)).toEqual({
      health: { grade: 1, smr: 58_000n },
      pension: { grade: 1, smr: 88_000n },
    });
    expect(determineStandardRemuneration(tables, 700_000n)).toEqual({
      health: { grade: 37, smr: 710_000n },
      pension: { grade: 32, smr: 650_000n },
    });
    expect(determineStandardRemuneration(tables, 1_400_000n).health).toEqual({
      grade: 50,
      smr: 1_390_000n,
    });
    expect(findPensionTable("2027-08").id).toBe("pension-2020");
    expect(
      determineStandardRemuneration({ kenpo, pension: findPensionTable("2027-08") }, 700_000n)
        .pension,
    ).toEqual({ grade: 32, smr: 650_000n });
    const september = findPensionTable("2027-09");
    expect(september.id).toBe("pension-2027");
    expect(determineStandardRemuneration({ kenpo, pension: september }, 700_000n).pension).toEqual({
      grade: 33,
      smr: 680_000n,
    });
    expect(determineStandardRemuneration({ kenpo, pension: september }, 664_999n).pension).toEqual({
      grade: 32,
      smr: 650_000n,
    });
  });
});

describe("§8.3 雇用保険 令和 8 年度（一般の事業）", () => {
  const table = findEmploymentInsuranceTable("2026-11");

  it("250,000 → employee 1,250, employer 2,125", () => {
    expect(table.id).toBe("employment-insurance-2026");
    const premium = employmentInsurancePremium(table, 250_000n);
    expect(premium).toEqual({ base: 250_000n, employee: 1_250n, employer: ratio(2_125n) });
  });

  it("rounds 50 銭 down and above 50 銭 up", () => {
    expect(employmentInsurancePremium(table, 250_120n).employee).toBe(1_251n); // 1,250.6
    expect(employmentInsurancePremium(table, 250_100n).employee).toBe(1_250n); // 1,250.5
  });

  it("an officer with employment insurance is an input error", () => {
    const input = officer({
      coverage: { health: true, care: false, pension: true, employment: true },
    });
    expect(() => calculatePayroll(input)).toThrow(PayrollInputError);
    try {
      calculatePayroll(input);
    } catch (error) {
      expect(error instanceof PayrollInputError && error.has("OFFICER_EMPLOYMENT_INSURANCE")).toBe(
        true,
      );
    }
  });
});

function officer(overrides: Partial<PayrollInput> = {}): PayrollInput {
  return {
    paymentDate: "2026-12-25",
    premiumMonth: "2026-11",
    worker: "officer",
    taxablePay: 300_000n,
    nonTaxablePay: 0n,
    standardRemuneration: { health: 300_000n, pension: 300_000n },
    coverage: { health: true, care: false, pension: true, employment: false },
    taxColumn: kou(0),
    residentTax: 0n,
    ...overrides,
  };
}

function employee(overrides: Partial<PayrollInput> = {}): PayrollInput {
  return {
    paymentDate: "2026-12-25",
    premiumMonth: "2026-11",
    worker: "employee",
    taxablePay: 250_000n,
    nonTaxablePay: 10_000n,
    standardRemuneration: { health: 260_000n, pension: 260_000n },
    coverage: { health: true, care: false, pension: true, employment: true },
    taxColumn: kou(0),
    residentTax: 10_000n,
    ...overrides,
  };
}

describe("§8.4 calculatePayroll", () => {
  it.each([
    [0, 6_430n, 250_895n],
    [1, 4_810n, 252_515n],
  ])("役員報酬 300,000 円・扶養 %i 人", (dependents, incomeTax, netPay) => {
    const result = calculatePayroll(officer({ taxColumn: kou(dependents) }));
    expect(result.grossPay).toBe(300_000n);
    expect(result.socialInsurance.health.employee).toBe(15_225n);
    expect(result.socialInsurance.pension.employee).toBe(27_450n);
    expect(result.socialInsurance.employeeTotal).toBe(42_675n);
    expect(result.employmentInsurance).toBeNull();
    expect(result.withholdingBase).toBe(257_325n);
    expect(result.incomeTax).toBe(incomeTax);
    expect(result.residentTax).toBe(0n);
    expect(result.netPay).toBe(netPay);

    expect(result.socialInsurance.health.employer).toEqual(ratio(15_225n));
    expect(result.socialInsurance.pension.employer).toEqual(ratio(27_450n));
    expect(result.socialInsurance.childContribution).toEqual(ratio(1_080n));
    expect(aggregateSocialInsurance([result.socialInsurance]).employerTotal).toBe(43_755n);

    expect(result.tables.withholding.id).toBe("withholding-monthly-2026");
    expect(result.tables.kenpo.id).toBe("kyokai-kenpo-kanagawa-2026");
    expect(result.tables.pension.id).toBe("pension-2020");
    expect(result.tables.employment).toBeNull();
    expect(result.tables.kenpo.source).toEqual({
      url: "https://www.kyoukaikenpo.or.jp/assets/R8_14kanagawa.pdf",
      fetchedAt: "2026-10-28",
    });
  });

  it.each([
    [0, 4_770n, 206_945n],
    [1, 3_150n, 208_565n],
  ])("給与 250,000 円 + 通勤手当 10,000 円・扶養 %i 人", (dependents, incomeTax, netPay) => {
    const result = calculatePayroll(employee({ taxColumn: kou(dependents) }));
    expect(result.grossPay).toBe(260_000n);
    expect(result.socialInsurance.health.employee).toBe(13_195n);
    expect(result.socialInsurance.pension.employee).toBe(23_790n);
    expect(result.employmentInsurance?.base).toBe(260_000n);
    expect(result.employmentInsurance?.employee).toBe(1_300n);
    expect(
      result.socialInsurance.employeeTotal + (result.employmentInsurance?.employee ?? 0n),
    ).toBe(38_285n);
    expect(result.withholdingBase).toBe(211_715n);
    expect(result.incomeTax).toBe(incomeTax);
    expect(result.residentTax).toBe(10_000n);
    expect(result.netPay).toBe(netPay);

    const aggregate = aggregateSocialInsurance([result.socialInsurance]);
    expect(aggregate.health.employer).toBe(13_195n);
    expect(aggregate.pension.employer).toBe(23_790n);
    expect(aggregate.childContribution).toBe(936n);
    expect(result.employmentInsurance?.employer).toEqual(ratio(2_210n));
    expect(aggregate.employerTotal + 2_210n).toBe(40_131n);
    expect(result.tables.employment?.id).toBe("employment-insurance-2026");
  });

  it("役員・介護あり（40〜64 歳）: 45,105 円控除、源泉 6,320 円、差引 248,575 円", () => {
    const result = calculatePayroll(
      officer({ coverage: { health: true, care: true, pension: true, employment: false } }),
    );
    expect(result.socialInsurance.health.employee).toBe(17_655n);
    expect(result.socialInsurance.employeeTotal).toBe(45_105n);
    expect(result.withholdingBase).toBe(254_895n);
    expect(result.incomeTax).toBe(6_320n);
    expect(result.netPay).toBe(248_575n);
  });

  it("支払日 2027-01-25・対象月 2026-12 uses the 令和 9 年分 table", () => {
    const zero = calculatePayroll(officer({ paymentDate: "2027-01-25", premiumMonth: "2026-12" }));
    expect(zero.tables.withholding.id).toBe("withholding-monthly-2027");
    expect(zero.tables.kenpo.id).toBe("kyokai-kenpo-kanagawa-2026");
    expect(zero.incomeTax).toBe(6_260n);
    expect(zero.netPay).toBe(251_065n);
    const one = calculatePayroll(
      officer({ paymentDate: "2027-01-25", premiumMonth: "2026-12", taxColumn: kou(1) }),
    );
    expect(one.incomeTax).toBe(4_650n);
  });

  it("対象月 2027-03 has no 協会けんぽ table yet", () => {
    const input = officer({ paymentDate: "2027-04-24", premiumMonth: "2027-03" });
    expect(() => calculatePayroll(input)).toThrow(PayrollTableMissingError);
    try {
      calculatePayroll(input);
    } catch (error) {
      expect(error).toBeInstanceOf(PayrollTableMissingError);
      if (!(error instanceof PayrollTableMissingError)) return;
      expect(error.tableKind).toBe("kyokai-kenpo");
      expect(error.needed).toBe("2027-03");
      expect(error.message).toContain("2027 年 3 月分");
      expect(error.message).toContain("2027 年度");
    }
  });

  it("支払日 2028-01-01 has no withholding table yet", () => {
    const input = officer({ paymentDate: "2028-01-01", premiumMonth: "2026-12" });
    expect(() => calculatePayroll(input)).toThrow(PayrollTableMissingError);
    try {
      calculatePayroll(input);
    } catch (error) {
      if (!(error instanceof PayrollTableMissingError)) throw error;
      expect(error.tableKind).toBe("withholding-monthly");
      expect(error.needed).toBe("2028-01-01");
      expect(error.message).toContain("2028 年分");
    }
  });

  it("a standard remuneration that is not a grade amount is an input error", () => {
    expect(() =>
      calculatePayroll(officer({ standardRemuneration: { health: 305_000n, pension: 300_000n } })),
    ).toThrow(PayrollInputError);
  });
});
