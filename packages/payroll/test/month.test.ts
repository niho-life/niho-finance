import { describe, expect, it } from "vitest";
import {
  compareYearMonths,
  coverageByAge,
  isYearMonth,
  parseYearMonth,
  reachedOn,
  yearMonthOf,
  yearMonthParts,
} from "../src";

describe("year-months", () => {
  it("accept only real YYYY-MM months", () => {
    expect(isYearMonth("2026-11")).toBe(true);
    expect(isYearMonth("2026-12")).toBe(true);
    expect(isYearMonth("2026-13")).toBe(false);
    expect(isYearMonth("2026-00")).toBe(false);
    expect(isYearMonth("2026-1")).toBe(false);
    expect(isYearMonth("2026-11-01")).toBe(false);
    expect(isYearMonth(202611)).toBe(false);
    expect(() => parseYearMonth("2026/11")).toThrow(RangeError);
  });

  it("compare, split and derive from dates", () => {
    expect(compareYearMonths("2026-11", "2027-03")).toBe(-1);
    expect(compareYearMonths("2027-03", "2027-03")).toBe(0);
    expect(compareYearMonths("2027-10", "2027-09")).toBe(1);
    expect(yearMonthParts("2027-09")).toEqual({ year: 2027, month: 9 });
    expect(yearMonthOf("2026-12-25")).toBe("2026-12");
  });
});

describe("reachedOn: the day before the birthday (年齢計算ニ関スル法律)", () => {
  it("is the day before the corresponding birthday", () => {
    expect(reachedOn("1986-11-02", 40)).toBe("2026-11-01");
    expect(reachedOn("1986-11-15", 40)).toBe("2026-11-14");
    // Born on the 1st: the age is reached in the previous month.
    expect(reachedOn("1986-11-01", 40)).toBe("2026-10-31");
    expect(reachedOn("1987-01-01", 40)).toBe("2026-12-31");
    expect(reachedOn("1987-03-01", 40)).toBe("2027-02-28");
    expect(reachedOn("1988-03-01", 40)).toBe("2028-02-29");
  });

  it("is 28 February for a 29 February birth, in common and leap years", () => {
    expect(reachedOn("2000-02-29", 1)).toBe("2001-02-28");
    expect(reachedOn("2000-02-29", 4)).toBe("2004-02-28");
    expect(reachedOn("1964-02-29", 65)).toBe("2029-02-28");
    expect(reachedOn("1988-02-29", 40)).toBe("2028-02-28");
  });

  it("rejects invalid input", () => {
    expect(() => reachedOn("1986-02-30", 40)).toThrow(RangeError);
    expect(() => reachedOn("1986-11-02", -1)).toThrow(RangeError);
    expect(() => reachedOn("1986-11-02", 1.5)).toThrow(RangeError);
  });
});

describe("coverageByAge (22-payroll §2.9)", () => {
  it("covers health and pension, not care, before 40", () => {
    expect(coverageByAge("1996-05-10", "2026-11")).toEqual({
      health: true,
      care: false,
      pension: true,
    });
  });

  it("介護保険 from the month of reaching 40", () => {
    // Reaches 40 on 2026-11-14.
    expect(coverageByAge("1986-11-15", "2026-10").care).toBe(false);
    expect(coverageByAge("1986-11-15", "2026-11").care).toBe(true);
    // Born on the 1st: reaches 40 on 2026-10-31, so October already.
    expect(coverageByAge("1986-11-01", "2026-09").care).toBe(false);
    expect(coverageByAge("1986-11-01", "2026-10").care).toBe(true);
  });

  it("介護保険 until the month before the month of reaching 65", () => {
    // Reaches 65 on 2026-11-14.
    expect(coverageByAge("1961-11-15", "2026-10").care).toBe(true);
    expect(coverageByAge("1961-11-15", "2026-11").care).toBe(false);
    // Born on the 1st: reaches 65 on 2026-10-31, so September is the last month.
    expect(coverageByAge("1961-11-01", "2026-09").care).toBe(true);
    expect(coverageByAge("1961-11-01", "2026-10").care).toBe(false);
  });

  it("厚生年金 until the month before the month of reaching 70", () => {
    expect(coverageByAge("1956-11-15", "2026-10").pension).toBe(true);
    expect(coverageByAge("1956-11-15", "2026-11").pension).toBe(false);
    expect(coverageByAge("1956-11-01", "2026-09").pension).toBe(true);
    expect(coverageByAge("1956-11-01", "2026-10").pension).toBe(false);
    expect(coverageByAge("1956-11-15", "2026-11")).toEqual({
      health: true,
      care: false,
      pension: false,
    });
  });

  it("健康保険 until the month before the month of the 75th birthday", () => {
    expect(coverageByAge("1951-11-15", "2026-10").health).toBe(true);
    expect(coverageByAge("1951-11-15", "2026-11").health).toBe(false);
    // The birthday itself counts here, so a birth on the 1st does not move to the month before.
    expect(coverageByAge("1951-11-01", "2026-10").health).toBe(true);
    expect(coverageByAge("1951-11-01", "2026-11").health).toBe(false);
    // 29 February in a common year: the 75th birthday is taken as 1 March.
    expect(coverageByAge("1952-02-29", "2027-02").health).toBe(true);
    expect(coverageByAge("1952-02-29", "2027-03").health).toBe(false);
    expect(coverageByAge("1951-11-15", "2026-11")).toEqual({
      health: false,
      care: false,
      pension: false,
    });
  });
});
