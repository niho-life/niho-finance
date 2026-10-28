/**
 * @niho-finance/importers — bank / card CSV parsers and Stripe sync.
 *
 * TODO(S4): one module per CSV format with golden tests, Stripe balance transactions → statement
 * lines, and duplicate detection by (walletId, externalId). See docs/design/04-integrations.md.
 */
import type { CalendarDate, Money } from "@niho-finance/ledger";

/** Where statement lines come from (`ImportBatch.source`). */
export const IMPORT_SOURCES = ["csv", "stripe", "api"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** A parsed statement line before it is stored as a `WalletTransaction`. */
export interface WalletTransactionDraft {
  txnDate: CalendarDate;
  /** Signed: deposits into the wallet are positive. */
  amount: Money;
  descriptionRaw: string;
  counterpartyRaw?: string;
  balanceAfter?: Money;
  /** Unique within the wallet: CSV row hash or Stripe balance transaction ID. */
  externalId: string;
}

export interface ImportResult {
  source: ImportSource;
  rows: WalletTransactionDraft[];
  failed: { rowNumber: number; reason: string }[];
}
