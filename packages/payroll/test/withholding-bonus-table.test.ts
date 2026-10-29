/**
 * The generated bonus withholding tables (賞与に対する源泉徴収税額の算出率の表, 22-payroll §10.1): the
 * committed JSON is exactly the conversion of the CSV snapshot, satisfies the schema, and both the
 * converter and the parser reject gaps, overlaps, broken rate order and changed layouts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../scripts/withholding-csv.ts";
import { convertWithholdingBonusCsv } from "../scripts/withholding-bonus-csv.ts";
import {
  findBonusWithholdingTable,
  findTableById,
  parseBonusWithholdingTable,
  parsePayrollTable,
  PayrollTableFormatError,
  PayrollTableMissingError,
  type BonusWithholdingTable,
} from "../src";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const csvOf = (year: number): string => read(`../data/${year}/source/withholding-bonus.csv`);
const jsonOf = (year: number): unknown =>
  JSON.parse(read(`../data/${year}/withholding-bonus.json`));

type MutableJson = {
  rows: {
    ratePercent: string;
    kou: { from: number | null; to: number | null }[];
    otsu: { from: number | null; to: number | null } | null;
  }[];
} & Record<string, unknown>;

function mutableJson(year: number): MutableJson {
  return jsonOf(year) as MutableJson;
}

/** The snapshot with one cell changed (records and columns 0-based, as parsed). */
function csvWith(year: number, record: number, column: number, value: string): string {
  const rows = parseCsv(csvOf(year));
  const row = rows[record];
  if (!row) throw new Error(`no record ${record}`);
  row[column] = value;
  return rows.map((cells) => cells.join(",")).join("\r\n");
}

const RATES = [
  "0",
  "2.042",
  "4.084",
  "6.126",
  "8.168",
  "10.21",
  "12.252",
  "14.294",
  "16.336",
  "18.378",
  "20.42",
  "22.462",
  "24.504",
  "26.546",
  "28.588",
  "30.63",
  "32.672",
  "35.735",
  "38.798",
  "41.861",
  "45.945",
];

describe.each([
  {
    year: 2026,
    kou0: [82_000, 94_000, 260_000],
    kou7: [317_000, 383_000],
    otsu: [
      ["10.21", null, 224_000],
      ["20.42", 224_000, 295_000],
      ["30.63", 295_000, 527_000],
      ["38.798", 527_000, 1_118_000],
      ["45.945", 1_118_000, null],
    ],
    legalBasis: "平成24年3月31日財務省告示第115号別表第三（令和7年4月30日財務省告示第122号改正）",
  },
  {
    year: 2027,
    kou0: [87_000, 100_000, 263_000],
    kou7: [320_000, 387_000],
    otsu: [
      ["10.21", null, 224_000],
      ["20.42", 224_000, 296_000],
      ["30.63", 296_000, 528_000],
      ["38.798", 528_000, 1_118_000],
      ["45.945", 1_118_000, null],
    ],
    legalBasis: "令和8年4月30日財務省告示第127号別表第三",
  },
])("withholding-bonus-$year", ({ year, kou0, kou7, otsu, legalBasis }) => {
  const table: BonusWithholdingTable = parseBonusWithholdingTable(jsonOf(year));

  it("is the exact conversion of the CSV snapshot", () => {
    expect(convertWithholdingBonusCsv(csvOf(year), year)).toStrictEqual(jsonOf(year));
  });

  it("is registered under its id for the calendar year", () => {
    expect(table.id).toBe(`withholding-bonus-${year}`);
    expect(findTableById(table.id)).toEqual(table);
    expect(parsePayrollTable(jsonOf(year))).toEqual(table);
    expect(table.effectiveFrom).toBe(`${year}-01-01`);
    expect(table.effectiveTo).toBe(`${year}-12-31`);
    expect(table.title).toBe(`賞与に対する源泉徴収税額の算出率の表（令和${year - 2018}年分）`);
    expect(table.legalBasis).toBe(legalBasis);
    expect(table.source.fetchedAt).toBe("2026-10-29");
    expect(table.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(findBonusWithholdingTable(`${year}-01-01`).id).toBe(table.id);
    expect(findBonusWithholdingTable(`${year}-12-31`).id).toBe(table.id);
  });

  it("has every rate in order, in yen, contiguous in every column", () => {
    expect(table.rows.map((row) => row.ratePercent)).toEqual(RATES);
    const yen = (value: bigint | null) => (value === null ? null : Number(value));
    // 甲欄 0 人: 0% below 82,000 円 (令和 9 年分 87,000 円), then 2.042% up to 94,000 円 …
    expect(
      table.rows.slice(0, 3).map((row) => [yen(row.kou[0]!.from), yen(row.kou[0]!.to)]),
    ).toEqual([
      [null, kou0[0]],
      [kou0[0], kou0[1]],
      [kou0[1], kou0[2]],
    ]);
    // 7 人以上 is the 8th 甲欄 column.
    expect(table.rows.slice(0, 2).map((row) => yen(row.kou[7]!.to))).toEqual(kou7);
    expect(table.rows.at(-1)?.kou.map((range) => range.to)).toEqual(Array(8).fill(null));
    expect(
      table.rows
        .filter((row) => row.otsu !== null)
        .map((row) => [row.ratePercent, yen(row.otsu!.from), yen(row.otsu!.to)]),
    ).toEqual(otsu);
    for (let column = 0; column < 8; column++) {
      table.rows.forEach((row, index) => {
        const previous = table.rows[index - 1];
        if (previous) expect(row.kou[column]!.from).toBe(previous.kou[column]!.to);
      });
    }
  });
});

describe("the bonus table converter and parser", () => {
  it("has no table for 2028 yet", () => {
    let error: unknown;
    try {
      findBonusWithholdingTable("2028-01-01");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PayrollTableMissingError);
    expect((error as PayrollTableMissingError).tableKind).toBe("withholding-bonus");
    expect((error as PayrollTableMissingError).message).toMatch(/2028 年分/);
  });

  it("rejects a changed layout, a gap, an overlap, a rate out of order and a stray cell", () => {
    expect(() => convertWithholdingBonusCsv(csvOf(2026), 2027)).toThrow(/令和8年分, not 2027/);
    expect(() => convertWithholdingBonusCsv(csvOf(2026), 2025)).toThrow(/no source/);
    // Header: 7 人以上 relabelled.
    expect(() => convertWithholdingBonusCsv(csvWith(2026, 4, 17, "7  人"), 2026)).toThrow(
      /must be labelled 7人以上/,
    );
    // 2.042% row of 0 人 starting at 83 千円: a gap after the 0% row.
    expect(() => convertWithholdingBonusCsv(csvWith(2026, 10, 3, "83"), 2026)).toThrow(
      /must start at 82000 円/,
    );
    // 4.084% row of 0 人 ending at 300 千円: overlaps the 6.126% row.
    expect(() => convertWithholdingBonusCsv(csvWith(2026, 11, 4, "300"), 2026)).toThrow(
      /must start at 300000 円/,
    );
    // 4.084% → 2.000%: the rates must increase.
    expect(() => convertWithholdingBonusCsv(csvWith(2026, 11, 1, "2.000"), 2026)).toThrow(
      /must be greater than 2.042%/,
    );
    // A 乙欄 range that leaves a gap.
    expect(() => convertWithholdingBonusCsv(csvWith(2026, 22, 19, "225"), 2026)).toThrow(/乙欄/);
    // A missing 甲欄 range.
    expect(() => convertWithholdingBonusCsv(csvWith(2026, 10, 9, ""), 2026)).toThrow(
      /is not a whole number of 千円|has no range/,
    );
    expect(() => convertWithholdingBonusCsv(csvWith(2026, 10, 22, "1"), 2026)).toThrow(
      /right of 乙欄/,
    );
  });

  it("rejects a JSON table with a gap, a rate out of order or a wrong column count", () => {
    const gap = mutableJson(2026);
    gap.rows[1]!.kou[0]!.from = 83_000;
    expect(() => parseBonusWithholdingTable(gap)).toThrow(PayrollTableFormatError);

    const order = mutableJson(2026);
    order.rows[2]!.ratePercent = "2.042";
    expect(() => parseBonusWithholdingTable(order)).toThrow(/must be greater than before/);

    const columns = mutableJson(2026);
    columns.rows[3]!.kou.pop();
    expect(() => parseBonusWithholdingTable(columns)).toThrow(/8 columns/);

    const closed = mutableJson(2027);
    closed.rows.at(-1)!.kou[2]!.to = 9_999_000;
    expect(() => parseBonusWithholdingTable(closed)).toThrow(/must be null/);

    const otsu = mutableJson(2027);
    otsu.rows[10]!.otsu = null;
    expect(() => parseBonusWithholdingTable(otsu)).toThrow(/乙欄/);
  });
});
