import type { Money } from "@niho-finance/ledger";
import type { Reading, ReadingRate } from "./reading";

/**
 * Normalization for comparing readings: issuer names (duplicates, partner matching) and the
 * per-rate breakdown, and the gold set comparison of the evaluation (20-reader §12).
 */

/** Legal entity forms, after NFKC (so `㈱` and `（株）` are already `(株)`). Longest first. */
const LEGAL_FORMS = [
  "特定非営利活動法人",
  "一般社団法人",
  "一般財団法人",
  "公益社団法人",
  "公益財団法人",
  "社会福祉法人",
  "株式会社",
  "有限会社",
  "合同会社",
  "合名会社",
  "合資会社",
  "医療法人",
  "学校法人",
  "宗教法人",
  "npo法人",
  "(株)",
  "(有)",
  "(同)",
  "(名)",
  "(資)",
  "(医)",
  "(社)",
  "(財)",
];

/** NFKC, no whitespace, lower case, legal entity forms removed: `㈱ 架空 商事` → `架空商事`. */
export function normalizeIssuerName(name: string): string {
  let value = name.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  for (const form of LEGAL_FORMS) value = value.split(form).join("");
  return value;
}

interface RateTotals {
  inclusiveAmount: Money;
  /** `null` when any line of the rate has no printed tax. */
  taxAmount: Money | null;
}

function totalsByRate(rates: readonly ReadingRate[]): Map<number, RateTotals> {
  const totals = new Map<number, RateTotals>();
  for (const rate of rates) {
    const current = totals.get(rate.ratePercent);
    if (!current) {
      totals.set(rate.ratePercent, {
        inclusiveAmount: rate.inclusiveAmount,
        taxAmount: rate.taxAmount,
      });
      continue;
    }
    current.inclusiveAmount += rate.inclusiveAmount;
    current.taxAmount =
      current.taxAmount === null || rate.taxAmount === null
        ? null
        : current.taxAmount + rate.taxAmount;
  }
  return totals;
}

/** Same tax-inclusive amount and same printed tax for every rate (lines of a rate are summed). */
export function sameRates(a: readonly ReadingRate[], b: readonly ReadingRate[]): boolean {
  const left = totalsByRate(a);
  const right = totalsByRate(b);
  if (left.size !== right.size) return false;
  for (const [rate, totals] of left) {
    const other = right.get(rate);
    if (!other) return false;
    if (other.inclusiveAmount !== totals.inclusiveAmount) return false;
    if (other.taxAmount !== totals.taxAmount) return false;
  }
  return true;
}

export interface ReadingComparison {
  date: boolean;
  total: boolean;
  rates: boolean;
  /** Not part of `all`: reported by the evaluation only. */
  registrationNumber: boolean;
  issuerName: boolean;
  /** Date, total and breakdown all match (the gold set criterion). */
  all: boolean;
}

export function compareWithExpected(reading: Reading, expected: Reading): ReadingComparison {
  const date = reading.transactionDate === expected.transactionDate;
  const total = reading.totalAmount === expected.totalAmount;
  const rates = sameRates(reading.rates, expected.rates);
  const issuerName =
    reading.issuerName === null || expected.issuerName === null
      ? reading.issuerName === expected.issuerName
      : normalizeIssuerName(reading.issuerName) === normalizeIssuerName(expected.issuerName);
  return {
    date,
    total,
    rates,
    registrationNumber: reading.registrationNumber === expected.registrationNumber,
    issuerName,
    all: date && total && rates,
  };
}
