import { describe, expect, it } from "vitest";
import { buildSegmentReport, segmentLabels } from "../src";
import { BOOK, FY1_TOTALS, FY1_YEAR } from "./fixtures/book";

describe("buildSegmentReport", () => {
  const report = buildSegmentReport(BOOK, FY1_YEAR);

  it("numbers the segments and ends with the total column", () => {
    expect(report.columns.map((c) => c.label)).toEqual([
      "① プラットフォーム",
      "② 鎌倉",
      "③ 受託",
      "共通",
      "合計",
    ]);
  });

  it("sums revenue, expenses and internal transactions per segment", () => {
    const { platform, kamakura, contract, corporate } = FY1_TOTALS.segments;
    expect(report.profit).toEqual([platform, kamakura, contract, corporate, FY1_TOTALS.netIncome]);
    expect(report.internal).toEqual([-3_000n, 3_000n, 0n, 0n, 0n]);
    expect(report.revenue[4]).toBe(FY1_TOTALS.revenue);
    expect(report.expenses[4]).toBe(FY1_TOTALS.expenses);
    expect(report.bars.map((bar) => bar.value)).toEqual([platform, kamakura, contract, corporate]);
  });

  it("lays out revenue, expenses, internal and the profit", () => {
    expect(report.rows.map((r) => r.kind)).toContain("section");
    const internalRow = report.rows.find((r) => r.accountId === "acc:9000");
    expect(internalRow?.values).toEqual([-3_000n, 3_000n, 0n, 0n, 0n]);
    expect(report.rows[report.rows.length - 1]).toMatchObject({ kind: "total", label: "利益" });
    expect(report.empty).toBe(false);
  });

  it("adds a 未設定 column only when a P&L line has no segment", () => {
    const withUnassigned = buildSegmentReport(
      {
        ...BOOK,
        entries: [
          ...BOOK.entries,
          {
            id: "x",
            fiscalYearId: "fy1",
            no: 99,
            entryDate: "2027-03-20",
            description: "セグメントなし",
            kind: "normal",
            sourceKind: "manual",
            status: "posted",
            reversalOfId: null,
            replacedById: null,
            voidReason: null,
            lines: [
              {
                lineNo: 1,
                side: "debit",
                accountId: "acc:5490",
                subAccountId: null,
                amount: 100n,
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
                accountId: "acc:1000",
                subAccountId: "sub:cash",
                amount: 100n,
                taxCategoryCode: "na",
                taxAmount: 0n,
                segmentId: null,
                partnerId: null,
                description: null,
                memoTagIds: [],
              },
            ],
          },
        ],
      },
      FY1_YEAR,
    );
    expect(withUnassigned.columns.map((c) => c.kind)).toEqual([
      "segment",
      "segment",
      "segment",
      "segment",
      "unassigned",
      "total",
    ]);
    expect(withUnassigned.profit[4]).toBe(-100n);
    expect(withUnassigned.profit[5]).toBe(FY1_TOTALS.netIncome - 100n);
  });

  it("labels 共通 without a number", () => {
    const labels = segmentLabels(BOOK.segments);
    expect(labels.get("seg:corporate")).toBe("共通");
    expect(labels.get("seg:contract")).toBe("③ 受託");
  });
});
