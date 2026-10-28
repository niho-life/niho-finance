import { describe, expect, it } from "vitest";
import { fiscalYearOn, monthsBetween, periodSearchParams, resolveReportPeriod } from "../src";
import { FY1, FY2 } from "./fixtures/book";

const years = [FY1, FY2];

describe("resolveReportPeriod", () => {
  it("defaults to the whole year of today", () => {
    const period = resolveReportPeriod({}, years, "2026-12-15");
    expect(period).toMatchObject({
      fiscalYear: FY1,
      preset: "year",
      from: "2026-11-02",
      to: "2027-03-31",
      segmentId: null,
    });
  });

  it("今月 is the month of today, clipped to the year", () => {
    expect(resolveReportPeriod({ period: "month" }, years, "2026-12-15")).toMatchObject({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    // Before the books start: the first month of the first year (from the founding date).
    expect(resolveReportPeriod({ period: "month" }, years, "2026-10-01")).toMatchObject({
      fiscalYear: FY1,
      from: "2026-11-02",
      to: "2026-11-30",
    });
    // A later year chosen explicitly: today's month does not belong to it → its last month.
    expect(resolveReportPeriod({ fy: 1, period: "month" }, years, "2027-06-10")).toMatchObject({
      fiscalYear: FY1,
      from: "2027-03-01",
      to: "2027-03-31",
    });
  });

  it("任意 clips to the year and swaps reversed bounds", () => {
    expect(
      resolveReportPeriod(
        { period: "custom", from: "2027-02-10", to: "2026-10-01" },
        years,
        "2027-01-01",
      ),
    ).toMatchObject({ preset: "custom", from: "2026-11-02", to: "2027-02-10" });
    expect(
      resolveReportPeriod({ period: "custom", to: "2026-12-31" }, years, "2027-01-01"),
    ).toMatchObject({ from: "2026-11-02", to: "2026-12-31" });
  });

  it("carries the segment and reproduces itself as URL parameters", () => {
    const period = resolveReportPeriod(
      { fy: 2, period: "custom", from: "2027-05-01", to: "2027-05-31", segment: "seg:kamakura" },
      years,
      "2026-12-01",
    );
    expect(period?.fiscalYear).toBe(FY2);
    expect(period?.segmentId).toBe("seg:kamakura");
    expect(periodSearchParams(period!)).toEqual({
      fy: "2",
      period: "custom",
      from: "2027-05-01",
      to: "2027-05-31",
      segment: "seg:kamakura",
    });
    expect(periodSearchParams(resolveReportPeriod({}, years, "2026-12-01")!)).toEqual({
      fy: "1",
      period: "year",
    });
  });

  it("returns null without fiscal years", () => {
    expect(resolveReportPeriod({}, [], "2026-12-01")).toBeNull();
    expect(fiscalYearOn([], "2026-12-01")).toBeNull();
  });
});

describe("monthsBetween", () => {
  it("clips the first and last month to the range", () => {
    const months = monthsBetween("2026-11-02", "2027-03-31");
    expect(months.map((m) => m.key)).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
      "2027-03",
    ]);
    expect(months[0]).toMatchObject({ label: "2026/11", from: "2026-11-02", to: "2026-11-30" });
    expect(months[4]).toMatchObject({ from: "2027-03-01", to: "2027-03-31" });
    expect(monthsBetween("2027-02-10", "2027-02-20")).toEqual([
      {
        key: "2027-02",
        label: "2027/02",
        year: 2027,
        month: 2,
        from: "2027-02-10",
        to: "2027-02-20",
      },
    ]);
    expect(monthsBetween("2027-02-10", "2027-02-01")).toEqual([]);
  });
});
