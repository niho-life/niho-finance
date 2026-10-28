import type {
  GmoAccount,
  GmoAozoraApi,
  GmoAozoraConfig,
  GmoBalance,
  GmoFetch,
  GmoTransaction,
  GmoTransactionsPage,
} from "@niho-finance/importers";
import { addDays, type CalendarDate } from "@niho-finance/ledger";

export type ListParams = Parameters<GmoAozoraApi["listTransactions"]>[0];

/** A fictional account ID (branch 301, number 9999999): never a real account. */
export const ACCOUNT_ID = "301019999999";

/** Fictional accounts: a yen ordinary deposit account and a time deposit. */
export const FICTIONAL_ACCOUNTS: GmoAccount[] = [
  {
    accountId: ACCOUNT_ID,
    branchCode: "301",
    branchName: "架空第一支店",
    accountTypeCode: "01",
    accountTypeName: "普通預金（有利息）",
    accountNumber: "9999999",
    accountName: "テスト商事（カ",
    currencyCode: "JPY",
    currencyName: "日本円",
  },
  {
    accountId: "301119999998",
    branchCode: "301",
    branchName: "架空第一支店",
    accountTypeCode: "11",
    accountTypeName: "定期預金",
    accountNumber: "9999998",
    currencyCode: "JPY",
    currencyName: "日本円",
  },
];

export const ACCOUNT_LABEL = "架空第一支店 普通預金（有利息） ••••9999";

/** A fictional line of the 入出金明細 API (`amount` is unsigned; `type` 1 入金 / 2 出金). */
export function bankLine(
  itemKey: string | undefined,
  transactionDate: CalendarDate,
  signedAmount: bigint,
  balance: bigint,
  remarks = "ﾃｽﾄ",
): GmoTransaction {
  return {
    transactionDate,
    valueDate: transactionDate,
    transactionType: signedAmount < 0n ? "2" : "1",
    amount: (signedAmount < 0n ? -signedAmount : signedAmount).toString(),
    remarks,
    balance: balance.toString(),
    ...(itemKey === undefined ? {} : { itemKey }),
  };
}

/**
 * 30 days of fictional lines (2026-11-01 … 11-30, one a day): deposits on even days, withdrawals
 * on odd days, balances following on from ¥1,000,000.
 */
export function thirtyDays(): GmoTransaction[] {
  const lines: GmoTransaction[] = [];
  let balance = 1_000_000n;
  let date: CalendarDate = "2026-11-01";
  for (let day = 1; day <= 30; day += 1) {
    const amount = day % 2 === 0 ? BigInt(day * 1_000) : -BigInt(day * 100);
    balance += amount;
    const itemKey = `202611${String(day).padStart(2, "0")}0900000000001`;
    lines.push(bankLine(itemKey, date, amount, balance));
    date = addDays(date, 1);
  }
  return lines;
}

/**
 * The account API over fictional lines: `dateFrom`..`dateTo`, oldest first (by date, then
 * item key), pages of `pageSize` followed by `nextItemKey`. `baseDate` is `dateTo` unless set.
 */
export class FakeBankApi implements GmoAozoraApi {
  readonly calls: ListParams[] = [];
  balanceCalls = 0;
  transactions: GmoTransaction[];
  accounts: GmoAccount[];
  balance: GmoBalance | null;
  /** Thrown by `listTransactions` (a refused token, a rate limit, …). */
  failWith: Error | null = null;
  /** Thrown by `getBalance`. */
  balanceFailsWith: Error | null = null;
  currencyCode = "JPY";
  baseDate: string | null = null;

  constructor(
    options: {
      transactions?: GmoTransaction[];
      accounts?: GmoAccount[];
      balance?: bigint | null;
      balanceDate?: CalendarDate;
    } = {},
    private readonly pageSize = 20,
  ) {
    this.transactions = options.transactions ?? [];
    this.accounts = options.accounts ?? FICTIONAL_ACCOUNTS;
    this.balance =
      options.balance === null || options.balance === undefined
        ? null
        : balanceOf(options.balance, options.balanceDate ?? "2026-11-30");
  }

  listAccounts(): Promise<GmoAccount[]> {
    return Promise.resolve(this.accounts.map((account) => ({ ...account })));
  }

  getBalance(accountId: string): Promise<GmoBalance | null> {
    this.balanceCalls += 1;
    if (this.balanceFailsWith) return Promise.reject(this.balanceFailsWith);
    return Promise.resolve(this.balance ? { ...this.balance, accountId } : null);
  }

  listTransactions(params: ListParams): Promise<GmoTransactionsPage> {
    this.calls.push(params);
    if (this.failWith) return Promise.reject(this.failWith);
    const inRange = this.transactions
      .filter((t) => t.transactionDate >= params.dateFrom && t.transactionDate <= params.dateTo)
      .sort(
        (a, b) =>
          a.transactionDate.localeCompare(b.transactionDate) ||
          (a.itemKey ?? "").localeCompare(b.itemKey ?? ""),
      );
    const start =
      params.nextItemKey === undefined
        ? 0
        : inRange.findIndex((t) => t.itemKey === params.nextItemKey);
    if (start < 0) return Promise.reject(new Error(`no such item: ${params.nextItemKey}`));
    const end = start + this.pageSize;
    const next = inRange[end];
    return Promise.resolve({
      accountId: params.accountId,
      currencyCode: this.currencyCode,
      currencyName: "日本円",
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      baseDate: this.baseDate ?? params.dateTo,
      baseTime: "10:00:00+09:00",
      hasNext: next !== undefined,
      nextItemKey: next?.itemKey ?? null,
      count: String(inRange.length),
      transactions: inRange.slice(start, end).map((t) => ({ ...t })),
    });
  }
}

export function balanceOf(balance: bigint, baseDate: CalendarDate): GmoBalance {
  return {
    accountId: ACCOUNT_ID,
    accountTypeCode: "01",
    accountTypeName: "普通預金（有利息）",
    balance: balance.toString(),
    baseDate,
    baseTime: "10:00:00+09:00",
    currencyCode: "JPY",
    currencyName: "日本円",
  };
}

/** The sunabar token method, with a fictional token. */
export const TOKEN_CONFIG: GmoAozoraConfig = {
  env: "sunabar",
  mode: "token",
  apiBase: "https://api.sunabar.gmo-aozora.com/corporation/v1",
  auth: null,
  accessToken: "fake-sunabar-token",
};

/** The authorization code flow of the 検証 environment, with a fictional client. */
export const OAUTH_CONFIG: GmoAozoraConfig = {
  env: "stg",
  mode: "oauth",
  apiBase: "https://stg-api.gmo-aozora.com/ganb/api/corporation/v1",
  auth: {
    authBase: "https://stg-api.gmo-aozora.com/ganb/api/auth/v1",
    issuer: "https://stg-api.gmo-aozora.com",
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    clientAuth: "basic",
    redirectUri: "https://finance.example.test/api/bank/gmo-aozora/callback",
  },
  accessToken: null,
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface BankRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  token: string | null;
  body: Record<string, string>;
}

/**
 * A `fetch` that serves the token endpoint and the account API of `OAUTH_CONFIG` / `TOKEN_CONFIG`
 * from `handle`, recording each request (path relative to the API or authorization base).
 */
export function bankFetch(handle: (request: BankRequest) => Response | Promise<Response>): {
  fetch: GmoFetch;
  requests: BankRequest[];
} {
  const requests: BankRequest[] = [];
  const bases = [
    OAUTH_CONFIG.apiBase,
    OAUTH_CONFIG.auth?.authBase ?? "",
    TOKEN_CONFIG.apiBase,
  ].filter((base) => base !== "");
  const fetch: GmoFetch = async (url, init) => {
    const parsed = new URL(url);
    const base = bases.find((item) => url.startsWith(item)) ?? parsed.origin;
    const headers = new Headers(init.headers);
    const request: BankRequest = {
      method: init.method ?? "GET",
      path: `${parsed.origin}${parsed.pathname}`.slice(base.length),
      query: Object.fromEntries(parsed.searchParams),
      token: headers.get("x-access-token"),
      body: typeof init.body === "string" ? Object.fromEntries(new URLSearchParams(init.body)) : {},
    };
    requests.push(request);
    return handle(request);
  };
  return { fetch, requests };
}
