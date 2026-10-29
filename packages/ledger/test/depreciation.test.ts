/**
 * 減価償却・繰延資産 (docs/design/16-year-end.md §4–§6). The golden tests follow the examples of
 * 国税庁 タックスアンサー No.5410 / No.5403 / No.5408 and 令133の2 (§4.4).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  allowedDepreciationMethods,
  checkDepreciationChoice,
  countLocalTaxMonths,
  countMonths,
  depreciationForPeriod,
  depreciationRates,
  depreciationWarnings,
  DEPRECIATION_METHODS,
  isDepreciableAccount,
  isDepreciableAssetTaxed,
  isSpecialSmallAsset,
  MAX_DEPRECIATION_ROWS,
  monthPeriodEnd,
  planDeferredAmortization,
  planDepreciation,
  specialSmallAssetCap,
  specialSmallAssetLimit,
  suggestDepreciationMethod,
  type CalendarDate,
  type DepreciableAsset,
  type DepreciationPeriodInput,
  type DepreciationRow,
} from "../src";
import { dateArb } from "./fixtures";

/** 第 1 期 of the fictional company (5 か月). */
const FIRST_YEAR = { startDate: "2026-11-02", endDate: "2027-03-31" } as const;

/** 3 月決算 12-month years starting on 04-01 of `fromYear`. */
function marchYears(fromYear: number, count: number): DepreciationPeriodInput[] {
  return Array.from({ length: count }, (_, index) => ({
    startDate: `${fromYear + index}-04-01` as CalendarDate,
    endDate: `${fromYear + index + 1}-03-31` as CalendarDate,
  }));
}

function amounts(rows: readonly DepreciationRow[]): bigint[] {
  return rows.map((row) => row.amount);
}

describe("月数 (民法143条)", () => {
  it.each([
    ["2026-11-02", "2027-03-31", 5, 4],
    ["2027-04-01", "2028-03-31", 12, 12],
    ["2027-01-15", "2027-03-31", 3, 2],
    ["2026-03-31", "2026-03-31", 1, 1],
    ["2027-01-31", "2027-02-27", 1, 1],
    ["2027-01-31", "2027-02-28", 1, 1],
    ["2027-01-31", "2027-03-30", 2, 2],
    ["2027-04-01", "2028-12-31", 21, 21],
    ["2028-02-29", "2029-02-27", 12, 11],
  ] as const)("%s〜%s → 国税 %i か月, 均等割 %i か月", (from, to, months, localMonths) => {
    expect(countMonths(from, to)).toBe(months);
    expect(countLocalTaxMonths(from, to)).toBe(localMonths);
  });

  it("returns 0 when the period ends before it starts", () => {
    expect(countMonths("2027-04-01", "2027-03-31")).toBe(0);
    expect(countLocalTaxMonths("2027-04-01", "2027-03-31")).toBe(0);
  });

  it("ends a period of months on the day before the corresponding day, or on the month's end", () => {
    expect(monthPeriodEnd("2026-11-02", 4)).toBe("2027-03-01");
    expect(monthPeriodEnd("2027-04-01", 12)).toBe("2028-03-31");
    expect(monthPeriodEnd("2027-01-31", 1)).toBe("2027-02-28");
    expect(monthPeriodEnd("2028-01-31", 1)).toBe("2028-02-29");
    expect(monthPeriodEnd("2027-01-15", 0)).toBe("2027-01-14");
  });

  it("counts the fewest months whose period covers the dates; 均等割 drops the remainder", () => {
    fc.assert(
      fc.property(
        dateArb("2026-01-01", "2030-12-31"),
        fc.integer({ min: 0, max: 800 }),
        (from, days) => {
          const to = addDays(from, days);
          const months = countMonths(from, to);
          expect(monthPeriodEnd(from, months) >= to).toBe(true);
          expect(monthPeriodEnd(from, months - 1) < to).toBe(true);
          const exact = monthPeriodEnd(from, months) === to;
          expect(countLocalTaxMonths(from, to)).toBe(Math.max(1, exact ? months : months - 1));
        },
      ),
    );
  });
});

describe("償却率 (別表第八・別表第十)", () => {
  it("has the rates of 2–50 years", () => {
    expect(depreciationRates(8)).toEqual({
      usefulLife: 8,
      straightLineMille: 125,
      decliningMille: 250,
      revisedMille: 334,
      guaranteePer100k: 7909,
    });
    expect(depreciationRates(2)).toEqual({
      usefulLife: 2,
      straightLineMille: 500,
      decliningMille: 1000,
      revisedMille: null,
      guaranteePer100k: null,
    });
    expect(depreciationRates(50)?.straightLineMille).toBe(20);
    for (let life = 2; life <= 50; life += 1) expect(depreciationRates(life)).not.toBeNull();
  });

  it("returns null outside the table", () => {
    expect(depreciationRates(1)).toBeNull();
    expect(depreciationRates(51)).toBeNull();
    expect(depreciationRates(4.5)).toBeNull();
  });
});

describe("国税庁の計算例 (ゴールデンテスト, §4.4)", () => {
  it("定額法: 1,000,000 円・8 年 → 125,000 × 7 期、8 期目 124,999 (1 円を残す)", () => {
    const rows = planDepreciation(
      {
        method: "straight_line",
        cost: 1_000_000n,
        acquisitionDate: "2007-04-01",
        usefulLifeYears: 8,
      },
      marchYears(2007, 1),
      { project: true },
    );
    expect(amounts(rows)).toEqual([
      125_000n,
      125_000n,
      125_000n,
      125_000n,
      125_000n,
      125_000n,
      125_000n,
      124_999n,
    ]);
    expect(rows.at(-1)?.closing).toBe(1n);
    expect(rows.at(-1)?.endDate).toBe("2015-03-31");
    expect(rows.slice(1).every((row) => row.projected)).toBe(true);
  });

  it("定率法: 1,000,000 円・8 年 → 改定取得価額 237,306 から 79,260", () => {
    const rows = planDepreciation(
      {
        method: "declining_balance",
        cost: 1_000_000n,
        acquisitionDate: "2012-04-01",
        usefulLifeYears: 8,
      },
      marchYears(2012, 1),
      { project: true },
    );
    expect(amounts(rows)).toEqual([
      250_000n,
      187_500n,
      140_625n,
      105_468n,
      79_101n,
      79_260n,
      79_260n,
      78_785n,
    ]);
    expect(rows.map((row) => row.revised)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    // 6 期目の期首帳簿価額が改定取得価額。
    expect(rows[5]?.opening).toBe(237_306n);
    expect(rows.at(-1)?.closing).toBe(1n);
  });

  it("即時償却 (少額): 98,000 円・第 1 期に取得 → 第 1 期 98,000", () => {
    const asset: DepreciableAsset = {
      method: "immediate",
      cost: 98_000n,
      acquisitionDate: "2026-12-01",
      usefulLifeYears: null,
    };
    const rows = planDepreciation(asset, [FIRST_YEAR], { project: true });
    expect(amounts(rows)).toEqual([98_000n]);
    expect(rows[0]?.closing).toBe(0n);
    expect(isSpecialSmallAsset(asset)).toBe(false);
    expect(isDepreciableAssetTaxed({ ...asset, accountCode: "1510" })).toBe(false);
  });

  it("即時償却 (特例): 350,000 円・2026/12/10 取得 → 350,000、期の上限 1,250,000", () => {
    const asset: DepreciableAsset = {
      method: "immediate",
      cost: 350_000n,
      acquisitionDate: "2026-12-10",
      usefulLifeYears: null,
    };
    expect(amounts(planDepreciation(asset, [FIRST_YEAR], { project: true }))).toEqual([350_000n]);
    expect(specialSmallAssetCap(FIRST_YEAR)).toBe(1_250_000n);
    expect(isSpecialSmallAsset(asset)).toBe(true);
    expect(isDepreciableAssetTaxed({ ...asset, accountCode: "1510" })).toBe(true);
    expect(
      suggestDepreciationMethod({
        cost: 350_000n,
        acquisitionDate: "2026-12-10",
        accountCode: "1510",
      }),
    ).toBe("immediate");
    expect(checkDepreciationChoice({ ...asset, accountCode: "1510" })).toEqual([]);
  });

  it("一括償却: 180,000 円・第 1 期 (5 か月) に取得 → 25,000、60,000、60,000、35,000", () => {
    const rows = planDepreciation(
      {
        method: "lump_sum_3y",
        cost: 180_000n,
        acquisitionDate: "2027-03-20",
        usefulLifeYears: null,
      },
      [FIRST_YEAR],
      { project: true },
    );
    expect(amounts(rows)).toEqual([25_000n, 60_000n, 60_000n, 35_000n]);
    expect(rows.map((row) => row.months)).toEqual([5, 12, 12, 12]);
    expect(rows.at(-1)?.closing).toBe(0n);
  });
});

describe("期の途中の取得と 1 年に満たない期", () => {
  it("定率法 4 年・600,000 円・2027/01/15 取得 → 第 1 期は 3 か月で 75,000", () => {
    const rows = planDepreciation(
      {
        method: "declining_balance",
        cost: 600_000n,
        acquisitionDate: "2027-01-15",
        usefulLifeYears: 4,
      },
      [FIRST_YEAR],
      { project: true },
    );
    // 第 1 期: 600,000 × 0.500 × 3 / 12 = 75,000。
    // 第 2 期: 525,000 × 0.500 = 262,500（保証額 600,000 × 0.12499 = 74,994 以上）。
    // 第 3 期: 262,500 × 0.500 = 131,250。
    // 第 4 期: 131,250 × 0.500 = 65,625 < 74,994 → 改定取得価額 131,250 × 1.000、1 円を残して 131,249。
    expect(rows.map((row) => row.months)).toEqual([3, 12, 12, 12]);
    expect(amounts(rows)).toEqual([75_000n, 262_500n, 131_250n, 131_249n]);
    expect(rows.map((row) => row.revised)).toEqual([false, false, false, true]);
    expect(rows.at(-1)?.closing).toBe(1n);
  });

  it("定額法の第 1 期 (5 か月) は 年額 × 5 ÷ 12、以後は年額、最後に 1 円を残す", () => {
    const rows = planDepreciation(
      {
        method: "straight_line",
        cost: 500_000n,
        acquisitionDate: "2026-11-02",
        usefulLifeYears: 5,
      },
      [FIRST_YEAR],
      { project: true },
    );
    // 500,000 × 0.200 × 5 / 12 = 41,666.66… → 41,666。
    expect(amounts(rows)).toEqual([41_666n, 100_000n, 100_000n, 100_000n, 100_000n, 58_333n]);
    expect(rows.at(-1)?.closing).toBe(1n);
  });

  it("決算期の変更で 9 か月の期があれば 年額 × 9 ÷ 12", () => {
    const rows = planDepreciation(
      {
        method: "straight_line",
        cost: 1_200_000n,
        acquisitionDate: "2027-04-01",
        usefulLifeYears: 10,
      },
      [
        { startDate: "2027-04-01", endDate: "2028-03-31" },
        { startDate: "2028-04-01", endDate: "2028-12-31" },
      ],
    );
    expect(amounts(rows)).toEqual([120_000n, 90_000n]);
  });

  it("projects 12-month years from a short last year with the same month end", () => {
    const rows = planDepreciation(
      {
        method: "straight_line",
        cost: 1_200_000n,
        acquisitionDate: "2027-04-01",
        usefulLifeYears: 10,
      },
      [
        { startDate: "2027-04-01", endDate: "2028-03-31", posted: 120_000n },
        { startDate: "2028-04-01", endDate: "2028-12-31" },
      ],
      { project: true },
    );
    expect(rows[2]).toMatchObject({ startDate: "2029-01-01", endDate: "2029-12-31" });
    expect(rows.reduce((sum, row) => sum + row.amount, 0n)).toBe(1_199_999n);
  });
});

describe("実績から計算し直す (§4.2)", () => {
  it("定額法: 計上しなかった期があると、償却は 1 期延びる", () => {
    const rows = planDepreciation(
      {
        method: "straight_line",
        cost: 1_000_000n,
        acquisitionDate: "2007-04-01",
        usefulLifeYears: 8,
      },
      [
        { startDate: "2007-04-01", endDate: "2008-03-31", posted: 125_000n },
        { startDate: "2008-04-01", endDate: "2009-03-31", posted: 0n },
        { startDate: "2009-04-01", endDate: "2010-03-31" },
      ],
      { project: true },
    );
    expect(rows[1]).toMatchObject({ amount: 125_000n, posted: 0n, closing: 875_000n });
    expect(rows[2]).toMatchObject({ opening: 875_000n, amount: 125_000n, projected: false });
    expect(rows).toHaveLength(9);
    expect(rows.at(-1)).toMatchObject({ amount: 124_999n, closing: 1n });
  });

  it("定率法: 期首帳簿価額は実績から取る", () => {
    const asset: DepreciableAsset = {
      method: "declining_balance",
      cost: 1_000_000n,
      acquisitionDate: "2012-04-01",
      usefulLifeYears: 8,
    };
    const periods: DepreciationPeriodInput[] = [
      { startDate: "2012-04-01", endDate: "2013-03-31", posted: 250_000n },
      { startDate: "2013-04-01", endDate: "2014-03-31", posted: 0n },
      { startDate: "2014-04-01", endDate: "2015-03-31" },
    ];
    const rows = planDepreciation(asset, periods);
    expect(rows[1]).toMatchObject({ opening: 750_000n, amount: 187_500n, closing: 750_000n });
    expect(rows[2]).toMatchObject({ opening: 750_000n, amount: 187_500n, closing: 562_500n });
    expect(depreciationForPeriod(asset, periods, periods[2]!)).toBe(187_500n);
  });

  it("定率法: 計上が限度より少ない期のあとは、その実績の期首帳簿価額から計算する", () => {
    const rows = planDepreciation(
      {
        method: "declining_balance",
        cost: 1_000_000n,
        acquisitionDate: "2012-04-01",
        usefulLifeYears: 8,
      },
      [
        { startDate: "2012-04-01", endDate: "2013-03-31", posted: 200_000n },
        { startDate: "2013-04-01", endDate: "2014-03-31" },
      ],
    );
    expect(rows[1]).toMatchObject({ opening: 800_000n, amount: 200_000n });
  });

  it("一括償却: 計上しなかった期の分は次の期に繰り越さず、36 か月の後に期ごとの限度で計上する", () => {
    const rows = planDepreciation(
      {
        method: "lump_sum_3y",
        cost: 180_000n,
        acquisitionDate: "2026-12-01",
        usefulLifeYears: null,
      },
      [
        { ...FIRST_YEAR, posted: 25_000n },
        { startDate: "2027-04-01", endDate: "2028-03-31", posted: 0n },
        { startDate: "2028-04-01", endDate: "2029-03-31" },
      ],
      { project: true },
    );
    // 各期の限度は 180,000 × 12 ÷ 36 = 60,000 (令133の2①)。第 2 期の 60,000 は第 5 期に回る。
    expect(amounts(rows)).toEqual([25_000n, 60_000n, 60_000n, 60_000n, 35_000n]);
  });

  it("即時償却: 取得した期に計上しなければ、以後の額は 0", () => {
    const rows = planDepreciation(
      {
        method: "immediate",
        cost: 98_000n,
        acquisitionDate: "2026-12-01",
        usefulLifeYears: null,
      },
      [
        { ...FIRST_YEAR, posted: 0n },
        { startDate: "2027-04-01", endDate: "2028-03-31" },
      ],
      { project: true },
    );
    expect(amounts(rows)).toEqual([98_000n, 0n]);
    expect(rows.at(-1)?.closing).toBe(98_000n);
  });
});

describe("除却・売却", () => {
  const straight: DepreciableAsset = {
    method: "straight_line",
    cost: 1_000_000n,
    acquisitionDate: "2007-04-01",
    usefulLifeYears: 8,
    disposedOn: "2009-06-30",
  };

  it("定額・定率: 除却した期は 0 で、以後の行はない", () => {
    const rows = planDepreciation(straight, marchYears(2007, 5), { project: true });
    expect(amounts(rows)).toEqual([125_000n, 125_000n, 0n]);
    expect(rows.at(-1)?.closing).toBe(750_000n);
    expect(
      planDepreciation({ ...straight, method: "declining_balance" }, marchYears(2007, 5)),
    ).toHaveLength(3);
  });

  it("即時: 取得した期に除却すれば 0", () => {
    const rows = planDepreciation(
      {
        method: "immediate",
        cost: 98_000n,
        acquisitionDate: "2026-12-01",
        usefulLifeYears: null,
        disposedOn: "2027-02-01",
      },
      [FIRST_YEAR, { startDate: "2027-04-01", endDate: "2028-03-31" }],
    );
    expect(amounts(rows)).toEqual([0n]);
  });

  it("一括: 除却しても 3 年で償却を続ける (令133の2)", () => {
    const rows = planDepreciation(
      {
        method: "lump_sum_3y",
        cost: 180_000n,
        acquisitionDate: "2026-12-01",
        usefulLifeYears: null,
        disposedOn: "2027-06-01",
      },
      [FIRST_YEAR],
      { project: true },
    );
    expect(amounts(rows)).toEqual([25_000n, 60_000n, 60_000n, 35_000n]);
  });
});

describe("planDepreciation の入力", () => {
  const asset: DepreciableAsset = {
    method: "straight_line",
    cost: 1_000_000n,
    acquisitionDate: "2008-06-01",
    usefulLifeYears: 8,
  };

  it("skips the years before the acquisition and stops at the given years without projection", () => {
    const rows = planDepreciation(asset, marchYears(2007, 3));
    expect(rows.map((row) => row.startDate)).toEqual(["2008-04-01", "2009-04-01"]);
    // 2008/06/01〜2009/03/31 は 10 か月。
    expect(rows[0]).toMatchObject({ months: 10, amount: 104_166n });
  });

  it("keeps rows for every given year after the book value reached its floor", () => {
    const rows = planDepreciation(
      { ...asset, method: "immediate", cost: 50_000n, usefulLifeYears: null },
      marchYears(2008, 3),
    );
    expect(amounts(rows)).toEqual([50_000n, 0n, 0n]);
  });

  it("rejects unsorted or overlapping years, and an acquisition before the first year", () => {
    expect(() =>
      planDepreciation(asset, [
        { startDate: "2008-04-01", endDate: "2009-03-31" },
        { startDate: "2009-04-02", endDate: "2010-03-31" },
      ]),
    ).toThrow(RangeError);
    expect(() => planDepreciation(asset, marchYears(2009, 2))).toThrow(RangeError);
    expect(() =>
      planDepreciation({ ...asset, usefulLifeYears: null }, marchYears(2008, 1)),
    ).toThrow(RangeError);
    expect(() => planDepreciation({ ...asset, cost: 0n }, marchYears(2008, 1))).toThrow(RangeError);
    expect(planDepreciation(asset, [], { project: true })).toEqual([]);
  });

  it("depreciationForPeriod: 0 before the acquisition, and the target must be one of the years", () => {
    const periods = marchYears(2007, 3);
    expect(depreciationForPeriod(asset, periods, periods[0]!)).toBe(0n);
    expect(depreciationForPeriod(asset, periods, periods[1]!)).toBe(104_166n);
    expect(() =>
      depreciationForPeriod(asset, periods, { startDate: "2010-04-01", endDate: "2011-03-31" }),
    ).toThrow(RangeError);
  });

  it("never goes below the floor nor below 0, and projects until the floor", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DEPRECIATION_METHODS),
        fc.bigInt({ min: 100_000n, max: 50_000_000n }),
        fc.integer({ min: 2, max: 50 }),
        dateArb(FIRST_YEAR.startDate, FIRST_YEAR.endDate),
        (method, cost, life, acquisitionDate) => {
          const rows = planDepreciation(
            { method, cost, acquisitionDate, usefulLifeYears: life },
            [FIRST_YEAR],
            { project: true },
          );
          const floor = method === "straight_line" || method === "declining_balance" ? 1n : 0n;
          expect(rows.length).toBeLessThanOrEqual(MAX_DEPRECIATION_ROWS);
          let opening = cost;
          for (const row of rows) {
            expect(row.opening).toBe(opening);
            expect(row.amount >= 0n).toBe(true);
            expect(row.closing).toBe(row.opening - row.amount);
            expect(row.closing >= floor).toBe(true);
            opening = row.closing;
          }
          expect(rows.at(-1)?.closing).toBe(floor);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("償却方法の提案と検査 (§5.1, §5.4)", () => {
  it.each([
    [99_999n, "2026-12-10", "1510", "immediate"],
    [100_000n, "2026-12-10", "1510", "lump_sum_3y"],
    [199_999n, "2026-12-10", "1510", "lump_sum_3y"],
    [200_000n, "2026-12-10", "1510", "immediate"],
    [399_999n, "2026-12-10", "1510", "immediate"],
    [400_000n, "2026-12-10", "1510", "declining_balance"],
    [400_000n, "2026-12-10", "1520", "straight_line"],
    [400_000n, "2026-12-10", "1500", "straight_line"],
    [299_999n, "2026-03-31", "1510", "immediate"],
    [300_000n, "2026-03-31", "1510", "declining_balance"],
    [250_000n, "2029-04-01", "1510", "declining_balance"],
  ] as const)("%s 円・%s・%s → %s", (cost, acquisitionDate, accountCode, expected) => {
    expect(suggestDepreciationMethod({ cost, acquisitionDate, accountCode })).toBe(expected);
  });

  it("特例の上限は取得日で決まる", () => {
    expect(specialSmallAssetLimit("2026-03-31")).toBe(300_000n);
    expect(specialSmallAssetLimit("2026-04-01")).toBe(400_000n);
    expect(specialSmallAssetLimit("2029-03-31")).toBe(400_000n);
    expect(specialSmallAssetLimit("2029-04-01")).toBeNull();
    expect(specialSmallAssetCap({ startDate: "2027-04-01", endDate: "2028-03-31" })).toBe(
      3_000_000n,
    );
  });

  it("償却できる科目は 固定資産 のうち 累計額・敷金・長期前払費用 を除くもの", () => {
    expect(isDepreciableAccount({ code: "1510", group: "fixed_assets" })).toBe(true);
    expect(isDepreciableAccount({ code: "1530", group: "fixed_assets" })).toBe(true);
    expect(isDepreciableAccount({ code: "1590", group: "fixed_assets" })).toBe(false);
    expect(isDepreciableAccount({ code: "1600", group: "fixed_assets" })).toBe(false);
    expect(isDepreciableAccount({ code: "1800", group: "fixed_assets" })).toBe(false);
    expect(isDepreciableAccount({ code: "1700", group: "deferred_assets" })).toBe(false);
    expect(allowedDepreciationMethods("1520")).toEqual([
      "straight_line",
      "immediate",
      "lump_sum_3y",
    ]);
    expect(allowedDepreciationMethods("1510")).toEqual([...DEPRECIATION_METHODS]);
  });

  it("償却資産税の対象: 有形の定額・定率と特例", () => {
    const taxed = (
      method: (typeof DEPRECIATION_METHODS)[number],
      cost: bigint,
      accountCode: string,
    ) => isDepreciableAssetTaxed({ method, cost, accountCode });
    expect(taxed("declining_balance", 500_000n, "1510")).toBe(true);
    expect(taxed("straight_line", 500_000n, "1500")).toBe(true);
    expect(taxed("straight_line", 500_000n, "1520")).toBe(false);
    expect(taxed("immediate", 150_000n, "1510")).toBe(true);
    expect(taxed("immediate", 150_000n, "1520")).toBe(false);
    expect(taxed("immediate", 99_999n, "1510")).toBe(false);
    expect(taxed("lump_sum_3y", 150_000n, "1510")).toBe(false);
  });

  it("checks the useful life, the account and the limits of each method", () => {
    const base = {
      cost: 500_000n,
      acquisitionDate: "2026-12-10",
      accountCode: "1510",
      usefulLifeYears: 4,
    } as const;
    const codes = (choice: Parameters<typeof checkDepreciationChoice>[0]) =>
      checkDepreciationChoice(choice).map((problem) => `${problem.code}:${problem.field}`);

    expect(codes({ ...base, method: "declining_balance" })).toEqual([]);
    expect(codes({ ...base, method: "straight_line", usefulLifeYears: null })).toEqual([
      "INVALID_USEFUL_LIFE:usefulLifeYears",
    ]);
    expect(codes({ ...base, method: "straight_line", usefulLifeYears: 51 })).toEqual([
      "INVALID_USEFUL_LIFE:usefulLifeYears",
    ]);
    expect(codes({ ...base, method: "declining_balance", accountCode: "1520" })).toEqual([
      "STRAIGHT_LINE_ONLY:method",
    ]);
    expect(codes({ ...base, method: "immediate" })).toEqual(["IMMEDIATE_LIMIT:method"]);
    expect(codes({ ...base, method: "immediate", cost: 99_999n, usefulLifeYears: null })).toEqual(
      [],
    );
    expect(
      codes({ ...base, method: "immediate", cost: 150_000n, acquisitionDate: "2029-04-01" }),
    ).toEqual(["SPECIAL_SMALL_ASSET_ENDED:method"]);
    expect(codes({ ...base, method: "lump_sum_3y", cost: 200_000n })).toEqual([
      "LUMP_SUM_LIMIT:method",
    ]);
    expect(codes({ ...base, method: "lump_sum_3y", cost: 0n })).toEqual(["INVALID_COST:cost"]);
    // 即時・一括 may keep a life for 償却資産申告 (16 §14.2): optional, but within the table.
    expect(codes({ ...base, method: "immediate", cost: 150_000n, usefulLifeYears: 4 })).toEqual([]);
    expect(codes({ ...base, method: "immediate", cost: 150_000n, usefulLifeYears: 1 })).toEqual([
      "INVALID_USEFUL_LIFE:usefulLifeYears",
    ]);
    expect(codes({ ...base, method: "lump_sum_3y", cost: 150_000n, usefulLifeYears: 51 })).toEqual([
      "INVALID_USEFUL_LIFE:usefulLifeYears",
    ]);

    const [lifeProblem] = checkDepreciationChoice({
      ...base,
      method: "straight_line",
      usefulLifeYears: 1,
    });
    expect(lifeProblem?.message).toBe("耐用年数は 2〜50 年で入力してください");
    const [lineProblem] = checkDepreciationChoice({
      ...base,
      method: "declining_balance",
      accountCode: "1500",
    });
    expect(lineProblem?.message).toBe("建物附属設備とソフトウェアは定額法だけです");
    const [limitProblem] = checkDepreciationChoice({ ...base, method: "immediate" });
    expect(limitProblem?.message).toBe("即時償却は 400,000 円未満の資産だけです");
  });

  it("注意: 器具備品の定額法は届出、特例は青色申告と償却資産税", () => {
    expect(
      depreciationWarnings({
        method: "straight_line",
        cost: 500_000n,
        accountCode: "1510",
        fiscalYear: { no: 1, endDate: "2027-03-31" },
      }).map((note) => note.message),
    ).toEqual(["定額法は償却方法の届出が要ります（第 1 期は申告期限の 2027/05/31 まで）"]);
    expect(
      depreciationWarnings({ method: "straight_line", cost: 500_000n, accountCode: "1500" }),
    ).toEqual([]);
    expect(
      depreciationWarnings({ method: "immediate", cost: 350_000n, accountCode: "1510" }).map(
        (note) => note.code,
      ),
    ).toEqual(["SPECIAL_SMALL_ASSET"]);
    expect(
      depreciationWarnings({ method: "immediate", cost: 98_000n, accountCode: "1510" }),
    ).toEqual([]);
  });
});

describe("繰延資産 (§6)", () => {
  const state = { cost: 165_000n, startDate: "2026-11-02" as CalendarDate };

  it("5 年: 創立費 165,000 円 → 第 1 期 13,750、第 2 期 33,000、… 第 6 期で残りの全額", () => {
    const ends: CalendarDate[] = [
      "2027-03-31",
      "2028-03-31",
      "2029-03-31",
      "2030-03-31",
      "2031-03-31",
      "2032-03-31",
      "2033-03-31",
    ];
    let amortized = 0n;
    const result: bigint[] = [];
    for (const endDate of ends) {
      const amount = planDeferredAmortization(
        { ...state, amortizedBefore: amortized },
        { endDate },
        "five_years",
      );
      result.push(amount);
      amortized += amount;
    }
    expect(result).toEqual([13_750n, 33_000n, 33_000n, 33_000n, 33_000n, 19_250n, 0n]);
    expect(amortized).toBe(165_000n);
  });

  it("全額: 残高のすべて。償却済みが多くても負にはならない", () => {
    expect(
      planDeferredAmortization(
        { ...state, amortizedBefore: 13_750n },
        { endDate: "2028-03-31" },
        "full",
      ),
    ).toBe(151_250n);
    expect(
      planDeferredAmortization(
        { ...state, amortizedBefore: 200_000n },
        { endDate: "2028-03-31" },
        "full",
      ),
    ).toBe(0n);
    expect(
      planDeferredAmortization(
        { ...state, amortizedBefore: 165_000n },
        { endDate: "2028-03-31" },
        "five_years",
      ),
    ).toBe(0n);
  });

  it("5 年: 計上しなかった期のあとは累計の額まで計上できる", () => {
    expect(
      planDeferredAmortization(
        { ...state, amortizedBefore: 0n },
        { endDate: "2028-03-31" },
        "five_years",
      ),
    ).toBe(46_750n);
  });
});
