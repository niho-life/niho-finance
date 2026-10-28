import { describe, expect, it } from "vitest";
import {
  add,
  compare,
  floorToYen,
  formatRational,
  fromDecimalString,
  half,
  isZero,
  mul,
  ratio,
  roundHalfDownToYen,
  roundHalfUpToYen,
  subtract,
} from "../src";

const decimal = fromDecimalString;

describe("rational numbers", () => {
  it("are normalized so that equal values are structurally equal", () => {
    expect(ratio(6n, 4n)).toEqual({ num: 3n, den: 2n });
    expect(ratio(3n, -6n)).toEqual({ num: -1n, den: 2n });
    expect(ratio(-3n, -6n)).toEqual({ num: 1n, den: 2n });
    expect(ratio(0n, -7n)).toEqual({ num: 0n, den: 1n });
    expect(ratio(5n)).toEqual({ num: 5n, den: 1n });
    expect(() => ratio(1n, 0n)).toThrow(RangeError);
  });

  it("parse decimal strings digit by digit, never through floating point", () => {
    expect(decimal("9.92")).toEqual(ratio(992n, 100n));
    expect(decimal("18.300")).toEqual(ratio(183n, 10n));
    expect(decimal("0.36")).toEqual(ratio(9n, 25n));
    expect(decimal("45.945")).toEqual(ratio(45_945n, 1_000n));
    expect(decimal("5")).toEqual(ratio(5n));
    expect(decimal("-1.5")).toEqual(ratio(-3n, 2n));
    // 0.1 + 0.2 is exactly 0.3 here.
    expect(add(decimal("0.1"), decimal("0.2"))).toEqual(decimal("0.3"));
    expect(decimal("12345678901234567890.123456789")).toEqual(
      ratio(12_345_678_901_234_567_890_123_456_789n, 1_000_000_000n),
    );
    for (const text of ["", ".5", "5.", "+1", " 1", "1 ", "1,000", "1e3", "0x10", "NaN", "1.2.3"]) {
      expect(() => decimal(text)).toThrow(RangeError);
    }
  });

  it("add, subtract, multiply, halve and compare exactly", () => {
    expect(add(ratio(1n, 3n), ratio(1n, 6n))).toEqual(ratio(1n, 2n));
    expect(subtract(ratio(1n, 3n), ratio(1n, 2n))).toEqual(ratio(-1n, 6n));
    expect(mul(ratio(300_000n), decimal("0.0992"))).toEqual(ratio(29_760n));
    expect(half(ratio(5_887n))).toEqual(ratio(5_887n, 2n));
    expect(compare(decimal("0.5"), ratio(1n, 2n))).toBe(0);
    expect(compare(ratio(1n, 3n), ratio(1n, 2n))).toBe(-1);
    expect(compare(ratio(-1n, 3n), ratio(-1n, 2n))).toBe(1);
    expect(isZero(subtract(decimal("1.25"), ratio(5n, 4n)))).toBe(true);
    expect(isZero(ratio(1n, 1_000_000n))).toBe(false);
  });
});

describe("rounding to the yen", () => {
  it("floorToYen truncates (円未満切り捨て)", () => {
    expect(floorToYen(decimal("5753.6"))).toBe(5_753n);
    expect(floorToYen(decimal("822415.5"))).toBe(822_415n);
    expect(floorToYen(decimal("1080"))).toBe(1_080n);
    expect(floorToYen(decimal("0.999"))).toBe(0n);
    expect(floorToYen(decimal("-2.5"))).toBe(-3n);
  });

  it("roundHalfDownToYen: 50 銭以下切り捨て・50 銭超切り上げ", () => {
    expect(roundHalfDownToYen(decimal("2943.5"))).toBe(2_943n);
    expect(roundHalfDownToYen(decimal("3413.3"))).toBe(3_413n);
    expect(roundHalfDownToYen(decimal("20807.5"))).toBe(20_807n);
    expect(roundHalfDownToYen(decimal("1250.6"))).toBe(1_251n);
    expect(roundHalfDownToYen(decimal("1250.5"))).toBe(1_250n);
    expect(roundHalfDownToYen(decimal("1250.50001"))).toBe(1_251n);
    expect(roundHalfDownToYen(decimal("1250.4"))).toBe(1_250n);
    expect(roundHalfDownToYen(decimal("0.5"))).toBe(0n);
    expect(roundHalfDownToYen(ratio(15_225n))).toBe(15_225n);
    expect(roundHalfDownToYen(decimal("-2.5"))).toBe(-2n);
    expect(roundHalfDownToYen(decimal("-2.6"))).toBe(-3n);
  });

  it("roundHalfUpToYen: 50 銭未満切り捨て・50 銭以上切り上げ", () => {
    expect(roundHalfUpToYen(decimal("2943.5"))).toBe(2_944n);
    expect(roundHalfUpToYen(decimal("1250.49999"))).toBe(1_250n);
    expect(roundHalfUpToYen(decimal("1250.5"))).toBe(1_251n);
    expect(roundHalfUpToYen(decimal("0.4"))).toBe(0n);
    expect(roundHalfUpToYen(decimal("-2.5"))).toBe(-3n);
    expect(roundHalfUpToYen(decimal("-2.4"))).toBe(-2n);
  });
});

describe("formatRational", () => {
  it("groups by 3 digits and writes exactly the requested fraction digits", () => {
    expect(formatRational(decimal("5753.6"), 1)).toBe("5,753.6");
    expect(formatRational(ratio(29_760n), 1)).toBe("29,760.0");
    expect(formatRational(decimal("1234567.25"), 2)).toBe("1,234,567.25");
    expect(formatRational(ratio(1_080n), 0)).toBe("1,080");
    expect(formatRational(decimal("0.05"), 2)).toBe("0.05");
    expect(formatRational(decimal("-0.5"), 1)).toBe("-0.5");
    expect(formatRational(decimal("-1234.5"), 2)).toBe("-1,234.50");
    expect(formatRational(ratio(0n), 2)).toBe("0.00");
  });

  it("never rounds: a value that needs more digits throws", () => {
    expect(() => formatRational(decimal("5753.6"), 0)).toThrow(RangeError);
    expect(() => formatRational(ratio(1n, 3n), 10)).toThrow(RangeError);
    expect(() => formatRational(ratio(1n), -1)).toThrow(RangeError);
    expect(() => formatRational(ratio(1n), 1.5)).toThrow(RangeError);
  });
});
