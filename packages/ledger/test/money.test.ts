import { describe, expect, it } from "vitest";
import { abs, add, formatYen, fromYen, isMoney, negate, subtract, sum, ZERO } from "../src";

describe("money", () => {
  it("adds, subtracts and negates whole yen as bigint", () => {
    expect(add(1_000n, 234n)).toBe(1_234n);
    expect(subtract(1_000n, 1_234n)).toBe(-234n);
    expect(negate(500n)).toBe(-500n);
    expect(negate(ZERO)).toBe(0n);
    expect(abs(-42n)).toBe(42n);
    expect(sum([1n, 2n, 3n])).toBe(6n);
    expect(sum([])).toBe(0n);
  });

  it("fromYen accepts safe integers only", () => {
    expect(fromYen(50_000)).toBe(50_000n);
    expect(fromYen(-1)).toBe(-1n);
    expect(fromYen(12n)).toBe(12n);
    expect(() => fromYen(1.5)).toThrow(RangeError);
    expect(() => fromYen(Number.NaN)).toThrow(RangeError);
    expect(() => fromYen(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it("formatYen groups by 3 digits", () => {
    expect(formatYen(0n)).toBe("0");
    expect(formatYen(999n)).toBe("999");
    expect(formatYen(1_000n)).toBe("1,000");
    expect(formatYen(1_234_567n)).toBe("1,234,567");
    expect(formatYen(-165_000n)).toBe("-165,000");
    expect(formatYen(12_345_678_901_234_567_890n)).toBe("12,345,678,901,234,567,890");
  });

  it("isMoney only accepts bigint", () => {
    expect(isMoney(1n)).toBe(true);
    expect(isMoney(1)).toBe(false);
    expect(isMoney("1")).toBe(false);
  });
});
