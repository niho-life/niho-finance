import { describe, expect, it } from "vitest";
import { checkBalanceContinuity } from "../src/csv/balance";
import { withRowNumber } from "../src/csv/rows";
import { draft } from "./support/drafts";

describe("checkBalanceContinuity (12-imports §3.4)", () => {
  it("is quiet when every balance connects", () => {
    const rows = [
      draft("2026-11-01", 100n, { balanceAfter: 1100n }),
      draft("2026-11-02", -50n, { balanceAfter: 1050n }),
    ];
    expect(checkBalanceContinuity(rows, 1000n)).toEqual([]);
    expect(checkBalanceContinuity(rows, null)).toEqual([]);
  });

  it("checks the first row against the starting balance", () => {
    const rows = [draft("2026-11-01", 100n, { balanceAfter: 1100n })];
    expect(checkBalanceContinuity(rows, 900n)).toEqual([
      "1 行目で残高がつながりません（前の残高 900 + 金額 100 ≠ 1,100）",
    ]);
  });

  it("restarts from a broken row's own balance, so a missing row warns once", () => {
    const rows = [
      draft("2026-11-01", 100n, { balanceAfter: 1100n }),
      draft("2026-11-03", -50n, { balanceAfter: 1030n }),
      draft("2026-11-04", -30n, { balanceAfter: 1000n }),
    ];
    expect(checkBalanceContinuity(rows, null)).toEqual([
      "2 行目で残高がつながりません（前の残高 1,100 + 金額 -50 ≠ 1,030）",
    ]);
  });

  it("carries the balance over rows without one", () => {
    const rows = [
      draft("2026-11-01", 100n, { balanceAfter: 1100n }),
      draft("2026-11-02", -50n),
      draft("2026-11-03", -30n, { balanceAfter: 1020n }),
      draft("2026-11-04", -20n, { balanceAfter: 1001n }),
    ];
    expect(checkBalanceContinuity(rows, null)).toEqual([
      "4 行目で残高がつながりません（前の残高 1,020 + 金額 -20 ≠ 1,001）",
    ]);
  });

  it("cites the row of the file when the rows came from a CSV", () => {
    const rows = [
      withRowNumber(draft("2026-11-01", 100n, { balanceAfter: 1100n }), 9),
      withRowNumber(draft("2026-11-02", -50n, { balanceAfter: 1000n }), 8),
    ];
    expect(checkBalanceContinuity(rows, null)).toEqual([
      "8 行目で残高がつながりません（前の残高 1,100 + 金額 -50 ≠ 1,000）",
    ]);
  });

  it("checks nothing without balances", () => {
    expect(checkBalanceContinuity([draft("2026-11-01", 1n), draft("2026-11-02", 2n)], 0n)).toEqual(
      [],
    );
  });
});
