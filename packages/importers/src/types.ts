import type { CalendarDate, Money, WalletKind } from "@niho-finance/ledger";

/** Where statement lines come from (`ImportBatch.source`). */
export const IMPORT_SOURCES = ["csv", "stripe", "api"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** A parsed statement line before it is stored as a `WalletTransaction` (12-imports §6.2). */
export interface WalletTransactionDraft {
  /** Unique within the wallet: CSV row hash (§3.3) or Stripe balance transaction ID (§4.3). */
  externalId: string;
  txnDate: CalendarDate;
  /** 起算日 (全銀) or `available_on` (Stripe) as a JST calendar date. */
  valueDate?: CalendarDate | null;
  /** Time of the transaction (Stripe `created`). `null` for CSV. */
  occurredAt?: Date | null;
  /** Signed: deposits into the wallet are positive. */
  amount: Money;
  descriptionRaw: string;
  counterpartyRaw?: string | null;
  balanceAfter?: Money | null;
  /** The source's own classification (Stripe `reporting_category`, 全銀 取引区分, card 支払方法). */
  category?: string | null;
  /** The original row: CSV cells or the Stripe balance transaction. A JSON-serializable value. */
  raw?: unknown;
}

/** A row that could not be read. It is kept in the result and never becomes a statement line. */
export interface RowFailure {
  /** 1-based row of the CSV table (header rows included); `0` for Stripe. */
  rowNumber: number;
  reason: string;
  raw?: string[];
}

export const CSV_FORMAT_KEYS = [
  "gmo_aozora_zengin",
  "docomo_smtb",
  "rakuten_card",
  "generic",
] as const;
export type CsvFormatKey = (typeof CSV_FORMAT_KEYS)[number];

export interface ParsedStatement {
  format: CsvFormatKey;
  /** Oldest first, with external IDs (from `parseStatement`; a format's own `parse` leaves them empty). */
  rows: WalletTransactionDraft[];
  failures: RowFailure[];
  warnings: string[];
  /** 取引前残高 of the header (全銀). */
  openingBalance: Money | null;
  /** 取引後残高 of the trailer (全銀). */
  closingBalance: Money | null;
  period: { from: CalendarDate; to: CalendarDate } | null;
}

/** Column mapping of the generic format, saved on the wallet (`Wallet.importerConfig`). */
export interface GenericCsvConfig {
  /** Rows to skip at the top of the file. The screen defaults to 1. */
  headerRows: number;
  /** 0-based column indices. */
  columns: {
    date: number;
    description: number;
    /** Signed amount (deposits positive). Exclusive with `deposit` / `withdrawal`. */
    amount?: number;
    deposit?: number;
    withdrawal?: number;
    balance?: number;
    counterparty?: number;
  };
  /** Treat a positive signed amount as money leaving the wallet (e.g. a card's 利用金額). */
  invertSign?: boolean;
  /** Row order of the file. Defaults to `auto`. */
  order?: "asc" | "desc" | "auto";
}

export interface CsvFormat {
  key: CsvFormatKey;
  label: string;
  walletKinds: readonly WalletKind[];
  /** Recognizes the format from the first rows. `generic` never matches (it is chosen). */
  detect(table: string[][]): boolean;
  /** Reads the rows in file order. External IDs, ordering and continuity are `parseStatement`'s. */
  parse(table: string[][], config: GenericCsvConfig | null): ParsedStatement;
}
