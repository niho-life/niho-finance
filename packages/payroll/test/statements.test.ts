/**
 * 法定調書 (22-payroll §12.2): the 源泉徴収票 of the 設例 of 「年末調整のしかた」 and of Fixture A, a
 * leaver's slip without 年末調整, the 提出範囲, 合計表's rows, and the unified CSV (147 items, 和暦,
 * 全角 / 半角, マイナンバー only from the options). Every person and address is fictional.
 */
import { describe, expect, it } from "vitest";
import {
  annualSalaryTotals,
  buildWithholdingSlip,
  calculateYearEnd,
  emptyYearEndDeclaration,
  findYearEndTable,
  inSalaryReportRange,
  inTaxOfficeRange,
  japaneseEra,
  specificRelativeCode,
  statementCsvText,
  toFullWidth,
  toHalfWidth,
  unifiedCsvIssues,
  unifiedCsvRow,
  UNIFIED_CSV_FIELD_COUNT,
  warekiYear2,
  yearEndCalculationPart,
  type StatementPayer,
  type WithholdingSlipInput,
  type YearEndDeclaration,
} from "../src";

const table = findYearEndTable(2026);

const PAYER: StatementPayer = {
  name: "架空株式会社",
  address: "架空県架空市本町1-2-3",
  phone: "045-000-0000",
  corporateNumber: "7000012345678",
};

const person = (name: string, furigana: string, nonResident = false) => ({
  name,
  furigana,
  nonResident,
});

/** The 設例 of 「年末調整のしかた」 57 ページ with the names a 源泉徴収票 needs (fictional). */
const exampleDeclaration: YearEndDeclaration = {
  ...emptyYearEndDeclaration(),
  dependents: [
    {
      category: "general",
      disability: "none",
      under23: false,
      person: person("テスト 一郎", "テスト イチロウ"),
    },
    {
      category: "specific",
      disability: "none",
      under23: false,
      person: person("テスト 次郎", "てすと じろう"),
    },
    {
      category: "elderly_cohabiting",
      disability: "general",
      under23: false,
      person: person("テスト 梅", "ﾃｽﾄ ｳﾒ"),
    },
  ],
  spouse: {
    totalIncome: 500_000n,
    elderly: false,
    disability: "none",
    person: person("テスト 花子", "テスト ハナコ"),
  },
  specificRelatives: [
    { totalIncome: 1_000_000n, person: person("テスト 三郎", "テスト サブロウ") },
  ],
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
  recipient: {
    furigana: "テスト タロウ",
    address: "架空県架空市中町4-5-6",
    municipalityCode: "149999",
    recipientNo: "",
  },
};

const exampleYearEnd = calculateYearEnd({
  year: 2026,
  taxColumn: "kou",
  salary: { pay: 8_970_000n, bonus: 0n, socialInsurance: 1_386_102n, withheld: 156_670n },
  declaration: exampleDeclaration,
});

const exampleInput: WithholdingSlipInput = {
  year: 2026,
  payer: PAYER,
  employee: {
    id: "01JEXAMPLEEMPLOYEE0000001",
    name: "テスト 太郎",
    kind: "employee",
    birthDate: "1980-04-01",
    taxColumn: "kou",
    leftOn: null,
    joinedOn: null,
  },
  totals: { pay: 8_970_000n, bonus: 0n, socialInsurance: 1_386_102n, withheld: 156_670n },
  declaration: exampleDeclaration,
  yearEnd: exampleYearEnd,
  table,
};

describe("the 源泉徴収票 of the 設例 (§12.2)", () => {
  const slip = buildWithholdingSlip(exampleInput);

  it("carries every amount of the 年末調整", () => {
    expect(slip).toMatchObject({
      adjusted: true,
      kindLabel: "給料",
      paid: 8_970_000n,
      salaryIncomeAfterAdjustment: 6_973_000n,
      totalDeductions: 4_826_102n,
      withheld: 41_400n,
      spouse: { has: true, secondary: false, elderly: false },
      spouseDeduction: 380_000n,
      socialInsurance: 1_386_102n,
      smallBusinessMutualAid: 0n,
      lifeInsurance: 120_000n,
      earthquake: 50_000n,
      housingLoan: 76_500n,
      spouseTotalIncome: 500_000n,
      oldLongTerm: 14_800n,
      basicDeduction: 620_000n,
      incomeAdjustment: 47_000n,
      specificRelativeDeduction: 410_000n,
      lifeInsuranceBreakdown: {
        newLife: 80_000n,
        oldLife: 35_000n,
        medical: 80_000n,
        newPension: 30_000n,
        oldPension: 90_000n,
      },
      housingLoanBreakdown: { possible: 76_500n },
    });
  });

  it("counts the relatives and names them", () => {
    expect(slip.dependents).toEqual({
      specific: 1,
      elderly: 1,
      elderlyCohabiting: 1,
      other: 1,
      specificRelative: 1,
      secondary: { specific: 0, elderly: 0, other: 0, specificRelative: 0 },
    });
    expect(slip.minors).toBe(0);
    expect(slip.disabled).toEqual({ special: 0, specialCohabiting: 0, other: 1 });
    expect(slip.nonResidentRelatives).toBe(0);
    expect(slip.spousePerson).toMatchObject({ name: "テスト 花子", code: "" });
    expect(slip.dependentPersons.map((relative) => [relative.name, relative.code])).toEqual([
      ["テスト 一郎", "00"],
      ["テスト 次郎", "00"],
      ["テスト 梅", "00"],
      // 特定親族 with 合計所得 100 万円: the 4th bracket (95 万円超 100 万円以下) → 40.
      ["テスト 三郎", "40"],
    ]);
    expect(slip.recipient).toMatchObject({
      furigana: "テスト タロウ",
      municipalityCode: "149999",
      // Empty 受給者番号 → the employee id.
      recipientNo: "01JEXAMPLEEMPLOYEE0000001",
    });
    expect(slip.flags).toMatchObject({ otsu: false, minor: false, widow: false });
    expect(slip.employmentChange).toBeNull();
    expect(slip.remarks).toEqual([]);
  });

  it("does not depend on the names for the numbers", () => {
    const without = calculateYearEnd({
      year: 2026,
      taxColumn: "kou",
      salary: { pay: 8_970_000n, bonus: 0n, socialInsurance: 1_386_102n, withheld: 156_670n },
      declaration: yearEndCalculationPart(exampleDeclaration),
    });
    expect(without).toEqual(exampleYearEnd);
    const part = yearEndCalculationPart(exampleDeclaration);
    expect(part.recipient).toBeUndefined();
    expect(part.dependents.every((dependent) => dependent.person === undefined)).toBe(true);
    expect(part.spouse?.person).toBeUndefined();
  });

  it("notes the 住宅借入金等特別控除可能額 when the credit is limited", () => {
    const limited = buildWithholdingSlip({
      ...exampleInput,
      declaration: { ...exampleDeclaration, housingLoanCredit: 200_000n },
      yearEnd: calculateYearEnd({
        year: 2026,
        taxColumn: "kou",
        salary: { pay: 8_970_000n, bonus: 0n, socialInsurance: 1_386_102n, withheld: 156_670n },
        declaration: { ...exampleDeclaration, housingLoanCredit: 200_000n },
      }),
    });
    expect(limited.housingLoan).toBe(117_100n);
    expect(limited.remarks).toContain("住宅借入金等特別控除可能額 200,000 円");
  });
});

describe("Fixture A: an officer (甲欄 0 人) with 1,200,000 円 (§11.6)", () => {
  const yearEnd = calculateYearEnd({
    year: 2026,
    taxColumn: "kou",
    salary: { pay: 1_200_000n, bonus: 0n, socialInsurance: 135_315n, withheld: 45_479n },
    declaration: emptyYearEndDeclaration(),
  });
  const slip = buildWithholdingSlip({
    year: 2026,
    payer: PAYER,
    employee: {
      id: "emp_officer",
      name: "テスト 太郎",
      kind: "officer",
      birthDate: "1975-06-15",
      taxColumn: "kou",
      leftOn: null,
      joinedOn: "2026-04-01",
    },
    totals: { pay: 1_200_000n, bonus: 0n, socialInsurance: 135_315n, withheld: 45_479n },
    declaration: emptyYearEndDeclaration(),
    yearEnd,
    table,
  });

  it("gives the officer's slip", () => {
    expect(slip).toMatchObject({
      adjusted: true,
      kindLabel: "役員報酬",
      paid: 1_200_000n,
      salaryIncomeAfterAdjustment: 460_000n,
      totalDeductions: 1_175_315n,
      withheld: 0n,
      socialInsurance: 135_315n,
      basicDeduction: 1_040_000n,
      spouse: { has: false },
      employmentChange: { kind: "joined", date: "2026-04-01" },
    });
    // 役員 150 万円以下: not to the tax office; 給与支払報告書 to the municipality.
    expect(inTaxOfficeRange(slip)).toBe(false);
    expect(inSalaryReportRange(slip)).toBe(true);
  });
});

describe("a leaver without 年末調整 (§12.2)", () => {
  const declaration: YearEndDeclaration = {
    ...emptyYearEndDeclaration(),
    dependents: [
      {
        category: "minor",
        disability: "none",
        under23: false,
        person: person("テスト 小太郎", "テスト コタロウ"),
      },
    ],
  };
  const slip = buildWithholdingSlip({
    year: 2026,
    payer: PAYER,
    employee: {
      id: "emp_leaver",
      name: "テスト 花子",
      kind: "employee",
      birthDate: "1990-02-03",
      taxColumn: "kou",
      leftOn: "2026-06-30",
      joinedOn: null,
    },
    totals: { pay: 280_000n, bonus: 0n, socialInsurance: 40_000n, withheld: 3_000n },
    declaration,
    yearEnd: null,
    table,
  });

  it("carries 支払金額・源泉徴収税額・社会保険料等 and the 申告書's counts only", () => {
    expect(slip).toMatchObject({
      adjusted: false,
      paid: 280_000n,
      withheld: 3_000n,
      socialInsurance: 40_000n,
      salaryIncomeAfterAdjustment: null,
      totalDeductions: null,
      spouseDeduction: null,
      lifeInsurance: null,
      basicDeduction: null,
      minors: 1,
      employmentChange: { kind: "left", date: "2026-06-30" },
    });
    expect(slip.minorPersons.map((relative) => relative.code)).toEqual(["00"]);
  });

  it("leaves the 給与支払報告書 out at 30 万円 or less", () => {
    expect(inSalaryReportRange(slip)).toBe(false);
    expect(inSalaryReportRange({ ...slip, paid: 300_001n })).toBe(true);
    expect(inTaxOfficeRange(slip)).toBe(false);
  });
});

describe("合計表 (給与) の元データ", () => {
  it("sums everyone and the parts", () => {
    const adjusted = buildWithholdingSlip(exampleInput);
    const officer = buildWithholdingSlip({
      ...exampleInput,
      employee: { ...exampleInput.employee, id: "emp_officer", kind: "officer", taxColumn: "otsu" },
      totals: { pay: 600_000n, bonus: 0n, socialInsurance: 0n, withheld: 0n },
      declaration: null,
      yearEnd: null,
    });
    const totals = annualSalaryTotals([adjusted, officer]);
    expect(totals.all).toEqual({
      people: 2,
      paid: 9_570_000n,
      withheld: 41_400n,
      peopleWithoutTax: 1,
    });
    expect(totals.adjusted).toEqual({ people: 1, paid: 8_970_000n, withheld: 41_400n });
    expect(totals.notAdjusted).toEqual({ people: 1, paid: 600_000n, withheld: 0n });
    expect(totals.officers).toEqual({ people: 1, paid: 600_000n, withheld: 0n });
    // 年調済み 500 万円超・乙欄 50 万円超.
    expect(totals.taxOffice.people).toBe(2);
    expect(totals.salaryReport.people).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// The unified CSV
// ---------------------------------------------------------------------------------------------

describe("text rules", () => {
  it("writes 和暦", () => {
    expect(warekiYear2(2026)).toBe("08");
    expect(warekiYear2(2019)).toBe("01");
    expect(japaneseEra("2019-04-30")).toEqual({ era: "heisei", year: 31 });
    expect(japaneseEra("2019-05-01")).toEqual({ era: "reiwa", year: 1 });
    expect(japaneseEra("1980-04-01")).toEqual({ era: "showa", year: 55 });
    expect(japaneseEra("1989-01-07")).toEqual({ era: "showa", year: 64 });
  });

  it("converts 全角 / 半角 and drops , and @", () => {
    expect(toHalfWidth("テスト ガッコウ")).toBe("ﾃｽﾄ ｶﾞｯｺｳ");
    expect(toHalfWidth("てすと　ぱんだ")).toBe("ﾃｽﾄ ﾊﾟﾝﾀﾞ");
    expect(toHalfWidth("ＡＢ,１@２")).toBe("AB12");
    expect(toFullWidth("架空市1-2-3, A@B")).toBe("架空市１－２－３，　Ａ＠Ｂ");
    expect(toFullWidth("ﾃｽﾄ ｶﾞｯｺｳ")).toBe("テスト　ガッコウ");
    expect(toFullWidth("髙﨑")).toBe("髙﨑");
  });

  it("codes 特定親族 by 合計所得金額 (令和 8 年分: 62 万円超)", () => {
    expect(specificRelativeCode(table, 620_000n, false)).toBeNull();
    expect(specificRelativeCode(table, 620_001n, false)).toBe("10");
    expect(specificRelativeCode(table, 850_000n, false)).toBe("10");
    expect(specificRelativeCode(table, 850_001n, true)).toBe("21");
    expect(specificRelativeCode(table, 1_230_000n, false)).toBe("90");
    expect(specificRelativeCode(table, 1_230_001n, false)).toBeNull();
  });
});

describe("the unified CSV row (147 items)", () => {
  const slip = buildWithholdingSlip(exampleInput);
  const row = unifiedCsvRow(slip, {
    myNumbers: {
      recipient: "123456789012",
      spouse: "234567890123",
      dependents: ["345678901234", "", "bad"],
    },
  });
  const at = (no: number) => row[no - 1];

  it("has 147 items in order", () => {
    expect(row).toHaveLength(UNIFIED_CSV_FIELD_COUNT);
    expect(at(1)).toBe("315");
    expect(at(4)).toBe("架空県架空市本町１－２－３");
    expect(at(5)).toBe("架空株式会社");
    expect(at(6)).toBe("045-000-0000");
    expect(at(10)).toBe("0");
    expect(at(11)).toBe("08");
    expect(at(12)).toBe("架空県架空市中町４－５－６");
    expect(at(13)).toBe("0");
    expect(at(14)).toBe("テスト　太郎");
    expect(at(16)).toBe("給料");
    expect(at(17)).toBe("8970000");
    expect(at(19)).toBe("6973000");
    expect(at(20)).toBe("4826102");
    expect(at(21)).toBe("41400");
    expect(at(23)).toBe("1");
    expect(at(24)).toBe("0");
    expect(at(25)).toBe("380000");
    expect([at(26), at(28), at(29), at(31)]).toEqual(["1", "1", "1", "1"]);
    expect(at(35)).toBe("1");
    expect(at(36)).toBe("1386102");
    expect([at(38), at(39), at(40)]).toEqual(["120000", "50000", "76500"]);
    expect([at(41), at(42), at(43)]).toEqual(["90000", "500000", "14800"]);
    // 昭和 55 年 4 月 1 日.
    expect([at(44), at(45), at(46), at(47)]).toEqual(["1", "55", "04", "01"]);
    expect(at(50)).toBe("0");
    expect(at(60)).toBe("0");
    expect([at(87), at(88), at(89), at(90)]).toEqual(["80000", "35000", "80000", "30000"]);
    expect(at(94)).toBe("7000012345678");
    expect(at(95)).toBe("123456789012");
    expect([at(96), at(97), at(98), at(99)]).toEqual([
      "テスト　ハナコ", // 配偶者のフリガナは全角（No. 96）
      "テスト　花子",
      "",
      "234567890123",
    ]);
    expect([at(100), at(101), at(102), at(103)]).toEqual([
      "テスト　イチロウ",
      "テスト　一郎",
      "00",
      "345678901234",
    ]);
    // A malformed number is left out.
    expect([at(104), at(105), at(106), at(107)]).toEqual([
      "テスト　ジロウ",
      "テスト　次郎",
      "00",
      "",
    ]);
    expect([at(112), at(113), at(114), at(115)]).toEqual([
      "テスト　サブロウ",
      "テスト　三郎",
      "40",
      "",
    ]);
    expect(at(116)).toBe("");
    expect(at(137)).toBe("ﾃｽﾄ ﾀﾛｳ");
    expect(at(138)).toBe("01JEXAMPLEEMPLOYEE0000001");
    expect(at(139)).toBe("149999");
    expect([at(141), at(142)]).toEqual(["620000", "47000"]);
    expect([at(144), at(146)]).toEqual(["1", "410000"]);
    expect(at(147)).toBe("2");
  });

  it("never carries a マイナンバー it was not given", () => {
    const plain = unifiedCsvRow(slip);
    expect(plain[94]).toBe("");
    expect(plain[98]).toBe("");
    expect(plain.join(",")).not.toContain("123456789012");
  });

  it("is free of , and @ and ends lines with CRLF", () => {
    const tricky = buildWithholdingSlip({
      ...exampleInput,
      declaration: {
        ...exampleDeclaration,
        recipient: { ...exampleDeclaration.recipient!, address: "架空市, 1@2" },
      },
    });
    const text = statementCsvText([unifiedCsvRow(tricky), unifiedCsvRow(slip)]);
    const lines = text.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    for (const line of lines.slice(0, 2)) {
      expect(line.split(",")).toHaveLength(UNIFIED_CSV_FIELD_COUNT);
      expect(line).not.toContain("@");
    }
    expect(text).not.toMatch(/(?<!\r)\n/);
  });

  it("writes a leaver's 中途退職 and leaves the deductions empty", () => {
    const leaver = buildWithholdingSlip({
      ...exampleInput,
      employee: { ...exampleInput.employee, leftOn: "2026-06-30", taxColumn: "otsu" },
      totals: { pay: 1_800_000n, bonus: 300_000n, socialInsurance: 260_000n, withheld: 60_000n },
      yearEnd: null,
    });
    const leaverRow = unifiedCsvRow(leaver);
    expect(leaverRow[16]).toBe("2100000");
    expect(leaverRow[15]).toBe("給料・賞与");
    expect(leaverRow[18]).toBe("");
    expect(leaverRow[19]).toBe("");
    expect(leaverRow[20]).toBe("60000");
    expect(leaverRow[22]).toBe("");
    expect(leaverRow[49]).toBe("1");
    expect(leaverRow.slice(59, 63)).toEqual(["2", "08", "06", "30"]);
    expect(leaverRow[133]).toBe("1");
    expect(leaverRow[140]).toBe("");
  });

  it("lists what is missing", () => {
    const bare = buildWithholdingSlip({
      ...exampleInput,
      declaration: { ...exampleDeclaration, recipient: undefined },
    });
    expect(unifiedCsvIssues(bare)).toEqual([
      "住所（翌年 1 月 1 日現在）",
      "フリガナ",
      "提出先市町村コード（6 桁）",
    ]);
    expect(unifiedCsvIssues(slip)).toEqual([]);
  });
});
