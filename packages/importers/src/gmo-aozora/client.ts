import { isCalendarDate } from "@niho-finance/ledger";
import { GmoApiError, type GmoApiErrorKind } from "./errors";
import {
  isRecord,
  isTimeout,
  oneLine,
  readJsonBody,
  send,
  stringField,
  type GmoFetch,
} from "./http";
import type {
  GmoAccount,
  GmoAozoraApi,
  GmoBalance,
  GmoTransaction,
  GmoTransactionsPage,
} from "./types";

export interface GmoAozoraApiOptions {
  /** `GmoAozoraConfig.apiBase`. */
  apiBase: string;
  /** The access token for the next call (refreshed beforehand when it is about to expire). */
  accessToken: () => Promise<string>;
  /**
   * Called once when a call answers 401: a fresh access token to call again with, or `null` to
   * give up (`unauthorized`). Without it a 401 is final (the sunabar token).
   */
  onUnauthorized?: () => Promise<string | null>;
  fetch?: GmoFetch;
}

const FAILURE_REASONS: Readonly<Record<GmoApiErrorKind, string>> = {
  unauthorized: "銀行 API がトークンを受け付けませんでした",
  rate_limited: "銀行 API の利用上限に当たりました。時間をおいて、もう一度同期してください",
  bad_request: "銀行 API が要求を受け付けませんでした",
  server: "銀行 API でエラーが起きました。時間をおいて、もう一度同期してください",
  network: "銀行 API に接続できませんでした。通信を確かめて、もう一度同期してください",
  invalid_response: "銀行 API の応答が読めませんでした",
};

function kindOfStatus(status: number): GmoApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  // A redirect (not followed) or another unexpected answer.
  return "invalid_response";
}

function invalidResponse(detail: string, status: number | null = null): GmoApiError {
  return new GmoApiError("invalid_response", `${FAILURE_REASONS.invalid_response}（${detail}）`, {
    status,
  });
}

/** A non-2xx answer → its error, with GMO's `{ errorCode, errorMessage }` when the body has them. */
function errorOf(status: number, body: unknown): GmoApiError {
  const kind = kindOfStatus(status);
  const code = isRecord(body) ? stringField(body, "errorCode") : null;
  const errorMessage = isRecord(body) ? stringField(body, "errorMessage") : null;
  const detail = [String(status), code, errorMessage === null ? null : oneLine(errorMessage, 120)]
    .filter((part): part is string => part !== null && part !== "")
    .join(" ");
  return new GmoApiError(kind, `${FAILURE_REASONS[kind]}（${detail}）`, { status, code });
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  return stringField(record, key);
}

function requiredString(record: Record<string, unknown>, key: string, what: string): string {
  const value = stringField(record, key);
  if (value === null || value === "") throw invalidResponse(`${what}の ${key} がありません`);
  return value;
}

function readAccounts(body: unknown): GmoAccount[] {
  if (!isRecord(body) || !Array.isArray(body.accounts)) {
    throw invalidResponse("口座一覧がありません");
  }
  return body.accounts.map((item: unknown): GmoAccount => {
    if (!isRecord(item)) throw invalidResponse("口座の形式が違います");
    return {
      accountId: requiredString(item, "accountId", "口座"),
      branchCode: optionalString(item, "branchCode"),
      branchName: optionalString(item, "branchName"),
      accountTypeCode: requiredString(item, "accountTypeCode", "口座"),
      accountTypeName: optionalString(item, "accountTypeName") ?? "",
      accountNumber: optionalString(item, "accountNumber"),
      primaryAccountCode: optionalString(item, "primaryAccountCode"),
      primaryAccountCodeName: optionalString(item, "primaryAccountCodeName"),
      accountName: optionalString(item, "accountName"),
      accountNameKana: optionalString(item, "accountNameKana"),
      currencyCode: requiredString(item, "currencyCode", "口座"),
      currencyName: optionalString(item, "currencyName") ?? "",
      transferLimitAmount: optionalString(item, "transferLimitAmount"),
    };
  });
}

function readBalance(body: unknown, accountId: string): GmoBalance | null {
  if (!isRecord(body) || !Array.isArray(body.balances)) throw invalidResponse("残高がありません");
  const item: unknown = body.balances.find(
    (balance: unknown) => isRecord(balance) && balance.accountId === accountId,
  );
  if (!isRecord(item)) return null;
  return {
    accountId,
    accountTypeCode: optionalString(item, "accountTypeCode") ?? "",
    accountTypeName: optionalString(item, "accountTypeName") ?? "",
    balance: optionalString(item, "balance"),
    baseDate: requiredString(item, "baseDate", "残高"),
    baseTime: optionalString(item, "baseTime") ?? "",
    withdrawableAmount: optionalString(item, "withdrawableAmount"),
    previousDayBalance: optionalString(item, "previousDayBalance"),
    previousMonthBalance: optionalString(item, "previousMonthBalance"),
    currencyCode: optionalString(item, "currencyCode") ?? "",
    currencyName: optionalString(item, "currencyName") ?? "",
  };
}

/**
 * A page of statement lines. The page itself must be well formed (`hasNext`, the lines, the
 * currency and the base date); each line is kept as the bank sent it (the stored `raw`) and read
 * by `convertGmoTransaction`, where a line that cannot be read becomes a failed row.
 */
function readTransactionsPage(body: unknown): GmoTransactionsPage {
  if (!isRecord(body)) throw invalidResponse("入出金明細がありません");
  if (typeof body.hasNext !== "boolean") throw invalidResponse("hasNext がありません");
  if (!Array.isArray(body.transactions)) throw invalidResponse("transactions がありません");
  const transactions = body.transactions.map((item: unknown): GmoTransaction => {
    if (!isRecord(item)) throw invalidResponse("明細の形式が違います");
    return item as unknown as GmoTransaction;
  });
  const baseDate = requiredString(body, "baseDate", "入出金明細");
  if (!isCalendarDate(baseDate))
    throw invalidResponse(`基準日が読めません（${oneLine(baseDate, 20)}）`);
  return {
    accountId: optionalString(body, "accountId") ?? "",
    currencyCode: requiredString(body, "currencyCode", "入出金明細"),
    currencyName: optionalString(body, "currencyName") ?? "",
    dateFrom: optionalString(body, "dateFrom") ?? "",
    dateTo: optionalString(body, "dateTo") ?? "",
    baseDate,
    baseTime: optionalString(body, "baseTime") ?? "",
    hasNext: body.hasNext,
    nextItemKey: optionalString(body, "nextItemKey"),
    count: optionalString(body, "count") ?? String(transactions.length),
    transactions,
  };
}

/**
 * The account inquiries of GMO あおぞらネット銀行's corporate API (19-bank-api §3.2, §6.2) with
 * Node's `fetch`: the token in `x-access-token`, 30 seconds per call, one retry with a fresh token
 * after a 401. Failures are `GmoApiError`s whose message never carries the token.
 */
export function createGmoAozoraApi(options: GmoAozoraApiOptions): GmoAozoraApi {
  const apiBase = options.apiBase.replace(/\/+$/, "");

  async function call(url: string, token: string): Promise<Response> {
    try {
      return await send(options.fetch, url, {
        method: "GET",
        headers: { Accept: "application/json", "x-access-token": token },
      });
    } catch (error) {
      throw new GmoApiError(
        "network",
        isTimeout(error)
          ? "銀行 API が応答しませんでした（30 秒）。時間をおいて、もう一度同期してください"
          : FAILURE_REASONS.network,
        { cause: error },
      );
    }
  }

  async function get(path: string, query: Record<string, string>): Promise<unknown> {
    const search = new URLSearchParams(query).toString();
    const url = `${apiBase}${path}${search === "" ? "" : `?${search}`}`;
    let response = await call(url, await options.accessToken());
    if (response.status === 401 && options.onUnauthorized) {
      await readJsonBody(response);
      const fresh = await options.onUnauthorized();
      if (fresh !== null) response = await call(url, fresh);
    }
    const body = await readJsonBody(response);
    if (!response.ok) throw errorOf(response.status, body);
    if (body === undefined) throw invalidResponse("JSON ではありません", response.status);
    return body;
  }

  return {
    async listAccounts() {
      return readAccounts(await get("/accounts", {}));
    },
    async getBalance(accountId) {
      return readBalance(await get("/accounts/balances", { accountId }), accountId);
    },
    async listTransactions({ accountId, dateFrom, dateTo, nextItemKey }) {
      return readTransactionsPage(
        await get("/accounts/transactions", {
          accountId,
          dateFrom,
          dateTo,
          ...(nextItemKey === undefined ? {} : { nextItemKey }),
        }),
      );
    },
  };
}
