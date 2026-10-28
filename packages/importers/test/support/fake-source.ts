import type {
  BalanceTransactionPage,
  BalanceTransactionSource,
  StripeBalanceTransaction,
} from "../../src/stripe/types";

export type ListParams = Parameters<BalanceTransactionSource["list"]>[0];

/**
 * `balance_transactions.list` over a fixture: newest first (ties by ID, descending), honouring
 * `created[gte]` and `starting_after`, with pages of at most `pageSize` to force paging.
 */
export class FakeBalanceTransactionSource implements BalanceTransactionSource {
  readonly calls: ListParams[] = [];
  private readonly transactions: StripeBalanceTransaction[];

  constructor(
    transactions: readonly StripeBalanceTransaction[],
    private readonly pageSize: number,
  ) {
    this.transactions = [...transactions].sort(
      (a, b) => b.created - a.created || b.id.localeCompare(a.id),
    );
  }

  list(params: ListParams): Promise<BalanceTransactionPage> {
    this.calls.push(params);
    const { createdGte, startingAfter } = params;
    const candidates = this.transactions.filter(
      (bt) => createdGte === undefined || bt.created >= createdGte,
    );
    let start = 0;
    if (startingAfter !== undefined) {
      const index = candidates.findIndex((bt) => bt.id === startingAfter);
      if (index < 0) return Promise.reject(new Error(`no such transaction: ${startingAfter}`));
      start = index + 1;
    }
    const end = start + Math.min(params.limit, this.pageSize);
    return Promise.resolve({
      data: candidates.slice(start, end),
      hasMore: end < candidates.length,
    });
  }
}
