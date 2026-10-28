import {
  buildAuthorizationUrl,
  GmoOAuthError,
  type GmoAozoraConfigResult,
  type GmoAozoraEnvironment,
  type GmoAuthConfig,
  type GmoTokenSet,
} from "@niho-finance/importers";
import {
  BANK_OAUTH_COOKIE,
  BANK_WALLET_ID_PATTERN,
  bankOAuthCookie,
  checkBankOAuthCallback,
  clearedBankOAuthCookie,
  newBankOAuthState,
  randomBankOAuthValue,
  readCookie,
  type BankOAuthCheck,
} from "./oauth-cookie";

/**
 * The authorization code flow of the bank API (19-bank-api §2.2): `GET
 * /api/bank/gmo-aozora/authorize?wallet=<id>` sends the browser to the bank with a fresh `state`
 * and `nonce` in the cookie, and `GET /api/bank/gmo-aozora/callback` checks them, exchanges the
 * code and saves the sealed tokens on the wallet. Either way the browser ends on the connection
 * page with a short code (`?bank=…`); the reasons go to the server log only, never with a token,
 * the code or the client secret. The dependencies are injected for the tests.
 */

/** The outcome the connection page shows (`?bank=<code>`); never a reason text in the URL. */
export const BANK_RETURN_CODES = [
  "authorized",
  "denied",
  "invalid",
  "failed",
  "unavailable",
] as const;
export type BankReturnCode = (typeof BANK_RETURN_CODES)[number];

export function isBankReturnCode(value: unknown): value is BankReturnCode {
  return typeof value === "string" && (BANK_RETURN_CODES as readonly string[]).includes(value);
}

/** 銀行 API の接続 of a wallet, with the outcome of the authorization. */
export function bankLinkPath(walletId: string, code?: BankReturnCode): string {
  const path = `/settings/wallets/${encodeURIComponent(walletId)}/bank`;
  return code ? `${path}?bank=${code}` : path;
}

export interface BankAuthorizeDependencies {
  /** `active` / `inactive` for a bank wallet, `null` for anything else. */
  walletState: (walletId: string) => Promise<"active" | "inactive" | null>;
  config: () => GmoAozoraConfigResult;
  /** Whether the key the tokens are sealed with (`NIHO_FINANCE_BANK_TOKEN_KEY`) is set. */
  hasTokenKey: () => boolean;
  /** `Secure` on the cookie: production. */
  secure: () => boolean;
  now?: () => Date;
  random?: () => string;
}

export interface BankCallbackDependencies {
  config: () => GmoAozoraConfigResult;
  /** `exchangeAuthorizationCode`: the ID Token (and its `nonce`) is verified inside. */
  exchange: (auth: GmoAuthConfig, code: string, nonce: string) => Promise<GmoTokenSet>;
  /** `saveBankAuthorization` as the screens' actor. */
  save: (input: {
    walletId: string;
    env: GmoAozoraEnvironment;
    tokens: GmoTokenSet;
  }) => Promise<void>;
  secure: () => boolean;
  now?: () => Date;
}

const NO_STORE = "no-store";

/** The callback refused before anything else (400): what happened and how to start again. */
const REFUSALS: Readonly<Record<Extract<BankOAuthCheck, { ok: false }>["reason"], string>> = {
  missing:
    "銀行の認可の途中の情報が見つかりません。銀行 API の接続の画面から、もう一度「接続する」を押してください",
  malformed:
    "銀行の認可の途中の情報が読めません。銀行 API の接続の画面から、もう一度「接続する」を押してください",
  expired:
    "銀行の認可の期限（10 分）が切れました。銀行 API の接続の画面から、もう一度「接続する」を押してください",
  state:
    "銀行の認可の応答が、この画面で始めた認可と一致しません。銀行 API の接続の画面から、もう一度「接続する」を押してください",
};

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location, "cache-control": NO_STORE });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function badRequest(text: string, cookie: string): Response {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": NO_STORE,
  });
  headers.append("set-cookie", cookie);
  return new Response(text, { status: 400, headers });
}

/** A log line without the given secrets, nor anything shaped like a token. */
export function redactBankLog(text: string, secrets: readonly string[] = []): string {
  let masked = text;
  for (const secret of secrets) if (secret !== "") masked = masked.split(secret).join("***");
  return (
    masked
      // JWTs (ID Tokens) and Authorization headers.
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, "[redacted]")
      .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted]")
      // Long opaque runs (access / refresh tokens, codes) and account IDs.
      .replace(/[A-Za-z0-9_\-~+/]{32,}={0,2}/g, "[redacted]")
      .replace(/\d{10,}/g, "***")
  );
}

function describe(error: unknown, secrets: readonly string[]): string {
  if (error instanceof GmoOAuthError) {
    return redactBankLog(`${error.name}(${error.error}): ${error.message}`, secrets);
  }
  if (error instanceof Error) return redactBankLog(`${error.name}: ${error.message}`, secrets);
  return "non-Error thrown";
}

/** `GET /api/bank/gmo-aozora/authorize?wallet=<id>` (19-bank-api §2.2 step 1). */
export async function handleBankAuthorize(
  request: Request,
  dependencies: BankAuthorizeDependencies,
): Promise<Response> {
  const walletId = new URL(request.url).searchParams.get("wallet") ?? "";
  if (!BANK_WALLET_ID_PATTERN.test(walletId)) return redirect("/settings/wallets");
  const wallet = await dependencies.walletState(walletId);
  if (wallet === null) return redirect("/settings/wallets");
  const resolved = dependencies.config();
  if (
    wallet !== "active" ||
    !resolved.ok ||
    resolved.config.mode !== "oauth" ||
    resolved.config.auth === null ||
    !dependencies.hasTokenKey()
  ) {
    return redirect(bankLinkPath(walletId, "unavailable"));
  }
  const now = dependencies.now?.() ?? new Date();
  const value = newBankOAuthState(walletId, now, dependencies.random ?? randomBankOAuthValue);
  return redirect(
    buildAuthorizationUrl(resolved.config.auth, { state: value.state, nonce: value.nonce }),
    bankOAuthCookie(value, { secure: dependencies.secure() }),
  );
}

/** `GET /api/bank/gmo-aozora/callback?code=…&state=…` (19-bank-api §2.2 steps 2–5). */
export async function handleBankCallback(
  request: Request,
  dependencies: BankCallbackDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const cleared = clearedBankOAuthCookie({ secure: dependencies.secure() });
  const check = checkBankOAuthCallback(
    readCookie(request.headers.get("cookie"), BANK_OAUTH_COOKIE),
    url.searchParams.get("state"),
    dependencies.now?.() ?? new Date(),
  );
  if (!check.ok) {
    console.error(
      `[niho-finance] bank authorization callback refused (${check.reason})${check.walletId ? ` for wallet ${check.walletId}` : ""}`,
    );
    return badRequest(REFUSALS[check.reason], cleared);
  }
  const back = (code: BankReturnCode) => redirect(bankLinkPath(check.walletId, code), cleared);

  const error = url.searchParams.get("error");
  if (error !== null) {
    // The error code only (e.g. access_denied): its description is the bank's free text.
    const code = /^[A-Za-z0-9_.-]{1,64}$/.test(error) ? error : "unknown";
    console.error(
      `[niho-finance] bank authorization not completed for wallet ${check.walletId} (${code})`,
    );
    return back("denied");
  }
  const code = url.searchParams.get("code");
  if (code === null || code === "") {
    console.error(
      `[niho-finance] bank authorization callback without a code for wallet ${check.walletId}`,
    );
    return back("failed");
  }
  const resolved = dependencies.config();
  if (!resolved.ok || resolved.config.mode !== "oauth" || resolved.config.auth === null) {
    console.error("[niho-finance] bank authorization callback: the bank API is not configured");
    return back("unavailable");
  }
  const { auth, env } = resolved.config;
  const secrets = [code, auth.clientSecret];

  let tokens: GmoTokenSet;
  try {
    tokens = await dependencies.exchange(auth, code, check.nonce);
  } catch (exchangeError) {
    console.error(
      `[niho-finance] bank authorization of wallet ${check.walletId} failed: ${describe(exchangeError, secrets)}`,
    );
    const invalid =
      exchangeError instanceof GmoOAuthError && exchangeError.error === "invalid_id_token";
    return back(invalid ? "invalid" : "failed");
  }
  try {
    await dependencies.save({ walletId: check.walletId, env, tokens });
  } catch (saveError) {
    const tokenValues = [tokens.accessToken, tokens.refreshToken ?? "", tokens.idToken ?? ""];
    console.error(
      `[niho-finance] bank authorization of wallet ${check.walletId} could not be saved: ${describe(saveError, [...secrets, ...tokenValues])}`,
    );
    return back("failed");
  }
  return back("authorized");
}
