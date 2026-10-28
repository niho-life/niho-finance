import {
  GmoOAuthError,
  type GmoAozoraConfig,
  type GmoAozoraConfigResult,
  type GmoTokenSet,
} from "@niho-finance/importers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  BANK_OAUTH_COOKIE,
  decodeBankOAuthState,
  encodeBankOAuthState,
  readCookie,
} from "./oauth-cookie";
import {
  bankLinkPath,
  handleBankAuthorize,
  handleBankCallback,
  redactBankLog,
  type BankAuthorizeDependencies,
  type BankCallbackDependencies,
} from "./oauth-routes";

const WALLET = "01JBANKWALLET0000000000001";
const NOW = new Date("2026-11-30T01:00:00Z");
const STATE = "S".repeat(43);
const NONCE = "N".repeat(43);
/** Fictional values only. */
const CODE = "fake-authorization-code-0123456789abcdef";
const CLIENT_SECRET = "fake-client-secret";

const OAUTH: GmoAozoraConfig = {
  env: "stg",
  mode: "oauth",
  apiBase: "https://stg-api.gmo-aozora.com/ganb/api/corporation/v1",
  auth: {
    authBase: "https://stg-api.gmo-aozora.com/ganb/api/auth/v1",
    issuer: "https://stg-api.gmo-aozora.com",
    clientId: "fake-client-id",
    clientSecret: CLIENT_SECRET,
    clientAuth: "basic",
    redirectUri: "https://finance.example.test/api/bank/gmo-aozora/callback",
  },
  accessToken: null,
};
const TOKEN: GmoAozoraConfig = {
  env: "sunabar",
  mode: "token",
  apiBase: "https://api.sunabar.gmo-aozora.com/corporation/v1",
  auth: null,
  accessToken: "fake-sunabar-token",
};
const UNSET: GmoAozoraConfigResult = {
  ok: false,
  reason: "unset",
  message: "銀行 API が設定されていません",
  variables: ["NIHO_FINANCE_GMO_AOZORA_ENV"],
};

const TOKENS: GmoTokenSet = {
  accessToken: "fake-access-token",
  refreshToken: "fake-refresh-token",
  accessTokenExpiresAt: new Date("2026-12-30T01:00:00Z"),
  scope: "openid offline_access private:account",
  idToken: "fake-id-token",
};

let log: MockInstance<typeof console.error>;
beforeEach(() => {
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
});

function logged(): string {
  return log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

function setCookie(response: Response): string {
  return response.headers.get("set-cookie") ?? "";
}

describe("handleBankAuthorize", () => {
  function authorize(
    url: string,
    overrides: Partial<BankAuthorizeDependencies> = {},
  ): Promise<Response> {
    let next = 0;
    return handleBankAuthorize(new Request(url), {
      walletState: () => Promise.resolve("active"),
      config: () => ({ ok: true, config: OAUTH }),
      hasTokenKey: () => true,
      secure: () => false,
      now: () => NOW,
      random: () => (next++ === 0 ? STATE : NONCE),
      ...overrides,
    });
  }

  const entry = `https://finance.example.test/api/bank/gmo-aozora/authorize?wallet=${WALLET}`;

  it("sends the browser to the bank's authorization with a state and a nonce kept in the cookie", async () => {
    const response = await authorize(entry);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://stg-api.gmo-aozora.com/ganb/api/auth/v1/authorization",
    );
    expect(Object.fromEntries(location.searchParams)).toEqual({
      response_type: "code",
      client_id: "fake-client-id",
      redirect_uri: "https://finance.example.test/api/bank/gmo-aozora/callback",
      scope: "openid offline_access private:account",
      state: STATE,
      nonce: NONCE,
    });
    const cookie = setCookie(response);
    expect(cookie).toContain("Path=/api/bank/gmo-aozora");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).not.toContain("Secure");
    expect(decodeBankOAuthState(readCookie(cookie, BANK_OAUTH_COOKIE) ?? "")).toEqual({
      walletId: WALLET,
      state: STATE,
      nonce: NONCE,
      issuedAt: NOW.getTime(),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("marks the cookie Secure in production", async () => {
    const response = await authorize(entry, { secure: () => true });
    expect(setCookie(response)).toContain("; Secure");
  });

  it.each([
    ["without a wallet", "https://finance.example.test/api/bank/gmo-aozora/authorize"],
    [
      "with a wallet ID that is a path",
      "https://finance.example.test/api/bank/gmo-aozora/authorize?wallet=..%2Fimports",
    ],
  ])("goes back to the wallets %s", async (_case, url) => {
    const response = await authorize(url);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/settings/wallets");
    expect(setCookie(response)).toBe("");
  });

  it("goes back to the wallets for a wallet that is not a bank's", async () => {
    const response = await authorize(entry, { walletState: () => Promise.resolve(null) });
    expect(response.headers.get("location")).toBe("/settings/wallets");
  });

  it.each([
    ["an inactive wallet", { walletState: () => Promise.resolve("inactive" as const) }],
    ["no configuration", { config: () => UNSET }],
    ["the token method", { config: () => ({ ok: true as const, config: TOKEN }) }],
    ["no key for the tokens", { hasTokenKey: () => false }],
  ])("does not start with %s: back to the page, unavailable", async (_case, overrides) => {
    const response = await authorize(entry, overrides);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(bankLinkPath(WALLET, "unavailable"));
    expect(setCookie(response)).toBe("");
  });
});

describe("handleBankCallback", () => {
  function cookieHeader(overrides: { issuedAt?: number; state?: string } = {}): string {
    return `${BANK_OAUTH_COOKIE}=${encodeBankOAuthState({
      walletId: WALLET,
      state: overrides.state ?? STATE,
      nonce: NONCE,
      issuedAt: overrides.issuedAt ?? NOW.getTime() - 60_000,
    })}`;
  }

  function callback(
    query: string,
    options: { cookie?: string | null } & Partial<BankCallbackDependencies> = {},
  ) {
    const { cookie = cookieHeader(), ...overrides } = options;
    const exchange = vi.fn<BankCallbackDependencies["exchange"]>(() => Promise.resolve(TOKENS));
    const save = vi.fn<BankCallbackDependencies["save"]>(() => Promise.resolve());
    const headers = cookie === null ? undefined : { cookie };
    const response = handleBankCallback(
      new Request(`https://finance.example.test/api/bank/gmo-aozora/callback?${query}`, {
        headers,
      }),
      {
        config: () => ({ ok: true, config: OAUTH }),
        exchange,
        save,
        secure: () => false,
        now: () => NOW,
        ...overrides,
      },
    );
    return { response, exchange, save };
  }

  function expectCleared(response: Response) {
    const cookie = setCookie(response);
    expect(cookie.startsWith(`${BANK_OAUTH_COOKIE}=;`)).toBe(true);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/api/bank/gmo-aozora");
  }

  it("exchanges the code with the cookie's nonce, saves the tokens and returns to the page", async () => {
    const { response, exchange, save } = callback(`code=${CODE}&state=${STATE}`);
    const answered = await response;
    expect(answered.status).toBe(302);
    expect(answered.headers.get("location")).toBe(
      `/settings/wallets/${WALLET}/bank?bank=authorized`,
    );
    expectCleared(answered);
    expect(exchange).toHaveBeenCalledWith(OAUTH.auth, CODE, NONCE);
    expect(save).toHaveBeenCalledWith({ walletId: WALLET, env: "stg", tokens: TOKENS });
  });

  it.each([
    ["without the cookie", { cookie: null }, `code=${CODE}&state=${STATE}`],
    ["with a broken cookie", { cookie: `${BANK_OAUTH_COOKIE}=broken` }, `code=${CODE}`],
    [
      "after 10 minutes",
      { cookie: cookieHeader({ issuedAt: NOW.getTime() - 601_000 }) },
      `code=${CODE}&state=${STATE}`,
    ],
    ["with another state", {}, `code=${CODE}&state=${"T".repeat(43)}`],
    ["without a state", {}, `code=${CODE}`],
  ])("is 400 %s, clears the cookie and exchanges nothing", async (_case, options, query) => {
    const { response, exchange, save } = callback(query, options);
    const answered = await response;
    expect(answered.status).toBe(400);
    expect(answered.headers.get("content-type")).toContain("text/plain");
    expect(await answered.text()).toContain("もう一度「接続する」を押してください");
    expectCleared(answered);
    expect(exchange).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("returns to the page as denied when the owner did not authorize", async () => {
    const { response, exchange } = callback(
      `error=access_denied&error_description=${encodeURIComponent("拒否されました")}&state=${STATE}`,
    );
    const answered = await response;
    expect(answered.headers.get("location")).toBe(`/settings/wallets/${WALLET}/bank?bank=denied`);
    expectCleared(answered);
    expect(exchange).not.toHaveBeenCalled();
    expect(logged()).toContain("access_denied");
  });

  it("returns as invalid when the ID Token does not pass, and logs no secret", async () => {
    const { response, save } = callback(`code=${CODE}&state=${STATE}`, {
      exchange: () =>
        Promise.reject(
          new GmoOAuthError(
            "invalid_id_token",
            `銀行の応答を確かめられませんでした（nonce が一致しません）code=${CODE} secret=${CLIENT_SECRET}`,
          ),
        ),
    });
    const answered = await response;
    expect(answered.headers.get("location")).toBe(`/settings/wallets/${WALLET}/bank?bank=invalid`);
    expectCleared(answered);
    expect(save).not.toHaveBeenCalled();
    const text = logged();
    expect(text).toContain("invalid_id_token");
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(CLIENT_SECRET);
  });

  it("returns as failed when the token endpoint refuses the code", async () => {
    const { response, save } = callback(`code=${CODE}&state=${STATE}`, {
      exchange: () =>
        Promise.reject(new GmoOAuthError("invalid_grant", "認可コードが無効です", { status: 400 })),
    });
    const answered = await response;
    expect(answered.headers.get("location")).toBe(`/settings/wallets/${WALLET}/bank?bank=failed`);
    expect(save).not.toHaveBeenCalled();
  });

  it("returns as failed when the tokens cannot be saved, without logging them", async () => {
    const { response } = callback(`code=${CODE}&state=${STATE}`, {
      save: () =>
        Promise.reject(new Error(`could not seal fake-access-token / fake-refresh-token`)),
    });
    const answered = await response;
    expect(answered.headers.get("location")).toBe(`/settings/wallets/${WALLET}/bank?bank=failed`);
    const text = logged();
    expect(text).not.toContain("fake-access-token");
    expect(text).not.toContain("fake-refresh-token");
  });

  it("returns as failed without a code", async () => {
    const { response, exchange } = callback(`state=${STATE}`);
    expect((await response).headers.get("location")).toBe(
      `/settings/wallets/${WALLET}/bank?bank=failed`,
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  it("returns as unavailable when the bank API is no longer configured for the flow", async () => {
    const { response, exchange } = callback(`code=${CODE}&state=${STATE}`, {
      config: () => ({ ok: true, config: TOKEN }),
    });
    expect((await response).headers.get("location")).toBe(
      `/settings/wallets/${WALLET}/bank?bank=unavailable`,
    );
    expect(exchange).not.toHaveBeenCalled();
  });
});

describe("redactBankLog", () => {
  it("masks the given secrets, JWTs, bearer values, long opaque runs and account IDs", () => {
    const line = redactBankLog(
      "secret=fake-client-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln Bearer abc token=0123456789abcdefABCDEF0123456789abcd id=301019999999",
      ["fake-client-secret"],
    );
    expect(line).not.toContain("fake-client-secret");
    expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(line).not.toContain("Bearer abc");
    expect(line).not.toContain("0123456789abcdefABCDEF0123456789abcd");
    expect(line).not.toContain("301019999999");
  });
});
