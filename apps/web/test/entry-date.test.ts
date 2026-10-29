import type { CalendarDate, FiscalYearStatus } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import { defaultEntryDate } from "../app/(app)/entries/_components/entry-date";

/* 日付の初期値 (11 §4.6): the date a new 収入 / 支出 / 振替 / 伝票 starts on. */

function year(
  startDate: CalendarDate,
  endDate: CalendarDate,
  options: { lockedThrough?: CalendarDate; status?: FiscalYearStatus } = {},
) {
  return {
    startDate,
    endDate,
    lockedThrough: options.lockedThrough ?? null,
    status: options.status ?? "open",
  };
}

const first = year("2026-02-01", "2027-01-31");

describe("defaultEntryDate", () => {
  it("is today inside an open fiscal year", () => {
    expect(defaultEntryDate("2026-10-29", [first])).toBe("2026-10-29");
    expect(defaultEntryDate("2026-02-01", [first])).toBe("2026-02-01");
    expect(defaultEntryDate("2027-01-31", [first])).toBe("2027-01-31");
  });

  it("is the first day of the first year before the founding", () => {
    expect(defaultEntryDate("2026-01-10", [first])).toBe("2026-02-01");
  });

  it("is the first open day in a closed month", () => {
    const locked = year("2026-02-01", "2027-01-31", { lockedThrough: "2026-10-31" });
    expect(defaultEntryDate("2026-10-15", [locked])).toBe("2026-11-01");
  });

  it("is the last day of the last range after the end", () => {
    expect(defaultEntryDate("2027-03-05", [first])).toBe("2027-01-31");
  });

  it("looks at every open year", () => {
    const earlier = year("2025-04-01", "2026-03-31", { lockedThrough: "2026-02-28" });
    const later = year("2026-04-01", "2027-03-31");
    expect(defaultEntryDate("2026-03-15", [earlier, later])).toBe("2026-03-15");
    expect(defaultEntryDate("2026-02-10", [earlier, later])).toBe("2026-03-01");
    expect(defaultEntryDate("2027-04-10", [earlier, later])).toBe("2027-03-31");
  });

  it("takes the earlier day when two are as near", () => {
    const earlier = year("2025-04-01", "2026-03-31");
    const later = year("2026-04-01", "2027-03-31", { lockedThrough: "2026-05-31" });
    // 2026-03-31 and 2026-06-01 are both 31 days away.
    expect(defaultEntryDate("2026-05-01", [earlier, later])).toBe("2026-03-31");
    expect(defaultEntryDate("2026-05-02", [earlier, later])).toBe("2026-06-01");
  });

  it("leaves out closed, closing and fully locked years", () => {
    const closed = year("2025-04-01", "2026-03-31", { status: "closed" });
    const open = year("2026-04-01", "2027-03-31");
    expect(defaultEntryDate("2026-01-20", [closed, open])).toBe("2026-04-01");
    const closing = year("2025-04-01", "2026-03-31", { status: "closing" });
    expect(defaultEntryDate("2026-03-20", [closing, open])).toBe("2026-04-01");
    const lockedToEnd = year("2025-04-01", "2026-03-31", { lockedThrough: "2026-03-31" });
    expect(defaultEntryDate("2026-03-20", [lockedToEnd, open])).toBe("2026-04-01");
  });

  it("is today when no date can take an entry", () => {
    expect(defaultEntryDate("2026-10-29", [])).toBe("2026-10-29");
    const lockedToEnd = year("2025-04-01", "2026-03-31", { lockedThrough: "2026-03-31" });
    const closed = year("2026-04-01", "2027-03-31", { status: "closed" });
    expect(defaultEntryDate("2026-10-29", [lockedToEnd, closed])).toBe("2026-10-29");
  });
});
