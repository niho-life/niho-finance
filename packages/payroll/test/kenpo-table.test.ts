/**
 * Every row of the 協会けんぽ 神奈川支部 令和 8 年度 table (the CSV snapshot of the PDF) against
 * the JSON: grades and ranges must match, and the full and half amounts recomputed from the JSON
 * rates must equal the PDF decimals exactly (22-payroll §8.2).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findKenpoTable,
  findPensionTable,
  fromDecimalString,
  half,
  mul,
  ratio,
  add,
  type Grade,
  type Rational,
} from "../src";

const COLUMNS = [
  "health_grade",
  "pension_grade",
  "smr",
  "rem_from",
  "rem_to",
  "health_full",
  "health_half",
  "health_care_full",
  "health_care_half",
  "support_full",
  "support_half",
  "pension_full",
  "pension_half",
] as const;
type Column = (typeof COLUMNS)[number];

const [header, ...lines] = readFileSync(
  new URL("../data/2026/source/kyokai-kenpo-kanagawa.csv", import.meta.url),
  "utf8",
)
  .split(/\r?\n/)
  .filter((line) => line !== "");
const rows = lines.map((line) => {
  const cells = line.split(",");
  return Object.fromEntries(COLUMNS.map((column, index) => [column, cells[index] ?? ""])) as Record<
    Column,
    string
  >;
});

const yen = (text: string): bigint | null => (text === "" ? null : BigInt(text));
const decimal = (text: string): Rational => fromDecimalString(text);

const kenpo = findKenpoTable("2026-11");
const pension = findPensionTable("2026-11");

describe("協会けんぽ 神奈川支部 令和 8 年度: the CSV snapshot and the JSON", () => {
  it("has the 13 columns and 50 rows of the PDF table", () => {
    expect(header?.split(",")).toEqual([...COLUMNS]);
    expect(rows).toHaveLength(50);
    expect(kenpo.grades).toHaveLength(50);
    expect(rows.filter((row) => row.pension_grade !== "")).toHaveLength(32);
    expect(pension.grades).toHaveLength(32);
  });

  it.each(rows.map((row) => [row.health_grade, row] as const))("健康保険 %s 級", (_grade, row) => {
    const grade: Grade | undefined = kenpo.grades[Number(row.health_grade) - 1];
    expect(grade).toEqual({
      grade: Number(row.health_grade),
      smr: BigInt(row.smr),
      from: yen(row.rem_from),
      to: yen(row.rem_to),
    });
    const smr = ratio(BigInt(row.smr));
    const healthFull = mul(smr, kenpo.rates.health);
    const careFull = mul(smr, add(kenpo.rates.health, kenpo.rates.care));
    const supportFull = mul(smr, kenpo.rates.childSupport);
    expect(healthFull).toEqual(decimal(row.health_full));
    expect(half(healthFull)).toEqual(decimal(row.health_half));
    expect(careFull).toEqual(decimal(row.health_care_full));
    expect(half(careFull)).toEqual(decimal(row.health_care_half));
    expect(supportFull).toEqual(decimal(row.support_full));
    expect(half(supportFull)).toEqual(decimal(row.support_half));
  });

  const pensionRows = rows.filter((row) => row.pension_grade !== "");
  it.each(pensionRows.map((row) => [row.pension_grade, row] as const))(
    "厚生年金 %s 級",
    (_grade, row) => {
      const number = Number(row.pension_grade);
      const grade = pension.grades[number - 1];
      // Grade 1 has no lower end (93,000 円未満) and grade 32 no upper end (635,000 円以上);
      // between them the ranges are those of the health grades on the same row.
      expect(grade).toEqual({
        grade: number,
        smr: BigInt(row.smr),
        from: number === 1 ? null : yen(row.rem_from),
        to: number === pension.grades.length ? null : yen(row.rem_to),
      });
      const full = mul(ratio(BigInt(row.smr)), pension.rate);
      expect(full).toEqual(decimal(row.pension_full));
      expect(half(full)).toEqual(decimal(row.pension_half));
    },
  );

  it("2027-09 adds grade 33 (680,000 円 from 665,000 円) and keeps grades 1–31", () => {
    const next = findPensionTable("2027-09");
    expect(next.grades).toHaveLength(33);
    expect(next.grades.slice(0, 31)).toEqual(pension.grades.slice(0, 31));
    expect(next.grades[31]).toEqual({ grade: 32, smr: 650_000n, from: 635_000n, to: 665_000n });
    expect(next.grades[32]).toEqual({ grade: 33, smr: 680_000n, from: 665_000n, to: null });
    expect(next.rate).toEqual(pension.rate);
    expect(next.childContributionRate).toEqual(pension.childContributionRate);
  });

  it("holds the rates as exact rationals", () => {
    expect(kenpo.rates).toEqual({
      health: decimal("0.0992"),
      care: decimal("0.0162"),
      childSupport: decimal("0.0023"),
    });
    expect(kenpo.childSupportFrom).toBe("2026-04");
    expect(pension.rate).toEqual(decimal("0.183"));
    expect(pension.childContributionRate).toEqual(decimal("0.0036"));
  });
});
