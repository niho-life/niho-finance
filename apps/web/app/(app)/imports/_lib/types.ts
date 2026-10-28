import type {
  CsvEncoding,
  CsvFormatKey,
  GenericCsvConfig,
  RowFailure,
} from "@niho-finance/importers";
import type { CalendarDate, WalletKind } from "@niho-finance/ledger";

/*
 * What the import screens hand to client components (types only: client components may import
 * this file). Money crosses as decimal strings and timestamps as ISO strings; the server keeps
 * `bigint` and `Date`.
 */

/** A bank / card / other wallet in the CSV screen's select. */
export interface CsvWalletOption {
  id: string;
  name: string;
  kind: WalletKind;
  kindLabel: string;
  /** The saved format (`null` = 自動判別). */
  importer: CsvFormatKey | null;
  /** The saved column mapping of 汎用. */
  config: GenericCsvConfig | null;
}

/** A CSV format as a select offers it (`CSV_FORMATS`, in their order). */
export interface CsvFormatOption {
  key: CsvFormatKey;
  label: string;
  walletKinds: readonly WalletKind[];
}

export interface PreviewRowView {
  externalId: string;
  txnDate: CalendarDate;
  /** Signed yen as a decimal string. */
  amount: string;
  descriptionRaw: string;
  counterpartyRaw: string | null;
  balanceAfter: string | null;
  /** Already in the wallet: the import counts it as a duplicate. */
  duplicate: boolean;
}

/** `CsvImportPreview` for the client (12-imports §1.2). */
export interface CsvPreviewView {
  walletId: string;
  fileName: string;
  byteSize: number;
  encoding: CsvEncoding;
  format: CsvFormatKey | null;
  detectedFormat: CsvFormatKey | null;
  config: GenericCsvConfig | null;
  /** The first 20 rows of the file as cells. */
  table: string[][];
  columnCount: number;
  rows: PreviewRowView[];
  rowCount: number;
  duplicateCount: number;
  failures: RowFailure[];
  warnings: string[];
  period: { from: CalendarDate; to: CalendarDate } | null;
  openingBalance: string | null;
  closingBalance: string | null;
  alreadyImported: { batchId: string; executedAt: string } | null;
}

export interface CsvImported {
  batchId: string;
}

/** The outcome of 同期. A sync that failed is `ok: true` with `error` (it is recorded as a batch). */
export interface StripeSyncView {
  batchId: string | null;
  importedCount: number;
  duplicateCount: number;
  failedCount: number;
  error: string | null;
}
