import { describe, expect, it } from "vitest";
import {
  buildMonthlyTrend,
  buildTrialBalance,
  type ReportEntry,
  type ReportPeriod,
  type ReportSource,
} from "../src";
import { BOOK, FY1, FY1_TOTALS, FY1_YEAR, FY2 } from "./fixtures/book";

describe("buildMonthlyTrend", () => {
  const report = buildMonthlyTrend(BOOK, FY1_YEAR);

  it("has one column per month of the year and a total", () => {
    expect(report.columns.map((c) => c.label)).toEqual([
      "2026/11",
      "2026/12",
      "2027/01",
      "2027/02",
      "2027/03",
    ]);
    expect(report.subtotals.netIncome).toEqual([...FY1_TOTALS.months, FY1_TOTALS.netIncome]);
    expect(report.empty).toBe(false);
  });

  it("agrees with the income statement of every month and of the year", () => {
    report.columns.forEach((column, i) => {
      const period: ReportPeriod = {
        fiscalYear: FY1,
        preset: "custom",
        from: column.from,
        to: column.to,
        segmentId: null,
      };
      const tb = buildTrialBalance(BOOK, period);
      expect(report.subtotals.netIncome[i]).toBe(tb.incomeStatement.netIncome);
      for (const row of report.rows) {
        if (row.kind !== "account") continue;
        const tbRow = tb.incomeStatement.rows.find((r) => r.accountId === row.accountId);
        expect(row.value[i]).toBe(tbRow?.value.period ?? 0n);
      }
    });
    const year = buildTrialBalance(BOOK, FY1_YEAR);
    expect(report.subtotals.netIncome[report.columns.length]).toBe(year.incomeStatement.netIncome);
  });

  it("narrows the columns to a custom range and honours the segment", () => {
    const custom = buildMonthlyTrend(BOOK, {
      ...FY1_YEAR,
      preset: "custom",
      from: "2026-12-01",
      to: "2027-01-31",
      segmentId: "seg:contract",
    });
    expect(custom.columns.map((c) => c.key)).toEqual(["2026-12", "2027-01"]);
    expect(custom.filteredBySegment).toBe(true);
    expect(custom.subtotals.netIncome).toEqual([330_000n - 1_980n, -440n, 327_580n]);
  });

  it("shows the subtotal rows even when their groups are empty", () => {
    const keys = report.rows.filter((r) => r.kind !== "account").map((r) => r.key);
    expect(keys).toEqual([
      "group:sales",
      "subtotal:grossProfit",
      "group:sga",
      "subtotal:operatingIncome",
      "subtotal:ordinaryIncome",
      "subtotal:pretaxIncome",
      "subtotal:netIncome",
    ]);
  });
});

describe("buildMonthlyTrend: 前年同月 (14-reports §15.6)", () => {
  const FY2_YEAR: ReportPeriod = {
    fiscalYear: FY2,
    preset: "year",
    from: FY2.startDate,
    to: FY2.endDate,
    segmentId: null,
  };
  const november: ReportEntry = {
    id: "x-nov",
    fiscalYearId: FY2.id,
    no: 2,
    entryDate: "2027-11-20",
    description: "月会費",
    kind: "normal",
    sourceKind: "stripe",
    status: "posted",
    reversalOfId: null,
    replacedById: null,
    voidReason: null,
    lines: [
      {
        lineNo: 1,
        side: "debit",
        accountId: "acc:1150",
        subAccountId: "sub:stripe2",
        amount: 5_000n,
        taxCategoryCode: "na",
        taxAmount: 0n,
        segmentId: null,
        partnerId: null,
        description: null,
        memoTagIds: [],
      },
      {
        lineNo: 2,
        side: "credit",
        accountId: "acc:4010",
        subAccountId: null,
        amount: 5_000n,
        taxCategoryCode: "sales_10",
        taxAmount: 0n,
        segmentId: "seg:kamakura",
        partnerId: null,
        description: null,
        memoTagIds: [],
      },
    ],
  };
  const book: ReportSource = { ...BOOK, entries: [...BOOK.entries, november] };
  const first = buildMonthlyTrend(book, FY1_YEAR);
  const report = buildMonthlyTrend(book, FY2_YEAR, { compareWithPriorYear: true });

  it("is not offered in the first year", () => {
    const fy1 = buildMonthlyTrend(book, FY1_YEAR, { compareWithPriorYear: true });
    expect(fy1.hasPriorYear).toBe(false);
    expect(fy1.comparing).toBe(false);
    expect(fy1.rows.every((row) => row.prior === undefined)).toBe(true);
    const off = buildMonthlyTrend(book, FY2_YEAR);
    expect([off.hasPriorYear, off.comparing]).toEqual([true, false]);
    expect(off.rows.every((row) => row.prior === undefined)).toBe(true);
  });

  it("shows — for months before the books and the first year's month a year later", () => {
    expect(report.comparing).toBe(true);
    expect(report.columns).toHaveLength(12);
    expect(report.priorRanges?.[0]).toBeNull();
    expect(report.priorRanges?.[7]).toEqual({ from: "2026-11-02", to: "2026-11-30" });
    const net = report.rows.find((row) => row.key === "subtotal:netIncome");
    expect(net?.prior).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      ...FY1_TOTALS.months,
      FY1_TOTALS.netIncome,
    ]);
    const sales = report.rows.find((row) => row.key === "pl:acc:4010");
    expect(sales?.value).toEqual([3_300n, 0n, 0n, 0n, 0n, 0n, 0n, 5_000n, 0n, 0n, 0n, 0n, 8_300n]);
    expect(sales?.prior?.slice(7)).toEqual([11_000n, 2_200n, 0n, 22_000n, 0n, 35_200n]);
  });

  it("agrees row by row with the first year's monthly trend, subtotals included", () => {
    for (const row of first.rows) {
      const same = report.rows.find((candidate) => candidate.key === row.key);
      expect(same, row.key).toBeDefined();
      expect(same?.prior?.slice(7)).toEqual(row.value);
    }
    // Accounts of the first year only (地代家賃) are rows with 0 this year.
    const rent = report.rows.find((row) => row.key === "pl:acc:5300");
    expect(rent?.value.at(-1)).toBe(0n);
    expect(rent?.prior?.at(-1)).toBe(264_000n);
    // This year's own amounts are unchanged by the comparison.
    const plain = buildMonthlyTrend(book, FY2_YEAR);
    expect(report.subtotals.netIncome).toEqual(plain.subtotals.netIncome);
  });

  it("leaves out the first year's 決算振替 and honours the segment", () => {
    const closing: ReportEntry = {
      ...november,
      id: "x-close",
      fiscalYearId: FY1.id,
      no: 99,
      entryDate: "2027-03-31",
      kind: "closing",
      sourceKind: "year_end",
      lines: [
        { ...november.lines[0]!, accountId: "acc:4010", subAccountId: null, amount: 35_200n },
        { ...november.lines[1]!, accountId: "acc:3200", segmentId: null, amount: 35_200n },
      ],
    };
    const closed = buildMonthlyTrend({ ...book, entries: [...book.entries, closing] }, FY2_YEAR, {
      compareWithPriorYear: true,
    });
    expect(closed.rows).toEqual(report.rows);
    const kamakura = buildMonthlyTrend(
      book,
      { ...FY2_YEAR, segmentId: "seg:kamakura" },
      { compareWithPriorYear: true },
    );
    const fy1Kamakura = buildMonthlyTrend(book, { ...FY1_YEAR, segmentId: "seg:kamakura" });
    expect(kamakura.rows.find((row) => row.key === "subtotal:netIncome")?.prior?.slice(7)).toEqual(
      fy1Kamakura.subtotals.netIncome,
    );
  });
});
