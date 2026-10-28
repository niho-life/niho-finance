import type { BalanceTransactionSource, StripeBalanceTransaction } from "./types";

/** Page size of `balance_transactions.list` (the API maximum). */
export const BALANCE_TRANSACTION_PAGE_LIMIT = 100;

export interface SyncCursor {
  created: number;
  id: string;
}

/**
 * Reads every balance transaction created at or after `createdGte` (all of them when omitted),
 * following `starting_after` until `has_more` is false (12-imports §4.2). The transactions come
 * newest first, as listed; `newest` is the one with the latest `created` (the first listed on a
 * tie), the next sync cursor.
 */
export async function fetchBalanceTransactions(
  source: BalanceTransactionSource,
  params: { createdGte?: number },
): Promise<{ transactions: StripeBalanceTransaction[]; newest: SyncCursor | null }> {
  const transactions: StripeBalanceTransaction[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await source.list({
      limit: BALANCE_TRANSACTION_PAGE_LIMIT,
      ...(params.createdGte === undefined ? {} : { createdGte: params.createdGte }),
      ...(startingAfter === undefined ? {} : { startingAfter }),
    });
    transactions.push(...page.data);
    const last = page.data[page.data.length - 1];
    if (!page.hasMore || last === undefined) break;
    if (last.id === startingAfter) {
      throw new Error(`balance_transactions.list returned the same page after ${last.id}`);
    }
    startingAfter = last.id;
  }

  let newest: SyncCursor | null = null;
  for (const { created, id } of transactions) {
    if (newest === null || created > newest.created) newest = { created, id };
  }
  return { transactions, newest };
}

/** `StripeAccountLink.syncCursor` (`{"created":<unix>,"id":"txn_…"}`) → the cursor, or `null`. */
export function parseSyncCursor(text: string | null): SyncCursor | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { created, id } = value as { created?: unknown; id?: unknown };
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0) return null;
  if (typeof id !== "string" || id === "") return null;
  return { created, id };
}
