/**
 * Money is always a whole number of JPY (円) held as a `bigint`.
 * Never use floating point for money: there is no fractional yen in this ledger.
 */
export type Money = bigint;

export const ZERO: Money = 0n;

export function isMoney(value: unknown): value is Money {
  return typeof value === "bigint";
}

export function add(a: Money, b: Money): Money {
  return a + b;
}

export function subtract(a: Money, b: Money): Money {
  return a - b;
}

export function negate(value: Money): Money {
  return -value;
}

export function abs(value: Money): Money {
  return value < 0n ? -value : value;
}

export function sum(values: Iterable<Money>): Money {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/**
 * Converts a whole-yen amount into `Money`.
 * Rejects fractions, NaN/Infinity and numbers outside the safe integer range,
 * because those cannot be represented exactly.
 */
export function fromYen(value: number | bigint): Money {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`fromYen: ${String(value)} is not a safe integer number of yen`);
  }
  return BigInt(value);
}

/** Formats with 3-digit grouping and no currency sign, e.g. `-1234567n` → `"-1,234,567"`. */
export function formatYen(value: Money): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}
