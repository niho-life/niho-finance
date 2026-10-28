import { describe, expect, it } from "vitest";
import { checkYearEndStart, lockedThroughAfterStart } from "../src/closing";

/** 決算整理を始める の条件と、締め日の戻し方 (16-year-end §1.1). */
describe("the start of the year-end adjustments", () => {
  const year = {
    no: 2,
    status: "open" as const,
    startDate: "2027-04-01" as const,
    endDate: "2028-03-31" as const,
    lockedThrough: null,
  };

  it("moves a close on the last day back to the previous month end", () => {
    expect(lockedThroughAfterStart({ ...year, lockedThrough: "2028-03-31" })).toBe("2028-02-29");
    expect(lockedThroughAfterStart({ ...year, lockedThrough: "2028-01-31" })).toBe("2028-01-31");
    expect(lockedThroughAfterStart({ ...year, lockedThrough: null })).toBeNull();
    // A year ending mid-month, and a one-month year: back to the month before, or 締めない.
    expect(
      lockedThroughAfterStart({
        startDate: "2027-01-10",
        endDate: "2027-03-15",
        lockedThrough: "2027-03-15",
      }),
    ).toBe("2027-02-28");
    expect(
      lockedThroughAfterStart({
        startDate: "2027-03-01",
        endDate: "2027-03-31",
        lockedThrough: "2027-03-31",
      }),
    ).toBeNull();
    expect(
      lockedThroughAfterStart({
        startDate: "2027-01-01",
        endDate: "2027-01-31",
        lockedThrough: "2027-01-31",
      }),
    ).toBeNull();
  });

  it("starts after the last day, once the previous year is closed", () => {
    expect(checkYearEndStart(year, null, "2028-04-01")).toEqual({
      canStart: true,
      reason: null,
      lockedThroughAfterStart: null,
    });
    expect(checkYearEndStart(year, { no: 1, status: "closed" }, "2028-04-01").canStart).toBe(true);
    expect(checkYearEndStart(year, null, "2028-03-31").reason).toBe(
      "期末は 2028/03/31 です。決算整理は 2028/04/01 から始められます",
    );
    expect(checkYearEndStart(year, { no: 1, status: "closing" }, "2028-04-01").reason).toBe(
      "第 1 期を締めてから始めます",
    );
    expect(checkYearEndStart({ ...year, status: "closing" }, null, "2028-04-01").reason).toBe(
      "第 2 期は決算整理中です",
    );
    expect(checkYearEndStart({ ...year, status: "closed" }, null, "2028-04-01").reason).toBe(
      "第 2 期は締め済みです",
    );
  });
});
