import { describe, expect, it, vi } from "vitest";
import { checkBalanceContinuity } from "../src/csv/balance";
import { isYenOrdinaryAccount, maskAccountLabel } from "../src/gmo-aozora/accounts";
import { createGmoAozoraApi } from "../src/gmo-aozora/client";
import { GMO_AOZORA_ENV_VARIABLES, resolveGmoAozoraConfig } from "../src/gmo-aozora/config";
import { convertGmoTransaction, GMO_TRANSACTION_TYPE_LABELS } from "../src/gmo-aozora/convert";
import { GmoApiError } from "../src/gmo-aozora/errors";
import { fetchAllTransactions, MAX_TRANSACTION_PAGES } from "../src/gmo-aozora/fetch";
import { matchExistingLines } from "../src/gmo-aozora/match";
import type {
  GmoAccount,
  GmoAozoraApi,
  GmoTransaction,
  GmoTransactionsPage,
} from "../src/gmo-aozora/types";
import { draft } from "./support/drafts";
import { fakeFetch, FakeGmoApi, gmoFixture, jsonResponse } from "./support/gmo";

const V = GMO_AOZORA_ENV_VARIABLES;
const API_BASE = "https://api.sunabar.gmo-aozora.com/corporation/v1";
const ACCOUNT_ID = "301019999999";
/** A fictional token: never a real one. */
const TOKEN = "fake-sunabar-token";

const page1 = gmoFixture<GmoTransactionsPage>("transactions-1");
const page2 = gmoFixture<GmoTransactionsPage>("transactions-2");
const accounts = gmoFixture<{ accounts: GmoAccount[] }>("accounts").accounts;
const allTransactions = [...page1.transactions, ...page2.transactions];

/** `rejects` with the error itself, to look at its fields. */
async function failureOf(promise: Promise<unknown>): Promise<GmoApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GmoApiError) return error;
    throw error;
  }
  throw new Error("expected a GmoApiError");
}

describe("resolveGmoAozoraConfig (19-bank-api §2.1, §5)", () => {
  const oauthEnv = {
    [V.env]: "stg",
    [V.clientId]: "fake-client-id",
    [V.clientSecret]: "fake-client-secret",
    [V.redirectUri]: "https://finance.example.test/api/bank/gmo-aozora/callback",
  };

  it("is unset without an environment, or without a token and a client", () => {
    expect(resolveGmoAozoraConfig({})).toEqual({
      ok: false,
      reason: "unset",
      message: "銀行 API が設定されていません",
      variables: [V.env],
    });
    expect(resolveGmoAozoraConfig({ [V.env]: "  ", [V.accessToken]: TOKEN })).toMatchObject({
      ok: false,
      reason: "unset",
    });
    expect(resolveGmoAozoraConfig({ [V.env]: "sunabar" })).toMatchObject({
      ok: false,
      reason: "unset",
      variables: [V.accessToken, V.clientId],
    });
  });

  it("uses the sunabar token as it is, with the default URL", () => {
    expect(resolveGmoAozoraConfig({ [V.env]: "sunabar", [V.accessToken]: ` ${TOKEN} ` })).toEqual({
      ok: true,
      config: { env: "sunabar", mode: "token", apiBase: API_BASE, auth: null, accessToken: TOKEN },
    });
  });

  it("uses the authorization code flow when a client ID is set, with the environment's URLs", () => {
    expect(resolveGmoAozoraConfig({ ...oauthEnv, [V.accessToken]: TOKEN })).toEqual({
      ok: true,
      config: {
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
      },
    });
    const prod = resolveGmoAozoraConfig({ ...oauthEnv, [V.env]: "prod", [V.clientAuth]: "post" });
    expect(prod.ok && prod.config).toMatchObject({
      apiBase: "https://api.gmo-aozora.com/ganb/api/corporation/v1",
      auth: {
        authBase: "https://api.gmo-aozora.com/ganb/api/auth/v1",
        issuer: "https://api.gmo-aozora.com",
        clientAuth: "post",
      },
    });
  });

  it("names the missing or malformed variables", () => {
    expect(resolveGmoAozoraConfig({ [V.env]: "production" })).toMatchObject({
      ok: false,
      reason: "invalid",
      variables: [V.env],
    });
    expect(resolveGmoAozoraConfig({ [V.env]: "prod", [V.clientId]: "fake" })).toMatchObject({
      ok: false,
      reason: "invalid",
      message: "銀行 API の認可に要る環境変数が足りません",
      variables: [V.clientSecret, V.redirectUri],
    });
    // sunabar has no default authorization server: it is given by URL.
    expect(resolveGmoAozoraConfig({ ...oauthEnv, [V.env]: "sunabar" })).toMatchObject({
      ok: false,
      variables: [V.authBase],
    });
    expect(resolveGmoAozoraConfig({ ...oauthEnv, [V.clientAuth]: "jwt" })).toMatchObject({
      ok: false,
      variables: [V.clientAuth],
    });
    expect(
      resolveGmoAozoraConfig({ ...oauthEnv, [V.redirectUri]: "http://finance.example.test/cb" }),
    ).toMatchObject({ ok: false, variables: [V.redirectUri] });
  });

  it("takes overriding URLs only on gmo-aozora.com over https, and localhost outside production", () => {
    const withApiBase = (apiBase: string, allowLocalhost = false) =>
      resolveGmoAozoraConfig(
        { [V.env]: "sunabar", [V.accessToken]: TOKEN, [V.apiBase]: apiBase },
        { allowLocalhost },
      );
    expect(withApiBase("https://api.sunabar.gmo-aozora.com/corporation/v1/")).toMatchObject({
      ok: true,
      config: { apiBase: API_BASE },
    });
    for (const refused of [
      "http://api.sunabar.gmo-aozora.com/corporation/v1",
      "https://example.com/corporation/v1",
      "https://notgmo-aozora.com/v1",
      "https://gmo-aozora.com.example.com/v1",
      "https://user:pass@api.gmo-aozora.com/v1",
      "http://localhost:4010",
      "not a url",
    ]) {
      expect(withApiBase(refused), refused).toMatchObject({
        ok: false,
        reason: "invalid",
        variables: [V.apiBase],
      });
    }
    expect(withApiBase("http://localhost:4010/v1", true)).toMatchObject({
      ok: true,
      config: { apiBase: "http://localhost:4010/v1" },
    });
    expect(withApiBase("http://127.0.0.1:4010", true)).toMatchObject({ ok: true });

    // sunabar's 認可利用: the given authorization server, which issues tokens as its origin.
    expect(
      resolveGmoAozoraConfig({
        ...oauthEnv,
        [V.env]: "sunabar",
        [V.authBase]: "https://portal.sunabar.gmo-aozora.com/auth/v1/",
      }),
    ).toMatchObject({
      ok: true,
      config: {
        apiBase: API_BASE,
        auth: {
          authBase: "https://portal.sunabar.gmo-aozora.com/auth/v1",
          issuer: "https://portal.sunabar.gmo-aozora.com",
        },
      },
    });
  });
});

describe("createGmoAozoraApi (19-bank-api §3.2, §2.3)", () => {
  function api(
    answer: Parameters<typeof fakeFetch>[0],
    onUnauthorized?: () => Promise<string | null>,
  ) {
    const fake = fakeFetch(answer);
    return {
      api: createGmoAozoraApi({
        apiBase: `${API_BASE}/`,
        accessToken: () => Promise.resolve(TOKEN),
        fetch: fake.fetch,
        ...(onUnauthorized ? { onUnauthorized } : {}),
      }),
      requests: fake.requests,
    };
  }

  it("lists the accounts with the token in x-access-token", async () => {
    const { api: client, requests } = api(() => jsonResponse(200, gmoFixture("accounts")));
    const listed = await client.listAccounts();
    expect(listed.map((account) => [account.accountId, account.accountTypeCode])).toEqual([
      ["301019999999", "01"],
      ["301119999998", "11"],
    ]);
    expect(listed[1]?.transferLimitAmount).toBeNull();
    expect(requests).toEqual([
      {
        url: `${API_BASE}/accounts`,
        method: "GET",
        headers: { accept: "application/json", "x-access-token": TOKEN },
        body: null,
      },
    ]);
  });

  it("reads the balance of one account, or null when the answer does not list it", async () => {
    const { api: client, requests } = api(() => jsonResponse(200, gmoFixture("balances")));
    expect(await client.getBalance(ACCOUNT_ID)).toMatchObject({
      accountId: ACCOUNT_ID,
      balance: "1068855",
      baseDate: "2026-11-30",
    });
    expect(await client.getBalance("301019999990")).toBeNull();
    expect(requests[0]?.url).toBe(`${API_BASE}/accounts/balances?accountId=${ACCOUNT_ID}`);
  });

  it("asks for a page of statement lines, the next one by its key", async () => {
    const { api: client, requests } = api(() => jsonResponse(200, page1));
    const page = await client.listTransactions({
      accountId: ACCOUNT_ID,
      dateFrom: "2026-11-01",
      dateTo: "2026-11-30",
      nextItemKey: "202611150900000000006",
    });
    expect(page).toMatchObject({ hasNext: true, currencyCode: "JPY", baseDate: "2026-11-30" });
    expect(page.transactions).toEqual(page1.transactions);
    expect(requests[0]?.url).toBe(
      `${API_BASE}/accounts/transactions?accountId=${ACCOUNT_ID}&dateFrom=2026-11-01&dateTo=2026-11-30&nextItemKey=202611150900000000006`,
    );
  });

  it("calls again once with a fresh token after a 401", async () => {
    const fresh = "fake-fresh-token";
    const onUnauthorized = vi.fn(() => Promise.resolve(fresh));
    const { api: client, requests } = api(
      (request) =>
        request.headers["x-access-token"] === fresh
          ? jsonResponse(200, gmoFixture("accounts"))
          : jsonResponse(401, gmoFixture("error-401")),
      onUnauthorized,
    );
    expect(await client.listAccounts()).toHaveLength(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => request.headers["x-access-token"])).toEqual([TOKEN, fresh]);
  });

  it("gives up as unauthorized when the fresh token is refused too, or there is none", async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve("fake-fresh-token"));
    const refused = api(() => jsonResponse(401, gmoFixture("error-401")), onUnauthorized);
    const error = await failureOf(refused.api.listAccounts());
    expect(error).toMatchObject({ kind: "unauthorized", status: 401, code: "WG_ERR_101" });
    expect(error.message).toBe(
      "銀行 API がトークンを受け付けませんでした（401 WG_ERR_101 アクセストークンが無効です）",
    );
    expect(error.message).not.toContain(TOKEN);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(refused.requests).toHaveLength(2);

    const none = api(
      () => jsonResponse(401, gmoFixture("error-401")),
      () => Promise.resolve(null),
    );
    expect(await failureOf(none.api.listAccounts())).toMatchObject({ kind: "unauthorized" });
    expect(none.requests).toHaveLength(1);

    // The sunabar token has no refresh: a 401 is final.
    const fixed = api(() => jsonResponse(401, undefined));
    expect(await failureOf(fixed.api.listAccounts())).toMatchObject({
      kind: "unauthorized",
      code: null,
      message: "銀行 API がトークンを受け付けませんでした（401）",
    });
  });

  it("tells a rate limit, a refused request, a server error and a network failure apart", async () => {
    const cases: [Response | Error, Partial<GmoApiError>][] = [
      [
        jsonResponse(429, gmoFixture("error-429")),
        {
          kind: "rate_limited",
          status: 429,
          code: "WG_ERR_154",
          message:
            "銀行 API の利用上限に当たりました。時間をおいて、もう一度同期してください（429 WG_ERR_154 利用上限を超えました）",
        },
      ],
      [
        jsonResponse(400, gmoFixture("error-400")),
        {
          kind: "bad_request",
          status: 400,
          code: "WG_ERR_002",
          message:
            "銀行 API が要求を受け付けませんでした（400 WG_ERR_002 日付の指定が正しくありません）",
        },
      ],
      [jsonResponse(404, undefined), { kind: "bad_request", status: 404 }],
      [new Response("<html>busy</html>", { status: 503 }), { kind: "server", status: 503 }],
      [new Response(null, { status: 302 }), { kind: "invalid_response", status: 302 }],
      [new Response("<html>ok</html>", { status: 200 }), { kind: "invalid_response", status: 200 }],
      [jsonResponse(200, { baseDate: "2026-11-30" }), { kind: "invalid_response" }],
      [
        new TypeError("fetch failed"),
        {
          kind: "network",
          status: null,
          message: "銀行 API に接続できませんでした。通信を確かめて、もう一度同期してください",
        },
      ],
      [
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        {
          kind: "network",
          message: "銀行 API が応答しませんでした（30 秒）。時間をおいて、もう一度同期してください",
        },
      ],
    ];
    for (const [answer, expected] of cases) {
      const { api: client } = api(() => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      const error = await failureOf(client.listAccounts());
      expect(error, JSON.stringify(expected)).toMatchObject(expected);
    }
  });

  it("refuses a page of lines that is not well formed", async () => {
    for (const body of [
      { ...page1, hasNext: "true" },
      { ...page1, transactions: undefined },
      { ...page1, transactions: ["line"] },
      { ...page1, baseDate: "2026-11-31" },
      { ...page1, currencyCode: undefined },
    ]) {
      const { api: client } = api(() => jsonResponse(200, body));
      const error = await failureOf(
        client.listTransactions({
          accountId: ACCOUNT_ID,
          dateFrom: "2026-11-01",
          dateTo: "2026-11-30",
        }),
      );
      expect(error.kind).toBe("invalid_response");
    }
  });
});

describe("fetchAllTransactions (19-bank-api §3.2)", () => {
  const params = { accountId: ACCOUNT_ID, dateFrom: "2026-11-01", dateTo: "2026-11-30" };

  it("follows nextItemKey while hasNext", async () => {
    const api = new FakeGmoApi([page1, page2]);
    const fetched = await fetchAllTransactions(api, params);
    expect(fetched.currencyCode).toBe("JPY");
    expect(fetched.baseDate).toBe("2026-11-30");
    expect(fetched.transactions).toEqual(allTransactions);
    expect(api.calls).toEqual([params, { ...params, nextItemKey: "202611150900000000006" }]);
  });

  it("fails on a loop: the same key twice, a missing key, or too many pages", async () => {
    const looping = new FakeGmoApi([
      page1,
      { ...page2, hasNext: true, nextItemKey: page1.nextItemKey },
    ]);
    expect(await failureOf(fetchAllTransactions(looping, params))).toMatchObject({
      kind: "invalid_response",
      message: "銀行 API の応答が読めませんでした（同じページが繰り返されました）",
    });
    const keyless = new FakeGmoApi([{ ...page1, nextItemKey: null }]);
    expect(await failureOf(fetchAllTransactions(keyless, params))).toMatchObject({
      kind: "invalid_response",
    });

    let key = 0;
    const endless: GmoAozoraApi = {
      listAccounts: () => Promise.resolve([]),
      getBalance: () => Promise.resolve(null),
      listTransactions: () => {
        key += 1;
        return Promise.resolve({ ...page1, nextItemKey: String(key) });
      },
    };
    expect(await failureOf(fetchAllTransactions(endless, params))).toMatchObject({
      kind: "invalid_response",
      message: `銀行 API の応答が読めませんでした（明細が ${MAX_TRANSACTION_PAGES} ページを超えました）`,
    });
    expect(key).toBe(MAX_TRANSACTION_PAGES);
  });

  it("puts lines in date order when the dates go backwards, keeping each day's order", async () => {
    const [a, b, c] = page1.transactions;
    if (!a || !b || !c) throw new Error("fixture");
    const api = new FakeGmoApi([{ ...page2, transactions: [b, c, a] }]);
    const { transactions } = await fetchAllTransactions(api, params);
    expect(transactions).toEqual([a, b, c]);
  });
});

/** The golden output of the fixture's 30 days (2 pages): [itemKey, 取引日, 起算日, 金額, 摘要, 残高]. */
const EXPECTED_LINES = [
  ["202611020900000000001", "2026-11-02", "2026-11-02", 330_000n, "ﾌﾘｺﾐ ｶ)ｻﾝﾌﾟﾙｼﾖｳｼﾞ", 1_330_000n],
  ["202611051000000000002", "2026-11-05", "2026-11-05", -55_000n, "ﾌﾘｺﾐ ｶ)ﾃｽﾄﾃﾞﾝｷ", 1_275_000n],
  ["202611051000000000003", "2026-11-05", "2026-11-05", -145n, "ﾌﾘｺﾐﾃｽｳﾘﾖｳ", 1_274_855n],
  ["202611100800000000004", "2026-11-10", "2026-11-10", -20_000n, "ﾃｽﾄｻｰﾋﾞｽ ﾘﾖｳﾘﾖｳ", 1_254_855n],
  // No 摘要: the type stands in.
  ["202611121200000000005", "2026-11-12", "2026-11-12", 1_100n, "入金", 1_255_955n],
  ["202611150900000000006", "2026-11-15", "2026-11-15", -88_000n, "ｶｰﾄﾞ ﾃｽﾄｶｰﾄﾞ", 1_167_955n],
  // A correction: a negative amount under 入金 takes money out.
  ["202611200900000000007", "2026-11-20", "2026-11-12", -1_100n, "ﾃｲｾｲ", 1_166_855n],
  ["202611251000000000008", "2026-11-25", "2026-11-25", -100_000n, "ﾔﾁﾝ ｶ)ｶｸｳﾌﾄﾞｳｻﾝ", 1_066_855n],
  ["202611300100000000009", "2026-11-30", "2026-11-30", 2_000n, "ﾘｿｸ", 1_068_855n],
] as const;

describe("convertGmoTransaction (19-bank-api §3.2)", () => {
  it("turns the fixture's lines into statement lines (golden)", () => {
    const converted = allTransactions.map((t, index) => convertGmoTransaction(t, index + 1));
    expect(converted.map((result) => result.failure)).toEqual(allTransactions.map(() => null));
    const drafts = converted.map((result) => result.draft);
    expect(
      drafts.map((line) => [
        line?.externalId,
        line?.txnDate,
        line?.valueDate,
        line?.amount,
        line?.descriptionRaw,
        line?.balanceAfter,
      ]),
    ).toEqual(EXPECTED_LINES);
    drafts.forEach((line, index) => {
      expect(line).toMatchObject({ occurredAt: null, counterpartyRaw: null, category: null });
      // The line as the bank sent it, transferRequestInfo included.
      expect(line?.raw).toEqual(allTransactions[index]);
    });
    expect(drafts[0]?.raw).toMatchObject({
      transferRequestInfo: { remitterNameKana: "ｶ)ｻﾝﾌﾟﾙｼﾖｳｼﾞ" },
    });
    // The balances follow on from the balance before the 1st.
    const lines = drafts.filter((line) => line !== null);
    expect(checkBalanceContinuity(lines, 1_000_000n)).toEqual([]);
  });

  it("cites the fetched row when the balances do not follow on", () => {
    const lines = allTransactions
      .filter((t) => t.itemKey !== "202611051000000000003")
      .map((t, index) => convertGmoTransaction(t, index + 1).draft)
      .filter((line) => line !== null);
    expect(checkBalanceContinuity(lines, 1_000_000n)).toEqual([
      "3 行目で残高がつながりません（前の残高 1,275,000 + 金額 -20,000 ≠ 1,254,855）",
    ]);
  });

  it("makes a failed row of a line that cannot be read", () => {
    const base: GmoTransaction = {
      transactionDate: "2026-11-02",
      valueDate: "2026-11-02",
      transactionType: "2",
      amount: "1000",
      remarks: "ﾃｽﾄ",
      balance: "9000",
      itemKey: "202611020900000000099",
    };
    const cases: [Partial<GmoTransaction>, string, string[]][] = [
      [{ itemKey: undefined }, "明細キーがありません", ["2026-11-02", "出金", "1000", "ﾃｽﾄ"]],
      [{ itemKey: "  " }, "明細キーがありません", ["2026-11-02", "出金", "1000", "ﾃｽﾄ"]],
      [
        { transactionDate: "2026-02-30" },
        "日付が読めません",
        ["2026-02-30", "出金", "1000", "ﾃｽﾄ"],
      ],
      [{ transactionDate: "20261102" }, "日付が読めません", ["20261102", "出金", "1000", "ﾃｽﾄ"]],
      [{ valueDate: "2026/11/02" }, "起算日が読めません", ["2026-11-02", "出金", "1000", "ﾃｽﾄ"]],
      [{ transactionType: "3" }, "入払区分が読めません", ["2026-11-02", "3", "1000", "ﾃｽﾄ"]],
      [{ amount: "1000.5" }, "金額が読めません", ["2026-11-02", "出金", "1000.5", "ﾃｽﾄ"]],
      [{ amount: "1,000" }, "金額が読めません", ["2026-11-02", "出金", "1,000", "ﾃｽﾄ"]],
      [{ amount: "" }, "金額が読めません", ["2026-11-02", "出金", "", "ﾃｽﾄ"]],
      [{ balance: "9e3" }, "残高が読めません", ["2026-11-02", "出金", "1000", "ﾃｽﾄ"]],
    ];
    for (const [change, reason, raw] of cases) {
      expect(convertGmoTransaction({ ...base, ...change }, 7), reason).toEqual({
        draft: null,
        failure: { rowNumber: 7, reason, raw },
      });
    }
    // No 起算日 or balance: the line is read without them.
    expect(convertGmoTransaction({ ...base, valueDate: "", balance: "" }, 1).draft).toMatchObject({
      valueDate: null,
      balanceAfter: null,
      amount: -1000n,
    });
    expect(GMO_TRANSACTION_TYPE_LABELS).toEqual({ "1": "入金", "2": "出金" });
  });
});

describe("matchExistingLines (19-bank-api §3.3)", () => {
  const api = (itemKey: string, txnDate: `${number}-${number}-${number}`, amount: bigint) =>
    draft(txnDate, amount, { externalId: itemKey });

  it("ties the same number of same-day, same-amount lines, the smallest itemKeys first", () => {
    // CSV: one line of 2026-11-05 −55,000. API: two of them, and one of another amount.
    const first = api("202611051000000000002", "2026-11-05", -55_000n);
    const second = api("202611051000000000010", "2026-11-05", -55_000n);
    const other = api("202611051000000000003", "2026-11-05", -145n);
    const existing = [{ txnDate: "2026-11-05" as const, amount: -55_000n }];
    expect(matchExistingLines([second, other, first], existing)).toEqual({
      insert: [second, other],
      matched: [first],
    });
    // The next sync: the second is stored (found by itemKey), the first still ties to the CSV line.
    expect(matchExistingLines([first], existing)).toEqual({ insert: [], matched: [first] });
  });

  it("orders item keys as numbers and leaves lines of other days alone", () => {
    const nine = api("9", "2026-11-02", 500n);
    const ten = api("10", "2026-11-02", 500n);
    const later = api("8", "2026-11-03", 500n);
    expect(
      matchExistingLines([ten, nine, later], [{ txnDate: "2026-11-02", amount: 500n }]),
    ).toEqual({ insert: [ten, later], matched: [nine] });
    expect(matchExistingLines([ten, nine], [])).toEqual({ insert: [ten, nine], matched: [] });
    // More existing lines than API lines: every API line ties.
    const existing = [
      { txnDate: "2026-11-02" as const, amount: 500n },
      { txnDate: "2026-11-02" as const, amount: 500n },
      { txnDate: "2026-11-02" as const, amount: 500n },
    ];
    expect(matchExistingLines([ten, nine], existing)).toEqual({ insert: [], matched: [nine, ten] });
  });
});

describe("accounts (19-bank-api §1.1)", () => {
  const [ordinary, timeDeposit] = accounts;

  it("offers yen ordinary deposit accounts only", () => {
    if (!ordinary || !timeDeposit) throw new Error("fixture");
    expect(isYenOrdinaryAccount(ordinary)).toBe(true);
    expect(isYenOrdinaryAccount(timeDeposit)).toBe(false);
    expect(isYenOrdinaryAccount({ ...ordinary, accountTypeCode: "02" })).toBe(true);
    expect(isYenOrdinaryAccount({ ...ordinary, currencyCode: "USD" })).toBe(false);
  });

  it("shows the branch, the type and the last 4 digits only", () => {
    if (!ordinary) throw new Error("fixture");
    expect(maskAccountLabel(ordinary)).toBe("架空第一支店 普通預金（有利息） ••••9999");
    expect(maskAccountLabel({ ...ordinary, branchName: null, accountNumber: null })).toBe(
      "普通預金（有利息） ••••9999",
    );
    expect(maskAccountLabel({ ...ordinary, accountId: "301019999123", accountNumber: " " })).toBe(
      "架空第一支店 普通預金（有利息） ••••9123",
    );
  });
});
