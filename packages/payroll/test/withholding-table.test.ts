/**
 * The generated withholding tables: the committed JSON is exactly the conversion of the CSV
 * snapshot, satisfies the schema of 22-payroll §3.1, and both the converter and the parser reject
 * gaps, broken monotonicity, column counts and malformed formulas.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertWithholdingCsv, parseCsv } from "../scripts/withholding-csv.ts";
import {
  findTableById,
  fromDecimalString,
  parseWithholdingTable,
  PayrollTableFormatError,
  ratio,
  type WithholdingTable,
} from "../src";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const csvOf = (year: number): string => read(`../data/${year}/source/withholding-monthly.csv`);
const jsonOf = (year: number): unknown =>
  JSON.parse(read(`../data/${year}/withholding-monthly.json`));

type MutableJson = Record<string, unknown> & {
  bands: { from: number; to: number; kou: number[]; otsu: number }[];
  kouSegments: { over: number; under: number | null; ratePercent: string }[];
  kouPoints: { at: number; kou: number[] }[];
  lowBand: { below: number; otsuRatePercent: string };
};

/** A fresh copy of the committed JSON as a plain mutable object, for breaking it on purpose. */
function mutableJson(year: number): MutableJson {
  return JSON.parse(read(`../data/${year}/withholding-monthly.json`)) as MutableJson;
}

const POINTS_2026 = [740, 790, 960, 1_710, 2_130, 2_170, 2_210, 2_250, 3_500].map(
  (thousands) => BigInt(thousands) * 1_000n,
);
const POINTS_2027 = [740, 790, 960, 1_720, 2_130, 2_170, 2_210, 2_250, 3_500].map(
  (thousands) => BigInt(thousands) * 1_000n,
);
const KOU_RATES = [
  "20.42",
  "23.483",
  "33.693",
  "40.84",
  "40.84",
  "40.84",
  "40.84",
  "40.84",
  "45.945",
];
const percent = (text: string) => {
  const value = fromDecimalString(text);
  return ratio(value.num, value.den * 100n);
};

describe.each([
  { year: 2026, below: 105_000n, rows: 231, points: POINTS_2026, otsuAt: [740_000n, 1_710_000n] },
  { year: 2027, below: 111_000n, rows: 228, points: POINTS_2027, otsuAt: [740_000n, 1_720_000n] },
])("withholding-monthly-$year", ({ year, below, rows, points, otsuAt }) => {
  const table: WithholdingTable = parseWithholdingTable(jsonOf(year));

  it("is the exact conversion of the CSV snapshot", () => {
    expect(convertWithholdingCsv(csvOf(year), year)).toStrictEqual(jsonOf(year));
  });

  it("is registered under its id for the calendar year", () => {
    expect(table.id).toBe(`withholding-monthly-${year}`);
    expect(findTableById(table.id)).toEqual(table);
    expect(table.effectiveFrom).toBe(`${year}-01-01`);
    expect(table.effectiveTo).toBe(`${year}-12-31`);
    expect(table.title).toBe(`給与所得の源泉徴収税額表（令和${year - 2018}年分）月額表`);
    expect(table.source.fetchedAt).toBe("2026-10-28");
    expect(table.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has contiguous rows from the low band to the first point", () => {
    expect(table.lowBand).toEqual({ below, otsuRate: percent("3.063") });
    expect(table.bands).toHaveLength(rows);
    expect(table.bands[0]?.from).toBe(below);
    table.bands.forEach((band, index) => {
      expect(band.kou).toHaveLength(8);
      if (index > 0) expect(band.from).toBe(table.bands[index - 1]?.to);
    });
    expect(table.bands.at(-1)?.to).toBe(740_000n);
  });

  it("has monotone tax: down the rows, across the dependents, and 乙 ≥ 甲 0 人", () => {
    const rowsAndPoints = [...table.bands, ...table.kouPoints];
    rowsAndPoints.forEach((row, index) => {
      row.kou
        .slice(1)
        .forEach((value, column) => expect(value).toBeLessThanOrEqual(row.kou[column]!));
      const previous = rowsAndPoints[index - 1];
      if (previous)
        row.kou.forEach((value, column) =>
          expect(value).toBeGreaterThanOrEqual(previous.kou[column]!),
        );
    });
    for (const band of table.bands) expect(band.otsu).toBeGreaterThanOrEqual(band.kou[0]!);
  });

  it("has the formula points and segments of §3.1", () => {
    expect(table.kouPoints.map((point) => point.at)).toEqual(points);
    expect(table.kouSegments).toEqual(
      points.map((over, index) => ({
        over,
        under: points[index + 1] ?? null,
        rate: percent(KOU_RATES[index]!),
      })),
    );
    expect(table.otsuPoints.map((point) => point.at)).toEqual(otsuAt);
    expect(table.otsuSegments).toEqual([
      { over: otsuAt[0], under: otsuAt[1], rate: percent("40.84") },
      { over: otsuAt[1], under: null, rate: percent("45.945") },
    ]);
    expect(table.extraDependentDeduction).toBe(1_610n);
  });
});

describe("convertWithholdingCsv rejects a broken snapshot and writes nothing", () => {
  const csv = csvOf(2026);
  const lines = csv.split("\r\n");
  const lineOf = (prefix: string): number => lines.findIndex((line) => line.startsWith(prefix));
  const withLine = (index: number, replacement: string | null): string =>
    lines
      .flatMap((line, i) => (i === index ? (replacement === null ? [] : [replacement]) : [line]))
      .join("\r\n");

  it("parses the snapshot as CSV with quoted fields", () => {
    const rows = parseCsv(csv);
    expect(rows[0]?.[1]).toBe("給与所得の源泉徴収税額表（令和８年分）");
    expect(rows.find((row) => row[1] === "740,000円")?.slice(3, 12)).toEqual([
      "71680",
      "65210",
      "58750",
      "52290",
      "45810",
      "39350",
      "32890",
      "26410",
      "259200",
    ]);
    expect(parseCsv('a,"b ""c"", d"\r\n1,2')).toEqual([
      ["a", 'b "c", d'],
      ["1", "2"],
    ]);
    expect(() => parseCsv('a,"b')).toThrow();
  });

  it("refuses the snapshot of another year", () => {
    expect(() => convertWithholdingCsv(csv, 2027)).toThrow(/令和8年分/);
    expect(() => convertWithholdingCsv(csv, 2031)).toThrow(/no source/);
  });

  it("refuses a gap between rows", () => {
    expect(() => convertWithholdingCsv(withLine(lineOf("100,"), null), 2026)).toThrow(/gap/);
  });

  it("refuses tax that rises with the number of dependents", () => {
    const index = lineOf("17,137000,139000,");
    const broken = lines[index]!.replace("1810,190,0,", "1810,190,200,");
    expect(() => convertWithholdingCsv(withLine(index, broken), 2026)).toThrow(/dependents/);
  });

  it("refuses a missing 甲欄 column", () => {
    const index = lineOf("17,137000,139000,");
    const broken = lines[index]!.replace("1810,190,0,", "1810,190,");
    expect(() => convertWithholdingCsv(withLine(index, broken), 2026)).toThrow();
  });

  it("refuses an unexpected row among the table rows", () => {
    expect(() => convertWithholdingCsv(withLine(lineOf("100,"), ",注記,,,,,,,,,,"), 2026)).toThrow(
      /neither blank nor a row/,
    );
  });

  it("refuses a formula whose rate cannot be read", () => {
    const index = lines.findIndex((line) => line.includes("740,000円を超える金額の20.42％"));
    const broken = lines[index]!.replace("20.42％", "20.42%");
    expect(() => convertWithholdingCsv(withLine(index, broken), 2026)).toThrow(/not recognised/);
  });

  it("refuses a segment that does not start at a point", () => {
    const index = lines.findIndex((line) => line.includes('" 790,000円を超え"'));
    const broken = lines[index]!.replace("790,000円を超え", "800,000円を超え");
    expect(() => convertWithholdingCsv(withLine(index, broken), 2026)).toThrow();
  });

  it("refuses a value right of 乙欄", () => {
    const index = lineOf("17,137000,139000,");
    expect(() => convertWithholdingCsv(withLine(index, `${lines[index]!},1`), 2026)).toThrow(
      /right of 乙欄/,
    );
  });
});

describe("parseWithholdingTable rejects a broken JSON", () => {
  const expectBroken = (mutate: (json: MutableJson) => void, path: RegExp) => {
    const json = mutableJson(2026);
    mutate(json);
    expect(() => parseWithholdingTable(json)).toThrow(PayrollTableFormatError);
    expect(() => parseWithholdingTable(json)).toThrow(path);
  };

  it("accepts the committed JSON", () => {
    expect(() => parseWithholdingTable(mutableJson(2026))).not.toThrow();
  });

  it("rejects gaps, overlaps and empty rows", () => {
    expectBroken((json) => (json.bands[10]!.from += 1_000), /bands\[10\]\.from/);
    expectBroken((json) => (json.bands[0]!.from = 104_000), /bands\[0\]\.from/);
    expectBroken((json) => (json.bands.at(-1)!.to = 739_000), /kouPoints\[0\]\.at/);
  });

  it("rejects a wrong number of 甲欄 columns and non-monotone tax", () => {
    expectBroken((json) => json.bands[5]!.kou.pop(), /bands\[5\]\.kou/);
    expectBroken((json) => (json.bands[20]!.kou[3] = 99_999), /bands\[20\]\.kou/);
    expectBroken(
      (json) => (json.bands[30]!.kou[0] = 0),
      /bands\[30\]\.kou|bands\[30\]\.otsu|bands\[31\]\.kou/,
    );
    expectBroken((json) => (json.bands[40]!.otsu = 0), /bands\[40\]\.otsu/);
  });

  it("rejects segments that do not run from point to point", () => {
    expectBroken((json) => (json.kouSegments[2]!.over = 970_000), /kouSegments\[2\]\.over/);
    expectBroken((json) => (json.kouSegments.at(-1)!.under = 4_000_000), /kouSegments\[8\]\.under/);
    expectBroken((json) => json.kouSegments.pop(), /kouSegments/);
    expectBroken((json) => json.kouPoints.reverse(), /kouPoints/);
  });

  it("rejects rates that are not plain decimal strings", () => {
    for (const rate of ["20.42%", "2.042e1", "-20.42", ".5", "20.", " 20.42"]) {
      expectBroken(
        (json) => (json.kouSegments[0]!.ratePercent = rate),
        /kouSegments\[0\]\.ratePercent/,
      );
    }
    expectBroken((json) => (json.lowBand.otsuRatePercent = "3.063 "), /lowBand\.otsuRatePercent/);
  });

  it("rejects amounts that are not whole yen, and unknown or missing fields", () => {
    expectBroken((json) => (json.bands[0]!.kou[0] = 170.5), /bands\[0\]\.kou\[0\]/);
    expectBroken((json) => (json.extraDependentDeduction = -1), /extraDependentDeduction/);
    expectBroken((json) => (json.extra = 1), /extra/);
    expectBroken((json) => delete json.otsuPoints, /otsuPoints/);
    expectBroken((json) => (json.effectiveTo = "2025-12-31"), /effectiveTo/);
    expectBroken((json) => (json.kind = "pension"), /kind/);
  });
});
