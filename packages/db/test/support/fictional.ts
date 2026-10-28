import { corporateNumberCheckDigit } from "@niho-finance/ledger";

/**
 * A fictional corporate number built from a 12-digit base with the check digit formula.
 * Bases of 9s are not registry codes, so these never name a real company.
 */
export function fictionalCorporateNumber(base = "999999999999"): string {
  return `${corporateNumberCheckDigit(base)}${base}`;
}

/** Captures the rejection of a promise (to inspect its fields). */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}
