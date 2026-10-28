import Stripe from "stripe";
import { sourceIdOf } from "./convert";
import type { BalanceTransactionSource, StripeBalanceTransaction } from "./types";

/**
 * Balance transactions from the Stripe API with the official SDK (12-imports §4.1). The key is a
 * read-only restricted key; `stripeAccount` reads a connected account with the platform's key
 * (the `Stripe-Account` header). The only module that imports the SDK.
 */
export function createStripeBalanceTransactionSource(options: {
  apiKey: string;
  stripeAccount?: string | null;
}): BalanceTransactionSource {
  const stripe = new Stripe(options.apiKey, {
    maxNetworkRetries: 2,
    ...(options.stripeAccount ? { stripeAccount: options.stripeAccount } : {}),
  });
  return {
    async list({ createdGte, startingAfter, limit }) {
      const page = await stripe.balanceTransactions.list({
        limit,
        ...(createdGte === undefined ? {} : { created: { gte: createdGte } }),
        ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
      });
      return { data: page.data.map(toBalanceTransaction), hasMore: page.has_more };
    },
  };
}

/** The SDK object as listed, with `source` reduced to its ID (the stored `raw`). */
function toBalanceTransaction(bt: Stripe.BalanceTransaction): StripeBalanceTransaction {
  return { ...bt, source: sourceIdOf(bt.source) };
}
