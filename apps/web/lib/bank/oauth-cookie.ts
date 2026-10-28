import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The authorization in progress at GMO あおぞらネット銀行 (19-bank-api §2.2), carried by the
 * browser between 「接続する」 and the callback in the httpOnly cookie `niho_bank_oauth`: the
 * wallet, the `state` the callback must bring back and the `nonce` the ID Token must carry.
 * Nothing about it is kept on the server. Pure functions: the route handlers read and write the
 * headers.
 */

export const BANK_OAUTH_COOKIE = "niho_bank_oauth";
/** Sent only to the authorization entry and its callback. */
export const BANK_OAUTH_COOKIE_PATH = "/api/bank/gmo-aozora";
/** 10 minutes from 「接続する」 to the callback. */
export const BANK_OAUTH_MAX_AGE_SECONDS = 600;
/** Allowed clock difference for an `issuedAt` in the future. */
const CLOCK_SKEW_MS = 60_000;

/** Wallet IDs (ULIDs): they go into the path of the page the callback returns to. */
export const BANK_WALLET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 32 random bytes as base64url. */
const RANDOM_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface BankOAuthState {
  walletId: string;
  state: string;
  nonce: string;
  /** Epoch milliseconds of 「接続する」. */
  issuedAt: number;
}

export type BankOAuthCheck =
  | { ok: true; walletId: string; nonce: string }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "state"; walletId: string | null };

/** 32 random bytes as base64url (`state`, `nonce`). */
export function randomBankOAuthValue(): string {
  return randomBytes(32).toString("base64url");
}

export function newBankOAuthState(
  walletId: string,
  now: Date,
  random: () => string = randomBankOAuthValue,
): BankOAuthState {
  return { walletId, state: random(), nonce: random(), issuedAt: now.getTime() };
}

/** The cookie's value: the state as JSON, base64url. */
export function encodeBankOAuthState(value: BankOAuthState): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** The state in a cookie's value, or `null` when it is not one of ours. */
export function decodeBankOAuthState(text: string): BankOAuthState | null {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { walletId, state, nonce, issuedAt } = parsed as Record<string, unknown>;
  if (
    typeof walletId !== "string" ||
    !BANK_WALLET_ID_PATTERN.test(walletId) ||
    typeof state !== "string" ||
    !RANDOM_PATTERN.test(state) ||
    typeof nonce !== "string" ||
    !RANDOM_PATTERN.test(nonce) ||
    typeof issuedAt !== "number" ||
    !Number.isSafeInteger(issuedAt)
  ) {
    return null;
  }
  return { walletId, state, nonce, issuedAt };
}

function cookieAttributes(maxAge: number, secure: boolean): string {
  return [
    `Path=${BANK_OAUTH_COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** `Set-Cookie` of a new authorization; `secure` in production. */
export function bankOAuthCookie(value: BankOAuthState, options: { secure: boolean }): string {
  return `${BANK_OAUTH_COOKIE}=${encodeBankOAuthState(value)}; ${cookieAttributes(BANK_OAUTH_MAX_AGE_SECONDS, options.secure)}`;
}

/** `Set-Cookie` that removes the cookie (the callback is done with it, whatever the outcome). */
export function clearedBankOAuthCookie(options: { secure: boolean }): string {
  return `${BANK_OAUTH_COOKIE}=; ${cookieAttributes(0, options.secure)}`;
}

/** The value of one cookie in a `Cookie` header, or `null`. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The callback against the cookie (19-bank-api §2.2 step 2): the cookie must be ours, at most
 * 10 minutes old, and its `state` the one the bank sent back. The wallet is named whenever the
 * cookie could be read, so that a refusal can still be logged against it.
 */
export function checkBankOAuthCallback(
  cookie: string | null,
  state: string | null,
  now: Date,
): BankOAuthCheck {
  if (cookie === null || cookie === "") return { ok: false, reason: "missing", walletId: null };
  const value = decodeBankOAuthState(cookie);
  if (value === null) return { ok: false, reason: "malformed", walletId: null };
  const age = now.getTime() - value.issuedAt;
  if (age > BANK_OAUTH_MAX_AGE_SECONDS * 1000 || age < -CLOCK_SKEW_MS) {
    return { ok: false, reason: "expired", walletId: value.walletId };
  }
  if (state === null || !sameText(state, value.state)) {
    return { ok: false, reason: "state", walletId: value.walletId };
  }
  return { ok: true, walletId: value.walletId, nonce: value.nonce };
}
