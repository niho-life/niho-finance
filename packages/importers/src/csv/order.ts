import type { GenericCsvConfig, WalletTransactionDraft } from "../types";

export type StatementOrder = NonNullable<GenericCsvConfig["order"]>;

/** How many neighbouring rows satisfy `previous balance + amount = balance` in this order. */
function continuousPairs(rows: readonly WalletTransactionDraft[]): number {
  let count = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]?.balanceAfter ?? null;
    const row = rows[index];
    const balance = row?.balanceAfter ?? null;
    if (row && previous !== null && balance !== null && previous + row.amount === balance) {
      count += 1;
    }
  }
  return count;
}

/**
 * Whether a file lists its newest row first: by the first and last dates, or, when they are the
 * same day, by the direction in which more balances connect. Without either, the file order stands.
 */
export function isNewestFirst(rows: readonly WalletTransactionDraft[]): boolean {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last || rows.length < 2) return false;
  if (first.txnDate !== last.txnDate) return first.txnDate > last.txnDate;
  return continuousPairs([...rows].reverse()) > continuousPairs(rows);
}

/**
 * Rows oldest first. The whole file is reversed when it is newest first; rows are never sorted,
 * so the order within a day stays the file's.
 */
export function orderChronologically(
  rows: readonly WalletTransactionDraft[],
  order: StatementOrder,
): WalletTransactionDraft[] {
  switch (order) {
    case "asc":
      return [...rows];
    case "desc":
      return [...rows].reverse();
    case "auto":
      return isNewestFirst(rows) ? [...rows].reverse() : [...rows];
  }
}
