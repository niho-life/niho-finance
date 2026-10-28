import { describe, expect, it } from "vitest";
import { isSearchable, isSearchKind, parseSearchQuery } from "../src/search";

describe("parseSearchQuery (10 §7.2)", () => {
  it("reads amounts with commas, yen signs, 円 and full-width digits", () => {
    for (const input of [
      "1,650",
      "1650",
      "¥1,650",
      "￥1650",
      "1,650円",
      "１，６５０",
      "￥１６５０円",
      " ¥ 1,650 ",
      "-1,650",
    ]) {
      expect(parseSearchQuery(input).amount, input).toBe(1650n);
    }
    expect(parseSearchQuery("1,65").amount).toBeNull();
    expect(parseSearchQuery("1,650.5").amount).toBeNull();
    expect(parseSearchQuery("12月").amount).toBeNull();
    expect(parseSearchQuery("1234567890123456").amount).toBeNull();
  });

  it("reads No. in its forms, and digits only as both an amount and a No.", () => {
    for (const input of ["No.12", "No 12", "no12", "No. 12", "Ｎｏ．１２", "NO.012"]) {
      expect(parseSearchQuery(input).entryNo, input).toBe(12);
      expect(parseSearchQuery(input).amount, input).toBeNull();
    }
    expect(parseSearchQuery("12")).toMatchObject({ amount: 12n, entryNo: 12 });
    expect(parseSearchQuery("1,650").entryNo).toBeNull();
    expect(parseSearchQuery("No.0").entryNo).toBeNull();
    expect(parseSearchQuery("1234567890").entryNo).toBeNull();
  });

  it("reads a T-number as a registration number", () => {
    const fictional = "T9999999999999";
    expect(parseSearchQuery(fictional).registrationNumber).toBe(fictional);
    expect(parseSearchQuery("t9999999999999").registrationNumber).toBe(fictional);
    expect(parseSearchQuery("Ｔ９９９９９９９９９９９９９").registrationNumber).toBe(fictional);
    expect(parseSearchQuery("T9999-9999-99999").registrationNumber).toBe(fictional);
    expect(parseSearchQuery("T999999999999").registrationNumber).toBeNull();
    expect(parseSearchQuery("T99999999999999").registrationNumber).toBeNull();
    expect(parseSearchQuery("Tokyo").registrationNumber).toBeNull();
  });

  it("normalizes text (NFKC, lower case, trimmed) and needs 2 characters", () => {
    expect(parseSearchQuery("  ｶｸｳ  ")).toMatchObject({ raw: "ｶｸｳ", text: "カクウ" });
    expect(parseSearchQuery("ＡＷＳ").text).toBe("aws");
    expect(parseSearchQuery("カ").text).toBeNull();
    expect(parseSearchQuery("カ")).toMatchObject({ amount: null, entryNo: null });
    expect(isSearchable(parseSearchQuery("カ"))).toBe(false);
    expect(isSearchable(parseSearchQuery(""))).toBe(false);
    expect(isSearchable(parseSearchQuery("   "))).toBe(false);
    // One digit is still an amount and a No.
    expect(parseSearchQuery("7")).toMatchObject({ text: null, amount: 7n, entryNo: 7 });
    expect(isSearchable(parseSearchQuery("7"))).toBe(true);
  });

  it("keeps %, _ and \\ as text (the SQL escapes them)", () => {
    expect(parseSearchQuery("10%").text).toBe("10%");
    expect(parseSearchQuery("a_b").text).toBe("a_b");
    expect(parseSearchQuery("a\\b").text).toBe("a\\b");
    expect(parseSearchQuery("%").text).toBeNull();
    expect(parseSearchQuery("10%").amount).toBeNull();
  });

  it("knows the kinds", () => {
    expect(isSearchKind("entry")).toBe(true);
    expect(isSearchKind("journal")).toBe(false);
    expect(isSearchKind(undefined)).toBe(false);
  });
});
