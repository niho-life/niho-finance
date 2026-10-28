import { describe, expect, it } from "vitest";
import { japanMonthRange } from "./month";

describe("japanMonthRange", () => {
  it("runs from the 1st 00:00 JST to the next month's 1st 00:00 JST", () => {
    expect(japanMonthRange("2026-11-07")).toEqual({
      from: new Date("2026-10-31T15:00:00.000Z"),
      to: new Date("2026-11-30T15:00:00.000Z"),
    });
  });

  it("crosses the year in December", () => {
    expect(japanMonthRange("2026-12-31")).toEqual({
      from: new Date("2026-11-30T15:00:00.000Z"),
      to: new Date("2026-12-31T15:00:00.000Z"),
    });
  });
});
