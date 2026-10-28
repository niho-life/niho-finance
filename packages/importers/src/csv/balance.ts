import { formatYen, type Money } from "@niho-finance/ledger";
import type { WalletTransactionDraft } from "../types";
import { rowNumberOf } from "./rows";

/**
 * Checks `previous balance + amount = balance` along `rows` (oldest first) from `start`
 * (12-imports §3.4). A row without a balance carries the expected balance forward; after a break
 * the row's own balance is the new reference, so a missing row yields one warning. Rows read by
 * `parseStatement` are cited by their row in the file, other rows by their 1-based position.
 */
export function checkBalanceContinuity(
  rows: readonly WalletTransactionDraft[],
  start: Money | null,
): string[] {
  const warnings: string[] = [];
  let previous = start;
  rows.forEach((row, index) => {
    const balance = row.balanceAfter ?? null;
    if (previous !== null && balance !== null && previous + row.amount !== balance) {
      const rowNumber = rowNumberOf(row) ?? index + 1;
      warnings.push(
        `${rowNumber} 行目で残高がつながりません（前の残高 ${formatYen(previous)} + 金額 ${formatYen(row.amount)} ≠ ${formatYen(balance)}）`,
      );
    }
    previous = balance ?? (previous === null ? null : previous + row.amount);
  });
  return warnings;
}
