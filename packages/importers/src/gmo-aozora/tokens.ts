import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GmoTokenCipherError } from "./errors";
import { isRecord } from "./http";
import type { GmoTokenSet } from "./oauth";

/** The tokens of a wallet, as sealed into `wallet.bank_api_tokens` (19-bank-api §2.3). */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO 8601. */
  accessTokenExpiresAt: string;
  scope: string;
}

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** The token answer as stored: the ID Token is not kept. */
export function toStoredTokens(tokens: GmoTokenSet): StoredTokens {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    scope: tokens.scope,
  };
}

/** `NIHO_FINANCE_BANK_TOKEN_KEY` (base64 of 32 bytes, `openssl rand -base64 32`) → the key. */
function decodeKey(key: string): Buffer {
  const text = key.trim();
  const bytes = BASE64.test(text) ? Buffer.from(text, "base64") : null;
  if (bytes === null || bytes.length !== KEY_BYTES) {
    throw new GmoTokenCipherError(
      "key",
      "トークンの暗号鍵は 32 バイトの base64 にします（openssl rand -base64 32）",
    );
  }
  return bytes;
}

/** Seals the tokens with AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
export function sealTokens(tokens: StoredTokens, key: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, decodeKey(key), iv);
  const plain = JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    scope: tokens.scope,
  });
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, ...[iv, tag, body].map((part) => part.toString("base64url"))].join(".");
}

function readStoredTokens(value: unknown): StoredTokens | null {
  if (!isRecord(value)) return null;
  const { accessToken, refreshToken, accessTokenExpiresAt, scope } = value;
  if (typeof accessToken !== "string" || accessToken === "") return null;
  if (refreshToken !== null && typeof refreshToken !== "string") return null;
  if (typeof accessTokenExpiresAt !== "string" || Number.isNaN(Date.parse(accessTokenExpiresAt))) {
    return null;
  }
  if (typeof scope !== "string") return null;
  return { accessToken, refreshToken, accessTokenExpiresAt, scope };
}

/**
 * Opens what `sealTokens` sealed. Another key, a changed byte or another format throws
 * `GmoTokenCipherError` (`reason`: `key` for a malformed key, `format`, `decrypt`).
 */
export function openTokens(sealed: string, key: string): StoredTokens {
  const keyBytes = decodeKey(key);
  const parts = sealed.split(".");
  const [version, iv, tag, body] = parts;
  if (
    parts.length !== 4 ||
    version !== VERSION ||
    iv === undefined ||
    tag === undefined ||
    body === undefined ||
    ![iv, tag, body].every((part) => BASE64URL.test(part))
  ) {
    throw new GmoTokenCipherError("format", "保存したトークンの形式が違います");
  }
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
    throw new GmoTokenCipherError("format", "保存したトークンの形式が違います");
  }
  let plain: string;
  try {
    const decipher = createDecipheriv(ALGORITHM, keyBytes, ivBytes);
    decipher.setAuthTag(tagBytes);
    plain = Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new GmoTokenCipherError("decrypt", "保存したトークンを復号できません");
  }
  let value: unknown;
  try {
    value = JSON.parse(plain);
  } catch {
    value = undefined;
  }
  const tokens = readStoredTokens(value);
  if (tokens === null) throw new GmoTokenCipherError("format", "保存したトークンの形式が違います");
  return tokens;
}
