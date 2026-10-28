import { describe, expect, it } from "vitest";
import { toAuditJson } from "../src/audit";
import { fromDbDate, toDbDate } from "../src/dates";

describe("serialization helpers", () => {
  it("audit snapshots keep bigint amounts exactly (as decimal strings)", () => {
    expect(
      toAuditJson({
        amount: 12_345_678_901_234_567_890n,
        at: new Date("2026-11-02T00:00:00.000Z"),
        lines: [{ tax: 0n }],
      }),
    ).toEqual({
      amount: "12345678901234567890",
      at: "2026-11-02T00:00:00.000Z",
      lines: [{ tax: "0" }],
    });
  });

  it("calendar dates round-trip through @db.Date values", () => {
    expect(toDbDate("2026-11-02").toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(fromDbDate(toDbDate("2027-03-31"))).toBe("2027-03-31");
    expect(() => toDbDate("2026-02-30")).toThrow(RangeError);
  });
});
