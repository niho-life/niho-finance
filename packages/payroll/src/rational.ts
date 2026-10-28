import { formatYen, type Money } from "@niho-finance/ledger";

/**
 * An exact rational number with `bigint` numerator and denominator.
 * Rates and premiums before rounding are held as rationals so that no floating point is ever
 * involved (22-payroll §1). Always normalized: `den > 0` and `gcd(|num|, den) = 1`, zero is `0/1`,
 * so structural equality (`toEqual`) is numeric equality.
 */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const rest = x % y;
    x = y;
    y = rest;
  }
  return x;
}

/** `num / den`, normalized. `ratio(5n)` is the integer 5. */
export function ratio(num: bigint, den: bigint = 1n): Rational {
  if (typeof num !== "bigint" || typeof den !== "bigint") {
    throw new TypeError("ratio: numerator and denominator must be bigint");
  }
  if (den === 0n) throw new RangeError("ratio: the denominator must not be zero");
  if (num === 0n) return { num: 0n, den: 1n };
  const sign = den < 0n ? -1n : 1n;
  const divisor = gcd(num, den);
  return { num: (sign * num) / divisor, den: (sign * den) / divisor };
}

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parses a decimal string such as `"9.92"` or `"18.300"` digit by digit into an exact rational.
 * Accepts an optional leading `-`, digits and at most one `.` followed by digits; nothing else
 * (no exponent, no `+`, no spaces, no grouping commas).
 */
export function fromDecimalString(text: string): Rational {
  const match = typeof text === "string" ? DECIMAL_PATTERN.exec(text) : null;
  if (!match) throw new RangeError(`"${String(text)}" is not a decimal number such as "9.92"`);
  const [, sign = "", whole = "", fraction = ""] = match;
  let num = 0n;
  for (const digit of whole + fraction) num = num * 10n + BigInt(digit.charCodeAt(0) - 48);
  return ratio(sign === "-" ? -num : num, 10n ** BigInt(fraction.length));
}

export function add(a: Rational, b: Rational): Rational {
  return ratio(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function subtract(a: Rational, b: Rational): Rational {
  return ratio(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return ratio(a.num * b.num, a.den * b.den);
}

/** `value ÷ 2` (折半). */
export function half(value: Rational): Rational {
  return ratio(value.num, value.den * 2n);
}

export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isZero(value: Rational): boolean {
  return value.num === 0n;
}

/** Largest whole yen ≤ value (円未満切り捨て; toward −∞ for negative values). */
export function floorToYen(value: Rational): Money {
  const whole = value.num / value.den;
  return value.num < 0n && whole * value.den !== value.num ? whole - 1n : whole;
}

/** Whole yen and the remainder in [0, den) of a non-negative rational. */
function splitNonNegative(value: Rational): { whole: bigint; remainder: bigint } {
  const whole = value.num / value.den;
  return { whole, remainder: value.num - whole * value.den };
}

/**
 * 50 銭以下切り捨て・50 銭超切り上げ: the rule for the employee share deducted from pay
 * (健保・介護・支援金・厚年・雇用保険). Symmetric for negative values (a tie rounds toward zero).
 */
export function roundHalfDownToYen(value: Rational): Money {
  if (value.num < 0n) return -roundHalfDownToYen(ratio(-value.num, value.den));
  const { whole, remainder } = splitNonNegative(value);
  return 2n * remainder > value.den ? whole + 1n : whole;
}

/**
 * 50 銭未満切り捨て・50 銭以上切り上げ: the rule when the insured pays the employer in cash.
 * Symmetric for negative values (a tie rounds away from zero).
 */
export function roundHalfUpToYen(value: Rational): Money {
  if (value.num < 0n) return -roundHalfUpToYen(ratio(-value.num, value.den));
  const { whole, remainder } = splitNonNegative(value);
  return 2n * remainder >= value.den ? whole + 1n : whole;
}

/**
 * Formats with 3-digit grouping and exactly `fractionDigits` digits after the point,
 * e.g. `formatRational(ratio(28768n, 5n), 1)` → `"5,753.6"`.
 * Never rounds: throws when the value cannot be written exactly with that many digits.
 */
export function formatRational(value: Rational, fractionDigits: number): string {
  if (!Number.isSafeInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 30) {
    throw new RangeError(`formatRational: ${fractionDigits} is not a number of fraction digits`);
  }
  const scale = 10n ** BigInt(fractionDigits);
  const scaled = value.num * scale;
  if (scaled % value.den !== 0n) {
    throw new RangeError(
      `formatRational: ${value.num}/${value.den} needs more than ${fractionDigits} fraction digits`,
    );
  }
  const units = scaled / value.den;
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = formatYen(magnitude / scale);
  const fraction = (magnitude % scale).toString().padStart(fractionDigits, "0");
  return `${negative ? "-" : ""}${whole}${fractionDigits > 0 ? `.${fraction}` : ""}`;
}
