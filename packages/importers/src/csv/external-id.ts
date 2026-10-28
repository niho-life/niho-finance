import { sha256Hex } from "../hash";
import type { WalletTransactionDraft } from "../types";
import { copyDraft } from "./rows";

type IdentityFields = Pick<
  WalletTransactionDraft,
  "txnDate" | "amount" | "descriptionRaw" | "counterpartyRaw"
>;

/** `<txnDate>|<amount>|<descriptionRaw>|<counterpartyRaw>`: what makes two CSV rows look alike. */
function identityOf(row: IdentityFields): string {
  return `${row.txnDate}|${row.amount}|${row.descriptionRaw}|${row.counterpartyRaw ?? ""}`;
}

/**
 * The external ID of a CSV row (12-imports §3.3): SHA-256 of
 * `<txnDate>|<amount>|<descriptionRaw>|<counterpartyRaw>|<occurrence>`. The balance is left out so
 * the ID does not depend on whether the format (or the column mapping) has one.
 */
export function rowExternalId(row: IdentityFields, occurrence: number): string {
  return sha256Hex(`${identityOf(row)}|${occurrence}`);
}

/**
 * Gives each row its external ID. `rows` must be oldest first: `occurrence` counts the earlier
 * rows of the same file with the same date, amount, description and counterparty (0-based).
 */
export function assignExternalIds(
  rows: readonly WalletTransactionDraft[],
): WalletTransactionDraft[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const identity = identityOf(row);
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    return copyDraft(row, { externalId: rowExternalId(row, occurrence) });
  });
}
