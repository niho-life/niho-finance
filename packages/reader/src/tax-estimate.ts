import type { TaxCategoryCode } from "@niho-finance/ledger";
import type { ReadingRatePercent } from "./reading";

/** The issuer's registration on the transaction date; `unknown` when not looked up (20-reader §6). */
export type RegistrationStatusAtDate = "registered" | "not_registered" | "unknown";

export type EstimatedPurchaseTaxCategory = Extract<
  TaxCategoryCode,
  "purchase_10" | "purchase_8r" | "purchase_10_ni" | "purchase_8r_ni"
>;

/**
 * The purchase tax category a rate line suggests (20-reader §6). An unregistered issuer gives the
 * transitional `_ni` category, whose deductible ratio `TaxRateRule` fixes by date. Nothing is
 * estimated without a lookup or for 0%; the bookkeeping-only exceptions (03 §2.4) are not guessed.
 */
export function estimatePurchaseTaxCategory(
  ratePercent: ReadingRatePercent,
  status: RegistrationStatusAtDate,
): EstimatedPurchaseTaxCategory | null {
  if (status === "unknown" || ratePercent === 0) return null;
  if (status === "registered") return ratePercent === 10 ? "purchase_10" : "purchase_8r";
  return ratePercent === 10 ? "purchase_10_ni" : "purchase_8r_ni";
}
