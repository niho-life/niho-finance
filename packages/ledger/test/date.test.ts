import { describe, expect, it } from "vitest";
import {
  addDays,
  compareDates,
  daysBetween,
  firstOpenDate,
  isCalendarDate,
  parseCalendarDate,
} from "../src";
import { FISCAL_YEAR } from "./fixtures";

describe("calendar dates", () => {
  it("accepts only real YYYY-MM-DD dates", () => {
    expect(isCalendarDate("2026-11-02")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-11-2")).toBe(false);
    expect(isCalendarDate("2026-11-02T00:00:00Z")).toBe(false);
    expect(isCalendarDate(20261102)).toBe(false);
    expect(() => parseCalendarDate("2026-02-30")).toThrow(RangeError);
  });

  it("adds days across months and years without time zones", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(daysBetween("2026-11-02", "2027-03-31")).toBe(149);
    expect(compareDates("2026-11-02", "2027-03-31")).toBe(-1);
    expect(compareDates("2027-03-31", "2027-03-31")).toBe(0);
  });

  it("firstOpenDate is the day after the close, inside the fiscal year", () => {
    expect(firstOpenDate(FISCAL_YEAR)).toBe("2026-11-02");
    expect(firstOpenDate({ ...FISCAL_YEAR, lockedThrough: "2026-11-30" })).toBe("2026-12-01");
    expect(firstOpenDate({ ...FISCAL_YEAR, lockedThrough: "2027-03-31" })).toBeNull();
    expect(firstOpenDate({ ...FISCAL_YEAR, status: "closed" })).toBeNull();
  });
});
