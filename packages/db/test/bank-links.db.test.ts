import { randomBytes } from "node:crypto";
import {
  GmoApiError,
  openTokens,
  sealTokens,
  type GmoTokenSet,
  type StoredTokens,
} from "@niho-finance/importers";
import type { CalendarDate } from "@niho-finance/ledger";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authorizeBankToken,
  bankReconnectTodo,
  connectBankAccount,
  createWallet,
  disconnectBankLink,
  getBankLink,
  getImportBatch,
  listBankLinkStatuses,
  listLinkableBankAccounts,
  loadBackupSource,
  loadWalletStatus,
  saveBankAuthorization,
  setWalletActive,
  SettingsError,
  syncAllBankWallets,
  syncBankWallet,
  updateWallet,
  type AfterImportHook,
} from "../src";
import { toDbDate } from "../src/dates";
import { newId } from "../src/ids";
import {
  ACCOUNT_ID,
  ACCOUNT_LABEL,
  bankFetch,
  bankLine,
  FakeBankApi,
  FICTIONAL_ACCOUNTS,
  jsonResponse,
  OAUTH_CONFIG,
  thirtyDays,
  TOKEN_CONFIG,
  type BankRequest,
} from "./support/bank-api";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";

const actor = "bank@example.com";
/** A fictional key for sealing the tokens in these tests. */
const KEY = randomBytes(32).toString("base64");
/** 2026-11-30 10:00 JST. */
const NOW = new Date("2026-11-30T01:00:00Z");
const LATER = new Date("2026-11-30T05:00:00Z");

/** 10:00 JST of a day. */
function jstMorning(date: CalendarDate): Date {
  return new Date(`${date}T10:00:00+09:00`);
}

function tokenSet(fields: Partial<GmoTokenSet> & { accessToken: string }): GmoTokenSet {
  return {
    refreshToken: null,
    accessTokenExpiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
    scope: "openid offline_access private:account",
    idToken: null,
    ...fields,
  };
}

/** The account API of `OAUTH_CONFIG` answering with `api`'s data, and the token endpoint. */
function oauthBank(
  api: FakeBankApi,
  token: (request: BankRequest) => Response | Promise<Response>,
  acceptedToken: (value: string | null) => boolean = () => true,
) {
  return bankFetch(async (request) => {
    if (request.path === "/token") return token(request);
    if (!acceptedToken(request.token)) {
      return jsonResponse(401, { errorCode: "WG_ERR_101", errorMessage: "認証エラー" });
    }
    if (request.path === "/accounts") {
      return jsonResponse(200, { accounts: await api.listAccounts() });
    }
    if (request.path === "/accounts/balances") {
      const balance = await api.getBalance(request.query.accountId ?? "");
      return jsonResponse(200, { balances: balance ? [balance] : [] });
    }
    if (request.path === "/accounts/transactions") {
      const { accountId = "", dateFrom = "", dateTo = "", nextItemKey } = request.query;
      return jsonResponse(
        200,
        await api.listTransactions({
          accountId,
          dateFrom,
          dateTo,
          ...(nextItemKey ? { nextItemKey } : {}),
        }),
      );
    }
    return jsonResponse(404, { errorCode: "WG_ERR_404", errorMessage: "not found" });
  });
}

/** Bank API connections and sync on the seeded book, with fictional accounts and answers. */
describe.skipIf(!hasTestDatabase)("bank API connections and sync", () => {
  let prisma: PrismaClient;
  /** Every wallet these tests create: made inactive at the end (other files read all wallets). */
  const created: string[] = [];

  async function bankWallet(
    name: string,
    fields: { openingBalance?: string; openingBalanceDate?: CalendarDate } = {},
  ): Promise<string> {
    const wallet = await createWallet(prisma, { name, kind: "bank", ...fields }, { actor });
    created.push(wallet.id);
    return wallet.id;
  }

  async function walletRow(id: string) {
    return prisma.wallet.findUniqueOrThrow({ where: { id } });
  }

  async function batchCount(walletId: string): Promise<number> {
    return prisma.importBatch.count({ where: { walletId } });
  }

  let accounts = 0;
  /** Another fictional account ID for each wallet connected directly (one account, one wallet). */
  function nextAccountId(): string {
    accounts += 1;
    return `30101900${String(accounts).padStart(4, "0")}`;
  }

  /** A sunabar wallet authorized and connected to a fictional account, with nothing fetched. */
  async function connectedWallet(name: string): Promise<string> {
    const id = await bankWallet(name);
    await saveBankAuthorization(prisma, { walletId: id, env: "sunabar", tokens: null }, { actor });
    await prisma.wallet.update({
      where: { id },
      data: {
        bankApiAccountId: nextAccountId(),
        bankApiAccountLabel: ACCOUNT_LABEL,
        bankApiStatus: "connected",
      },
    });
    return id;
  }

  /** An 検証 wallet connected with sealed tokens. */
  async function oauthWallet(name: string, tokens: StoredTokens): Promise<string> {
    const id = await bankWallet(name);
    await prisma.wallet.update({
      where: { id },
      data: {
        bankApiEnv: "stg",
        bankApiStatus: "connected",
        bankApiAccountId: nextAccountId(),
        bankApiAccountLabel: ACCOUNT_LABEL,
        bankApiTokens: sealTokens(tokens, KEY),
      },
    });
    return id;
  }

  beforeAll(() => {
    prisma = testPrisma();
  });

  afterAll(async () => {
    for (const id of created) {
      await setWalletActive(prisma, { id, isActive: false }, { actor });
    }
  });

  let mainId: string;

  it("connects a wallet: authorization, the choice of account and a first sync of 30 days", async () => {
    mainId = await bankWallet("架空銀行 API 普通");
    expect(await getBankLink(prisma, mainId)).toMatchObject({
      walletName: "架空銀行 API 普通",
      env: null,
      status: null,
      recentBatches: [],
    });
    await saveBankAuthorization(
      prisma,
      { walletId: mainId, env: "sunabar", tokens: null },
      { actor },
    );
    expect(await getBankLink(prisma, mainId)).toMatchObject({
      env: "sunabar",
      status: "authorized",
    });
    await expect(syncBankWallet(prisma, { walletId: mainId }, { actor })).rejects.toThrow(
      "接続する銀行の口座が選ばれていません。銀行 API の接続で口座を選んでください",
    );

    const api = new FakeBankApi({ transactions: thirtyDays(), balance: 1_217_500n });
    expect(await listLinkableBankAccounts(prisma, { walletId: mainId }, { api })).toEqual([
      { accountId: ACCOUNT_ID, label: ACCOUNT_LABEL, linkedWalletName: null },
    ]);

    const hooked: string[][] = [];
    const afterImport: AfterImportHook = (_tx, batch) => {
      hooked.push(batch.transactionIds);
      return Promise.resolve();
    };
    const journalEntries = await prisma.journalEntry.count();
    const outcome = await connectBankAccount(
      prisma,
      { walletId: mainId, accountId: ACCOUNT_ID, now: NOW },
      { actor, api, afterImport },
    );
    expect(typeof outcome.batchId).toBe("string");
    expect(outcome).toEqual({
      batchId: outcome.batchId,
      walletId: mainId,
      source: "api",
      rowCount: 30,
      importedCount: 30,
      duplicateCount: 0,
      failedCount: 0,
      warnings: [],
      error: null,
    });
    // 30 days up to today (JST), in pages of 20.
    expect(api.calls).toEqual([
      { accountId: ACCOUNT_ID, dateFrom: "2026-11-01", dateTo: "2026-11-30" },
      {
        accountId: ACCOUNT_ID,
        dateFrom: "2026-11-01",
        dateTo: "2026-11-30",
        nextItemKey: "202611210900000000001",
      },
    ]);

    const lines = await prisma.walletTransaction.findMany({
      where: { walletId: mainId },
      orderBy: { id: "asc" },
    });
    expect(lines).toHaveLength(30);
    expect(lines.every((line) => line.status === "pending")).toBe(true);
    expect(lines.every((line) => line.importBatchId === outcome.batchId)).toBe(true);
    expect(hooked).toEqual([lines.map((line) => line.id)]);
    expect(await prisma.journalEntry.count()).toBe(journalEntries);
    expect(lines[0]).toMatchObject({
      externalId: "202611010900000000001",
      txnDate: toDbDate("2026-11-01"),
      amount: -100n,
      balanceAfter: 999_900n,
      descriptionRaw: "ﾃｽﾄ",
      counterpartyRaw: null,
      occurredAt: null,
    });
    expect(lines[29]).toMatchObject({ amount: 30_000n, balanceAfter: 1_217_500n });

    expect(await getImportBatch(prisma, outcome.batchId ?? "")).toMatchObject({
      source: "api",
      importer: "gmo_aozora",
      periodFrom: "2026-11-01",
      periodTo: "2026-11-30",
      rowCount: 30,
      importedCount: 30,
      error: null,
    });
    const link = await getBankLink(prisma, mainId);
    expect(link).toMatchObject({
      env: "sunabar",
      status: "connected",
      accountLabel: ACCOUNT_LABEL,
      syncedThrough: "2026-11-30",
      lastSyncedAt: NOW,
      balance: 1_217_500n,
      balanceDate: "2026-11-30",
      error: null,
    });
    expect(link?.recentBatches.map((batch) => batch.id)).toEqual([outcome.batchId]);
    expect(link?.recentBatches[0]).not.toHaveProperty("failures");
    expect(await listBankLinkStatuses(prisma)).toContainEqual({
      walletId: mainId,
      status: "connected",
    });
  });

  it("syncs again without duplicating: no batch, the last sync and the audit log only", async () => {
    const api = new FakeBankApi({ transactions: thirtyDays(), balance: 1_217_500n });
    const batches = await batchCount(mainId);
    const outcome = await syncBankWallet(prisma, { walletId: mainId, now: LATER }, { actor, api });
    expect(outcome).toEqual({
      batchId: null,
      walletId: mainId,
      source: "api",
      rowCount: 4,
      importedCount: 0,
      duplicateCount: 4,
      failedCount: 0,
      warnings: [],
      error: null,
    });
    // From 3 days before the last day fetched.
    expect(api.calls).toEqual([
      { accountId: ACCOUNT_ID, dateFrom: "2026-11-27", dateTo: "2026-11-30" },
    ]);
    expect(await batchCount(mainId)).toBe(batches);
    expect(await prisma.walletTransaction.count({ where: { walletId: mainId } })).toBe(30);
    expect(await walletRow(mainId)).toMatchObject({
      bankApiLastSyncedAt: LATER,
      bankApiSyncedThrough: toDbDate("2026-11-30"),
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "import_batch.sync", entityId: null },
      orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    expect(audit.after).toMatchObject({ walletId: mainId, batchId: null, duplicateCount: 4 });
  });

  it("starts the first sync from the wallet's latest line or its opening date", async () => {
    const withLine = await connectedWallet("架空銀行 API 明細あり");
    await prisma.walletTransaction.create({
      data: {
        id: newId(),
        walletId: withLine,
        txnDate: toDbDate("2026-11-20"),
        amount: 5_000n,
        descriptionRaw: "手入力の明細",
        externalId: "fake-manual-0001",
      },
    });
    const first = new FakeBankApi();
    await syncBankWallet(prisma, { walletId: withLine, now: NOW }, { actor, api: first });
    expect(first.calls[0]).toMatchObject({ dateFrom: "2026-11-17", dateTo: "2026-11-30" });

    const opened = await bankWallet("架空銀行 API 開始日", {
      openingBalance: "0",
      openingBalanceDate: "2026-11-25",
    });
    await saveBankAuthorization(
      prisma,
      { walletId: opened, env: "sunabar", tokens: null },
      { actor },
    );
    await prisma.wallet.update({
      where: { id: opened },
      data: { bankApiAccountId: nextAccountId(), bankApiStatus: "connected" },
    });
    const fromOpening = new FakeBankApi();
    const outcome = await syncBankWallet(
      prisma,
      { walletId: opened, now: jstMorning("2026-11-26") },
      { actor, api: fromOpening },
    );
    // The opening date itself is fetched; nothing came, so no batch.
    expect(fromOpening.calls[0]).toMatchObject({ dateFrom: "2026-11-25", dateTo: "2026-11-26" });
    expect(outcome).toMatchObject({ batchId: null, rowCount: 0, error: null });
    expect((await walletRow(opened)).bankApiSyncedThrough).toEqual(toDbDate("2026-11-26"));
    // The second sync stops at the opening date too (3 days before the 26th would be the 23rd).
    await syncBankWallet(
      prisma,
      { walletId: opened, now: jstMorning("2026-11-27") },
      { actor, api: fromOpening },
    );
    expect(fromOpening.calls[1]).toMatchObject({ dateFrom: "2026-11-25", dateTo: "2026-11-27" });
  });

  it("ties API lines to CSV lines of the same day and amount, the same way every time", async () => {
    const walletId = await connectedWallet("架空銀行 API CSV と重なる");
    const csvBatchId = newId();
    await prisma.importBatch.create({
      data: {
        id: csvBatchId,
        walletId,
        source: "csv",
        importer: "gmo_aozora_zengin",
        rowCount: 1,
        importedCount: 1,
        executedBy: actor,
      },
    });
    await prisma.walletTransaction.create({
      data: {
        id: newId(),
        walletId,
        txnDate: toDbDate("2026-11-10"),
        amount: -55_000n,
        descriptionRaw: "ﾌﾘｺﾐ ｶ)ﾃｽﾄﾃﾞﾝｷ",
        balanceAfter: 945_000n,
        externalId: "fake-csv-hash-0001",
        importBatchId: csvBatchId,
      },
    });
    // Two transfers of the same amount on the 10th (the CSV has one of them), and a deposit.
    const first = bankLine(
      "2026111009000000000001",
      "2026-11-10",
      -55_000n,
      945_000n,
      "ﾌﾘｺﾐ ﾃｽﾄﾃﾞﾝｷ",
    );
    const second = bankLine(
      "2026111015000000000002",
      "2026-11-10",
      -55_000n,
      890_000n,
      "ﾌﾘｺﾐ ﾃｽﾄﾃﾞﾝｷ",
    );
    const deposit = bankLine("2026111209000000000003", "2026-11-12", 1_000n, 891_000n);
    const api = new FakeBankApi({ transactions: [first, second, deposit], balance: 891_000n });

    const outcome = await syncBankWallet(
      prisma,
      { walletId, now: jstMorning("2026-11-12") },
      { actor, api },
    );
    expect(api.calls[0]).toMatchObject({ dateFrom: "2026-11-07", dateTo: "2026-11-12" });
    expect(outcome).toMatchObject({
      rowCount: 3,
      importedCount: 2,
      duplicateCount: 1,
      failedCount: 0,
    });
    const externalIds = async () =>
      (
        await prisma.walletTransaction.findMany({
          where: { walletId },
          orderBy: { externalId: "asc" },
          select: { externalId: true },
        })
      ).map((line) => line.externalId);
    expect(await externalIds()).toEqual([second.itemKey, deposit.itemKey, "fake-csv-hash-0001"]);

    // The next sync reads the same days again: nothing new.
    const again = await syncBankWallet(
      prisma,
      { walletId, now: jstMorning("2026-11-13") },
      { actor, api },
    );
    expect(again).toMatchObject({
      batchId: null,
      rowCount: 3,
      importedCount: 0,
      duplicateCount: 3,
    });
    expect(await externalIds()).toEqual([second.itemKey, deposit.itemKey, "fake-csv-hash-0001"]);

    // A third transfer of that day arrives late: the API's own lines are not ties, so it is new.
    const third = bankLine("2026111018000000000004", "2026-11-10", -55_000n, 836_000n);
    api.transactions.push(third);
    const late = await syncBankWallet(
      prisma,
      { walletId, now: jstMorning("2026-11-13") },
      { actor, api },
    );
    expect(late).toMatchObject({ rowCount: 4, importedCount: 1, duplicateCount: 3 });
    expect(await externalIds()).toContain(third.itemKey);
    // The CSV line is never changed.
    expect(
      await prisma.walletTransaction.findUniqueOrThrow({
        where: { walletId_externalId: { walletId, externalId: "fake-csv-hash-0001" } },
      }),
    ).toMatchObject({ importBatchId: csvBatchId, status: "pending" });
  });

  it("counts a line that cannot be read once, not again in the overlap", async () => {
    const walletId = await connectedWallet("架空銀行 API 読めない明細");
    const broken = bankLine(undefined, "2026-11-11", -1_000n, 9_000n);
    const api = new FakeBankApi({ transactions: [broken], balance: 9_000n });
    const first = await syncBankWallet(
      prisma,
      { walletId, now: jstMorning("2026-11-12") },
      { actor, api },
    );
    expect(first).toMatchObject({ rowCount: 1, importedCount: 0, failedCount: 1 });
    expect(await getImportBatch(prisma, first.batchId ?? "")).toMatchObject({
      failedCount: 1,
      failures: [
        {
          rowNumber: 1,
          reason: "明細キーがありません",
          raw: ["2026-11-11", "出金", "1000", "ﾃｽﾄ"],
        },
      ],
    });
    const again = await syncBankWallet(
      prisma,
      { walletId, now: jstMorning("2026-11-13") },
      { actor, api },
    );
    expect(again).toMatchObject({ batchId: null, rowCount: 0, failedCount: 0 });

    api.transactions.push(bankLine(undefined, "2026-11-13", -2_000n, 7_000n));
    const fresh = await syncBankWallet(
      prisma,
      { walletId, now: jstMorning("2026-11-13") },
      { actor, api },
    );
    expect(fresh).toMatchObject({ rowCount: 1, failedCount: 1 });
    expect(typeof fresh.batchId).toBe("string");
  });

  it("imports the lines with a warning when the balance cannot be read", async () => {
    const walletId = await connectedWallet("架空銀行 API 残高なし");
    const api = new FakeBankApi({
      transactions: [bankLine("2026112909000000000001", "2026-11-29", 3_000n, 3_000n)],
    });
    api.balanceFailsWith = new GmoApiError("server", "銀行 API でエラーが起きました（503）");
    const outcome = await syncBankWallet(prisma, { walletId, now: NOW }, { actor, api });
    expect(outcome).toMatchObject({
      importedCount: 1,
      warnings: ["銀行の残高を取得できませんでした"],
      error: null,
    });
    expect(await getImportBatch(prisma, outcome.batchId ?? "")).toMatchObject({
      warnings: ["銀行の残高を取得できませんでした"],
    });
    expect(await walletRow(walletId)).toMatchObject({
      bankApiBalance: null,
      bankApiSyncedThrough: toDbDate("2026-11-30"),
    });
  });

  let refusedId: string;

  it("needs reconnecting when the bank refuses the token (401), and resumes after it", async () => {
    refusedId = await connectedWallet("架空銀行 API 失効");
    const ok = new FakeBankApi({ transactions: thirtyDays(), balance: 1_217_500n });
    await syncBankWallet(
      prisma,
      { walletId: refusedId, now: jstMorning("2026-11-20") },
      { actor, api: ok },
    );
    const before = await walletRow(refusedId);
    expect(before.bankApiSyncedThrough).toEqual(toDbDate("2026-11-20"));

    // The sunabar token, refused: the real client against a 401.
    const refused = bankFetch(() =>
      jsonResponse(401, { errorCode: "WG_ERR_101", errorMessage: "認証エラー" }),
    );
    const outcome = await syncBankWallet(
      prisma,
      { walletId: refusedId, now: NOW },
      { actor, config: TOKEN_CONFIG, fetch: refused.fetch },
    );
    const reason =
      "銀行 API がトークンを受け付けませんでした（401 WG_ERR_101 認証エラー）。再接続してください";
    expect(outcome).toMatchObject({ rowCount: 0, importedCount: 0, error: reason });
    expect(refused.requests).toHaveLength(1);
    expect(refused.requests[0]).toMatchObject({
      path: "/accounts/transactions",
      token: "fake-sunabar-token",
    });
    expect(await getImportBatch(prisma, outcome.batchId ?? "")).toMatchObject({
      source: "api",
      importer: "gmo_aozora",
      rowCount: 0,
      error: reason,
    });
    const after = await walletRow(refusedId);
    expect(after).toMatchObject({
      bankApiStatus: "reauth_required",
      bankApiError: reason,
      bankApiSyncedThrough: before.bankApiSyncedThrough,
      bankApiLastSyncedAt: before.bankApiLastSyncedAt,
    });
    const reauthAudits = await prisma.auditLog.findMany({
      where: { entityId: refusedId, action: "wallet.require_bank_reauth" },
    });
    expect(reauthAudits).toMatchObject([
      { entity: "wallet", after: { status: "reauth_required", error: reason }, reason },
    ]);
    // ホーム: one wallet to reconnect → its connection page.
    const todos = await bankReconnectTodo(prisma, "2026-11-30");
    const mine = await prisma.wallet.findMany({
      where: { isActive: true, kind: "bank", bankApiStatus: "reauth_required" },
    });
    expect(todos).toEqual([
      {
        key: "bank-reconnect",
        badge: String(mine.length),
        tone: "warn",
        label: "銀行 API の再接続",
        href: mine.length === 1 ? `/settings/wallets/${refusedId}/bank` : "/settings/wallets",
      },
    ]);

    // Synced again (the daily job): the bank is not called, the failure is recorded again.
    const calls = ok.calls.length;
    const again = await syncBankWallet(
      prisma,
      { walletId: refusedId, now: NOW },
      { actor, api: ok },
    );
    expect(again).toMatchObject({ error: reason });
    expect(typeof again.batchId).toBe("string");
    expect(ok.calls).toHaveLength(calls);
    expect(
      await prisma.auditLog.count({
        where: { entityId: refusedId, action: "wallet.require_bank_reauth" },
      }),
    ).toBe(1);

    // 再接続: the account and the period fetched stay; the next sync goes on from there.
    await saveBankAuthorization(
      prisma,
      { walletId: refusedId, env: "sunabar", tokens: null },
      { actor },
    );
    expect(await getBankLink(prisma, refusedId)).toMatchObject({
      status: "connected",
      accountLabel: ACCOUNT_LABEL,
      syncedThrough: "2026-11-20",
      error: null,
    });
    const resumed = await syncBankWallet(
      prisma,
      { walletId: refusedId, now: NOW },
      { actor, api: ok },
    );
    expect(ok.calls.at(-1)).toMatchObject({ dateFrom: "2026-11-17", dateTo: "2026-11-30" });
    expect(resumed).toMatchObject({ importedCount: 10, error: null });
  });

  it("does not reconnect on a rate limit: the period stays, the next sync reads it again", async () => {
    const api = new FakeBankApi({ transactions: thirtyDays(), balance: 1_217_500n });
    api.failWith = new GmoApiError(
      "rate_limited",
      "銀行 API の利用上限に当たりました。時間をおいて、もう一度同期してください（429 WG_ERR_154）",
      { status: 429, code: "WG_ERR_154" },
    );
    const before = await walletRow(mainId);
    const outcome = await syncBankWallet(prisma, { walletId: mainId, now: NOW }, { actor, api });
    expect(outcome.error).toBe(api.failWith.message);
    expect(await walletRow(mainId)).toMatchObject({
      bankApiStatus: "connected",
      bankApiError: api.failWith.message,
      bankApiSyncedThrough: before.bankApiSyncedThrough,
      bankApiLastSyncedAt: before.bankApiLastSyncedAt,
    });
    // The failed attempt is not the last import of the wallet card (14-reports §6).
    const failed = await prisma.importBatch.findFirstOrThrow({
      where: { walletId: mainId, error: { not: null } },
      orderBy: { executedAt: "desc" },
    });
    const status = (await loadWalletStatus(prisma, { through: "2026-11-30" })).find(
      (row) => row.walletId === mainId,
    );
    expect(status?.lastImportedAt?.getTime() ?? 0).toBeLessThan(failed.executedAt.getTime());
    api.failWith = null;
    await syncBankWallet(prisma, { walletId: mainId, now: LATER }, { actor, api });
    expect(await walletRow(mainId)).toMatchObject({
      bankApiStatus: "connected",
      bankApiError: null,
    });
  });

  it("stores nothing when the wallet's link changes while the bank answers", async () => {
    const walletId = await connectedWallet("架空銀行 API 切替");
    const api = new FakeBankApi({ transactions: thirtyDays(), balance: 1_217_500n });
    // Another tab disconnects the wallet after the lines are fetched, before they are stored.
    api.getBalance = async () => {
      await disconnectBankLink(prisma, { walletId }, { actor });
      return null;
    };
    const outcome = await syncBankWallet(prisma, { walletId, now: NOW }, { actor, api });
    expect(outcome).toMatchObject({
      batchId: null,
      walletId,
      importedCount: 0,
      error:
        "同期の間に口座の接続が変わったため、取得した明細は保存しませんでした。接続を確かめて、もう一度同期してください",
    });
    expect(await prisma.walletTransaction.count({ where: { walletId } })).toBe(0);
    expect(await batchCount(walletId)).toBe(0);
    expect(await walletRow(walletId)).toMatchObject({
      bankApiStatus: null,
      bankApiAccountId: null,
      bankApiLastSyncedAt: null,
    });
  });

  it("needs reconnecting when the environment changed", async () => {
    const walletId = await connectedWallet("架空銀行 API 環境");
    const outcome = await syncBankWallet(
      prisma,
      { walletId, now: NOW },
      {
        actor,
        config: OAUTH_CONFIG,
        key: KEY,
        fetch: bankFetch(() => jsonResponse(500, undefined)).fetch,
      },
    );
    expect(outcome.error).toBe(
      "接続した環境（sunabar）と今の環境（検証）が違います。再接続してください",
    );
    expect((await walletRow(walletId)).bankApiStatus).toBe("reauth_required");
    // Authorizing in the other environment starts over: the account is chosen again.
    await saveBankAuthorization(
      prisma,
      { walletId, env: "stg", tokens: tokenSet({ accessToken: "fake-a" }) },
      { actor, key: KEY },
    );
    expect(await getBankLink(prisma, walletId)).toMatchObject({
      env: "stg",
      status: "authorized",
      accountLabel: null,
      syncedThrough: null,
    });
  });

  it("refreshes an expiring token, stores the new pair, and uses it", async () => {
    const walletId = await oauthWallet("架空銀行 API 更新", {
      accessToken: "fake-access-old",
      refreshToken: "fake-refresh-old",
      accessTokenExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      scope: "openid offline_access private:account",
    });
    const api = new FakeBankApi({ transactions: thirtyDays().slice(25), balance: 1_217_500n });
    const bank = oauthBank(
      api,
      () =>
        jsonResponse(200, {
          access_token: "fake-access-new",
          refresh_token: "fake-refresh-new",
          token_type: "Bearer",
          expires_in: 2_592_000,
        }),
      (token) => token === "fake-access-new",
    );
    const outcome = await syncBankWallet(
      prisma,
      { walletId, now: NOW },
      { actor, config: OAUTH_CONFIG, key: KEY, fetch: bank.fetch },
    );
    expect(outcome).toMatchObject({ importedCount: 5, error: null });
    expect(bank.requests.map((request) => request.path)).toEqual([
      "/token",
      "/accounts/transactions",
      "/accounts/balances",
    ]);
    expect(bank.requests[0]?.body).toEqual({
      grant_type: "refresh_token",
      refresh_token: "fake-refresh-old",
    });
    const sealed = (await walletRow(walletId)).bankApiTokens ?? "";
    expect(openTokens(sealed, KEY)).toEqual({
      accessToken: "fake-access-new",
      refreshToken: "fake-refresh-new",
      accessTokenExpiresAt: new Date(NOW.getTime() + 2_592_000_000).toISOString(),
      scope: "openid offline_access private:account",
    });

    // A token revoked mid-way: a 401 refreshes once and calls again.
    const revoked = oauthBank(
      api,
      () =>
        jsonResponse(200, {
          access_token: "fake-access-newer",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      (token) => token === "fake-access-newer",
    );
    const retried = await syncBankWallet(
      prisma,
      { walletId, now: LATER },
      { actor, config: OAUTH_CONFIG, key: KEY, fetch: revoked.fetch },
    );
    expect(retried.error).toBeNull();
    expect(revoked.requests.map((request) => request.path)).toEqual([
      "/accounts/transactions",
      "/token",
      "/accounts/transactions",
      "/accounts/balances",
    ]);
    // No new refresh token in the answer: the one used goes on.
    expect(openTokens((await walletRow(walletId)).bankApiTokens ?? "", KEY)).toMatchObject({
      accessToken: "fake-access-newer",
      refreshToken: "fake-refresh-new",
    });
  });

  it("needs reconnecting when the refresh token is refused (invalid_grant)", async () => {
    const walletId = await oauthWallet("架空銀行 API 更新拒否", {
      accessToken: "fake-access-old",
      refreshToken: "fake-refresh-old",
      accessTokenExpiresAt: new Date(NOW.getTime() - 60_000).toISOString(),
      scope: "openid offline_access private:account",
    });
    const bank = oauthBank(new FakeBankApi(), () =>
      jsonResponse(400, { error: "invalid_grant", error_description: "expired" }),
    );
    const outcome = await syncBankWallet(
      prisma,
      { walletId, now: NOW },
      { actor, config: OAUTH_CONFIG, key: KEY, fetch: bank.fetch },
    );
    expect(outcome.error).toBe(
      "銀行のトークンを更新できませんでした（invalid_grant）。再接続してください",
    );
    expect(bank.requests.map((request) => request.path)).toEqual(["/token"]);
    expect(await walletRow(walletId)).toMatchObject({ bankApiStatus: "reauth_required" });

    // A key that does not open the tokens (the key was replaced) needs reconnecting too.
    const otherKey = await oauthWallet("架空銀行 API 鍵", {
      accessToken: "fake-access-old",
      refreshToken: null,
      accessTokenExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      scope: "",
    });
    const replaced = await syncBankWallet(
      prisma,
      { walletId: otherKey, now: NOW },
      { actor, config: OAUTH_CONFIG, key: randomBytes(32).toString("base64"), fetch: bank.fetch },
    );
    expect(replaced.error).toBe(
      "保存したトークンを復号できません（暗号鍵が変わりました）。再接続してください",
    );
    expect((await walletRow(otherKey)).bankApiStatus).toBe("reauth_required");

    // Two wallets (or more) to reconnect: ホーム goes to 設定 › 口座.
    const count = await prisma.wallet.count({
      where: { isActive: true, kind: "bank", bankApiStatus: "reauth_required" },
    });
    expect(count).toBeGreaterThanOrEqual(2);
    expect(await bankReconnectTodo(prisma, "2026-11-30")).toEqual([
      {
        key: "bank-reconnect",
        badge: String(count),
        tone: "warn",
        label: "銀行 API の再接続",
        href: "/settings/wallets",
      },
    ]);
  });

  it("uses the tokens another sync stored when it refreshed first", async () => {
    const stored = (access: string, refresh: string): StoredTokens => ({
      accessToken: access,
      refreshToken: refresh,
      accessTokenExpiresAt: new Date(NOW.getTime() + 3_600_000 * 24).toISOString(),
      scope: "openid offline_access private:account",
    });
    const walletId = await oauthWallet("架空銀行 API 同時", {
      ...stored("fake-access-old", "fake-refresh-old"),
      accessTokenExpiresAt: new Date(NOW.getTime() - 1).toISOString(),
    });
    const api = new FakeBankApi({ balance: 0n });
    // The other sync stores its refreshed pair while this one is at the token endpoint.
    const bank = oauthBank(
      api,
      async () => {
        await prisma.wallet.update({
          where: { id: walletId },
          data: {
            bankApiTokens: sealTokens(stored("fake-access-other", "fake-refresh-other"), KEY),
          },
        });
        return jsonResponse(200, {
          access_token: "fake-access-mine",
          refresh_token: "fake-refresh-mine",
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
      (token) => token === "fake-access-other",
    );
    const outcome = await syncBankWallet(
      prisma,
      { walletId, now: NOW },
      { actor, config: OAUTH_CONFIG, key: KEY, fetch: bank.fetch },
    );
    expect(outcome.error).toBeNull();
    expect(openTokens((await walletRow(walletId)).bankApiTokens ?? "", KEY)).toMatchObject({
      accessToken: "fake-access-other",
      refreshToken: "fake-refresh-other",
    });

    // The other sync used the single-use refresh token first: invalid_grant, yet its pair works.
    await prisma.wallet.update({
      where: { id: walletId },
      data: {
        bankApiTokens: sealTokens(
          {
            ...stored("fake-access-old", "fake-refresh-old"),
            accessTokenExpiresAt: new Date(NOW.getTime() - 1).toISOString(),
          },
          KEY,
        ),
      },
    });
    const late = oauthBank(
      api,
      async () => {
        await prisma.wallet.update({
          where: { id: walletId },
          data: {
            bankApiTokens: sealTokens(stored("fake-access-other", "fake-refresh-other"), KEY),
          },
        });
        return jsonResponse(400, { error: "invalid_grant" });
      },
      (token) => token === "fake-access-other",
    );
    const second = await syncBankWallet(
      prisma,
      { walletId, now: NOW },
      { actor, config: OAUTH_CONFIG, key: KEY, fetch: late.fetch },
    );
    expect(second.error).toBeNull();
    expect((await walletRow(walletId)).bankApiStatus).toBe("connected");
  });

  it("connects through the authorization code flow's tokens end to end", async () => {
    const walletId = await bankWallet("架空銀行 API 認可");
    await saveBankAuthorization(
      prisma,
      {
        walletId,
        env: "stg",
        tokens: tokenSet({ accessToken: "fake-access-first", refreshToken: "fake-refresh-first" }),
      },
      { actor, key: KEY },
    );
    const sealed = (await walletRow(walletId)).bankApiTokens ?? "";
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("fake-access-first");
    const api = new FakeBankApi({ transactions: thirtyDays().slice(28), balance: 1_217_500n });
    const bank = oauthBank(
      api,
      () => jsonResponse(500, undefined),
      (token) => token === "fake-access-first",
    );
    const options = { config: OAUTH_CONFIG, key: KEY, fetch: bank.fetch };
    expect(await listLinkableBankAccounts(prisma, { walletId }, options)).toEqual([
      { accountId: ACCOUNT_ID, label: ACCOUNT_LABEL, linkedWalletName: null },
    ]);
    const outcome = await connectBankAccount(
      prisma,
      { walletId, accountId: ACCOUNT_ID, now: NOW },
      { actor, ...options },
    );
    expect(outcome).toMatchObject({ importedCount: 2, error: null });
    expect(bank.requests.every((request) => request.token === "fake-access-first")).toBe(true);
    expect(await getBankLink(prisma, walletId)).toMatchObject({ env: "stg", status: "connected" });

    // A rename of the wallet audits it without the tokens or the account ID.
    await updateWallet(prisma, { id: walletId, name: "架空銀行 API 認可（改名）" }, { actor });
  });

  it("refuses an account another wallet has, or one the bank does not list", async () => {
    const walletId = await bankWallet("架空銀行 API 二重");
    await saveBankAuthorization(prisma, { walletId, env: "sunabar", tokens: null }, { actor });
    const [ordinary] = FICTIONAL_ACCOUNTS;
    if (!ordinary) throw new Error("fixture");
    const api = new FakeBankApi({
      accounts: [
        ...FICTIONAL_ACCOUNTS,
        { ...ordinary, accountId: "301019999902", accountNumber: "9999902" },
      ],
    });
    const listed = await listLinkableBankAccounts(prisma, { walletId }, { api });
    expect(listed).toEqual([
      { accountId: ACCOUNT_ID, label: ACCOUNT_LABEL, linkedWalletName: "架空銀行 API 普通" },
      {
        accountId: "301019999902",
        label: "架空第一支店 普通預金（有利息） ••••9902",
        linkedWalletName: null,
      },
    ]);
    const taken = await rejectionOf(
      connectBankAccount(prisma, { walletId, accountId: ACCOUNT_ID, now: NOW }, { actor, api }),
    );
    expect(taken).toBeInstanceOf(SettingsError);
    expect(taken).toMatchObject({
      field: "accountId",
      message:
        "この口座は「架空銀行 API 普通」に接続済みです。同じ口座を 2 つの口座に接続すると明細が二重になります",
    });
    for (const accountId of ["301019999990", "301119999998"]) {
      await expect(
        connectBankAccount(prisma, { walletId, accountId, now: NOW }, { actor, api }),
      ).rejects.toMatchObject({
        field: "accountId",
        message:
          "選んだ口座は銀行 API の口座一覧にありません。画面を読み込み直して、口座を選び直してください",
      });
    }
    await expect(
      connectBankAccount(prisma, { walletId, accountId: "301-01", now: NOW }, { actor, api }),
    ).rejects.toThrow();
    expect((await walletRow(walletId)).bankApiAccountId).toBeNull();
  });

  it("uses the bank's balance as the statement balance when it is the latest", async () => {
    await prisma.wallet.update({
      where: { id: mainId },
      data: { bankApiBalance: 1_200_000n, bankApiBalanceDate: toDbDate("2026-11-30") },
    });
    const statusOf = async (through: CalendarDate) =>
      (await loadWalletStatus(prisma, { through })).find((row) => row.walletId === mainId);
    expect(await statusOf("2026-11-30")).toMatchObject({
      lastStatement: { date: "2026-11-30", balanceAfter: 1_200_000n },
      lastSyncedAt: LATER,
      bankApiStatus: "connected",
    });
    // Before the balance's date: the lines.
    expect(await statusOf("2026-11-29")).toMatchObject({
      lastStatement: { date: "2026-11-29", balanceAfter: 1_187_500n },
    });
    // A balance older than the last line: the line.
    await prisma.wallet.update({
      where: { id: mainId },
      data: { bankApiBalanceDate: toDbDate("2026-11-28") },
    });
    expect(await statusOf("2026-11-30")).toMatchObject({
      lastStatement: { date: "2026-11-30", balanceAfter: 1_217_500n },
    });
  });

  it("syncs every connected bank wallet and reports each one", async () => {
    const asleep = await connectedWallet("架空銀行 API 休止");
    await setWalletActive(prisma, { id: asleep, isActive: false }, { actor });
    const outcomes = await syncAllBankWallets(prisma, {
      actor,
      now: LATER,
      apiFor: (walletId) =>
        walletId === mainId
          ? new FakeBankApi({ transactions: thirtyDays(), balance: 1_217_500n })
          : new FakeBankApi(),
    });
    const byWallet = new Map(outcomes.map((outcome) => [outcome.walletId, outcome]));
    expect(byWallet.get(mainId)).toMatchObject({ error: null, batchId: null });
    expect(byWallet.get(refusedId)).toMatchObject({ error: null });
    expect(byWallet.has(asleep)).toBe(false);
    // 再接続が必要 wallets are recorded as failed without calling the bank.
    const reauth = await prisma.wallet.findMany({
      where: { isActive: true, kind: "bank", bankApiStatus: "reauth_required" },
      select: { id: true },
    });
    for (const { id } of reauth) {
      expect(byWallet.get(id)?.error).toMatch(/再接続/);
    }
    // Authorized wallets (no account chosen yet) are not synced.
    const authorized = await prisma.wallet.findMany({ where: { bankApiStatus: "authorized" } });
    for (const { id } of authorized) expect(byWallet.has(id)).toBe(false);

    // A wallet whose sync throws (here its hook) is reported; its batch is rolled back.
    const thrown = await syncAllBankWallets(prisma, {
      actor,
      now: new Date("2026-12-01T01:00:00Z"),
      afterImport: (_tx, batch) =>
        batch.walletId === mainId
          ? Promise.reject(new SettingsError("自動登録のルールを確かめてください"))
          : Promise.resolve(),
      apiFor: (walletId) =>
        new FakeBankApi({
          transactions:
            walletId === mainId
              ? [bankLine("2026120109000000000001", "2026-12-01", 1_000n, 1_218_500n)]
              : [],
        }),
    });
    expect(thrown.find((outcome) => outcome.walletId === mainId)).toMatchObject({
      batchId: null,
      error: "自動登録のルールを確かめてください",
    });
    expect(
      await prisma.walletTransaction.count({ where: { externalId: "2026120109000000000001" } }),
    ).toBe(0);
  });

  it("disconnects: the columns are cleared, the lines and batches stay", async () => {
    const lines = await prisma.walletTransaction.count({ where: { walletId: mainId } });
    const batches = await batchCount(mainId);
    await disconnectBankLink(prisma, { walletId: mainId }, { actor });
    expect(await walletRow(mainId)).toMatchObject({
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
    });
    expect(await prisma.walletTransaction.count({ where: { walletId: mainId } })).toBe(lines);
    expect(await batchCount(mainId)).toBe(batches);
    await expect(syncBankWallet(prisma, { walletId: mainId }, { actor })).rejects.toThrow(
      "銀行 API が接続されていません。銀行 API の接続で接続してください",
    );
    // Nothing left to disconnect: no error, no audit.
    await disconnectBankLink(prisma, { walletId: mainId }, { actor });
    const audits = await prisma.auditLog.findMany({
      where: { entityId: mainId, action: { startsWith: "wallet." } },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(audits.map((row) => row.action)).toEqual([
      "wallet.create",
      "wallet.authorize_bank",
      "wallet.connect_bank",
      "wallet.disconnect_bank",
    ]);
    // Only bank wallets have a connection.
    const cash = await prisma.wallet.findFirstOrThrow({ where: { kind: "cash" } });
    expect(await getBankLink(prisma, cash.id)).toBeNull();
    await expect(
      saveBankAuthorization(prisma, { walletId: cash.id, env: "sunabar", tokens: null }, { actor }),
    ).rejects.toThrow("銀行の口座ではありません。種類が 銀行 の口座を選んでください");
  });

  it("authorizes the sunabar token only when the bank accepts it", async () => {
    const walletId = await bankWallet("架空銀行 API トークン");
    const refused = bankFetch(() =>
      jsonResponse(401, { errorCode: "WG_ERR_101", errorMessage: "認証エラー" }),
    );
    const rejected = await rejectionOf(
      authorizeBankToken(
        prisma,
        { walletId },
        { actor, config: TOKEN_CONFIG, fetch: refused.fetch },
      ),
    );
    expect(rejected).toBeInstanceOf(SettingsError);
    expect(rejected).toMatchObject({
      field: "walletId",
      message:
        "銀行 API がトークンを受け付けませんでした（401 WG_ERR_101 認証エラー）。sunabar にログインしてトークンを確かめ、環境変数 NIHO_FINANCE_GMO_AOZORA_ACCESS_TOKEN を差し替えてから、もう一度接続してください",
    });
    expect(refused.requests).toMatchObject([{ path: "/accounts", token: "fake-sunabar-token" }]);
    expect(await getBankLink(prisma, walletId)).toMatchObject({ env: null, status: null });

    // A rate limit is refused too, with the bank's reason.
    const limited = bankFetch(() =>
      jsonResponse(429, { errorCode: "WG_ERR_154", errorMessage: "利用上限" }),
    );
    await expect(
      authorizeBankToken(
        prisma,
        { walletId },
        { actor, config: TOKEN_CONFIG, fetch: limited.fetch },
      ),
    ).rejects.toBeInstanceOf(SettingsError);
    expect((await walletRow(walletId)).bankApiStatus).toBeNull();

    // The authorization code flow's environment is connected from the bank's screen, not here.
    await expect(
      authorizeBankToken(prisma, { walletId }, { actor, config: OAUTH_CONFIG }),
    ).rejects.toThrow("この環境は銀行の認可画面から接続します");
    // Only bank wallets, and without calling the bank.
    const cash = await prisma.wallet.findFirstOrThrow({ where: { kind: "cash" } });
    const unused = bankFetch(() => jsonResponse(500, undefined));
    await expect(
      authorizeBankToken(
        prisma,
        { walletId: cash.id },
        { actor, config: TOKEN_CONFIG, fetch: unused.fetch },
      ),
    ).rejects.toThrow("銀行の口座ではありません。種類が 銀行 の口座を選んでください");
    expect(unused.requests).toHaveLength(0);

    const accepted = bankFetch((request) =>
      request.path === "/accounts"
        ? jsonResponse(200, { accounts: FICTIONAL_ACCOUNTS })
        : jsonResponse(404, { errorCode: "WG_ERR_404", errorMessage: "not found" }),
    );
    await authorizeBankToken(
      prisma,
      { walletId },
      { actor, config: TOKEN_CONFIG, fetch: accepted.fetch },
    );
    expect(accepted.requests.map((request) => request.path)).toEqual(["/accounts"]);
    expect(await getBankLink(prisma, walletId)).toMatchObject({
      env: "sunabar",
      status: "authorized",
      accountLabel: null,
    });
    expect((await walletRow(walletId)).bankApiTokens).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { entityId: walletId, action: "wallet.authorize_bank" },
      }),
    ).toBe(1);
  });

  it("keeps the tokens and the account ID out of the audit log and the backup", async () => {
    const audits = await prisma.auditLog.findMany({
      where: { OR: [{ entityId: { in: created } }, { action: "import_batch.sync" }] },
    });
    expect(audits.length).toBeGreaterThan(10);
    const text = JSON.stringify(audits);
    for (const secret of [ACCOUNT_ID, "fake-access", "fake-refresh", "fake-sunabar-token"]) {
      expect(text).not.toContain(secret);
    }
    // No sealed tokens either.
    expect(text).not.toMatch(/v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\./);
    const backup = await loadBackupSource(prisma);
    const wallets = backup.settings.wallets.filter((wallet) => created.includes(String(wallet.id)));
    expect(wallets.length).toBe(created.length);
    for (const wallet of wallets) {
      expect(wallet).not.toHaveProperty("bankApiTokens");
      expect(wallet).not.toHaveProperty("bankApiAccountId");
    }
    expect(
      JSON.stringify(wallets, (_key, value: unknown) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain(ACCOUNT_ID);
    expect(wallets.find((wallet) => wallet.bankApiStatus === "connected")).toMatchObject({
      bankApiAccountLabel: ACCOUNT_LABEL,
    });
  });
});
