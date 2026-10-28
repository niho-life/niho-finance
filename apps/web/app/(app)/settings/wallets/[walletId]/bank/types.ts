/*
 * What 銀行 API の接続 hands to its client components (types only: client components may import
 * this file). The bank's account ID crosses only as the radio's value; it is never shown.
 */

/** An account of 口座の選択: 「支店名 科目名 ••••末尾 4 桁」. */
export interface BankAccountOption {
  accountId: string;
  label: string;
  /** The wallet it is already connected to (the radio is disabled). */
  linkedWalletName: string | null;
}

/**
 * The outcome of 今すぐ同期 or of the first sync after 「この口座を接続する」. A sync that failed
 * is `ok: true` with `error` (it is recorded as a batch).
 */
export interface BankSyncView {
  batchId: string | null;
  importedCount: number;
  duplicateCount: number;
  failedCount: number;
  warnings: string[];
  error: string | null;
}

/** After the token was checked: 口座の選択 (`authorized`), or reconnected (`connected`). */
export interface BankAuthorizedView {
  status: "authorized" | "connected";
}
