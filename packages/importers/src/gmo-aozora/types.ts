/**
 * The part of GMO あおぞらネット銀行's corporate API (account inquiries) the books use (19-bank-api
 * §3, §6.2). Numbers come as strings (the API's own convention); amounts and balances are read as
 * integer yen (`bigint`) by the converter, never as floating point.
 */

export const GMO_AOZORA_ENVIRONMENTS = ["sunabar", "stg", "prod"] as const;
export type GmoAozoraEnvironment = (typeof GMO_AOZORA_ENVIRONMENTS)[number];

/** Owner-facing names of the environments (接続ページの「環境」). */
export const GMO_AOZORA_ENVIRONMENT_LABELS: Readonly<Record<GmoAozoraEnvironment, string>> = {
  sunabar: "sunabar",
  stg: "検証",
  prod: "本番",
};

/** One account of `GET /accounts`. */
export interface GmoAccount {
  /** 12–29 characters: branch, type and number of the account. Never shown on a screen. */
  accountId: string;
  branchCode?: string | null;
  branchName?: string | null;
  /** `01` 普通（有利息）, `02` 普通（決済用）, `11` 定期, … */
  accountTypeCode: string;
  accountTypeName: string;
  /** 7 digits. */
  accountNumber?: string | null;
  primaryAccountCode?: string | null;
  primaryAccountCodeName?: string | null;
  accountName?: string | null;
  accountNameKana?: string | null;
  currencyCode: string;
  currencyName: string;
  transferLimitAmount?: string | null;
}

/** One account of `GET /accounts/balances`. */
export interface GmoBalance {
  accountId: string;
  accountTypeCode: string;
  accountTypeName: string;
  /** Integer string; absent when the bank does not answer it. */
  balance?: string | null;
  /** `YYYY-MM-DD`. */
  baseDate: string;
  baseTime: string;
  withdrawableAmount?: string | null;
  previousDayBalance?: string | null;
  previousMonthBalance?: string | null;
  currencyCode: string;
  currencyName: string;
}

/** One line of `GET /accounts/transactions` (the stored `raw`). */
export interface GmoTransaction {
  /** `YYYY-MM-DD`. */
  transactionDate: string;
  /** 起算日, `YYYY-MM-DD`. */
  valueDate: string;
  /** `1` 入金, `2` 出金. */
  transactionType: string;
  /** Integer string, a minus sign included for corrections. */
  amount: string;
  /** 摘要 (up to 255 characters), the remitter's name included. */
  remarks?: string | null;
  /** 取引後残高 (integer string). */
  balance: string;
  /** The line's key within the account: a timestamp in µs, up to 24 digits. */
  itemKey?: string | null;
  transferRequestInfo?: unknown;
}

/** One page (up to 500 lines, oldest first) of `GET /accounts/transactions`. */
export interface GmoTransactionsPage {
  accountId: string;
  currencyCode: string;
  currencyName: string;
  dateFrom: string;
  dateTo: string;
  /** The date the bank answered for (`YYYY-MM-DD`; usually today). */
  baseDate: string;
  baseTime: string;
  hasNext: boolean;
  nextItemKey?: string | null;
  count: string;
  transactions: GmoTransaction[];
}

/** The bank's account inquiries: the API, or a fake in tests. */
export interface GmoAozoraApi {
  listAccounts(): Promise<GmoAccount[]>;
  /** The balance of `accountId`, or `null` when the answer does not list it. */
  getBalance(accountId: string): Promise<GmoBalance | null>;
  listTransactions(params: {
    accountId: string;
    dateFrom: string;
    dateTo: string;
    nextItemKey?: string;
  }): Promise<GmoTransactionsPage>;
}
