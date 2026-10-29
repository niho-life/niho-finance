/**
 * 定期取引の発生日と月のキー (docs/design/21-cashflow.md §2.1, §10.1, §10.2, §10.5).
 */
import { describe, expect, it } from "vitest";
import {
  isRecurringMonth,
  parseRecurringSourceId,
  recurringDateInMonth,
  recurringEntryDescription,
  recurringEntryType,
  recurringMonth,
  recurringMonthLabel,
  recurringMonthRange,
  recurringOccurrences,
  recurringSourceId,
  recurringSourcePrefix,
  type RecurringSchedule,
} from "../src";

const monthly = (dayOfMonth: number, rest: Partial<RecurringSchedule> = {}): RecurringSchedule => ({
  frequency: "monthly",
  dayOfMonth,
  monthOfYear: null,
  startDate: "2026-01-01",
  endDate: null,
  ...rest,
});

describe("recurringOccurrences", () => {
  it("puts a day the month does not have on its last day (末日 = 31, leap years too)", () => {
    expect(
      recurringOccurrences(monthly(31), { after: "2026-11-01", through: "2027-02-28" }),
    ).toEqual(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
    expect(
      recurringOccurrences(monthly(30), { after: "2028-01-31", through: "2028-03-31" }),
    ).toEqual(["2028-02-29", "2028-03-30"]);
  });

  it("happens once a year in the month of a yearly item", () => {
    const yearly: RecurringSchedule = { ...monthly(29), frequency: "yearly", monthOfYear: 2 };
    expect(recurringOccurrences(yearly, { after: "2026-12-31", through: "2029-03-01" })).toEqual([
      "2027-02-28",
      "2028-02-29",
      "2029-02-28",
    ]);
    expect(
      recurringOccurrences(
        { ...yearly, monthOfYear: null },
        { after: "2026-12-31", through: "2029-03-01" },
      ),
    ).toEqual([]);
  });

  it("keeps after < d ≤ through, the start and the end", () => {
    expect(
      recurringOccurrences(monthly(10, { startDate: "2027-01-15" }), {
        after: "2026-12-01",
        through: "2027-03-31",
      }),
    ).toEqual(["2027-02-10", "2027-03-10"]);
    expect(
      recurringOccurrences(monthly(1, { endDate: "2027-02-01" }), {
        after: "2026-12-01",
        through: "2027-03-31",
      }),
    ).toEqual(["2027-01-01", "2027-02-01"]);
    expect(
      recurringOccurrences(monthly(1), { after: "2026-12-01", through: "2026-12-01" }),
    ).toEqual([]);
  });
});

describe("the month of an occurrence", () => {
  it("is the year and month of its date", () => {
    expect(recurringMonth("2026-12-31")).toBe("2026-12");
    expect(isRecurringMonth("2026-12")).toBe(true);
    for (const bad of ["2026-13", "2026-1", "2026-12-01", "", 202612, null]) {
      expect(isRecurringMonth(bad)).toBe(false);
    }
    expect(recurringMonthLabel("2027-01")).toBe("2027 年 1 月");
    expect(recurringMonthRange("2028-02")).toEqual({ from: "2028-02-01", through: "2028-02-29" });
  });

  it("has the nominal date of the item, whatever its start and end", () => {
    expect(recurringDateInMonth(monthly(31), "2027-02")).toBe("2027-02-28");
    expect(recurringDateInMonth(monthly(5, { startDate: "2030-01-01" }), "2027-02")).toBe(
      "2027-02-05",
    );
    const yearly = { ...monthly(31), frequency: "yearly" as const, monthOfYear: 5 };
    expect(recurringDateInMonth(yearly, "2027-05")).toBe("2027-05-31");
    expect(recurringDateInMonth(yearly, "2027-06")).toBeNull();
  });

  it("names the entry 「家賃（2026 年 12 月分）」", () => {
    expect(recurringEntryDescription("家賃", "2026-12")).toBe("家賃（2026 年 12 月分）");
  });
});

describe("the entry of an occurrence", () => {
  it("is 振替 with the other wallet, else 支出 for money out and 収入 for money in", () => {
    expect(recurringEntryType({ amount: -50_000n, transferWalletId: "w_card" })).toBe("transfer");
    expect(recurringEntryType({ amount: 200_000n, transferWalletId: "w_stripe" })).toBe("transfer");
    expect(recurringEntryType({ amount: -110_000n, transferWalletId: null })).toBe("expense");
    expect(recurringEntryType({ amount: 300_000n, transferWalletId: null })).toBe("income");
  });

  it("has the sourceId <item>:<YYYY-MM>, read back by parseRecurringSourceId", () => {
    const id = recurringSourceId("01JFAKEITEM", "2026-12");
    expect(id).toBe("01JFAKEITEM:2026-12");
    expect(id.startsWith(recurringSourcePrefix("01JFAKEITEM"))).toBe(true);
    expect(parseRecurringSourceId(id)).toEqual({ itemId: "01JFAKEITEM", month: "2026-12" });
    for (const bad of [
      null,
      undefined,
      "",
      "01JFAKEITEM",
      "01JFAKEITEM:2026-13",
      ":2026-12",
      "a:b:c",
    ]) {
      expect(parseRecurringSourceId(bad)).toBeNull();
    }
    expect(() => recurringSourceId("a:b", "2026-12")).toThrow(RangeError);
    expect(() => recurringSourceId("01JFAKEITEM", "2026-1")).toThrow(RangeError);
  });
});
