import { isDepreciableAssetTaxed } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import {
  buildDepreciableAssetsReturn,
  classifyDepreciableAsset,
  csvText,
  defaultDepreciableAssetsReturnYear,
  defaultPropertyTaxAssetType,
  DEPRECIABLE_ASSETS_RETURN_CSV_HEADER,
  depreciableAssetsReturnCsv,
  depreciableAssetsReturnFileName,
  propertyTaxAssetTypeText,
  wareki,
  warekiDate,
  warekiYear,
  type DepreciableAssetsReturnAsset,
} from "../src";

function asset(
  id: string,
  overrides: Partial<DepreciableAssetsReturnAsset> = {},
): DepreciableAssetsReturnAsset {
  return {
    id,
    name: id,
    accountCode: "1510",
    accountName: "工具器具備品",
    acquisitionDate: "2026-06-01",
    cost: 600_000n,
    method: "declining_balance",
    usefulLifeYears: 5,
    disposedAt: null,
    sold: false,
    voided: false,
    propertyTaxAssetType: null,
    propertyTaxExcludedReason: null,
    ...overrides,
  };
}

/** The fixture of §14.6 for the return of 2027 (判定の日 2027-01-01, window 2026-01-02 … 2027-01-01). */
const FIXTURE: DepreciableAssetsReturnAsset[] = [
  asset("special", { method: "immediate", cost: 350_000n, acquisitionDate: "2026-12-10" }),
  asset("special-no-life", {
    method: "immediate",
    cost: 150_000n,
    acquisitionDate: "2026-12-11",
    usefulLifeYears: null,
  }),
  asset("lump-sum", { method: "lump_sum_3y", cost: 180_000n, usefulLifeYears: null }),
  asset("small", { method: "immediate", cost: 98_000n, usefulLifeYears: null }),
  asset("ordinary", { acquisitionDate: "2025-06-01" }),
  asset("interior", {
    accountCode: "1500",
    accountName: "建物附属設備",
    method: "straight_line",
    cost: 1_000_000n,
    usefulLifeYears: 15,
    acquisitionDate: "2026-11-02",
  }),
  asset("software", {
    accountCode: "1520",
    accountName: "ソフトウェア",
    method: "straight_line",
    cost: 500_000n,
  }),
  asset("disposed-before", { acquisitionDate: "2025-04-01", disposedAt: "2026-12-20" }),
  asset("disposed-on-jan-1", { acquisitionDate: "2025-04-02", disposedAt: "2027-01-01" }),
  asset("disposed-after", { acquisitionDate: "2025-04-03", disposedAt: "2027-01-02" }),
  asset("sold", { acquisitionDate: "2025-05-01", disposedAt: "2026-08-01", sold: true }),
  asset("in-and-out", { acquisitionDate: "2026-03-01", disposedAt: "2026-10-01" }),
  asset("acquired-jan-1", { acquisitionDate: "2027-01-01", cost: 300_001n }),
  asset("acquired-jan-2", { acquisitionDate: "2027-01-02", cost: 400_000n }),
  asset("vehicle", {
    cost: 2_000_000n,
    propertyTaxAssetType: 5,
    propertyTaxExcludedReason: "  自動車税の課税対象（車両）  ",
  }),
  asset("lump-sum-excluded", {
    method: "lump_sum_3y",
    cost: 150_000n,
    propertyTaxExcludedReason: "手引で確かめる",
  }),
  asset("voided", { voided: true, acquisitionDate: "2025-01-10" }),
  asset("machine", {
    accountCode: "1530",
    accountName: "機械装置",
    usefulLifeYears: 8,
    acquisitionDate: "2026-02-01",
  }),
  asset("machine-typed", {
    accountCode: "1530",
    accountName: "機械装置",
    usefulLifeYears: 8,
    acquisitionDate: "2026-02-02",
    propertyTaxAssetType: 2,
  }),
];

const ids = (rows: readonly { assetId: string }[]) => rows.map((row) => row.assetId);

describe("資産の種類", () => {
  it("defaults from the account (1500 → 1, 1510 → 6) and names the kinds as the form does", () => {
    expect(defaultPropertyTaxAssetType("1500")).toBe(1);
    expect(defaultPropertyTaxAssetType("1510")).toBe(6);
    expect(defaultPropertyTaxAssetType("1520")).toBeNull();
    expect(defaultPropertyTaxAssetType("1530")).toBeNull();
    expect(propertyTaxAssetTypeText(1)).toBe("1 構築物");
    expect(propertyTaxAssetTypeText(6)).toBe("6 工具、器具及び備品");
  });
});

describe("classifyDepreciableAsset (§14.1)", () => {
  it("reports 定額・定率 and the special measure, not 少額・一括・ソフトウェア", () => {
    const verdicts = Object.fromEntries(
      FIXTURE.map((row) => [row.id, classifyDepreciableAsset(row)]),
    );
    expect(verdicts.special).toEqual({ taxable: true, reason: null });
    expect(verdicts.ordinary).toEqual({ taxable: true, reason: null });
    expect(verdicts.interior).toEqual({ taxable: true, reason: null });
    expect(verdicts.small).toEqual({ taxable: false, reason: "少額減価償却資産（10 万円未満）" });
    expect(verdicts["lump-sum"]).toEqual({ taxable: false, reason: "一括償却資産（3 年）" });
    expect(verdicts.software).toEqual({ taxable: false, reason: "無形固定資産（ソフトウェア）" });
    expect(verdicts.vehicle).toEqual({ taxable: false, reason: "自動車税の課税対象（車両）" });
    // The rules come first: an explicit reason does not replace them.
    expect(verdicts["lump-sum-excluded"]).toEqual({
      taxable: false,
      reason: "一括償却資産（3 年）",
    });
  });

  it("agrees with the register's 償却資産税 flag when nothing is excluded by hand", () => {
    for (const row of FIXTURE.filter((item) => item.propertyTaxExcludedReason === null)) {
      expect(classifyDepreciableAsset(row).taxable, row.id).toBe(isDepreciableAssetTaxed(row));
    }
  });

  it("puts the 10 万円 line between 少額 and the special measure", () => {
    const at = (cost: bigint) =>
      classifyDepreciableAsset({
        accountCode: "1510",
        method: "immediate",
        cost,
        propertyTaxExcludedReason: null,
      }).taxable;
    expect(at(99_999n)).toBe(false);
    expect(at(100_000n)).toBe(true);
  });
});

describe("wareki", () => {
  it("writes 令和 from 2019-05-01 and 平成 before", () => {
    expect(wareki("2026-12")).toBe("令和 8 年 12 月");
    expect(wareki("2026-12-10")).toBe("令和 8 年 12 月");
    expect(wareki("2019-05")).toBe("令和 1 年 5 月");
    expect(wareki("2019-04-30")).toBe("平成 31 年 4 月");
    expect(wareki("1989-02")).toBe("平成 1 年 2 月");
    expect(warekiDate("2027-01-01")).toBe("令和 9 年 1 月 1 日");
    expect(warekiYear(2019)).toBe("平成 31 年");
    expect(warekiYear(2027)).toBe("令和 9 年");
    expect(() => wareki("2026-13")).toThrow(RangeError);
    expect(() => wareki("令和 8 年")).toThrow(RangeError);
  });
});

describe("defaultDepreciableAssetsReturnYear", () => {
  it("is this year in January and next year otherwise", () => {
    expect(defaultDepreciableAssetsReturnYear("2027-01-31")).toBe(2027);
    expect(defaultDepreciableAssetsReturnYear("2027-02-01")).toBe(2028);
    expect(defaultDepreciableAssetsReturnYear("2026-12-31")).toBe(2027);
  });
});

describe("buildDepreciableAssetsReturn (§14.3)", () => {
  const result = buildDepreciableAssetsReturn(FIXTURE, { year: 2027 });

  it("judges on 1 January and counts what was acquired or disposed since 2 January a year ago", () => {
    expect(result.assessmentDate).toBe("2027-01-01");
    expect(result.previousAssessmentDate).toBe("2026-01-01");
    expect(result.window).toEqual({ from: "2026-01-02", to: "2027-01-01" });
  });

  it("lists the reported assets held on 1 January by kind, then by acquisition", () => {
    expect(ids(result.all)).toEqual([
      "interior",
      "machine-typed",
      "disposed-after",
      "ordinary",
      "special",
      "special-no-life",
      "acquired-jan-1",
      "machine",
    ]);
    const interior = result.all[0];
    expect(interior).toMatchObject({
      assetType: 1,
      quantity: 1,
      acquisitionYearMonth: "2026-11",
      acquisitionWareki: "令和 8 年 11 月",
      cost: 1_000_000n,
      usefulLifeYears: 15,
      increaseReason: "新品取得",
      decrease: null,
      note: null,
    });
    expect(result.all.find((row) => row.assetId === "special")).toMatchObject({
      assetType: 6,
      note: "中小企業者の特例（措法 67 条の 5）",
    });
    expect(result.all.find((row) => row.assetId === "machine-typed")?.assetType).toBe(2);
    expect(result.all.find((row) => row.assetId === "machine")?.assetType).toBeNull();
  });

  it("increases by what was acquired in the window, 1 January included and 2 January not", () => {
    expect(ids(result.increased)).toEqual([
      "interior",
      "machine-typed",
      "special",
      "special-no-life",
      "acquired-jan-1",
      "machine",
    ]);
    expect(ids(result.all)).not.toContain("acquired-jan-2");
    const next = buildDepreciableAssetsReturn(FIXTURE, { year: 2028 });
    expect(ids(next.increased)).toEqual(["acquired-jan-2"]);
    expect(next.increased[0]?.increaseReason).toBe("新品取得");
  });

  it("decreases by what was disposed or sold in the window and reported a year ago", () => {
    expect(ids(result.decreased)).toEqual(["disposed-before", "disposed-on-jan-1", "sold"]);
    expect(result.decreased.map((row) => row.decrease)).toEqual([
      { reason: "滅失", scope: "全部", date: "2026-12-20" },
      { reason: "滅失", scope: "全部", date: "2027-01-01" },
      { reason: "売却", scope: "全部", date: "2026-08-01" },
    ]);
    expect(result.decreased.map((row) => row.note)).toEqual([
      "除却 2026/12/20",
      "除却 2027/01/01",
      "売却 2026/08/01",
    ]);
    expect(result.decreased.every((row) => row.increaseReason === null)).toBe(true);
    // Disposed after 1 January: still held on the assessment date, a decrease of the next return.
    const next = buildDepreciableAssetsReturn(FIXTURE, { year: 2028 });
    expect(ids(next.decreased)).toEqual(["disposed-after"]);
    // Bought and disposed between two assessment dates: never reported.
    for (const rows of [result.all, result.decreased, next.all, next.decreased]) {
      expect(ids(rows)).not.toContain("in-and-out");
    }
  });

  it("lists the excluded assets held on 1 January with the reason, and never a voided one", () => {
    expect(result.excluded.map((row) => [row.assetId, row.reason])).toEqual([
      ["lump-sum", "一括償却資産（3 年）"],
      ["lump-sum-excluded", "一括償却資産（3 年）"],
      ["small", "少額減価償却資産（10 万円未満）"],
      ["software", "無形固定資産（ソフトウェア）"],
      ["vehicle", "自動車税の課税対象（車両）"],
    ]);
    for (const rows of [result.all, result.increased, result.decreased, result.excluded]) {
      expect(ids(rows)).not.toContain("voided");
    }
  });

  it("warns about a reported asset without a kind or a useful life", () => {
    expect(result.warnings.map((warning) => [warning.assetId, warning.kind])).toEqual([
      ["special-no-life", "useful_life"],
      ["machine", "asset_type"],
    ]);
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      "耐用年数が未入力です",
      "資産の種類が未選択です",
    ]);
  });

  it("totals the count and the cost of each section", () => {
    const sum = (rows: readonly { cost: bigint }[]) => rows.reduce((s, row) => s + row.cost, 0n);
    expect(result.totals.all).toEqual({ count: 8, cost: sum(result.all) });
    expect(result.totals.all.cost).toBe(
      1_000_000n + 600_000n * 4n + 350_000n + 150_000n + 300_001n,
    );
    expect(result.totals.increased).toEqual({ count: 6, cost: sum(result.increased) });
    expect(result.totals.decreased).toEqual({ count: 3, cost: 1_800_000n });
    expect(result.totals.excluded).toEqual({ count: 5, cost: sum(result.excluded) });
    expect(result.firstReturn).toBe(false);
  });

  it("makes every asset an increase in the first return", () => {
    const first = buildDepreciableAssetsReturn(
      FIXTURE.filter((row) => row.acquisitionDate >= "2026-01-02"),
      { year: 2027 },
    );
    expect(first.firstReturn).toBe(true);
    expect(ids(first.increased)).toEqual(ids(first.all));
    expect(first.decreased).toEqual([]);
  });

  it("rejects a year that is not one", () => {
    expect(() => buildDepreciableAssetsReturn([], { year: 2027.5 })).toThrow(RangeError);
  });
});

describe("depreciableAssetsReturnCsv (§14.2, §14.4)", () => {
  const result = buildDepreciableAssetsReturn(FIXTURE, { year: 2027 });
  const rows = depreciableAssetsReturnCsv(result);

  it("has the items of the 種類別明細書, with the municipality's columns empty", () => {
    expect(rows[0]).toEqual([...DEPRECIABLE_ASSETS_RETURN_CSV_HEADER]);
    expect(rows[0]).toEqual([
      "区分",
      "資産の種類",
      "資産の名称等",
      "数量",
      "取得年月（和暦）",
      "取得年月（西暦）",
      "取得価額",
      "耐用年数",
      "減価残存率",
      "価額",
      "課税標準額",
      "増加事由",
      "減少の事由",
      "減少の区分",
      "摘要",
    ]);
    expect(rows[1]).toEqual([
      "全資産",
      "1 構築物",
      "interior",
      1,
      "令和 8 年 11 月",
      "2026-11",
      1_000_000n,
      15,
      null,
      null,
      null,
      "新品取得",
      undefined,
      undefined,
      null,
    ]);
    const sold = rows.find((row) => row[0] === "減少資産" && row[2] === "sold");
    expect(sold?.slice(11)).toEqual([null, "売却", "全部", "売却 2026/08/01"]);
  });

  it("holds 全資産, 増加資産 and 減少資産 in one file, and 全資産 sums to the total", () => {
    const sections = rows.slice(1).map((row) => row[0]);
    expect(sections.filter((section) => section === "全資産")).toHaveLength(8);
    expect(sections.filter((section) => section === "増加資産")).toHaveLength(6);
    expect(sections.filter((section) => section === "減少資産")).toHaveLength(3);
    const allCost = rows
      .filter((row) => row[0] === "全資産")
      .reduce((sum, row) => sum + (row[6] as bigint), 0n);
    expect(allCost).toBe(result.totals.all.cost);
    const text = csvText(rows);
    expect(text.split("\r\n")[1]).toBe(
      "全資産,1 構築物,interior,1,令和 8 年 11 月,2026-11,1000000,15,,,,新品取得,,,",
    );
  });

  it("names the files by the return year", () => {
    expect(depreciableAssetsReturnFileName(2027, "csv")).toBe("depreciable-assets-return_2027.csv");
    expect(depreciableAssetsReturnFileName(2027, "pdf")).toBe("depreciable-assets-return_2027.pdf");
  });
});
