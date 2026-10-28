import type { CalendarDate } from "./date";
import { LedgerInvariantError } from "./errors";
import type { Money } from "./money";

/**
 * Rate, deductible ratio and validity period of a tax category code.
 * Transitional measures and rate changes are added as data, never as code.
 */
export interface TaxRateRule {
  taxCategoryCode: string;
  effectiveFrom: CalendarDate;
  /** Inclusive. `null` means open-ended. */
  effectiveTo: CalendarDate | null;
  /** Integer percent (10, 8, 1, 0). */
  ratePercent: number;
  /** Purchase tax credit ratio in percent (100, 80, 70, 50, 30, 0). `null` when not a taxable purchase. */
  deductiblePercent: number | null;
  /** Disabled rules are kept as data (e.g. a bill not yet passed) and ignored by `resolveTaxRule`. */
  enabled: boolean;
  note?: string;
}

function toRate(ratePercent: number | bigint): bigint {
  const rate =
    typeof ratePercent === "bigint" ? ratePercent : BigInt(ratePercentToInteger(ratePercent));
  if (rate < 0n || rate > 100n) {
    throw new LedgerInvariantError(
      "INVALID_TAX_RATE",
      `tax rate ${rate.toString()}% is out of range`,
    );
  }
  return rate;
}

function ratePercentToInteger(ratePercent: number): number {
  if (!Number.isInteger(ratePercent)) {
    throw new LedgerInvariantError(
      "INVALID_TAX_RATE",
      `tax rate ${ratePercent}% is not an integer`,
    );
  }
  return ratePercent;
}

/**
 * Consumption tax contained in a tax-inclusive amount:
 * amount × rate ÷ (100 + rate), fractions of a yen truncated (toward zero for negative amounts).
 */
export function inclusiveTaxAmount(amountInclusive: Money, ratePercent: number | bigint): Money {
  const rate = toRate(ratePercent);
  if (rate === 0n) return 0n;
  return (amountInclusive * rate) / (100n + rate);
}

/** Consumption tax on a tax-exclusive amount: amount × rate ÷ 100, fractions truncated. */
export function exclusiveTaxAmount(amountExclusive: Money, ratePercent: number | bigint): Money {
  const rate = toRate(ratePercent);
  return (amountExclusive * rate) / 100n;
}

/** Tax-exclusive amount → tax-inclusive amount (tax truncated to the yen). */
export function exclusiveToInclusive(amountExclusive: Money, ratePercent: number | bigint): Money {
  return amountExclusive + exclusiveTaxAmount(amountExclusive, ratePercent);
}

export interface TaxableLine {
  amount: Money;
  ratePercent: number;
}

export interface RateSummary {
  ratePercent: number;
  lineCount: number;
  /** Sum of the line amounts as given (inclusive or exclusive per `amountsInclude`). */
  amount: Money;
  /** Tax for the rate, rounded once on the rate total. */
  taxAmount: Money;
  amountInclusive: Money;
  amountExclusive: Money;
}

export interface SumByRateOptions {
  /** Whether the line amounts already include tax. Defaults to `tax_inclusive`. */
  amountsInclude?: "tax_inclusive" | "tax_exclusive";
}

/**
 * Invoice rule (適格請求書): total the lines per tax rate, then round the tax once per rate.
 * Returns one summary per rate, highest rate first.
 */
export function sumByRateWithSingleRounding(
  lines: Iterable<TaxableLine>,
  options: SumByRateOptions = {},
): RateSummary[] {
  const mode = options.amountsInclude ?? "tax_inclusive";
  const totals = new Map<number, { amount: Money; lineCount: number }>();
  for (const line of lines) {
    toRate(line.ratePercent);
    const current = totals.get(line.ratePercent) ?? { amount: 0n, lineCount: 0 };
    current.amount += line.amount;
    current.lineCount += 1;
    totals.set(line.ratePercent, current);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => b - a)
    .map(([ratePercent, { amount, lineCount }]) => {
      if (mode === "tax_inclusive") {
        const taxAmount = inclusiveTaxAmount(amount, ratePercent);
        return {
          ratePercent,
          lineCount,
          amount,
          taxAmount,
          amountInclusive: amount,
          amountExclusive: amount - taxAmount,
        };
      }
      const taxAmount = exclusiveTaxAmount(amount, ratePercent);
      return {
        ratePercent,
        lineCount,
        amount,
        taxAmount,
        amountInclusive: amount + taxAmount,
        amountExclusive: amount,
      };
    });
}

/**
 * Finds the enabled rule for a tax category code on a date.
 * When several enabled rules overlap, the most specific one wins: the latest `effectiveFrom`,
 * then the earliest `effectiveTo` (an override such as a temporary rate).
 * Two candidates with the same period are a data error.
 */
export function resolveTaxRule(
  taxCategoryCode: string,
  date: CalendarDate,
  rules: Iterable<TaxRateRule>,
): TaxRateRule | undefined {
  const candidates: TaxRateRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.taxCategoryCode !== taxCategoryCode) continue;
    if (rule.effectiveFrom > date) continue;
    if (rule.effectiveTo !== null && rule.effectiveTo < date) continue;
    candidates.push(rule);
  }
  candidates.sort(compareSpecificity);
  const [first, second] = candidates;
  if (first && second && compareSpecificity(first, second) === 0) {
    throw new LedgerInvariantError(
      "TAX_RULE_AMBIGUOUS",
      `${taxCategoryCode} has more than one enabled rule for ${first.effectiveFrom}..${first.effectiveTo ?? ""}`,
    );
  }
  return first;
}

/** Most specific first: later start, then earlier end (open-ended last). */
function compareSpecificity(a: TaxRateRule, b: TaxRateRule): number {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom > b.effectiveFrom ? -1 : 1;
  if (a.effectiveTo === b.effectiveTo) return 0;
  if (a.effectiveTo === null) return 1;
  if (b.effectiveTo === null) return -1;
  return a.effectiveTo < b.effectiveTo ? -1 : 1;
}
