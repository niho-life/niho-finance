import { createHmac, timingSafeEqual } from "node:crypto";
import type { GmoAuthConfig } from "./config";
import { GmoOAuthError } from "./errors";
import {
  isRecord,
  isTimeout,
  oneLine,
  readJsonBody,
  send,
  stringField,
  type GmoFetch,
} from "./http";

/**
 * The scopes the connection asks for (19-bank-api §2.2): `offline_access` for a refresh token,
 * `private:account` for the account inquiries (一覧・残高・入出金明細).
 */
export const GMO_AOZORA_SCOPE = "openid offline_access private:account";

/** ID Tokens issued more than 10 minutes before now are refused (GMO's rule). */
const ID_TOKEN_MAX_AGE_SECONDS = 600;

/** The token endpoint's answer. */
export interface GmoTokenSet {
  accessToken: string;
  /** `null` when the answer carries none (a refresh then keeps the one it used). */
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
  scope: string;
  idToken: string | null;
}

export interface GmoIdTokenClaims {
  iss: string;
  aud: string | string[];
  azp: string;
  exp: number;
  iat: number;
  nonce?: string;
  sub?: string;
  [claim: string]: unknown;
}

export type GmoIdTokenVerification =
  { ok: true; claims: GmoIdTokenClaims } | { ok: false; reason: string };

export interface GmoTokenRequestOptions {
  fetch?: GmoFetch;
  /** The clock for `expires_in` and the ID Token's `exp` / `iat`. */
  now?: Date;
}

/** `GET {authBase}/authorization?…`: where 「接続する」 sends the owner (19-bank-api §2.2). */
export function buildAuthorizationUrl(
  auth: GmoAuthConfig,
  params: { state: string; nonce: string },
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: auth.clientId,
    redirect_uri: auth.redirectUri,
    scope: GMO_AOZORA_SCOPE,
    state: params.state,
    nonce: params.nonce,
  });
  // Spaces as %20 rather than "+": both are valid, %20 is read the same by every server.
  return `${auth.authBase}/authorization?${query.toString().replaceAll("+", "%20")}`;
}

/** `application/x-www-form-urlencoded` of a credential for HTTP Basic (RFC 6749 §2.3.1). */
function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

function expiresInSeconds(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === "string" && /^\d{1,10}$/.test(value)) {
    const seconds = Number(value);
    return seconds > 0 ? seconds : null;
  }
  return null;
}

function invalidAnswer(detail: string): GmoOAuthError {
  return new GmoOAuthError(
    "invalid_response",
    `銀行の認可サーバーの応答が読めませんでした（${detail}）`,
  );
}

function toTokenSet(body: unknown, now: Date): GmoTokenSet {
  if (!isRecord(body)) throw invalidAnswer("JSON ではありません");
  const accessToken = stringField(body, "access_token");
  if (accessToken === null || accessToken === "") throw invalidAnswer("access_token がありません");
  const tokenType = stringField(body, "token_type");
  if (tokenType !== null && tokenType.toLowerCase() !== "bearer") {
    throw invalidAnswer(`token_type が Bearer ではありません（${oneLine(tokenType, 20)}）`);
  }
  const expiresIn = expiresInSeconds(body.expires_in);
  if (expiresIn === null) throw invalidAnswer("expires_in が読めません");
  const refreshToken = stringField(body, "refresh_token");
  const idToken = stringField(body, "id_token");
  return {
    accessToken,
    refreshToken: refreshToken === "" ? null : refreshToken,
    accessTokenExpiresAt: new Date(now.getTime() + expiresIn * 1000),
    scope: stringField(body, "scope") ?? "",
    idToken: idToken === "" ? null : idToken,
  };
}

/**
 * `POST {authBase}/token` with the client authenticated as registered: `client_secret_basic`
 * (Authorization: Basic) or `client_secret_post` (in the body). An error answer becomes a
 * `GmoOAuthError` with its `error` code; a missing answer one with `network`.
 */
async function requestTokens(
  auth: GmoAuthConfig,
  params: Record<string, string>,
  options: GmoTokenRequestOptions,
): Promise<GmoTokenSet> {
  const now = options.now ?? new Date();
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (auth.clientAuth === "basic") {
    const credentials = `${formEncode(auth.clientId)}:${formEncode(auth.clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
  } else {
    body.set("client_id", auth.clientId);
    body.set("client_secret", auth.clientSecret);
  }
  let response: Response;
  try {
    response = await send(options.fetch, `${auth.authBase}/token`, {
      method: "POST",
      headers,
      body: body.toString(),
    });
  } catch (error) {
    throw new GmoOAuthError(
      "network",
      isTimeout(error)
        ? "銀行の認可サーバーが応答しませんでした（30 秒）"
        : "銀行の認可サーバーに接続できませんでした",
      { cause: error },
    );
  }
  const json = await readJsonBody(response);
  if (!response.ok) {
    const error = (isRecord(json) ? stringField(json, "error") : null) ?? `http_${response.status}`;
    const description = isRecord(json) ? stringField(json, "error_description") : null;
    const detail = description ? `${error}: ${oneLine(description)}` : error;
    throw new GmoOAuthError(
      error,
      `銀行の認可サーバーがトークンを発行しませんでした（${detail}）`,
      { status: response.status },
    );
  }
  return toTokenSet(json, now);
}

/**
 * Exchanges the authorization code for tokens (19-bank-api §2.2 step 3–4) and verifies the ID
 * Token, its `nonce` against the one the caller kept (the cookie's). A token answer that does not
 * pass is refused with `invalid_id_token`: the connection is not made.
 */
export async function exchangeAuthorizationCode(
  auth: GmoAuthConfig,
  code: string,
  options: GmoTokenRequestOptions & { nonce: string },
): Promise<GmoTokenSet> {
  const now = options.now ?? new Date();
  const tokens = await requestTokens(
    auth,
    { grant_type: "authorization_code", code, redirect_uri: auth.redirectUri },
    { ...options, now },
  );
  if (tokens.idToken === null) {
    throw new GmoOAuthError("invalid_id_token", "銀行の応答に ID Token がありません");
  }
  const verified = verifyIdToken(tokens.idToken, auth, { nonce: options.nonce, now });
  if (!verified.ok) {
    throw new GmoOAuthError(
      "invalid_id_token",
      `銀行の応答を確かめられませんでした（${verified.reason}）`,
    );
  }
  return tokens;
}

/**
 * `grant_type=refresh_token` (19-bank-api §2.3). The ID Token of a refresh has no `nonce` and is
 * not verified: the answer comes straight from the token endpoint over TLS.
 */
export function refreshAccessToken(
  auth: GmoAuthConfig,
  refreshToken: string,
  options: GmoTokenRequestOptions = {},
): Promise<GmoTokenSet> {
  return requestTokens(auth, { grant_type: "refresh_token", refresh_token: refreshToken }, options);
}

function decodeJsonPart(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Verifies an ID Token as GMO specifies (19-bank-api §2.2 step 4): HS256 signed with the client
 * secret (compared in constant time), `iss` the environment's issuer (a trailing `/` either way),
 * the client ID in `aud` and as `azp`, `exp` after now, `iat` no older than 600 seconds, and
 * `nonce` equal to `expected.nonce` unless that is `null` (refresh).
 */
export function verifyIdToken(
  idToken: string,
  auth: Pick<GmoAuthConfig, "issuer" | "clientId" | "clientSecret">,
  expected: { nonce: string | null; now: Date },
): GmoIdTokenVerification {
  const parts = idToken.split(".");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    parts.length !== 3 ||
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return { ok: false, reason: "ID Token の形式が違います" };
  }
  const header = decodeJsonPart(encodedHeader);
  if (!isRecord(header)) return { ok: false, reason: "ID Token の形式が違います" };
  if (header.alg !== "HS256") return { ok: false, reason: "署名の方式が HS256 ではありません" };

  const signature = /^[A-Za-z0-9_-]+$/.test(encodedSignature)
    ? Buffer.from(encodedSignature, "base64url")
    : Buffer.alloc(0);
  const computed = createHmac("sha256", auth.clientSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  if (signature.length !== computed.length || !timingSafeEqual(signature, computed)) {
    return { ok: false, reason: "署名が一致しません" };
  }

  const claims = decodeJsonPart(encodedPayload);
  if (!isRecord(claims)) return { ok: false, reason: "ID Token の形式が違います" };
  const { iss, aud, azp, exp, iat, nonce } = claims;
  if (typeof iss !== "string" || withoutTrailingSlash(iss) !== withoutTrailingSlash(auth.issuer)) {
    return { ok: false, reason: "発行元（iss）が違います" };
  }
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(auth.clientId)) {
    return { ok: false, reason: "受け手（aud）にクライアント ID がありません" };
  }
  if (azp !== auth.clientId) return { ok: false, reason: "azp がクライアント ID ではありません" };
  const nowSeconds = expected.now.getTime() / 1000;
  if (typeof exp !== "number" || !(exp > nowSeconds)) {
    return { ok: false, reason: "ID Token の期限（exp）が切れています" };
  }
  if (typeof iat !== "number" || iat < nowSeconds - ID_TOKEN_MAX_AGE_SECONDS) {
    return { ok: false, reason: "ID Token の発行（iat）が古すぎます" };
  }
  if (expected.nonce !== null && nonce !== expected.nonce) {
    return { ok: false, reason: "nonce が一致しません" };
  }
  return { ok: true, claims: claims as GmoIdTokenClaims };
}
