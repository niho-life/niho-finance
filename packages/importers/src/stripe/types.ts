/**
 * The part of a Stripe balance transaction the books use (12-imports §4). `source` is reduced to
 * its ID; amounts are integers in the currency's smallest unit (yen for `jpy`).
 */
export interface StripeFeeDetail {
  amount: number;
  currency: string;
  /** `stripe_fee`, `application_fee`, `tax`, `withheld_tax`, … */
  type: string;
  description: string | null;
  application?: string | null;
}

export interface StripeBalanceTransaction {
  id: string;
  object: "balance_transaction";
  /** Gross amount. */
  amount: number;
  fee: number;
  /** `amount − fee`. */
  net: number;
  currency: string;
  /** Unix seconds. */
  created: number;
  /** Unix seconds: when the net funds become available. */
  available_on: number;
  reporting_category: string;
  type: string;
  description: string | null;
  /** `available` or `pending`. */
  status: string;
  /** ID of the object the transaction comes from (charge, refund, payout, …). */
  source: string | null;
  fee_details: StripeFeeDetail[];
}

export interface BalanceTransactionPage {
  /** Newest first, as `balance_transactions.list` returns them. */
  data: StripeBalanceTransaction[];
  hasMore: boolean;
}

/** Where balance transactions are read from: the Stripe API, or a fixture in tests. */
export interface BalanceTransactionSource {
  list(params: {
    createdGte?: number;
    startingAfter?: string;
    limit: number;
  }): Promise<BalanceTransactionPage>;
}
