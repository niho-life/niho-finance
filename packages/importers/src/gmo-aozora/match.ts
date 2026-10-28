import type { CalendarDate, Money } from "@niho-finance/ledger";
import type { WalletTransactionDraft } from "../types";

const DIGITS = /^\d+$/;

/** `itemKey` order: numerically for keys of digits (µs timestamps), else as text. */
function compareItemKeys(a: string, b: string): number {
  if (DIGITS.test(a) && DIGITS.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function dayAmount(txnDate: CalendarDate, amount: Money): string {
  return `${txnDate}|${amount}`;
}

/**
 * Ties API lines to the wallet's lines from elsewhere (19-bank-api §3.3): for each (date, amount),
 * with `c` existing lines that did not come from the API, the first `min(c, n)` of the `n` API
 * lines in `itemKey` order are the same transactions (`matched`, not imported); the rest are new
 * (`insert`, in the order of `drafts`). `drafts` are the lines no stored `itemKey` matched;
 * counted afresh on every sync, the answer is the same each time without storing the ties.
 */
export function matchExistingLines(
  drafts: readonly WalletTransactionDraft[],
  existing: readonly { txnDate: CalendarDate; amount: Money }[],
): { insert: WalletTransactionDraft[]; matched: WalletTransactionDraft[] } {
  const remaining = new Map<string, number>();
  for (const line of existing) {
    const key = dayAmount(line.txnDate, line.amount);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const matched: WalletTransactionDraft[] = [];
  const tied = new Set<WalletTransactionDraft>();
  const byItemKey = [...drafts].sort((a, b) => compareItemKeys(a.externalId, b.externalId));
  for (const draft of byItemKey) {
    const key = dayAmount(draft.txnDate, draft.amount);
    const count = remaining.get(key) ?? 0;
    if (count === 0) continue;
    remaining.set(key, count - 1);
    matched.push(draft);
    tied.add(draft);
  }
  return { insert: drafts.filter((draft) => !tied.has(draft)), matched };
}
