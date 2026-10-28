import type {
  BalanceTransactionPage,
  BalanceTransactionSource,
  StripeBalanceTransaction,
} from "@niho-finance/importers";

export type ListParams = Parameters<BalanceTransactionSource["list"]>[0];

/**
 * `balance_transactions.list` over fictional transactions: newest first (ties by ID, descending),
 * honouring `created[gte]`, `starting_after` and `limit`, with pages of at most `pageSize` so that
 * the sync has to follow `has_more`.
 */
export class FakeBalanceTransactionSource implements BalanceTransactionSource {
  readonly calls: ListParams[] = [];
  private readonly transactions: StripeBalanceTransaction[];
  private readonly pageSize: number;

  constructor(transactions: readonly StripeBalanceTransaction[], pageSize = 2) {
    this.transactions = [...transactions].sort(
      (a, b) => b.created - a.created || b.id.localeCompare(a.id),
    );
    this.pageSize = pageSize;
  }

  list(params: ListParams): Promise<BalanceTransactionPage> {
    this.calls.push(params);
    const { createdGte, startingAfter, limit } = params;
    const candidates = this.transactions.filter(
      (bt) => createdGte === undefined || bt.created >= createdGte,
    );
    let start = 0;
    if (startingAfter !== undefined) {
      const index = candidates.findIndex((bt) => bt.id === startingAfter);
      if (index < 0) {
        return Promise.reject(new Error(`No such balance transaction: ${startingAfter}`));
      }
      start = index + 1;
    }
    const end = start + Math.min(limit, this.pageSize);
    return Promise.resolve({
      data: candidates.slice(start, end),
      hasMore: end < candidates.length,
    });
  }
}

/** A source whose every call fails, like the API with a bad key. */
export function failingSource(error: Error): BalanceTransactionSource {
  return { list: () => Promise.reject(error) };
}

/** Unix seconds of a JST wall-clock time, e.g. `jst("2026-11-10T10:00")`. */
export function jst(dateTime: string): number {
  return Date.parse(`${dateTime}:00+09:00`) / 1000;
}

/** A fictional JPY balance transaction; `net` follows from `amount` and `fee`. */
export function balanceTransaction(
  fields: Pick<StripeBalanceTransaction, "id" | "amount" | "created"> &
    Partial<StripeBalanceTransaction>,
): StripeBalanceTransaction {
  return {
    object: "balance_transaction",
    fee: 0,
    net: fields.amount - (fields.fee ?? 0),
    currency: "jpy",
    available_on: fields.created,
    reporting_category: "charge",
    type: "charge",
    description: null,
    status: "available",
    source: null,
    fee_details: [],
    ...fields,
  };
}
