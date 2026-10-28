import type { CalendarDate, Money } from "@niho-finance/ledger";
import type { WalletTransactionDraft } from "../../src/types";

/** A minimal CSV statement line for unit tests. */
export function draft(
  txnDate: CalendarDate,
  amount: Money,
  fields: Partial<WalletTransactionDraft> = {},
): WalletTransactionDraft {
  return {
    externalId: "",
    txnDate,
    amount,
    descriptionRaw: "テスト",
    counterpartyRaw: null,
    balanceAfter: null,
    ...fields,
  };
}
