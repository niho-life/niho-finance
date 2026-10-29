/**
 * Schemas of the rate and grade tables and the version registry (22-payroll §3.1・§3.2・§8.5).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findEmploymentInsuranceTable,
  findKenpoTable,
  findPensionTable,
  findTableById,
  findWithholdingTable,
  fromDecimalString,
  isTableEffective,
  parseEmploymentInsuranceTable,
  parseKenpoTable,
  parsePayrollTable,
  parsePensionTable,
  PayrollInputError,
  PayrollTableFormatError,
  PayrollTableMissingError,
  ratio,
  REGISTERED_TABLES,
  tableRef,
  type YearMonth,
} from "../src";

type Json = Record<string, unknown> & {
  grades: { grade: number; smr: number; from: number | null; to: number | null }[];
  source: Record<string, unknown>;
};
const json = (path: string): Json =>
  JSON.parse(readFileSync(new URL(`../data/${path}`, import.meta.url), "utf8")) as Json;

function expectBroken(
  parse: (value: unknown) => unknown,
  path: string,
  mutate: (value: Json) => void,
  message: RegExp,
): void {
  const value = json(path);
  mutate(value);
  expect(() => parse(value)).toThrow(PayrollTableFormatError);
  expect(() => parse(value)).toThrow(message);
}

describe("grade tables", () => {
  it.each([
    ["2026/kyokai-kenpo-kanagawa.json", parseKenpoTable],
    ["2020/pension.json", parsePensionTable],
    ["2027/pension.json", parsePensionTable],
  ] as const)("%s rejects gaps, misplaced amounts and open ends in the middle", (path, parse) => {
    expect(() => parse(json(path))).not.toThrow();
    expectBroken(parse, path, (t) => (t.grades[3]!.from = 84_000), /grades\[3\]\.from/);
    expectBroken(parse, path, (t) => (t.grades[3]!.smr = 200_000), /grades\[3\]\.smr/);
    expectBroken(parse, path, (t) => (t.grades[0]!.from = 0), /grades\[0\]\.from/);
    expectBroken(parse, path, (t) => (t.grades.at(-1)!.to = 2_000_000), /\.to must be null/);
    expectBroken(parse, path, (t) => (t.grades[5]!.to = null), /grades\[5\]\.to/);
    expectBroken(parse, path, (t) => (t.grades[7]!.grade = 9), /grades\[7\]\.grade/);
    expectBroken(parse, path, (t) => t.grades.splice(10, 1), /grades\[10\]/);
    expectBroken(parse, path, (t) => (t.grades[2]!.smr = 78_000.5), /grades\[2\]\.smr/);
  });

  it("協会けんぽ rejects malformed rates and months", () => {
    const path = "2026/kyokai-kenpo-kanagawa.json";
    expectBroken(
      parseKenpoTable,
      path,
      (t) => (t.ratesPercent = { health: "9.92", care: "1.62" }),
      /childSupport/,
    );
    expectBroken(
      parseKenpoTable,
      path,
      (t) => (t.ratesPercent = { health: 9.92, care: "1.62", childSupport: "0.23" }),
      /ratesPercent\.health/,
    );
    expectBroken(parseKenpoTable, path, (t) => (t.childSupportFrom = "2026-4"), /childSupportFrom/);
    expectBroken(parseKenpoTable, path, (t) => (t.effectiveFrom = "2026-03-01"), /effectiveFrom/);
    expectBroken(parseKenpoTable, path, (t) => (t.source.sha256 = "ABC"), /source\.sha256/);
    expectBroken(
      parseKenpoTable,
      path,
      (t) => (t.source.url = "http://example.invalid/"),
      /source\.url/,
    );
    expectBroken(parseKenpoTable, path, (t) => (t.branch = "kanagawa"), /branch/);
  });

  it("雇用保険 requires employee + employer = total and the general business type", () => {
    const path = "2026/employment-insurance.json";
    const table = parseEmploymentInsuranceTable(json(path));
    expect(table.rates).toEqual({
      employee: ratio(5n, 1_000n),
      employer: ratio(85n, 10_000n),
      total: ratio(135n, 10_000n),
    });
    expectBroken(
      parseEmploymentInsuranceTable,
      path,
      (t) => (t.ratesPerMille = { employee: "6", employer: "8.5", total: "13.5" }),
      /ratesPerMille\.total/,
    );
    expectBroken(
      parseEmploymentInsuranceTable,
      path,
      (t) => (t.businessType = "construction"),
      /businessType/,
    );
  });

  it("parsePayrollTable dispatches on kind", () => {
    expect(parsePayrollTable(json("2026/employment-insurance.json")).kind).toBe(
      "employment-insurance",
    );
    expect(parsePayrollTable(json("2020/pension.json")).kind).toBe("pension");
    expect(() => parsePayrollTable({ kind: "bonus" })).toThrow(PayrollTableFormatError);
    expect(() => parsePayrollTable(null)).toThrow(PayrollTableFormatError);
  });
});

describe("the registry", () => {
  it("registers each version once", () => {
    const ids = REGISTERED_TABLES.map((table) => table.id);
    expect(ids.sort()).toEqual([
      "employment-insurance-2026",
      "kyokai-kenpo-kanagawa-2026",
      "pension-2020",
      "pension-2027",
      "withholding-bonus-2026",
      "withholding-bonus-2027",
      "withholding-monthly-2026",
      "withholding-monthly-2027",
      "year-end-2026",
    ]);
    expect(findTableById("pension-2027")?.kind).toBe("pension");
    expect(findTableById("pension-2019")).toBeUndefined();
  });

  it("selects by the first and last day or month of each version", () => {
    expect(findWithholdingTable("2026-01-01").id).toBe("withholding-monthly-2026");
    expect(findWithholdingTable("2027-12-31").id).toBe("withholding-monthly-2027");
    expect(findKenpoTable("2026-03").id).toBe("kyokai-kenpo-kanagawa-2026");
    expect(findKenpoTable("2027-02").id).toBe("kyokai-kenpo-kanagawa-2026");
    expect(findPensionTable("2020-09").id).toBe("pension-2020");
    expect(findPensionTable("2027-08").id).toBe("pension-2020");
    expect(findPensionTable("2027-09").id).toBe("pension-2027");
    expect(findEmploymentInsuranceTable("2026-04").id).toBe("employment-insurance-2026");
    expect(findEmploymentInsuranceTable("2027-03").id).toBe("employment-insurance-2026");
  });

  it("a version ends where the next enacted change starts (厚生年金 2028-09, 71 万円)", () => {
    expect(findPensionTable("2028-08").id).toBe("pension-2027");
    expect(() => findPensionTable("2028-09")).toThrow(PayrollTableMissingError);
    expect(() => findPensionTable("2030-01")).toThrow(/2030 年 1 月分/);
  });

  it.each<[string, () => unknown, string, RegExp]>([
    ["2025-12-31", () => findWithholdingTable("2025-12-31"), "withholding-monthly", /2025 年分/],
    ["2028-01-01", () => findWithholdingTable("2028-01-01"), "withholding-monthly", /2028 年分/],
    ["2026-02", () => findKenpoTable("2026-02"), "kyokai-kenpo", /2026 年 2 月分.*2025 年度/],
    ["2027-03", () => findKenpoTable("2027-03"), "kyokai-kenpo", /2027 年 3 月分.*2027 年度/],
    ["2020-08", () => findPensionTable("2020-08"), "pension", /2020 年 8 月分/],
    [
      "2026-03",
      () => findEmploymentInsuranceTable("2026-03"),
      "employment-insurance",
      /2026 年 3 月分.*2025 年度/,
    ],
    [
      "2027-04",
      () => findEmploymentInsuranceTable("2027-04"),
      "employment-insurance",
      /2027 年 4 月分.*2027 年度/,
    ],
  ])("never falls back to another version: %s", (needed, find, tableKind, message) => {
    expect(find).toThrow(PayrollTableMissingError);
    expect(find).toThrow(message);
    try {
      find();
    } catch (error) {
      expect(error).toMatchObject({ tableKind, needed });
    }
  });

  it("rejects malformed dates and months", () => {
    expect(() => findWithholdingTable("2026-02-30")).toThrow(PayrollInputError);
    expect(() => findKenpoTable("2026-13")).toThrow(PayrollInputError);
    expect(() => findPensionTable("2026/11" as YearMonth)).toThrow(PayrollInputError);
  });

  it("isTableEffective and tableRef", () => {
    const kenpo = findKenpoTable("2026-11");
    expect(isTableEffective(kenpo, "2026-03")).toBe(true);
    expect(isTableEffective(kenpo, "2027-03")).toBe(false);
    expect(isTableEffective(findPensionTable("2027-09"), "2028-08")).toBe(true);
    expect(isTableEffective(findPensionTable("2027-09"), "2028-09")).toBe(false);
    expect(() => isTableEffective(kenpo, "2026-11-01")).toThrow(RangeError);
    expect(tableRef(kenpo)).toEqual({
      id: "kyokai-kenpo-kanagawa-2026",
      title: kenpo.title,
      source: {
        url: "https://www.kyoukaikenpo.or.jp/assets/R8_14kanagawa.pdf",
        fetchedAt: "2026-10-28",
      },
    });
    // "9.92" percent is 992 / 10,000, parsed without floating point.
    expect(kenpo.rates.health).toEqual(ratio(992n, 10_000n));
    expect(kenpo.rates.care).toEqual(ratio(162n, 10_000n));
    expect(findPensionTable("2026-11").rate).toEqual(fromDecimalString("0.183"));
  });
});
