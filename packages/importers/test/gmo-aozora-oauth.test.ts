import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GmoAuthConfig } from "../src/gmo-aozora/config";
import { GmoOAuthError, GmoTokenCipherError } from "../src/gmo-aozora/errors";
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  GMO_AOZORA_SCOPE,
  refreshAccessToken,
  verifyIdToken,
} from "../src/gmo-aozora/oauth";
import {
  openTokens,
  sealTokens,
  toStoredTokens,
  type StoredTokens,
} from "../src/gmo-aozora/tokens";
import { fakeFetch, gmoFixture, jsonResponse, signIdToken } from "./support/gmo";

/** A fictional client: never real credentials. */
const AUTH: GmoAuthConfig = {
  authBase: "https://stg-api.gmo-aozora.com/ganb/api/auth/v1",
  issuer: "https://stg-api.gmo-aozora.com",
  clientId: "fake-client-id",
  clientSecret: "fake-client-secret-0123456789",
  clientAuth: "basic",
  redirectUri: "https://finance.example.test/api/bank/gmo-aozora/callback",
};
const NOW = new Date("2026-11-30T01:00:00Z");
const NOW_SECONDS = NOW.getTime() / 1000;
const NONCE = "fake-nonce-0001";

function claims(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: AUTH.issuer,
    sub: "fake-subject",
    aud: AUTH.clientId,
    azp: AUTH.clientId,
    exp: NOW_SECONDS + 3600,
    iat: NOW_SECONDS - 5,
    nonce: NONCE,
    ...changes,
  };
}

function tokenAnswer(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...gmoFixture<Record<string, unknown>>("token"),
    id_token: signIdToken(claims(), AUTH.clientSecret),
    ...changes,
  };
}

async function oauthFailureOf(promise: Promise<unknown>): Promise<GmoOAuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GmoOAuthError) return error;
    throw error;
  }
  throw new Error("expected a GmoOAuthError");
}

describe("the authorization code flow (19-bank-api §2.2)", () => {
  it("sends the owner to the authorization endpoint with the client, scope, state and nonce", () => {
    const url = new URL(buildAuthorizationUrl(AUTH, { state: "fake-state", nonce: NONCE }));
    expect(`${url.origin}${url.pathname}`).toBe(`${AUTH.authBase}/authorization`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: AUTH.clientId,
      redirect_uri: AUTH.redirectUri,
      scope: "openid offline_access private:account",
      state: "fake-state",
      nonce: NONCE,
    });
    expect(url.search).toContain("scope=openid%20offline_access%20private%3Aaccount");
    expect(GMO_AOZORA_SCOPE).toBe("openid offline_access private:account");
  });

  it("exchanges the code with client_secret_basic and verifies the ID Token", async () => {
    const { fetch, requests } = fakeFetch(() => jsonResponse(200, tokenAnswer()));
    const tokens = await exchangeAuthorizationCode(AUTH, "fake-code", {
      nonce: NONCE,
      now: NOW,
      fetch,
    });
    expect(tokens).toMatchObject({
      accessToken: "fake-access-token-0001",
      refreshToken: "fake-refresh-token-0001",
      scope: GMO_AOZORA_SCOPE,
      accessTokenExpiresAt: new Date(NOW.getTime() + 2_592_000 * 1000),
    });
    expect(typeof tokens.idToken).toBe("string");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe(`${AUTH.authBase}/token`);
    expect(request?.method).toBe("POST");
    expect(request?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${AUTH.clientId}:${AUTH.clientSecret}`).toString("base64")}`,
    );
    expect(request?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(request?.body ?? ""))).toEqual({
      grant_type: "authorization_code",
      code: "fake-code",
      redirect_uri: AUTH.redirectUri,
    });
  });

  it("puts the client in the body with client_secret_post", async () => {
    const { fetch, requests } = fakeFetch(() => jsonResponse(200, tokenAnswer()));
    await exchangeAuthorizationCode({ ...AUTH, clientAuth: "post" }, "fake-code", {
      nonce: NONCE,
      now: NOW,
      fetch,
    });
    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(requests[0]?.body ?? ""))).toEqual({
      grant_type: "authorization_code",
      code: "fake-code",
      redirect_uri: AUTH.redirectUri,
      client_id: AUTH.clientId,
      client_secret: AUTH.clientSecret,
    });
  });

  it("does not connect when the ID Token is missing or does not pass", async () => {
    const answer = (body: Record<string, unknown>) =>
      fakeFetch(() => jsonResponse(200, body)).fetch;
    const missing = await oauthFailureOf(
      exchangeAuthorizationCode(AUTH, "fake-code", {
        nonce: NONCE,
        now: NOW,
        fetch: answer(tokenAnswer({ id_token: undefined })),
      }),
    );
    expect(missing).toMatchObject({ error: "invalid_id_token" });
    const otherNonce = await oauthFailureOf(
      exchangeAuthorizationCode(AUTH, "fake-code", {
        nonce: "fake-nonce-of-another-request",
        now: NOW,
        fetch: answer(tokenAnswer()),
      }),
    );
    expect(otherNonce).toMatchObject({
      error: "invalid_id_token",
      message: "銀行の応答を確かめられませんでした（nonce が一致しません）",
    });
  });

  it("refreshes the access token without verifying the refresh's ID Token", async () => {
    const { fetch, requests } = fakeFetch(() =>
      jsonResponse(200, {
        access_token: "fake-access-token-0002",
        token_type: "Bearer",
        expires_in: "3600",
        id_token: "not-checked",
      }),
    );
    const tokens = await refreshAccessToken(AUTH, "fake-refresh-token-0001", { now: NOW, fetch });
    expect(tokens).toEqual({
      accessToken: "fake-access-token-0002",
      refreshToken: null,
      accessTokenExpiresAt: new Date(NOW.getTime() + 3_600_000),
      scope: "",
      idToken: "not-checked",
    });
    expect(Object.fromEntries(new URLSearchParams(requests[0]?.body ?? ""))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "fake-refresh-token-0001",
    });
  });

  it("turns the token endpoint's errors into GmoOAuthError with their code", async () => {
    const refused = await oauthFailureOf(
      refreshAccessToken(AUTH, "fake-refresh-token-0001", {
        fetch: fakeFetch(() => jsonResponse(400, gmoFixture("token-error-400"))).fetch,
      }),
    );
    expect(refused).toMatchObject({
      error: "invalid_grant",
      status: 400,
      message:
        "銀行の認可サーバーがトークンを発行しませんでした（invalid_grant: The refresh token is invalid or expired.）",
    });
    expect(
      await oauthFailureOf(
        refreshAccessToken(AUTH, "fake", {
          fetch: fakeFetch(() => new Response(null, { status: 401 })).fetch,
        }),
      ),
    ).toMatchObject({ error: "http_401", status: 401 });
    expect(
      await oauthFailureOf(
        refreshAccessToken(AUTH, "fake", {
          fetch: () => Promise.reject(new TypeError("fetch failed")),
        }),
      ),
    ).toMatchObject({ error: "network", status: null });
    for (const body of [
      { token_type: "Bearer", expires_in: 3600 },
      { access_token: "fake", token_type: "mac", expires_in: 3600 },
      { access_token: "fake", token_type: "Bearer" },
      { access_token: "fake", token_type: "Bearer", expires_in: -1 },
    ]) {
      expect(
        await oauthFailureOf(
          refreshAccessToken(AUTH, "fake", {
            fetch: fakeFetch(() => jsonResponse(200, body)).fetch,
          }),
        ),
      ).toMatchObject({ error: "invalid_response" });
    }
  });
});

describe("verifyIdToken (19-bank-api §2.2 step 4)", () => {
  const expected = { nonce: NONCE, now: NOW };

  it("accepts a token signed with the client secret, iss with or without the trailing /", () => {
    const verified = verifyIdToken(signIdToken(claims(), AUTH.clientSecret), AUTH, expected);
    expect(verified).toEqual({ ok: true, claims: claims() });
    const accepted: [string, string | null][] = [
      [signIdToken(claims({ iss: `${AUTH.issuer}/` }), AUTH.clientSecret), NONCE],
      [
        signIdToken(claims({ aud: ["fake-other-client", AUTH.clientId] }), AUTH.clientSecret),
        NONCE,
      ],
      // A refresh's token has no nonce, and none is expected.
      [signIdToken(claims({ nonce: undefined }), AUTH.clientSecret), null],
    ];
    for (const [token, nonce] of accepted) {
      expect(verifyIdToken(token, AUTH, { nonce, now: NOW }).ok).toBe(true);
    }
    expect(
      verifyIdToken(
        signIdToken(claims(), AUTH.clientSecret),
        { ...AUTH, issuer: `${AUTH.issuer}/` },
        expected,
      ).ok,
    ).toBe(true);
  });

  it("refuses each claim that differs", () => {
    const cases: [string, string][] = [
      [signIdToken(claims(), "fake-other-secret"), "署名が一致しません"],
      [signIdToken(claims(), AUTH.clientSecret).slice(0, -2), "署名が一致しません"],
      [
        signIdToken(claims({ iss: "https://api.gmo-aozora.com" }), AUTH.clientSecret),
        "発行元（iss）が違います",
      ],
      [signIdToken(claims({ iss: undefined }), AUTH.clientSecret), "発行元（iss）が違います"],
      [
        signIdToken(claims({ aud: "fake-other-client" }), AUTH.clientSecret),
        "受け手（aud）にクライアント ID がありません",
      ],
      [
        signIdToken(claims({ aud: ["fake-other-client"] }), AUTH.clientSecret),
        "受け手（aud）にクライアント ID がありません",
      ],
      [
        signIdToken(claims({ azp: "fake-other-client" }), AUTH.clientSecret),
        "azp がクライアント ID ではありません",
      ],
      [
        signIdToken(claims({ azp: undefined }), AUTH.clientSecret),
        "azp がクライアント ID ではありません",
      ],
      [
        signIdToken(claims({ exp: NOW_SECONDS }), AUTH.clientSecret),
        "ID Token の期限（exp）が切れています",
      ],
      [
        signIdToken(claims({ exp: "later" }), AUTH.clientSecret),
        "ID Token の期限（exp）が切れています",
      ],
      [
        signIdToken(claims({ iat: NOW_SECONDS - 601 }), AUTH.clientSecret),
        "ID Token の発行（iat）が古すぎます",
      ],
      [
        signIdToken(claims({ nonce: "fake-other-nonce" }), AUTH.clientSecret),
        "nonce が一致しません",
      ],
      [signIdToken(claims({ nonce: undefined }), AUTH.clientSecret), "nonce が一致しません"],
      [
        signIdToken(claims(), AUTH.clientSecret, { alg: "none", typ: "JWT" }),
        "署名の方式が HS256 ではありません",
      ],
      [
        signIdToken(claims(), AUTH.clientSecret, { alg: "RS256", typ: "JWT" }),
        "署名の方式が HS256 ではありません",
      ],
      ["not-a-token", "ID Token の形式が違います"],
      ["a.b.c.d", "ID Token の形式が違います"],
    ];
    for (const [token, reason] of cases) {
      expect(verifyIdToken(token, AUTH, expected), reason).toEqual({ ok: false, reason });
    }
    // Exactly 600 seconds old is still accepted.
    expect(
      verifyIdToken(
        signIdToken(claims({ iat: NOW_SECONDS - 600 }), AUTH.clientSecret),
        AUTH,
        expected,
      ).ok,
    ).toBe(true);
  });
});

describe("sealTokens / openTokens (19-bank-api §2.3)", () => {
  const key = randomBytes(32).toString("base64");
  const tokens: StoredTokens = {
    accessToken: "fake-access-token-0001",
    refreshToken: "fake-refresh-token-0001",
    accessTokenExpiresAt: "2026-12-30T01:00:00.000Z",
    scope: GMO_AOZORA_SCOPE,
  };

  function cipherFailureOf(run: () => unknown): GmoTokenCipherError {
    try {
      run();
    } catch (error) {
      if (error instanceof GmoTokenCipherError) return error;
      throw error;
    }
    throw new Error("expected a GmoTokenCipherError");
  }

  it("seals with AES-256-GCM as v1.<iv>.<tag>.<body> and opens it again", () => {
    const sealed = sealTokens(tokens, key);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("fake-access-token");
    expect(openTokens(sealed, key)).toEqual(tokens);
    // A fresh IV every time.
    expect(sealTokens(tokens, key)).not.toBe(sealed);
    expect(
      toStoredTokens({
        accessToken: "fake-access-token-0001",
        refreshToken: null,
        accessTokenExpiresAt: new Date("2026-12-30T01:00:00Z"),
        scope: "",
        idToken: "fake-id-token",
      }),
    ).toEqual({
      accessToken: "fake-access-token-0001",
      refreshToken: null,
      accessTokenExpiresAt: "2026-12-30T01:00:00.000Z",
      scope: "",
    });
  });

  it("refuses a changed value, another key and another format", () => {
    const sealed = sealTokens(tokens, key);
    const parts = sealed.split(".");
    const body = parts[3] ?? "";
    // The first character carries 6 bits of the ciphertext (the last may carry padding bits only).
    const flipped = `${body.startsWith("A") ? "B" : "A"}${body.slice(1)}`;
    expect(
      cipherFailureOf(() => openTokens([...parts.slice(0, 3), flipped].join("."), key)),
    ).toMatchObject({
      reason: "decrypt",
    });
    expect(
      cipherFailureOf(() => openTokens(sealed, randomBytes(32).toString("base64"))),
    ).toMatchObject({ reason: "decrypt", message: "保存したトークンを復号できません" });
    for (const other of [`v2.${parts.slice(1).join(".")}`, "v1.abc", "", `${sealed}.x`]) {
      expect(
        cipherFailureOf(() => openTokens(other, key)),
        other,
      ).toMatchObject({ reason: "format" });
    }
    for (const badKey of [randomBytes(16).toString("base64"), "not base64!", ""]) {
      expect(cipherFailureOf(() => sealTokens(tokens, badKey))).toMatchObject({ reason: "key" });
      expect(cipherFailureOf(() => openTokens(sealed, badKey))).toMatchObject({ reason: "key" });
    }
  });
});
