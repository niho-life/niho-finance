import { describe, expect, it } from "vitest";
import { buildMonthlyTrend, buildTrialBalance, type ReportPeriod } from "../src";
import { BOOK, FY1, FY1_TOTALS, FY1_YEAR } from "./fixtures/book";

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
