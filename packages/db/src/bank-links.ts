/**
 * Bank API connections and sync (19-bank-api): a bank wallet connected to its account at GMO
 * あおぞらネット銀行, and the daily sync of the account's statement lines. The tokens are sealed
 * on the wallet (AES-256-GCM, the key in `NIHO_FINANCE_BANK_TOKEN_KEY`); neither they nor the
 * bank's account ID are ever logged, audited, shown or backed up. Expected failures (the bank
 * refusing the token, a rate limit, a network error) are recorded as a batch with `error` and on
 * the wallet, and returned, never thrown; a refused token marks the wallet 再接続が必要.
 */
import {
  checkBalanceContinuity,
  convertGmoTransaction,
  createGmoAozoraApi,
  fetchAllTransactions,
  GMO_AOZORA_ENV_VARIABLES,
  GMO_AOZORA_ENVIRONMENT_LABELS,
  GMO_AOZORA_ENVIRONMENTS,
  GmoApiError,
  GmoOAuthError,
  GmoTokenCipherError,
  isYenOrdinaryAccount,
  maskAccountLabel,
  matchExistingLines,
  openTokens,
  refreshAccessToken,
  resolveGmoAozoraConfig,
  sealTokens,
  toStoredTokens,
  type GmoAozoraApi,
  type GmoAozoraConfig,
  type GmoAozoraConfigResult,
  type GmoAozoraEnvironment,
  type GmoAuthConfig,
  type GmoBalance,
  type GmoFetch,
  type GmoTokenSet,
  type RowFailure,
  type StoredTokens,
  type WalletTransactionDraft,
} from "@niho-finance/importers";
import { addDays, isCalendarDate, type CalendarDate, type Money } from "@niho-finance/ledger";
import type { Prisma, Wallet } from "@prisma/client";
import { appendAuditLog, toAuditJson, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, toDbDate, todayInJapan } from "./dates";
import { loadRootEnv } from "./env";
import { SettingsError } from "./errors";
import { newId } from "./ids";
import {
  finishImportBatch,
  getImportBatch,
  insertWalletTransactions,
  type ImportBatchSummary,
  type ImportOptions,
  type ImportOutcome,
} from "./imports";
import {
  bankAccountChoiceSchema,
  bankWalletInputSchema,
  type BankAccountChoiceInput,
  type BankWalletInput,
} from "./schemas";
import type { WriteOptions } from "./settings";
import { lockSettings, runInTransaction } from "./transaction";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const BANK_API_STATUSES = ["authorized", "connected", "reauth_required"] as const;
/** `authorized`: 口座の選択待ち; `connected`; `reauth_required`: 再接続が必要. */
export type BankApiStatus = (typeof BANK_API_STATUSES)[number];

/** The variable that holds the key the tokens are sealed with (19-bank-api §5). */
export const BANK_TOKEN_KEY_VARIABLE = "NIHO_FINANCE_BANK_TOKEN_KEY";

export interface BankLinkSettings {
  walletId: string;
  walletName: string;
  env: GmoAozoraEnvironment | null;
  status: BankApiStatus | null;
  /** 「支店名 科目名 ••••末尾 4 桁」 (never the account ID). */
  accountLabel: string | null;
  /** The last day fetched so far (取得済みの期間). */
  syncedThrough: CalendarDate | null;
  lastSyncedAt: Date | null;
  /** The bank's balance and its base date. */
  balance: Money | null;
  balanceDate: CalendarDate | null;
  /** Why the last sync failed. */
  error: string | null;
  /** The latest bank API batches, newest first (直近の同期). */
  recentBatches: ImportBatchSummary[];
}

export interface BankApiOptions {
  /** The bank's API; by default built from the configuration and the wallet's tokens. */
  api?: GmoAozoraApi;
  /** By default read from the environment (`resolveBankApiConfig`). */
  config?: GmoAozoraConfig;
  /** The key the tokens are sealed with; by default `NIHO_FINANCE_BANK_TOKEN_KEY`. */
  key?: string;
  /** `fetch` of the calls to the bank (tests). */
  fetch?: GmoFetch;
}

export interface BankSyncOptions extends ImportOptions, BankApiOptions {}

export interface BankSyncAllOptions extends ImportOptions, Omit<BankApiOptions, "api"> {
  now?: Date;
  /** The API of a wallet; built from the configuration when it returns `undefined`. */
  apiFor?: (walletId: string) => GmoAozoraApi | undefined;
}

export interface LinkableBankAccount {
  /** The radio's value; checked again on 「この口座を接続する」. Not shown. */
  accountId: string;
  label: string;
  /** The wallet this account is already connected to (the radio is disabled). */
  linkedWalletName: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMPORTER = "gmo_aozora";
/** Each sync reads again the 3 days before what it fetched so far (19-bank-api §3.1). */
const OVERLAP_DAYS = 3;
/** The first sync of a wallet without lines fetches 30 days. */
const FIRST_SYNC_DAYS = 30;
/** The access token is refreshed 5 minutes before it expires (19-bank-api §2.3). */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const RECENT_BATCHES = 5;
/** `ImportBatch.error` and `bank_api_error` are one line of at most this many characters. */
const MAX_ERROR_LENGTH = 500;

const NO_WALLET = "口座が見つかりません。画面を読み込み直してください";
const NOT_BANK_WALLET = "銀行の口座ではありません。種類が 銀行 の口座を選んでください";
const INACTIVE_WALLET = "この口座は無効です。設定 › 口座 で有効にしてください";
const NOT_CONNECTED = "銀行 API が接続されていません。銀行 API の接続で接続してください";
const NO_ACCOUNT_CHOSEN =
  "接続する銀行の口座が選ばれていません。銀行 API の接続で口座を選んでください";
const REAUTH_REQUIRED = "銀行 API の再接続が必要です";
const NO_AUTHORIZATION = "銀行 API の認可がありません。再接続してください";
const BALANCE_UNAVAILABLE = "銀行の残高を取得できませんでした";

/** The bank API cannot be used for the wallet until it is reconnected (19-bank-api §2.4). */
class BankReauthRequired extends Error {}
/** The bank API is not set up where this runs: not the connection's fault, no reconnection. */
class BankSetupProblem extends Error {}

// ---------------------------------------------------------------------------
// Configuration and wallets
// ---------------------------------------------------------------------------

/**
 * The bank API's configuration (19-bank-api §5) after the repository `.env`: a local mock server
 * on localhost is allowed unless `NIHO_FINANCE_ENV=prod`.
 */
export function resolveBankApiConfig(env: NodeJS.ProcessEnv = process.env): GmoAozoraConfigResult {
  loadRootEnv();
  return resolveGmoAozoraConfig(env, { allowLocalhost: env.NIHO_FINANCE_ENV !== "prod" });
}

/** `NIHO_FINANCE_BANK_TOKEN_KEY`, or `null` when it is not set. */
export function resolveBankTokenKey(env: NodeJS.ProcessEnv = process.env): string | null {
  loadRootEnv();
  const value = env[BANK_TOKEN_KEY_VARIABLE]?.trim();
  return value ? value : null;
}

function bankApiStatusOf(value: string | null): BankApiStatus | null {
  return BANK_API_STATUSES.find((status) => status === value) ?? null;
}

function bankApiEnvOf(value: string | null): GmoAozoraEnvironment | null {
  return GMO_AOZORA_ENVIRONMENTS.find((env) => env === value) ?? null;
}

function envLabel(env: GmoAozoraEnvironment | null): string {
  return env === null ? "不明" : GMO_AOZORA_ENVIRONMENT_LABELS[env];
}

/** A bank wallet (active ones only unless `active` is false); anything else is refused. */
async function loadBankWallet(db: Db, walletId: string, active = true): Promise<Wallet> {
  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw new SettingsError(NO_WALLET, { field: "walletId" });
  if (wallet.kind !== "bank") throw new SettingsError(NOT_BANK_WALLET, { field: "walletId" });
  if (active && !wallet.isActive) throw new SettingsError(INACTIVE_WALLET, { field: "walletId" });
  return wallet;
}

type LinkColumns = Pick<
  Wallet,
  | "bankApiEnv"
  | "bankApiStatus"
  | "bankApiAccountLabel"
  | "bankApiSyncedThrough"
  | "bankApiLastSyncedAt"
  | "bankApiError"
>;

/** The connection as audited: its state and label, never the tokens or the account ID. */
function linkSnapshot(wallet: LinkColumns) {
  return {
    env: wallet.bankApiEnv,
    status: wallet.bankApiStatus,
    accountLabel: wallet.bankApiAccountLabel,
    syncedThrough: fromDbDateOrNull(wallet.bankApiSyncedThrough),
    lastSyncedAt: wallet.bankApiLastSyncedAt,
    error: wallet.bankApiError,
  };
}

/** The columns of a connection, all cleared (接続を外す / another environment). */
const NO_LINK = {
  bankApiEnv: null,
  bankApiStatus: null,
  bankApiAccountId: null,
  bankApiAccountLabel: null,
  bankApiTokens: null,
  bankApiSyncedThrough: null,
  bankApiLastSyncedAt: null,
  bankApiBalance: null,
  bankApiBalanceDate: null,
  bankApiError: null,
} as const satisfies Prisma.WalletUncheckedUpdateInput;

/** What was fetched for another account: cleared when the wallet is pointed at a new one. */
const NO_SYNC = {
  bankApiSyncedThrough: null,
  bankApiLastSyncedAt: null,
  bankApiBalance: null,
  bankApiBalanceDate: null,
} as const satisfies Prisma.WalletUncheckedUpdateInput;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The connection of a bank wallet (接続ページ); `null` for a wallet that is not a bank's. */
export async function getBankLink(db: Db, walletId: string): Promise<BankLinkSettings | null> {
  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  if (!wallet || wallet.kind !== "bank") return null;
  const batchIds = await db.importBatch.findMany({
    where: { walletId: wallet.id, source: "api" },
    orderBy: [{ executedAt: "desc" }, { id: "desc" }],
    take: RECENT_BATCHES,
    select: { id: true },
  });
  const recentBatches: ImportBatchSummary[] = [];
  for (const { id } of batchIds) {
    const batch = await getImportBatch(db, id);
    if (batch === null) continue;
    const { failures: _failures, warnings: _warnings, ...summary } = batch;
    recentBatches.push(summary);
  }
  return {
    walletId: wallet.id,
    walletName: wallet.name,
    env: bankApiEnvOf(wallet.bankApiEnv),
    status: bankApiStatusOf(wallet.bankApiStatus),
    accountLabel: wallet.bankApiAccountLabel,
    syncedThrough: fromDbDateOrNull(wallet.bankApiSyncedThrough),
    lastSyncedAt: wallet.bankApiLastSyncedAt,
    balance: wallet.bankApiBalance,
    balanceDate: fromDbDateOrNull(wallet.bankApiBalanceDate),
    error: wallet.bankApiError,
    recentBatches,
  };
}

/** The state of every bank wallet that has a connection (設定 › 口座, ホーム). */
export async function listBankLinkStatuses(
  db: Db,
): Promise<{ walletId: string; status: BankApiStatus }[]> {
  const wallets = await db.wallet.findMany({
    where: { kind: "bank", bankApiStatus: { not: null } },
    orderBy: { id: "asc" },
    select: { id: true, bankApiStatus: true },
  });
  return wallets.flatMap((wallet) => {
    const status = bankApiStatusOf(wallet.bankApiStatus);
    return status === null ? [] : [{ walletId: wallet.id, status }];
  });
}

// ---------------------------------------------------------------------------
// The API for a wallet: configuration, tokens and their refresh
// ---------------------------------------------------------------------------

interface BankConnection {
  api: GmoAozoraApi;
  /** The token values in use, masked out of any message that is kept. */
  secrets(): string[];
}

function openStoredTokens(sealed: string, key: string): StoredTokens {
  try {
    return openTokens(sealed, key);
  } catch (error) {
    if (error instanceof GmoTokenCipherError && error.reason === "key") {
      throw new BankSetupProblem(`${error.message}（環境変数 ${BANK_TOKEN_KEY_VARIABLE}）`);
    }
    if (error instanceof GmoTokenCipherError) {
      throw new BankReauthRequired(
        "保存したトークンを復号できません（暗号鍵が変わりました）。再接続してください",
      );
    }
    throw error;
  }
}

/** The refresh token is revoked or the client refused: only a new authorization helps. */
function isRevoked(error: unknown): error is GmoOAuthError {
  return (
    error instanceof GmoOAuthError &&
    (error.error === "invalid_grant" || error.error === "invalid_client" || error.status === 401)
  );
}

/**
 * The wallet's sealed tokens, refreshed when they are about to expire or the API answers 401
 * (19-bank-api §2.3). A refresh is stored only over the tokens it read (compare-and-set): when
 * another sync refreshed first, its stored tokens are used instead, so a single-use refresh
 * token never revokes the other's.
 */
function tokenSession(
  db: Db,
  walletId: string,
  storedSealed: string,
  key: string,
  auth: GmoAuthConfig,
  context: { fetch: GmoFetch | undefined; now: Date },
) {
  let sealed = storedSealed;
  let tokens = openStoredTokens(sealed, key);
  const seen = new Set<string>();
  const remember = (stored: StoredTokens) => {
    seen.add(stored.accessToken);
    if (stored.refreshToken) seen.add(stored.refreshToken);
  };
  remember(tokens);

  /** Takes the tokens stored by someone else since they were read; false when there are none. */
  async function adoptStored(): Promise<boolean> {
    const row = await db.wallet.findUnique({
      where: { id: walletId },
      select: { bankApiTokens: true },
    });
    if (!row?.bankApiTokens || row.bankApiTokens === sealed) return false;
    sealed = row.bankApiTokens;
    tokens = openStoredTokens(sealed, key);
    remember(tokens);
    return true;
  }

  async function refresh(): Promise<void> {
    const refreshToken = tokens.refreshToken;
    if (!refreshToken) {
      if (await adoptStored()) return;
      throw new BankReauthRequired("リフレッシュトークンがありません。再接続してください");
    }
    let answer: GmoTokenSet;
    try {
      answer = await refreshAccessToken(auth, refreshToken, context);
    } catch (error) {
      if (isRevoked(error)) {
        // Another sync may have used the refresh token first: its stored tokens are good.
        if (await adoptStored()) return;
        throw new BankReauthRequired(
          `銀行のトークンを更新できませんでした（${error.error}）。再接続してください`,
        );
      }
      throw error;
    }
    const next: StoredTokens = {
      ...toStoredTokens(answer),
      // No new refresh token: the one used goes on (19-bank-api §2.3).
      refreshToken: answer.refreshToken ?? refreshToken,
      scope: answer.scope === "" ? tokens.scope : answer.scope,
    };
    remember(next);
    const nextSealed = sealTokens(next, key);
    const { count } = await db.wallet.updateMany({
      where: { id: walletId, bankApiTokens: sealed },
      data: { bankApiTokens: nextSealed },
    });
    if (count === 1) {
      sealed = nextSealed;
      tokens = next;
      return;
    }
    // Lost to a concurrent refresh: the tokens it stored win.
    if (await adoptStored()) return;
    throw new BankReauthRequired(NO_AUTHORIZATION);
  }

  return {
    accessToken: async (): Promise<string> => {
      const expiresAt = Date.parse(tokens.accessTokenExpiresAt);
      if (expiresAt - REFRESH_MARGIN_MS <= context.now.getTime()) await refresh();
      return tokens.accessToken;
    },
    onUnauthorized: async (): Promise<string | null> => {
      await refresh();
      return tokens.accessToken;
    },
    secrets: () => [...seen],
  };
}

function configOrProblem(options: BankApiOptions): GmoAozoraConfig {
  if (options.config) return options.config;
  const resolved = resolveBankApiConfig();
  if (resolved.ok) return resolved.config;
  throw new BankSetupProblem(
    `${resolved.message}（環境変数 ${resolved.variables.join("・")}）。設定してから、もう一度同期してください`,
  );
}

function environmentMismatch(
  connected: GmoAozoraEnvironment | null,
  current: GmoAozoraEnvironment,
): BankReauthRequired {
  return new BankReauthRequired(
    `接続した環境（${envLabel(connected)}）と今の環境（${envLabel(current)}）が違います。再接続してください`,
  );
}

/**
 * The bank API for a connected wallet: the sunabar token as configured, or the wallet's sealed
 * tokens with their refresh. Throws `BankReauthRequired` (another environment, no tokens, tokens
 * that do not open) or `BankSetupProblem` (no configuration, no key). An `api` given in `options`
 * is used as it is (the environment is checked only against a given `config`).
 */
function connect(
  db: Db,
  wallet: Pick<Wallet, "id" | "bankApiEnv" | "bankApiTokens">,
  options: BankApiOptions,
  now: Date,
): BankConnection {
  const connected = bankApiEnvOf(wallet.bankApiEnv);
  if (options.api) {
    if (options.config && options.config.env !== connected) {
      throw environmentMismatch(connected, options.config.env);
    }
    return { api: options.api, secrets: () => [] };
  }
  const config = configOrProblem(options);
  if (config.env !== connected) throw environmentMismatch(connected, config.env);
  if (config.mode === "token" || config.auth === null) {
    const token = config.accessToken ?? "";
    return {
      api: createGmoAozoraApi({
        apiBase: config.apiBase,
        accessToken: () => Promise.resolve(token),
        fetch: options.fetch,
      }),
      secrets: () => [token],
    };
  }
  const key = options.key ?? resolveBankTokenKey();
  if (key === null) {
    throw new BankSetupProblem(
      `トークンの暗号鍵がありません（環境変数 ${BANK_TOKEN_KEY_VARIABLE}）。設定してから、もう一度同期してください`,
    );
  }
  if (wallet.bankApiTokens === null) throw new BankReauthRequired(NO_AUTHORIZATION);
  const session = tokenSession(db, wallet.id, wallet.bankApiTokens, key, config.auth, {
    fetch: options.fetch,
    now,
  });
  return {
    api: createGmoAozoraApi({
      apiBase: config.apiBase,
      accessToken: session.accessToken,
      onUnauthorized: session.onUnauthorized,
      fetch: options.fetch,
    }),
    secrets: session.secrets,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One line of at most 500 characters, with the tokens in use masked. */
function storedMessage(text: string, secrets: readonly string[]): string {
  let masked = text;
  for (const secret of secrets) if (secret !== "") masked = masked.split(secret).join("***");
  const line = masked.replace(/\s+/g, " ").trim();
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line;
}

/** Why a sync could not fetch (19-bank-api §2.4, §3.4), and whether it needs a reconnection. */
function failureOf(error: unknown, secrets: readonly string[]): { error: string; reauth: boolean } {
  if (error instanceof BankReauthRequired) return { error: error.message, reauth: true };
  if (error instanceof BankSetupProblem) return { error: error.message, reauth: false };
  if (error instanceof GmoApiError) {
    return error.kind === "unauthorized"
      ? { error: storedMessage(`${error.message}。再接続してください`, secrets), reauth: true }
      : { error: storedMessage(error.message, secrets), reauth: false };
  }
  if (error instanceof GmoOAuthError) {
    return {
      error: storedMessage(`${error.message}。時間をおいて、もう一度同期してください`, secrets),
      reauth: false,
    };
  }
  return {
    error: storedMessage(
      `銀行 API から明細を取得できませんでした。時間をおいて、もう一度同期してください（${messageOf(error)}）`,
      secrets,
    ),
    reauth: false,
  };
}

/** For the screens: a failure to reach the bank while connecting is a refusal of the request. */
function settingsErrorOf(error: unknown, secrets: readonly string[]): unknown {
  if (
    error instanceof BankReauthRequired ||
    error instanceof BankSetupProblem ||
    error instanceof GmoApiError ||
    error instanceof GmoOAuthError
  ) {
    return new SettingsError(failureOf(error, secrets).error, { field: "walletId" });
  }
  return error;
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/**
 * 認可 (19-bank-api §2.2 step 5, and the sunabar token checked on the spot): saves the tokens
 * sealed (`null` for the token method) and the environment (`wallet.authorize_bank`). A
 * reconnection in the same environment keeps the account and the period fetched, and is
 * `connected` again; otherwise the wallet waits for 口座の選択 (`authorized`).
 */
export async function saveBankAuthorization(
  db: Db,
  input: BankWalletInput & { env: GmoAozoraEnvironment; tokens: GmoTokenSet | null },
  options: WriteOptions & { key?: string },
): Promise<void> {
  const { walletId } = bankWalletInputSchema.parse(input);
  if (!GMO_AOZORA_ENVIRONMENTS.includes(input.env)) {
    throw new SettingsError("銀行 API の環境が正しくありません（sunabar・stg・prod）");
  }
  let sealed: string | null = null;
  if (input.tokens !== null) {
    const key = options.key ?? resolveBankTokenKey();
    if (key === null) {
      throw new SettingsError(
        `トークンの暗号鍵がありません。環境変数 ${BANK_TOKEN_KEY_VARIABLE} を設定してから接続してください`,
      );
    }
    try {
      sealed = sealTokens(toStoredTokens(input.tokens), key);
    } catch (error) {
      if (error instanceof GmoTokenCipherError) {
        throw new SettingsError(`${error.message}（環境変数 ${BANK_TOKEN_KEY_VARIABLE}）`);
      }
      throw error;
    }
  }
  await runInTransaction(db, async (tx) => {
    const wallet = await loadBankWallet(tx, walletId);
    const reconnecting =
      bankApiStatusOf(wallet.bankApiStatus) !== null &&
      wallet.bankApiEnv === input.env &&
      wallet.bankApiAccountId !== null;
    const data: Prisma.WalletUncheckedUpdateInput = reconnecting
      ? { bankApiTokens: sealed, bankApiStatus: "connected", bankApiError: null }
      : { ...NO_LINK, bankApiEnv: input.env, bankApiTokens: sealed, bankApiStatus: "authorized" };
    const updated = await tx.wallet.update({ where: { id: wallet.id }, data });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "wallet.authorize_bank",
      entity: "wallet",
      entityId: wallet.id,
      before: linkSnapshot(wallet),
      after: linkSnapshot(updated),
    });
  });
}

/**
 * 「接続する」/「再接続する」 of the token method (sunabar, 19-bank-api §1.1, §2.1): the token in
 * the environment is tried on the bank first (its account list must come back), and only then
 * saved as the wallet's authorization (`saveBankAuthorization` without tokens). A token the bank
 * refuses, or a bank that cannot be reached, is refused with the reason; nothing is saved.
 */
export async function authorizeBankToken(
  db: Db,
  input: BankWalletInput,
  options: WriteOptions & Pick<BankApiOptions, "api" | "config" | "fetch">,
): Promise<void> {
  const { walletId } = bankWalletInputSchema.parse(input);
  let config = options.config;
  if (!config) {
    const resolved = resolveBankApiConfig();
    if (!resolved.ok) {
      throw new SettingsError(
        `${resolved.message}（環境変数 ${resolved.variables.join("・")}）。設定してから接続してください`,
      );
    }
    config = resolved.config;
  }
  const token = config.accessToken;
  if (config.mode !== "token" || token === null) {
    throw new SettingsError(
      "この環境は銀行の認可画面から接続します。画面を読み込み直して「接続する」を押してください",
    );
  }
  await loadBankWallet(db, walletId);
  const api =
    options.api ??
    createGmoAozoraApi({
      apiBase: config.apiBase,
      accessToken: () => Promise.resolve(token),
      fetch: options.fetch,
    });
  try {
    await api.listAccounts();
  } catch (error) {
    if (error instanceof GmoApiError && error.kind === "unauthorized") {
      throw new SettingsError(
        storedMessage(
          `${error.message}。sunabar にログインしてトークンを確かめ、環境変数 ${GMO_AOZORA_ENV_VARIABLES.accessToken} を差し替えてから、もう一度接続してください`,
          [token],
        ),
        { field: "walletId" },
      );
    }
    if (error instanceof GmoApiError) {
      throw new SettingsError(storedMessage(error.message, [token]), { field: "walletId" });
    }
    throw error;
  }
  await saveBankAuthorization(
    db,
    { walletId, env: config.env, tokens: null },
    { actor: options.actor },
  );
}

/** An authorized wallet with the bank API to ask; 再接続が必要 or not connected is refused. */
async function loadAuthorizedWallet(
  db: Db,
  walletId: string,
): Promise<{ wallet: Wallet; env: GmoAozoraEnvironment }> {
  const wallet = await loadBankWallet(db, walletId);
  const status = bankApiStatusOf(wallet.bankApiStatus);
  const env = bankApiEnvOf(wallet.bankApiEnv);
  if (status === null || env === null) {
    throw new SettingsError(NOT_CONNECTED, { field: "walletId" });
  }
  if (status === "reauth_required") {
    throw new SettingsError(`${REAUTH_REQUIRED}。再接続してから口座を選んでください`, {
      field: "walletId",
    });
  }
  return { wallet, env };
}

/** The yen ordinary accounts the bank lists for the wallet's tokens, and their wallets. */
async function linkableAccounts(
  db: Db,
  wallet: Wallet,
  env: GmoAozoraEnvironment,
  connection: BankConnection,
): Promise<LinkableBankAccount[]> {
  let accounts;
  try {
    accounts = (await connection.api.listAccounts()).filter(isYenOrdinaryAccount);
  } catch (error) {
    throw settingsErrorOf(error, connection.secrets());
  }
  const linked = await db.wallet.findMany({
    where: {
      id: { not: wallet.id },
      bankApiEnv: env,
      bankApiAccountId: { in: accounts.map((account) => account.accountId) },
    },
    orderBy: { id: "asc" },
    select: { name: true, bankApiAccountId: true },
  });
  return accounts.map((account) => ({
    accountId: account.accountId,
    label: maskAccountLabel(account),
    linkedWalletName:
      linked.find((other) => other.bankApiAccountId === account.accountId)?.name ?? null,
  }));
}

function connectOrSettingsError(
  db: Db,
  wallet: Wallet,
  options: BankApiOptions,
  now: Date,
): BankConnection {
  try {
    return connect(db, wallet, options, now);
  } catch (error) {
    throw settingsErrorOf(error, []);
  }
}

/** 口座の選択 (19-bank-api §1.1): the bank's yen ordinary accounts, with those taken marked. */
export async function listLinkableBankAccounts(
  db: Db,
  input: BankWalletInput,
  options: BankApiOptions & { now?: Date } = {},
): Promise<LinkableBankAccount[]> {
  const { walletId } = bankWalletInputSchema.parse(input);
  const { wallet, env } = await loadAuthorizedWallet(db, walletId);
  const connection = connectOrSettingsError(db, wallet, options, options.now ?? new Date());
  return linkableAccounts(db, wallet, env, connection);
}

/**
 * 「この口座を接続する」 (`wallet.connect_bank`): the account must be listed for the wallet's
 * tokens now and not connected to another wallet; then the first sync runs (19-bank-api §3.1)
 * and its outcome is returned. Another account than before starts the period over.
 */
export async function connectBankAccount(
  db: Db,
  input: BankAccountChoiceInput & { now?: Date },
  options: BankSyncOptions,
): Promise<ImportOutcome> {
  const data = bankAccountChoiceSchema.parse(input);
  const now = input.now ?? new Date();
  const { wallet, env } = await loadAuthorizedWallet(db, data.walletId);
  const connection = connectOrSettingsError(db, wallet, options, now);
  const accounts = await linkableAccounts(db, wallet, env, connection);
  const chosen = accounts.find((account) => account.accountId === data.accountId);
  if (!chosen) {
    throw new SettingsError(
      "選んだ口座は銀行 API の口座一覧にありません。画面を読み込み直して、口座を選び直してください",
      { field: "accountId" },
    );
  }
  const alreadyLinked = (name: string) =>
    new SettingsError(
      `この口座は「${name}」に接続済みです。同じ口座を 2 つの口座に接続すると明細が二重になります`,
      { field: "accountId" },
    );
  if (chosen.linkedWalletName !== null) throw alreadyLinked(chosen.linkedWalletName);

  await runInTransaction(db, async (tx) => {
    await lockSettings(tx, "bankLinks");
    const current = await loadBankWallet(tx, wallet.id);
    const other = await tx.wallet.findFirst({
      where: { id: { not: wallet.id }, bankApiEnv: env, bankApiAccountId: chosen.accountId },
      select: { name: true },
    });
    if (other) throw alreadyLinked(other.name);
    const updated = await tx.wallet.update({
      where: { id: current.id },
      data: {
        bankApiAccountId: chosen.accountId,
        bankApiAccountLabel: chosen.label,
        bankApiStatus: "connected",
        bankApiError: null,
        ...(current.bankApiAccountId === chosen.accountId ? {} : NO_SYNC),
      },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "wallet.connect_bank",
      entity: "wallet",
      entityId: current.id,
      before: linkSnapshot(current),
      after: linkSnapshot(updated),
    });
  });
  return syncBankWallet(db, { walletId: wallet.id, now }, { ...options, api: connection.api });
}

/**
 * 接続を外す (`wallet.disconnect_bank`): every column of the connection is cleared, the tokens
 * with them. The lines and batches stay. A wallet without a connection is left as it is.
 */
export async function disconnectBankLink(
  db: Db,
  input: BankWalletInput,
  options: WriteOptions,
): Promise<void> {
  const { walletId } = bankWalletInputSchema.parse(input);
  await runInTransaction(db, async (tx) => {
    const wallet = await loadBankWallet(tx, walletId, false);
    if (wallet.bankApiStatus === null && wallet.bankApiEnv === null) return;
    await tx.wallet.update({ where: { id: wallet.id }, data: NO_LINK });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "wallet.disconnect_bank",
      entity: "wallet",
      entityId: wallet.id,
      before: linkSnapshot(wallet),
    });
  });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * The period to fetch (19-bank-api §3.1), JST days up to today: from 3 days before the last day
 * fetched; on the first sync, 3 days before the wallet's latest line, or 30 days without lines.
 * Never before the wallet's statement opening date.
 */
async function syncPeriodOf(
  db: Db,
  wallet: Pick<Wallet, "id" | "bankApiSyncedThrough" | "openingBalanceDate">,
  today: CalendarDate,
): Promise<{ from: CalendarDate; to: CalendarDate }> {
  const syncedThrough = fromDbDateOrNull(wallet.bankApiSyncedThrough);
  let from: CalendarDate;
  if (syncedThrough !== null) {
    from = addDays(syncedThrough, -OVERLAP_DAYS);
  } else {
    const latest = await db.walletTransaction.findFirst({
      where: { walletId: wallet.id },
      orderBy: [{ txnDate: "desc" }, { id: "desc" }],
      select: { txnDate: true },
    });
    from = latest
      ? addDays(fromDbDate(latest.txnDate), -OVERLAP_DAYS)
      : addDays(today, -(FIRST_SYNC_DAYS - 1));
  }
  const opening = fromDbDateOrNull(wallet.openingBalanceDate);
  if (opening !== null && from < opening) from = opening;
  if (from > today) from = today;
  return { from, to: today };
}

/** The balance the bank answered, when it is an integer with a date. */
function readBalance(answer: GmoBalance | null): { amount: Money; date: CalendarDate } | null {
  if (answer === null) return null;
  const { balance, baseDate } = answer;
  if (typeof balance !== "string" || !/^-?\d+$/.test(balance) || !isCalendarDate(baseDate)) {
    return null;
  }
  return { amount: BigInt(balance), date: baseDate };
}

/**
 * A sync that could not fetch (19-bank-api §3.4): a batch with `error` and the reason on the
 * wallet; the period fetched and the last sync stay. `reauth` marks the wallet 再接続が必要
 * (`wallet.require_bank_reauth` when it was not already).
 */
async function recordFailedSync(
  db: Db,
  walletId: string,
  failure: { error: string; reauth: boolean; period: { from: CalendarDate; to: CalendarDate } },
  options: ImportOptions,
): Promise<ImportOutcome> {
  return runInTransaction(db, async (tx) => {
    const batchId = newId();
    await tx.importBatch.create({
      data: {
        id: batchId,
        walletId,
        source: "api",
        importer: IMPORTER,
        periodFrom: toDbDate(failure.period.from),
        periodTo: toDbDate(failure.period.to),
        rowCount: 0,
        error: failure.error,
        executedBy: options.actor,
      },
      select: { id: true },
    });
    const outcome: ImportOutcome = {
      batchId,
      walletId,
      source: "api",
      rowCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      failedCount: 0,
      warnings: [],
      error: failure.error,
    };
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "import_batch.sync",
      entity: "import_batch",
      entityId: batchId,
      after: outcome,
    });
    const current = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
    if (current.bankApiStatus === null) return outcome;
    const updated = await tx.wallet.update({
      where: { id: walletId },
      data: {
        bankApiError: failure.error,
        ...(failure.reauth ? { bankApiStatus: "reauth_required" } : {}),
      },
    });
    if (failure.reauth && current.bankApiStatus !== "reauth_required") {
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "wallet.require_bank_reauth",
        entity: "wallet",
        entityId: walletId,
        before: linkSnapshot(current),
        after: linkSnapshot(updated),
        reason: failure.error,
      });
    }
    return outcome;
  });
}

/** The link changed during a sync (connect / disconnect meanwhile): nothing fetched is stored. */
const LINK_CHANGED =
  "同期の間に口座の接続が変わったため、取得した明細は保存しませんでした。接続を確かめて、もう一度同期してください";

/**
 * Syncs a connected bank wallet (19-bank-api §3): fetches the period's lines page by page,
 * converts them, skips those stored before (by `itemKey`) and those that are lines from a CSV of
 * the same day and amount (§3.3), stores the new ones as `pending` in one batch with the import
 * hook, and records the bank's balance and the period fetched. A sync that brings nothing new
 * records no batch (only the last sync and the audit log). A wallet that needs reconnecting is
 * recorded as failed without calling the bank. Throws `SettingsError` only for a wallet that is
 * not an active bank wallet connected to an account.
 */
export async function syncBankWallet(
  db: Db,
  input: { walletId: string; now?: Date },
  options: BankSyncOptions,
): Promise<ImportOutcome> {
  const now = input.now ?? new Date();
  const { walletId } = bankWalletInputSchema.parse(input);
  const wallet = await loadBankWallet(db, walletId);
  const status = bankApiStatusOf(wallet.bankApiStatus);
  if (status === null) throw new SettingsError(NOT_CONNECTED, { field: "walletId" });
  const accountId = wallet.bankApiAccountId;
  if (status === "authorized" || accountId === null) {
    throw new SettingsError(NO_ACCOUNT_CHOSEN, { field: "walletId" });
  }
  const period = await syncPeriodOf(db, wallet, todayInJapan(now));
  if (status === "reauth_required") {
    return recordFailedSync(
      db,
      wallet.id,
      { error: wallet.bankApiError ?? REAUTH_REQUIRED, reauth: false, period },
      options,
    );
  }

  let connection: BankConnection | null = null;
  let fetched: Awaited<ReturnType<typeof fetchAllTransactions>>;
  try {
    connection = connect(db, wallet, options, now);
    fetched = await fetchAllTransactions(connection.api, {
      accountId,
      dateFrom: period.from,
      dateTo: period.to,
    });
  } catch (error) {
    return recordFailedSync(
      db,
      wallet.id,
      { ...failureOf(error, connection?.secrets() ?? []), period },
      options,
    );
  }
  if (fetched.currencyCode !== "JPY") {
    return recordFailedSync(
      db,
      wallet.id,
      {
        error: storedMessage(`円の口座ではありません（${fetched.currencyCode}）`, []),
        reauth: false,
        period,
      },
      options,
    );
  }

  const syncedThrough = fromDbDateOrNull(wallet.bankApiSyncedThrough);
  const drafts: WalletTransactionDraft[] = [];
  const failures: RowFailure[] = [];
  fetched.transactions.forEach((transaction, index) => {
    const converted = convertGmoTransaction(transaction, index + 1);
    if (converted.draft) drafts.push(converted.draft);
    if (!converted.failure) return;
    // Read again in the overlap: the sync that first read it recorded the failure. The last day
    // fetched is not skipped: lines can still arrive for it after that sync.
    const date = transaction.transactionDate;
    if (syncedThrough !== null && isCalendarDate(date) && date < syncedThrough) return;
    failures.push(converted.failure);
  });
  const rowCount = drafts.length + failures.length;
  const warnings = checkBalanceContinuity(drafts, null);

  // Stored before (by itemKey), then tied to the lines from elsewhere of the same day and amount.
  const firsts = new Map<string, WalletTransactionDraft>();
  for (const line of drafts) if (!firsts.has(line.externalId)) firsts.set(line.externalId, line);
  const stored = new Set(
    firsts.size === 0
      ? []
      : (
          await db.walletTransaction.findMany({
            where: { walletId: wallet.id, externalId: { in: [...firsts.keys()] } },
            select: { externalId: true },
          })
        ).map((row) => row.externalId),
  );
  const unseen = [...firsts.values()].filter((line) => !stored.has(line.externalId));
  const existing =
    unseen.length === 0
      ? []
      : await db.walletTransaction.findMany({
          where: {
            walletId: wallet.id,
            txnDate: { in: [...new Set(unseen.map((line) => line.txnDate))].map(toDbDate) },
            OR: [{ importBatchId: null }, { importBatch: { source: { not: "api" } } }],
          },
          select: { txnDate: true, amount: true },
        });
  const { insert, matched } = matchExistingLines(
    unseen,
    existing.map((row) => ({ txnDate: fromDbDate(row.txnDate), amount: row.amount })),
  );
  const knownDuplicates = drafts.length - unseen.length + matched.length;

  let balance: { amount: Money; date: CalendarDate } | null = null;
  try {
    balance = readBalance(await connection.api.getBalance(accountId));
  } catch {
    balance = null;
  }
  if (balance === null) warnings.push(BALANCE_UNAVAILABLE);

  const baseDate = isCalendarDate(fetched.baseDate) ? fetched.baseDate : period.to;
  const nextThrough = syncedThrough !== null && syncedThrough > baseDate ? syncedThrough : baseDate;
  return runInTransaction(db, async (tx) => {
    // The lines were fetched for `accountId`. A connect or a disconnect (another tab, the job) may
    // have changed the wallet's link while the bank answered: under the same lock as those, store
    // nothing unless the wallet is still connected to that account, so another account's lines
    // never land on it.
    await lockSettings(tx, "bankLinks");
    const current = await tx.wallet.findUnique({
      where: { id: wallet.id },
      select: { bankApiAccountId: true, bankApiStatus: true },
    });
    if (
      current === null ||
      current.bankApiAccountId !== accountId ||
      bankApiStatusOf(current.bankApiStatus) === null ||
      bankApiStatusOf(current.bankApiStatus) === "authorized"
    ) {
      return {
        batchId: null,
        walletId: wallet.id,
        source: "api",
        rowCount,
        importedCount: 0,
        duplicateCount: 0,
        failedCount: 0,
        warnings,
        error: LINK_CHANGED,
      } satisfies ImportOutcome;
    }
    let batchId: string | null = null;
    let created: string[] = [];
    let duplicateCount = knownDuplicates;
    if (insert.length > 0 || failures.length > 0) {
      batchId = newId();
      await tx.importBatch.create({
        data: {
          id: batchId,
          walletId: wallet.id,
          source: "api",
          importer: IMPORTER,
          periodFrom: toDbDate(period.from),
          periodTo: toDbDate(period.to),
          rowCount,
          failedCount: failures.length,
          failures: toAuditJson(failures),
          warnings,
          executedBy: options.actor,
        },
        select: { id: true },
      });
      const inserted = await insertWalletTransactions(tx, {
        walletId: wallet.id,
        importBatchId: batchId,
        drafts: insert,
      });
      created = inserted.created;
      duplicateCount = knownDuplicates + inserted.duplicateCount;
      await tx.importBatch.update({
        where: { id: batchId },
        data: { importedCount: created.length, duplicateCount },
        select: { id: true },
      });
      await finishImportBatch(
        tx,
        { id: batchId, walletId: wallet.id, source: "api" },
        created,
        options,
      );
    }
    // Only while the wallet is still connected to that account (not disconnected meanwhile).
    await tx.wallet.updateMany({
      where: { id: wallet.id, bankApiAccountId: accountId },
      data: {
        bankApiStatus: "connected",
        bankApiError: null,
        bankApiSyncedThrough: toDbDate(nextThrough),
        bankApiLastSyncedAt: now,
        ...(balance === null
          ? {}
          : { bankApiBalance: balance.amount, bankApiBalanceDate: toDbDate(balance.date) }),
      },
    });
    const outcome: ImportOutcome = {
      batchId,
      walletId: wallet.id,
      source: "api",
      rowCount,
      importedCount: created.length,
      duplicateCount,
      failedCount: failures.length,
      warnings,
      error: null,
    };
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "import_batch.sync",
      entity: "import_batch",
      entityId: batchId,
      after: { ...outcome, period, syncedThrough: nextThrough, lastSyncedAt: now },
    });
    return outcome;
  });
}

/** A wallet whose sync threw: its outcome carries the reason instead. */
function unsyncedOutcome(walletId: string, error: unknown): ImportOutcome {
  let message: string;
  if (error instanceof SettingsError) {
    message = error.message;
  } else {
    // Long digit runs (an account ID) are masked out of the log.
    console.error(
      `[niho-finance] Bank sync of wallet ${walletId} failed: ${messageOf(error).replace(/\d{10,}/g, "***")}`,
    );
    message = "同期できませんでした。時間をおいて、もう一度同期してください";
  }
  return {
    batchId: null,
    walletId,
    source: "api",
    rowCount: 0,
    importedCount: 0,
    duplicateCount: 0,
    failedCount: 0,
    warnings: [],
    error: message,
  };
}

/**
 * Syncs every active bank wallet that is connected or needs reconnecting, in turn (the daily
 * job, 19-bank-api §3.5): one wallet's failure is that wallet's outcome (`error`); it never stops
 * the others or throws.
 */
export async function syncAllBankWallets(
  db: Db,
  options: BankSyncAllOptions,
): Promise<ImportOutcome[]> {
  const wallets = await db.wallet.findMany({
    where: {
      isActive: true,
      kind: "bank",
      bankApiStatus: { in: ["connected", "reauth_required"] },
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const outcomes: ImportOutcome[] = [];
  for (const { id } of wallets) {
    try {
      outcomes.push(
        await syncBankWallet(
          db,
          { walletId: id, now: options.now },
          {
            actor: options.actor,
            afterImport: options.afterImport,
            config: options.config,
            key: options.key,
            fetch: options.fetch,
            api: options.apiFor?.(id),
          },
        ),
      );
    } catch (error) {
      outcomes.push(unsyncedOutcome(id, error));
    }
  }
  return outcomes;
}
