import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  checkFiscalYearPeriod,
  dateParts,
  deriveFirstFiscalYear,
  deriveNextFiscalYear,
  fiscalYearEndMonthFromStartMonth,
  fiscalYearStartMonthFromEndMonth,
  isLastDayOfMonth,
  lastDayOfMonth,
  maxFiscalYearEndDate,
  type CalendarDate,
} from "../src";

describe("month ends", () => {
  it("knows the last day of each month, leap years included", () => {
    expect(lastDayOfMonth(2027, 3)).toBe("2027-03-31");
    expect(lastDayOfMonth(2026, 11)).toBe("2026-11-30");
    expect(lastDayOfMonth(2027, 2)).toBe("2027-02-28");
    expect(lastDayOfMonth(2028, 2)).toBe("2028-02-29");
    expect(lastDayOfMonth(2100, 2)).toBe("2100-02-28");
    expect(lastDayOfMonth(2000, 2)).toBe("2000-02-29");
    expect(() => lastDayOfMonth(2027, 13)).toThrow(RangeError);
    expect(isLastDayOfMonth("2028-02-29")).toBe(true);
    expect(isLastDayOfMonth("2027-02-28")).toBe(true);
    expect(isLastDayOfMonth("2028-02-28")).toBe(false);
    expect(dateParts("2026-11-02")).toEqual({ year: 2026, month: 11, day: 2 });
  });

  it("converts between 決算月 and the first month of the year", () => {
    expect(fiscalYearEndMonthFromStartMonth(4)).toBe(3);
    expect(fiscalYearEndMonthFromStartMonth(1)).toBe(12);
    expect(fiscalYearStartMonthFromEndMonth(3)).toBe(4);
    expect(fiscalYearStartMonthFromEndMonth(12)).toBe(1);
    for (let month = 1; month <= 12; month += 1) {
      expect(fiscalYearStartMonthFromEndMonth(fiscalYearEndMonthFromStartMonth(month))).toBe(month);
    }
    expect(() => fiscalYearStartMonthFromEndMonth(0)).toThrow(RangeError);
  });
});

describe("deriveFirstFiscalYear", () => {
  it("runs from the founding date to the end of the next 決算月", () => {
    expect(deriveFirstFiscalYear("2026-11-02", 3)).toEqual({
      startDate: "2026-11-02",
      endDate: "2027-03-31",
    });
    expect(deriveFirstFiscalYear("2026-02-10", 3)).toEqual({
      startDate: "2026-02-10",
      endDate: "2026-03-31",
    });
    expect(deriveFirstFiscalYear("2026-04-01", 3)).toEqual({
      startDate: "2026-04-01",
      endDate: "2027-03-31",
    });
    expect(deriveFirstFiscalYear("2026-12-01", 12).endDate).toBe("2026-12-31");
    expect(deriveFirstFiscalYear("2027-01-05", 12).endDate).toBe("2027-12-31");
  });

  it("ends in the founding month when it is the 決算月", () => {
    expect(deriveFirstFiscalYear("2026-03-15", 3).endDate).toBe("2026-03-31");
    expect(deriveFirstFiscalYear("2026-03-31", 3).endDate).toBe("2026-03-31");
  });

  it("uses the real last day of February", () => {
    expect(deriveFirstFiscalYear("2027-05-01", 2).endDate).toBe("2028-02-29");
    expect(deriveFirstFiscalYear("2026-05-01", 2).endDate).toBe("2027-02-28");
  });

  it("is always a valid period of at most a year", () => {
    const dates = fc
      .integer({ min: 0, max: 365 * 30 })
      .map((offset) => addDays("2020-01-01", offset));
    fc.assert(
      fc.property(dates, fc.integer({ min: 1, max: 12 }), (foundedOn, endMonth) => {
        const period = deriveFirstFiscalYear(foundedOn, endMonth);
        expect(checkFiscalYearPeriod(period)).toEqual({ ok: true });
        expect(isLastDayOfMonth(period.endDate)).toBe(true);
        expect(dateParts(period.endDate).month).toBe(endMonth);
      }),
    );
  });
});

describe("deriveNextFiscalYear", () => {
  it("starts the next day and lasts 12 months", () => {
    expect(deriveNextFiscalYear("2027-03-31")).toEqual({
      startDate: "2027-04-01",
      endDate: "2028-03-31",
    });
    expect(deriveNextFiscalYear("2026-12-31")).toEqual({
      startDate: "2027-01-01",
      endDate: "2027-12-31",
    });
  });

  it("keeps month ends through February", () => {
    expect(deriveNextFiscalYear("2027-02-28")).toEqual({
      startDate: "2027-03-01",
      endDate: "2028-02-29",
    });
    expect(deriveNextFiscalYear("2028-02-29")).toEqual({
      startDate: "2028-03-01",
      endDate: "2029-02-28",
    });
  });

  it("keeps the same day for a close that is not a month end", () => {
    expect(deriveNextFiscalYear("2027-03-20")).toEqual({
      startDate: "2027-03-21",
      endDate: "2028-03-20",
    });
  });

  it("chains into valid periods without gaps", () => {
    let previous: CalendarDate = "2027-03-31";
    for (let index = 0; index < 10; index += 1) {
      const next = deriveNextFiscalYear(previous);
      expect(next.startDate).toBe(addDays(previous, 1));
      expect(checkFiscalYearPeriod(next)).toEqual({ ok: true });
      previous = next.endDate;
    }
    expect(previous).toBe("2037-03-31");
  });
});

describe("checkFiscalYearPeriod", () => {
  it("allows at most one year (民法 §143)", () => {
    expect(maxFiscalYearEndDate("2026-11-02")).toBe("2027-11-01");
    expect(maxFiscalYearEndDate("2026-04-01")).toBe("2027-03-31");
    expect(maxFiscalYearEndDate("2028-02-29")).toBe("2029-02-28");
    expect(checkFiscalYearPeriod({ startDate: "2026-04-01", endDate: "2027-03-31" })).toEqual({
      ok: true,
    });
    expect(checkFiscalYearPeriod({ startDate: "2026-04-01", endDate: "2027-04-01" })).toMatchObject(
      { ok: false, code: "LONGER_THAN_A_YEAR" },
    );
  });

  it("rejects an end before the start and invalid dates", () => {
    expect(checkFiscalYearPeriod({ startDate: "2026-11-02", endDate: "2026-11-01" })).toMatchObject(
      { ok: false, code: "END_BEFORE_START" },
    );
    expect(checkFiscalYearPeriod({ startDate: "2026-11-02", endDate: "2026-11-02" })).toEqual({
      ok: true,
    });
    expect(checkFiscalYearPeriod({ startDate: "2026-02-30", endDate: "2027-03-31" })).toMatchObject(
      { ok: false, code: "INVALID_DATE" },
    );
  });
});
