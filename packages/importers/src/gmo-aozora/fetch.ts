import { GmoApiError } from "./errors";
import type { GmoAozoraApi, GmoTransaction } from "./types";

/** More pages than this (500 lines each) is taken as a loop, not as a statement. */
export const MAX_TRANSACTION_PAGES = 200;

function pagingError(detail: string): GmoApiError {
  return new GmoApiError("invalid_response", `銀行 API の応答が読めませんでした（${detail}）`);
}

function dateOf(transaction: GmoTransaction): string {
  return typeof transaction.transactionDate === "string" ? transaction.transactionDate : "";
}

/**
 * Every statement line of `dateFrom`..`dateTo` (19-bank-api §3.2): follows `nextItemKey` while
 * `hasNext`. The same `nextItemKey` twice, a page without one, or more than 200 pages fails with
 * `invalid_response`. Lines come oldest first; should the dates go backwards they are sorted by
 * date, stably. `currencyCode` and `baseDate` are those of the first page.
 */
export async function fetchAllTransactions(
  api: GmoAozoraApi,
  params: { accountId: string; dateFrom: string; dateTo: string },
): Promise<{ transactions: GmoTransaction[]; currencyCode: string; baseDate: string }> {
  const transactions: GmoTransaction[] = [];
  const seenKeys = new Set<string>();
  let nextItemKey: string | undefined;
  let first: { currencyCode: string; baseDate: string } | null = null;
  for (let pages = 1; ; pages += 1) {
    if (pages > MAX_TRANSACTION_PAGES) {
      throw pagingError(`明細が ${MAX_TRANSACTION_PAGES} ページを超えました`);
    }
    const page = await api.listTransactions({
      accountId: params.accountId,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      ...(nextItemKey === undefined ? {} : { nextItemKey }),
    });
    first ??= { currencyCode: page.currencyCode, baseDate: page.baseDate };
    transactions.push(...page.transactions);
    if (!page.hasNext) break;
    const key = page.nextItemKey;
    if (key === null || key === undefined || key === "") {
      throw pagingError("次のページの明細キーがありません");
    }
    if (seenKeys.has(key)) throw pagingError("同じページが繰り返されました");
    seenKeys.add(key);
    nextItemKey = key;
  }
  // The loop reads at least one page; this only tells the compiler.
  if (first === null) throw pagingError("入出金明細がありません");
  // Array.prototype.sort is stable: lines of one date keep the bank's order.
  const sorted = [...transactions].sort((a, b) => {
    const left = dateOf(a);
    const right = dateOf(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { transactions: sorted, currencyCode: first.currencyCode, baseDate: first.baseDate };
}
