/**
 * Why a call to the bank failed. `message` is one owner-facing line (it goes into the import
 * history and the wallet's `bank_api_error`) and never carries a token.
 */
export type GmoApiErrorKind =
  "unauthorized" | "rate_limited" | "bad_request" | "server" | "network" | "invalid_response";

/** A failed call to the account API (19-bank-api §2.4, §3.4). */
export class GmoApiError extends Error {
  readonly kind: GmoApiErrorKind;
  /** HTTP status; `null` when no response came (network, timeout). */
  readonly status: number | null;
  /** GMO's `errorCode` (e.g. `WG_ERR_154` for 429), when the answer carried one. */
  readonly code: string | null;

  constructor(
    kind: GmoApiErrorKind,
    message: string,
    options: { status?: number | null; code?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GmoApiError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

/**
 * A failed call to the token endpoint, or a token answer that could not be trusted (19-bank-api
 * §2.2–§2.4). `error` is the OAuth error code (`invalid_grant`, `invalid_client`, …) or one of
 * ours: `network`, `invalid_response`, `invalid_id_token`.
 */
export class GmoOAuthError extends Error {
  readonly error: string;
  /** HTTP status of the token endpoint; `null` when no response came or it was not the cause. */
  readonly status: number | null;

  constructor(
    error: string,
    message: string,
    options: { status?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GmoOAuthError";
    this.error = error;
    this.status = options.status ?? null;
  }
}

/** Sealed tokens that cannot be opened: another key, a tampered value, or not our format. */
export class GmoTokenCipherError extends Error {
  /** `key`: the key itself is malformed (a configuration error, not a reason to reconnect). */
  readonly reason: "key" | "format" | "decrypt";

  constructor(reason: "key" | "format" | "decrypt", message: string) {
    super(message);
    this.name = "GmoTokenCipherError";
    this.reason = reason;
  }
}
