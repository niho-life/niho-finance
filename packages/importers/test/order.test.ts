import { describe, expect, it } from "vitest";
import { isNewestFirst, orderChronologically } from "../src/csv/order";
import { draft } from "./support/drafts";

const ascending = [
  draft("2026-11-01", 100n, { descriptionRaw: "a", balanceAfter: 100n }),
  draft("2026-11-02", -30n, { descriptionRaw: "b", balanceAfter: 70n }),
  draft("2026-11-02", -20n, { descriptionRaw: "c", balanceAfter: 50n }),
  draft("2026-11-03", 5n, { descriptionRaw: "d", balanceAfter: 55n }),
];
const descriptions = (rows: readonly { descriptionRaw: string }[]): string[] =>
  rows.map((row) => row.descriptionRaw);

describe("orderChronologically", () => {
  it("keeps an oldest-first file as it is", () => {
    expect(descriptions(orderChronologically(ascending, "auto"))).toEqual(["a", "b", "c", "d"]);
  });

  it("reverses a newest-first file as a whole, including the order within a day", () => {
    const newestFirst = [...ascending].reverse();
    expect(descriptions(orderChronologically(newestFirst, "auto"))).toEqual(["a", "b", "c", "d"]);
  });

  it("does not sort: rows out of date order stay where they are", () => {
    const mixed = [ascending[0], ascending[3], ascending[1], ascending[2]].filter(
      (row) => row !== undefined,
    );
    expect(descriptions(orderChronologically(mixed, "auto"))).toEqual(["a", "d", "b", "c"]);
  });

  it("follows an explicit order", () => {
    expect(descriptions(orderChronologically(ascending, "asc"))).toEqual(["a", "b", "c", "d"]);
    expect(descriptions(orderChronologically(ascending, "desc"))).toEqual(["d", "c", "b", "a"]);
  });

  it("does not change the input array", () => {
    const input = [...ascending];
    orderChronologically(input, "desc");
    expect(descriptions(input)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("isNewestFirst", () => {
  it("compares the first and last dates", () => {
    expect(isNewestFirst(ascending)).toBe(false);
    expect(isNewestFirst([...ascending].reverse())).toBe(true);
  });

  it("uses the balances when the file covers one day", () => {
    const oneDay = [
      draft("2026-11-02", 100n, { balanceAfter: 1100n }),
      draft("2026-11-02", -50n, { balanceAfter: 1050n }),
      draft("2026-11-02", -25n, { balanceAfter: 1025n }),
    ];
    expect(isNewestFirst(oneDay)).toBe(false);
    expect(isNewestFirst([...oneDay].reverse())).toBe(true);
  });

  it("keeps the file order when neither dates nor balances tell", () => {
    const oneDay = [draft("2026-11-02", 100n), draft("2026-11-02", -50n)];
    expect(isNewestFirst(oneDay)).toBe(false);
    expect(isNewestFirst([])).toBe(false);
    expect(isNewestFirst([draft("2026-11-02", 1n)])).toBe(false);
  });
});
