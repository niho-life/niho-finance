import { createHash, createPublicKey, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";
import { loadRootEnv } from "@niho-finance/db";

/**
 * Authentication of job requests (12-imports §5): the OIDC token Cloud Scheduler sends (a JWT
 * signed by Google with RS256) is verified against Google's JWKS with `node:crypto`. Outside
 * production, the static `NIHO_FINANCE_JOB_TOKEN` is accepted too (for `curl` on a laptop).
 * Reasons never contain the token.
 */

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
/** Allowed clock difference for `exp` and `iat`. */
const CLOCK_SKEW_MS = 60_000;
/** JWKS cache lifetime when the response has no `Cache-Control: max-age`. */
const DEFAULT_JWKS_MAX_AGE_SECONDS = 3600;
const LOCAL_PRINCIPAL = "local-job";

const REASONS = {
  notConfigured:
    "ジョブの認証が設定されていません（NIHO_FINANCE_JOB_AUDIENCE / NIHO_FINANCE_JOB_SERVICE_ACCOUNT）",
  missing: "認証のトークンがありません",
  malformed: "認証のトークンの形式が正しくありません",
  algorithm: "認証のトークンの署名方式に対応していません",
  keyId: "認証のトークンに鍵の ID がありません",
  unknownKey: "認証のトークンの鍵が Google の公開鍵にありません",
  jwksUnavailable: "Google の公開鍵を取得できません",
  signature: "認証のトークンの署名が正しくありません",
  issuer: "認証のトークンの発行元が Google ではありません",
  audience: "認証のトークンの宛先が一致しません",
  expired: "認証のトークンの期限が切れています",
  issuedAt: "認証のトークンの発行時刻が正しくありません",
  email: "認証のトークンのサービスアカウントが一致しません",
  emailVerified: "認証のトークンのメールアドレスが確認済みではありません",
} as const;

export interface JobJwks {
  keys: JsonWebKey[];
  /** How long the keys may be cached (`Cache-Control: max-age`). */
  maxAgeSeconds?: number;
}

export interface JobAuthOptions {
  /** Defaults to `process.env` after the root `.env` is applied. */
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Defaults to Google's JWKS. */
  fetchJwks?: () => Promise<JobJwks>;
}

export type JobAuthResult =
  { ok: true; principal: string } | { ok: false; status: 401 | 403 | 503; reason: string };

type JobAuthFailure = Extract<JobAuthResult, { ok: false }>;

function fail(status: JobAuthFailure["status"], reason: string): JobAuthFailure {
  return { ok: false, status, reason };
}

function defaultEnv(): NodeJS.ProcessEnv {
  loadRootEnv();
  return process.env;
}

function setting(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/** Whether the OIDC audience and service account are set (`NIHO_FINANCE_JOB_*`, 12-imports §6.4). */
export function isJobAuthConfigured(env: NodeJS.ProcessEnv = defaultEnv()): boolean {
  return (
    setting(env, "NIHO_FINANCE_JOB_AUDIENCE") !== null &&
    setting(env, "NIHO_FINANCE_JOB_SERVICE_ACCOUNT") !== null
  );
}

function bearerToken(header: string | null): string | null {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** The static local token: accepted only outside production, compared in constant time. */
function isLocalToken(token: string, env: NodeJS.ProcessEnv): boolean {
  if (setting(env, "NIHO_FINANCE_ENV") === "prod") return false;
  const expected = setting(env, "NIHO_FINANCE_JOB_TOKEN");
  return expected !== null && timingSafeEqual(sha256(token), sha256(expected));
}

interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decodeJwt(token: string): DecodedJwt | null {
  const [header, payload, signature, ...rest] = token.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return null;
  if (rest.length > 0 || ![header, payload, signature].every((part) => BASE64URL.test(part))) {
    return null;
  }
  const decodedHeader = decodeSegment(header);
  const decodedPayload = decodeSegment(payload);
  if (decodedHeader === null || decodedPayload === null) return null;
  return {
    header: decodedHeader,
    payload: decodedPayload,
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url"),
  };
}

async function fetchGoogleJwks(): Promise<JobJwks> {
  const response = await fetch(GOOGLE_JWKS_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Google JWKS responded ${response.status}`);
  const body: unknown = await response.json();
  const listed =
    typeof body === "object" && body !== null && "keys" in body && Array.isArray(body.keys)
      ? (body.keys as unknown[])
      : [];
  const keys = listed.filter((key): key is JsonWebKey => typeof key === "object" && key !== null);
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get("cache-control") ?? "")?.[1];
  return maxAge === undefined ? { keys } : { keys, maxAgeSeconds: Number(maxAge) };
}

type JwksFetcher = () => Promise<JobJwks>;

/** Keys per fetcher (Google's in production), kept until their `max-age` runs out. */
const jwksCache = new WeakMap<JwksFetcher, { keys: JsonWebKey[]; expiresAt: number }>();

async function loadJwks(
  fetchJwks: JwksFetcher,
  nowMs: number,
  refresh: boolean,
): Promise<{ keys: JsonWebKey[]; fetched: boolean }> {
  const cached = jwksCache.get(fetchJwks);
  if (!refresh && cached !== undefined && cached.expiresAt > nowMs) {
    return { keys: cached.keys, fetched: false };
  }
  const { keys, maxAgeSeconds } = await fetchJwks();
  const maxAge =
    maxAgeSeconds !== undefined && Number.isFinite(maxAgeSeconds) && maxAgeSeconds >= 0
      ? maxAgeSeconds
      : DEFAULT_JWKS_MAX_AGE_SECONDS;
  jwksCache.set(fetchJwks, { keys, expiresAt: nowMs + maxAge * 1000 });
  return { keys, fetched: true };
}

/** The key with `kid`; cached keys that miss it are fetched again once (Google rotates keys). */
async function findKey(
  kid: string,
  fetchJwks: JwksFetcher,
  nowMs: number,
): Promise<JsonWebKey | null> {
  const withKid = (keys: JsonWebKey[]): JsonWebKey | null =>
    keys.find((key) => key.kid === kid) ?? null;
  const first = await loadJwks(fetchJwks, nowMs, false);
  const key = withKid(first.keys);
  if (key !== null || first.fetched) return key;
  return withKid((await loadJwks(fetchJwks, nowMs, true)).keys);
}

function signatureMatches(jwt: DecodedJwt, key: JsonWebKey): boolean {
  try {
    const publicKey = createPublicKey({ key, format: "jwk" });
    if (publicKey.asymmetricKeyType !== "rsa") return false;
    return verify("RSA-SHA256", Buffer.from(jwt.signingInput), publicKey, jwt.signature);
  } catch {
    return false;
  }
}

function checkClaims(
  claims: Record<string, unknown>,
  expected: { audience: string; serviceAccount: string; nowMs: number },
): JobAuthResult {
  const { iss, aud, exp, iat, email } = claims;
  if (typeof iss !== "string" || !GOOGLE_ISSUERS.has(iss)) return fail(403, REASONS.issuer);
  if (aud !== expected.audience) return fail(403, REASONS.audience);
  if (typeof exp !== "number" || exp * 1000 <= expected.nowMs - CLOCK_SKEW_MS) {
    return fail(401, REASONS.expired);
  }
  if (typeof iat !== "number" || iat * 1000 > expected.nowMs + CLOCK_SKEW_MS) {
    return fail(401, REASONS.issuedAt);
  }
  if (email !== expected.serviceAccount) return fail(403, REASONS.email);
  if (claims.email_verified !== true) return fail(403, REASONS.emailVerified);
  return { ok: true, principal: expected.serviceAccount };
}

/**
 * Accepts a job request whose `Authorization: Bearer` is Cloud Scheduler's OIDC token for
 * `NIHO_FINANCE_JOB_AUDIENCE`, issued to `NIHO_FINANCE_JOB_SERVICE_ACCOUNT` (12-imports §5).
 * 401: no token, or a token that is malformed, badly signed, expired or not yet valid.
 * 403: a valid Google token for another issuer, audience or account. 503: not configured, or
 * Google's keys could not be fetched.
 */
export async function verifyJobRequest(
  request: Request,
  options: JobAuthOptions = {},
): Promise<JobAuthResult> {
  const env = options.env ?? defaultEnv();
  const token = bearerToken(request.headers.get("authorization"));
  if (token !== null && isLocalToken(token, env)) return { ok: true, principal: LOCAL_PRINCIPAL };

  const audience = setting(env, "NIHO_FINANCE_JOB_AUDIENCE");
  const serviceAccount = setting(env, "NIHO_FINANCE_JOB_SERVICE_ACCOUNT");
  if (audience === null || serviceAccount === null) return fail(503, REASONS.notConfigured);
  if (token === null) return fail(401, REASONS.missing);

  const jwt = decodeJwt(token);
  if (jwt === null) return fail(401, REASONS.malformed);
  if (jwt.header.alg !== "RS256") return fail(401, REASONS.algorithm);
  const { kid } = jwt.header;
  if (typeof kid !== "string" || kid === "") return fail(401, REASONS.keyId);

  const nowMs = (options.now ?? new Date()).getTime();
  let key: JsonWebKey | null;
  try {
    key = await findKey(kid, options.fetchJwks ?? fetchGoogleJwks, nowMs);
  } catch {
    return fail(503, REASONS.jwksUnavailable);
  }
  if (key === null) return fail(401, REASONS.unknownKey);
  if (!signatureMatches(jwt, key)) return fail(401, REASONS.signature);
  return checkClaims(jwt.payload, { audience, serviceAccount, nowMs });
}
