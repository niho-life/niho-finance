import { GMO_AOZORA_ENVIRONMENTS, type GmoAozoraEnvironment } from "./types";

/** The client registered with GMO for the authorization code flow (19-bank-api §2.2). */
export interface GmoAuthConfig {
  /** Base of `/authorization` and `/token`. */
  authBase: string;
  /** `iss` of the ID Token. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** `client_secret_basic` (default) or `client_secret_post`, as registered with GMO. */
  clientAuth: "basic" | "post";
  redirectUri: string;
}

export interface GmoAozoraConfig {
  env: GmoAozoraEnvironment;
  /** `oauth`: tokens from the authorization code flow; `token`: a fixed sunabar token. */
  mode: "token" | "oauth";
  /** Base of the corporate API (`/accounts`, …), without a trailing `/`. */
  apiBase: string;
  /** `oauth` only. */
  auth: GmoAuthConfig | null;
  /** `token` only. */
  accessToken: string | null;
}

export type GmoAozoraConfigResult =
  | { ok: true; config: GmoAozoraConfig }
  | {
      ok: false;
      /** `unset`: the bank API is not configured; `invalid`: it is, but wrongly. */
      reason: "unset" | "invalid";
      message: string;
      /** Names of the variables to set or fix (never their values). */
      variables: string[];
    };

/** The environment variables of the bank API (19-bank-api §5). */
export const GMO_AOZORA_ENV_VARIABLES = {
  env: "NIHO_FINANCE_GMO_AOZORA_ENV",
  accessToken: "NIHO_FINANCE_GMO_AOZORA_ACCESS_TOKEN",
  clientId: "NIHO_FINANCE_GMO_AOZORA_CLIENT_ID",
  clientSecret: "NIHO_FINANCE_GMO_AOZORA_CLIENT_SECRET",
  clientAuth: "NIHO_FINANCE_GMO_AOZORA_CLIENT_AUTH",
  redirectUri: "NIHO_FINANCE_GMO_AOZORA_REDIRECT_URI",
  apiBase: "NIHO_FINANCE_GMO_AOZORA_API_BASE",
  authBase: "NIHO_FINANCE_GMO_AOZORA_AUTH_BASE",
} as const;

/** The default URLs of each environment (19-bank-api §5). sunabar's authorization is given by URL. */
export const GMO_AOZORA_DEFAULT_URLS: Readonly<
  Record<GmoAozoraEnvironment, { apiBase: string; authBase: string | null; issuer: string | null }>
> = {
  sunabar: {
    apiBase: "https://api.sunabar.gmo-aozora.com/corporation/v1",
    authBase: null,
    issuer: null,
  },
  stg: {
    apiBase: "https://stg-api.gmo-aozora.com/ganb/api/corporation/v1",
    authBase: "https://stg-api.gmo-aozora.com/ganb/api/auth/v1",
    issuer: "https://stg-api.gmo-aozora.com",
  },
  prod: {
    apiBase: "https://api.gmo-aozora.com/ganb/api/corporation/v1",
    authBase: "https://api.gmo-aozora.com/ganb/api/auth/v1",
    issuer: "https://api.gmo-aozora.com",
  },
};

const BANK_DOMAIN = "gmo-aozora.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function isEnvironment(value: string): value is GmoAozoraEnvironment {
  return (GMO_AOZORA_ENVIRONMENTS as readonly string[]).includes(value);
}

/** A trimmed variable; blank counts as unset. */
function read(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * An overriding API / authorization URL: `https://` on `gmo-aozora.com` or a subdomain of it, so
 * tokens are never sent anywhere else. `allowLocalhost` (outside production) also lets a local
 * mock server on `localhost` / `127.0.0.1` through. `null` when the URL is refused.
 */
export function allowedBankUrl(text: string, allowLocalhost: boolean): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const bank =
    url.protocol === "https:" && (host === BANK_DOMAIN || host.endsWith(`.${BANK_DOMAIN}`));
  const local =
    allowLocalhost &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOCAL_HOSTS.has(host);
  return bank || local ? withoutTrailingSlash(url.toString()) : null;
}

/** Our callback URL: `https://`, or `http://localhost` outside production. */
function allowedRedirectUri(text: string, allowLocalhost: boolean): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return allowLocalhost && url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname.toLowerCase());
}

function invalid(message: string, variables: string[]): GmoAozoraConfigResult {
  return { ok: false, reason: "invalid", message, variables };
}

/**
 * The bank API's configuration from the environment (19-bank-api §2.1, §5): unset without
 * `NIHO_FINANCE_GMO_AOZORA_ENV`; `oauth` when a client ID is set, else `token` when an access
 * token is; unset with neither. Missing or malformed values are `invalid`, naming the variables.
 */
export function resolveGmoAozoraConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowLocalhost?: boolean } = {},
): GmoAozoraConfigResult {
  const names = GMO_AOZORA_ENV_VARIABLES;
  const allowLocalhost = options.allowLocalhost ?? false;
  const envName = read(env, names.env);
  if (envName === null) {
    return {
      ok: false,
      reason: "unset",
      message: "銀行 API が設定されていません",
      variables: [names.env],
    };
  }
  if (!isEnvironment(envName)) {
    return invalid(`${names.env} は sunabar・stg・prod のどれかにします`, [names.env]);
  }
  const defaults = GMO_AOZORA_DEFAULT_URLS[envName];

  const apiBaseText = read(env, names.apiBase);
  const apiBase =
    apiBaseText === null ? defaults.apiBase : allowedBankUrl(apiBaseText, allowLocalhost);
  if (apiBase === null) {
    return invalid(`${names.apiBase} は https:// で始まる gmo-aozora.com の URL にします`, [
      names.apiBase,
    ]);
  }

  const clientId = read(env, names.clientId);
  if (clientId !== null) {
    const clientSecret = read(env, names.clientSecret);
    const redirectUri = read(env, names.redirectUri);
    const authBaseText = read(env, names.authBase);
    const missing = [
      ...(clientSecret === null ? [names.clientSecret] : []),
      ...(redirectUri === null ? [names.redirectUri] : []),
      ...(authBaseText === null && defaults.authBase === null ? [names.authBase] : []),
    ];
    if (missing.length > 0) {
      return invalid("銀行 API の認可に要る環境変数が足りません", missing);
    }
    const clientAuth = read(env, names.clientAuth) ?? "basic";
    if (clientAuth !== "basic" && clientAuth !== "post") {
      return invalid(`${names.clientAuth} は basic か post にします`, [names.clientAuth]);
    }
    if (redirectUri === null || !allowedRedirectUri(redirectUri, allowLocalhost)) {
      return invalid(`${names.redirectUri} は https:// で始まる URL にします`, [names.redirectUri]);
    }
    let authBase: string | null;
    let issuer: string | null;
    if (authBaseText === null) {
      authBase = defaults.authBase;
      issuer = defaults.issuer;
    } else {
      authBase = allowedBankUrl(authBaseText, allowLocalhost);
      // An overriding authorization server issues its ID Tokens as its own origin.
      issuer = authBase === null ? null : new URL(authBase).origin;
    }
    if (authBase === null || issuer === null || clientSecret === null) {
      return invalid(`${names.authBase} は https:// で始まる gmo-aozora.com の URL にします`, [
        names.authBase,
      ]);
    }
    return {
      ok: true,
      config: {
        env: envName,
        mode: "oauth",
        apiBase,
        auth: { authBase, issuer, clientId, clientSecret, clientAuth, redirectUri },
        accessToken: null,
      },
    };
  }

  const accessToken = read(env, names.accessToken);
  if (accessToken !== null) {
    return { ok: true, config: { env: envName, mode: "token", apiBase, auth: null, accessToken } };
  }
  return {
    ok: false,
    reason: "unset",
    message: "銀行 API のトークン（sunabar）か認可のクライアントが設定されていません",
    variables: [names.accessToken, names.clientId],
  };
}
