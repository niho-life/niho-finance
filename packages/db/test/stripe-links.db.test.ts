import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createWallet,
  getImportBatch,
  getStripeAccountLink,
  removeStripeAccountLink,
  resolveStripeApiKey,
  saveStripeAccountLink,
  setWalletActive,
  SettingsError,
  syncAllStripeWallets,
  syncStripeWallet,
  type AfterImportHook,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { testPrisma } from "./support/prisma";
import {
  balanceTransaction,
  failingSource,
  FakeBalanceTransactionSource,
  jst,
} from "./support/stripe-source";

const actor = "sync@example.com";

/** Names of environment variables for fictional keys (set with `vi.stubEnv`, never real keys). */
const PLATFORM_KEY = "NIHO_FINANCE_STRIPE_TEST_KEY_PLATFORM";
const BRANCH_KEY = "NIHO_FINANCE_STRIPE_TEST_KEY_BRANCH";
const MISSING_KEY = "NIHO_FINANCE_STRIPE_TEST_KEY_MISSING";
const PLATFORM_KEY_VALUE = "fake-platform-key";

const CHARGE = balanceTransaction({
  id: "txn_fake_charge_01",
  amount: 11_000,
  fee: 396,
  created: jst("2026-11-10T10:00"),
  available_on: jst("2026-11-17T09:00"),
  status: "pending",
  description: "予約 テストルーム 2 泊",
  source: "ch_fake_01",
  fee_details: [
    {
      amount: 360,
      currency: "jpy",
      type: "stripe_fee",
      description: "Stripe processing fees",
      application: null,
    },
    { amount: 36, currency: "jpy", type: "tax", description: "JCT", application: null },
  ],
});
/** Nothing moves: skipped and not counted. */
const NOTHING = balanceTransaction({
  id: "txn_fake_zero_01",
  amount: 0,
  created: jst("2026-11-12T08:00"),
  reporting_category: "other_adjustment",
  type: "adjustment",
});
const FOREIGN = balanceTransaction({
  id: "txn_fake_usd_01",
  amount: 1_500,
  fee: 75,
  currency: "usd",
  created: jst("2026-11-15T12:00"),
});
/** 03:00 JST is the previous day in UTC: the line is dated by the JST day. */
const PAYOUT = balanceTransaction({
  id: "txn_fake_payout_01",
  amount: -10_604,
  created: jst("2026-11-20T03:00"),
  reporting_category: "payout",
  type: "payout",
  description: "STRIPE PAYOUT",
  source: "po_fake_01",
});
/** Older than the cursor, listed only after it was set: the 7-day overlap catches it. */
const LATE = balanceTransaction({
  id: "txn_fake_charge_02",
  amount: 3_300,
  fee: 119,
  created: jst("2026-11-18T15:00"),
  source: "ch_fake_02",
});

function dateOf(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** Stripe connections and sync on the seeded book, with fictional accounts and fixture sources. */
describe.skipIf(!hasTestDatabase)("Stripe connections and sync", () => {
  let prisma: PrismaClient;
  let platformId: string;
  let bankId: string;
  let branchId: string;

  beforeAll(async () => {
    prisma = testPrisma();
    const wallets = await prisma.wallet.findMany();
    const idOf = (name: string): string => {
      const wallet = wallets.find((item) => item.name === name);
      if (!wallet) throw new Error(`not seeded: ${name}`);
      return wallet.id;
    };
    platformId = idOf("Stripe platform");
    bankId = idOf("架空銀行 普通");
    vi.stubEnv(PLATFORM_KEY, PLATFORM_KEY_VALUE);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  async function linkOf(walletId: string) {
    return prisma.stripeAccountLink.findUniqueOrThrow({ where: { walletId } });
  }

  it("resolves a key by the name of its variable", () => {
    const name = "NIHO_FINANCE_STRIPE_FAKE_KEY";
    expect(resolveStripeApiKey(name, { [name]: "  fake-key  " })).toBe("fake-key");
    expect(resolveStripeApiKey(name, { [name]: "   " })).toBeNull();
    expect(resolveStripeApiKey(name, {})).toBeNull();
    // Only NIHO_FINANCE_STRIPE_* variables are read as a key.
    expect(resolveStripeApiKey("FAKE_KEY", { FAKE_KEY: "fake-key" })).toBeNull();
    expect(resolveStripeApiKey(PLATFORM_KEY)).toBe(PLATFORM_KEY_VALUE);
  });

  it("connects a Stripe wallet and changes the name of its key", async () => {
    await expect(
      saveStripeAccountLink(
        prisma,
        { walletId: bankId, stripeAccountId: "acct_FICTIONALBK01", secretName: PLATFORM_KEY },
        { actor },
      ),
    ).rejects.toMatchObject({
      message: "Stripe の口座ではありません。種類が Stripe の口座を選んでください",
      field: "walletId",
    });

    const input = { walletId: platformId, stripeAccountId: "acct_FICTIONALPF01" };
    expect(
      await saveStripeAccountLink(prisma, { ...input, secretName: MISSING_KEY }, { actor }),
    ).toEqual({
      walletId: platformId,
      walletName: "Stripe platform",
      stripeAccountId: "acct_FICTIONALPF01",
      secretName: MISSING_KEY,
      keyConfigured: false,
      syncCursor: null,
      lastSyncedAt: null,
      lastBatch: null,
    });
    // The same values again change nothing.
    await saveStripeAccountLink(prisma, { ...input, secretName: MISSING_KEY }, { actor });
    expect(
      await saveStripeAccountLink(prisma, { ...input, secretName: PLATFORM_KEY }, { actor }),
    ).toMatchObject({ secretName: PLATFORM_KEY, keyConfigured: true });

    const link = await linkOf(platformId);
    const audits = await prisma.auditLog.findMany({
      where: { entityId: link.id },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(audits.map((row) => [row.action, row.actor])).toEqual([
      ["stripe_account_link.create", actor],
      ["stripe_account_link.update", actor],
    ]);
    expect(audits[1]).toMatchObject({
      before: { secretName: MISSING_KEY },
      after: { secretName: PLATFORM_KEY, stripeAccountId: "acct_FICTIONALPF01" },
    });
    expect(JSON.stringify(audits)).not.toContain(PLATFORM_KEY_VALUE);
  });

  it("records a sync without a key as a failed batch", async () => {
    branchId = (
      await createWallet(
        prisma,
        {
          name: "Stripe 架空拠点",
          kind: "stripe",
          openingBalance: "0",
          openingBalanceDate: "2026-11-01",
        },
        { actor },
      )
    ).id;
    await saveStripeAccountLink(
      prisma,
      { walletId: branchId, stripeAccountId: "acct_FICTIONALBR01", secretName: MISSING_KEY },
      { actor },
    );
    const source = new FakeBalanceTransactionSource([CHARGE]);
    const outcome = await syncStripeWallet(prisma, { walletId: branchId }, { actor, source });
    expect(outcome).toMatchObject({
      walletId: branchId,
      source: "stripe",
      rowCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      failedCount: 0,
      error: `鍵がありません（環境変数 ${MISSING_KEY}）。鍵を置いてから、もう一度同期してください`,
    });
    expect(source.calls).toEqual([]);
    expect(await getImportBatch(prisma, outcome.batchId ?? "")).toMatchObject({
      walletName: "Stripe 架空拠点",
      source: "stripe",
      importer: "stripe",
      rowCount: 0,
      error: outcome.error,
    });
    expect(await getStripeAccountLink(prisma, branchId)).toMatchObject({
      keyConfigured: false,
      syncCursor: null,
      lastSyncedAt: null,
      lastBatch: { id: outcome.batchId, error: outcome.error },
    });
    expect(await prisma.auditLog.findMany({ where: { entityId: outcome.batchId } })).toMatchObject([
      { action: "import_batch.sync", actor, after: { error: outcome.error } },
    ]);
  });

  it("syncs gross, fee and payout lines and keeps the newest transaction as the cursor", async () => {
    const source = new FakeBalanceTransactionSource([CHARGE, NOTHING, FOREIGN, PAYOUT]);
    const now = new Date("2026-11-21T00:00:00Z");
    const hooked: string[][] = [];
    const afterImport: AfterImportHook = (_tx, batch) => {
      hooked.push(batch.transactionIds);
      return Promise.resolve();
    };
    const journalEntries = await prisma.journalEntry.count();
    const outcome = await syncStripeWallet(
      prisma,
      { walletId: platformId, now },
      { actor, afterImport, source },
    );
    expect(typeof outcome.batchId).toBe("string");
    expect(outcome).toEqual({
      batchId: outcome.batchId,
      walletId: platformId,
      source: "stripe",
      rowCount: 3,
      importedCount: 3,
      duplicateCount: 0,
      failedCount: 1,
      warnings: [],
      error: null,
    });
    // Everything (no opening date, no cursor), page by page.
    expect(source.calls).toEqual([{ limit: 100 }, { limit: 100, startingAfter: FOREIGN.id }]);

    const lines = await prisma.walletTransaction.findMany({
      where: { importBatchId: outcome.batchId ?? "" },
      orderBy: { id: "asc" },
    });
    expect(hooked).toEqual([lines.map((line) => line.id)]);
    expect(
      lines.map((line) => ({
        externalId: line.externalId,
        txnDate: dateOf(line.txnDate),
        valueDate: dateOf(line.valueDate),
        occurredAt: line.occurredAt?.toISOString(),
        amount: line.amount,
        category: line.category,
        descriptionRaw: line.descriptionRaw,
      })),
    ).toEqual([
      {
        externalId: "txn_fake_charge_01",
        txnDate: "2026-11-10",
        valueDate: "2026-11-17",
        occurredAt: "2026-11-10T01:00:00.000Z",
        amount: 11_000n,
        category: "charge",
        descriptionRaw: "決済 予約 テストルーム 2 泊",
      },
      {
        externalId: "txn_fake_charge_01:fee",
        txnDate: "2026-11-10",
        valueDate: "2026-11-17",
        occurredAt: "2026-11-10T01:00:00.000Z",
        amount: -396n,
        category: "fee",
        descriptionRaw: "手数料 · 決済 予約 テストルーム 2 泊",
      },
      {
        externalId: "txn_fake_payout_01",
        txnDate: "2026-11-20",
        valueDate: "2026-11-20",
        occurredAt: "2026-11-19T18:00:00.000Z",
        amount: -10_604n,
        category: "payout",
        descriptionRaw: "入金（銀行へ） STRIPE PAYOUT",
      },
    ]);
    expect(
      lines.every(
        (line) =>
          line.status === "pending" && line.balanceAfter === null && line.counterpartyRaw === null,
      ),
    ).toBe(true);
    expect(lines[0]?.raw).toMatchObject({ id: CHARGE.id, source: "ch_fake_01", fee: 396 });
    expect(lines[1]?.raw).toEqual({
      balanceTransactionId: CHARGE.id,
      feeDetails: CHARGE.fee_details,
    });
    expect(await prisma.journalEntry.count()).toBe(journalEntries);

    const batch = await getImportBatch(prisma, outcome.batchId ?? "");
    expect(batch).toMatchObject({
      source: "stripe",
      importer: "stripe",
      originalName: null,
      periodFrom: "2026-11-10",
      periodTo: "2026-11-20",
      rowCount: 3,
      importedCount: 3,
      duplicateCount: 0,
      failedCount: 1,
      error: null,
      executedBy: actor,
    });
    expect(batch?.failures).toEqual([
      {
        rowNumber: 0,
        reason: "通貨が円ではありません（usd）",
        raw: ["2026-11-15", "1500 USD", FOREIGN.reporting_category],
      },
    ]);
    expect(await getStripeAccountLink(prisma, platformId)).toMatchObject({
      syncCursor: { created: new Date(PAYOUT.created * 1000), id: PAYOUT.id },
      lastSyncedAt: now,
      lastBatch: { id: outcome.batchId },
    });
    expect((await linkOf(platformId)).syncCursor).toBe(
      JSON.stringify({ created: PAYOUT.created, id: PAYOUT.id }),
    );
    expect(await prisma.auditLog.findMany({ where: { entityId: outcome.batchId } })).toMatchObject([
      {
        action: "import_batch.sync",
        actor,
        after: {
          walletId: platformId,
          batchId: outcome.batchId,
          importedCount: 3,
          syncCursor: { created: PAYOUT.created, id: PAYOUT.id },
        },
      },
    ]);
  });

  it("syncs again without duplicating and never moves the cursor back", async () => {
    const source = new FakeBalanceTransactionSource([CHARGE, NOTHING, FOREIGN, PAYOUT]);
    const again = await syncStripeWallet(
      prisma,
      { walletId: platformId, now: new Date("2026-11-22T00:00:00Z") },
      { actor, source },
    );
    expect(source.calls[0]?.createdGte).toBe(PAYOUT.created - 7 * 24 * 60 * 60);
    // Nothing new (the payout again, the foreign one was recorded by the first sync): no batch.
    const batches = await prisma.importBatch.count({ where: { walletId: platformId } });
    expect(again).toMatchObject({
      batchId: null,
      rowCount: 1,
      importedCount: 0,
      duplicateCount: 1,
      failedCount: 0,
      error: null,
    });
    expect(await prisma.importBatch.count({ where: { walletId: platformId } })).toBe(batches);

    const lateSync = new Date("2026-11-23T00:00:00Z");
    const late = await syncStripeWallet(
      prisma,
      { walletId: platformId, now: lateSync },
      { actor, source: new FakeBalanceTransactionSource([LATE]) },
    );
    expect(late).toMatchObject({ rowCount: 1, importedCount: 2, duplicateCount: 0 });
    expect(await getStripeAccountLink(prisma, platformId)).toMatchObject({
      syncCursor: { id: PAYOUT.id },
      lastSyncedAt: lateSync,
    });
  });

  it("records only the time and the audit log when there is nothing new", async () => {
    const now = new Date("2026-11-24T00:00:00Z");
    const batches = await prisma.importBatch.count({ where: { walletId: platformId } });
    const outcome = await syncStripeWallet(
      prisma,
      { walletId: platformId, now },
      { actor, source: new FakeBalanceTransactionSource([]) },
    );
    expect(outcome).toEqual({
      batchId: null,
      walletId: platformId,
      source: "stripe",
      rowCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      failedCount: 0,
      warnings: [],
      error: null,
    });
    expect(await prisma.importBatch.count({ where: { walletId: platformId } })).toBe(batches);
    expect(await linkOf(platformId)).toMatchObject({
      lastSyncedAt: now,
      syncCursor: JSON.stringify({ created: PAYOUT.created, id: PAYOUT.id }),
    });
    const audit = await prisma.auditLog.findFirst({
      where: { action: "import_batch.sync", entityId: null, actor },
      orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    expect(audit?.after).toMatchObject({ walletId: platformId, batchId: null, rowCount: 0 });
  });

  it("records an API error with the key masked, and keeps the cursor and the last sync", async () => {
    const before = await linkOf(platformId);
    const error = Object.assign(
      new Error(`Invalid API Key provided: rk_test_FAKE********1234 (${PLATFORM_KEY_VALUE})`),
      { type: "StripeAuthenticationError" },
    );
    const outcome = await syncStripeWallet(
      prisma,
      { walletId: platformId, now: new Date("2026-11-30T00:00:00Z") },
      { actor, source: failingSource(error) },
    );
    expect(outcome.error).toBe(
      `Stripe が鍵を受け付けませんでした。環境変数 ${PLATFORM_KEY} の鍵を確かめてください（Invalid API Key provided: *** (***)）`,
    );
    expect(outcome).toMatchObject({ rowCount: 0, importedCount: 0 });
    expect(typeof outcome.batchId).toBe("string");
    expect((await getImportBatch(prisma, outcome.batchId ?? ""))?.error).toBe(outcome.error);
    const after = await linkOf(platformId);
    expect(after.syncCursor).toBe(before.syncCursor);
    expect(after.lastSyncedAt).toEqual(before.lastSyncedAt);
  });

  it("starts the first sync of a wallet at its statement opening date (JST)", async () => {
    vi.stubEnv(BRANCH_KEY, "fake-branch-key");
    await saveStripeAccountLink(
      prisma,
      { walletId: branchId, stripeAccountId: "acct_FICTIONALBR01", secretName: BRANCH_KEY },
      { actor },
    );
    const source = new FakeBalanceTransactionSource([]);
    await syncStripeWallet(prisma, { walletId: branchId }, { actor, source });
    expect(source.calls).toEqual([{ limit: 100, createdGte: jst("2026-11-01T00:00") }]);
  });

  it("syncs every connected, active Stripe wallet and reports each one", async () => {
    const sleeping = await createWallet(
      prisma,
      { name: "Stripe 架空休止", kind: "stripe" },
      { actor },
    );
    await saveStripeAccountLink(
      prisma,
      { walletId: sleeping.id, stripeAccountId: "acct_FICTIONALSL01", secretName: PLATFORM_KEY },
      { actor },
    );
    await setWalletActive(prisma, { id: sleeping.id, isActive: false }, { actor });
    const mine = <T extends { walletId: string }>(outcomes: T[]): T[] =>
      outcomes.filter((outcome) => [platformId, branchId, sleeping.id].includes(outcome.walletId));

    const outcomes = await syncAllStripeWallets(prisma, {
      actor,
      now: new Date("2026-12-01T00:00:00Z"),
      sourceFor: (walletId) =>
        walletId === platformId
          ? new FakeBalanceTransactionSource([CHARGE, PAYOUT])
          : failingSource(new Error("connect ETIMEDOUT")),
    });
    expect(mine(outcomes)).toMatchObject([
      { walletId: platformId, error: null, rowCount: 1, importedCount: 0, duplicateCount: 1 },
      {
        walletId: branchId,
        error:
          "Stripe から明細を取得できませんでした。時間をおいて、もう一度同期してください（connect ETIMEDOUT）",
      },
    ]);
    // The branch's failed fetch is recorded as a batch.
    expect(typeof mine(outcomes)[1]?.batchId).toBe("string");

    // A wallet whose sync throws (here its hook) is reported; its batch is rolled back.
    const fresh = balanceTransaction({
      id: "txn_fake_charge_03",
      amount: 2_200,
      created: jst("2026-12-01T10:00"),
    });
    const failed = await syncAllStripeWallets(prisma, {
      actor,
      afterImport: (_tx, batch) =>
        batch.walletId === platformId
          ? Promise.reject(new SettingsError("自動登録のルールを確かめてください"))
          : Promise.resolve(),
      sourceFor: (walletId) =>
        new FakeBalanceTransactionSource(walletId === platformId ? [fresh] : []),
    });
    expect(mine(failed)).toMatchObject([
      { walletId: platformId, batchId: null, error: "自動登録のルールを確かめてください" },
      { walletId: branchId, batchId: null, error: null },
    ]);
    expect(await prisma.walletTransaction.findMany({ where: { externalId: fresh.id } })).toEqual(
      [],
    );
  });

  it("changes the account: the sync starts over, and one account belongs to one wallet", async () => {
    const changed = await saveStripeAccountLink(
      prisma,
      { walletId: platformId, stripeAccountId: "acct_FICTIONALPF02", secretName: PLATFORM_KEY },
      { actor },
    );
    expect(changed).toMatchObject({
      stripeAccountId: "acct_FICTIONALPF02",
      syncCursor: null,
      lastSyncedAt: null,
    });
    await expect(
      saveStripeAccountLink(
        prisma,
        { walletId: branchId, stripeAccountId: "acct_FICTIONALPF02", secretName: BRANCH_KEY },
        { actor },
      ),
    ).rejects.toMatchObject({
      message:
        "このアカウントは口座「Stripe platform」に接続済みです。同じアカウントを 2 つの口座に接続すると明細が二重になります",
      field: "stripeAccountId",
    });
  });

  it("disconnects a wallet: the lines stay and the sync stops", async () => {
    const lines = await prisma.walletTransaction.count({ where: { walletId: platformId } });
    const link = await linkOf(platformId);
    await removeStripeAccountLink(prisma, { walletId: platformId }, { actor });
    expect(await getStripeAccountLink(prisma, platformId)).toBeNull();
    expect(await prisma.walletTransaction.count({ where: { walletId: platformId } })).toBe(lines);
    await expect(syncStripeWallet(prisma, { walletId: platformId }, { actor })).rejects.toThrow(
      "Stripe が接続されていません。取込の設定で接続してください",
    );
    // Nothing left to remove: no error, no audit.
    await removeStripeAccountLink(prisma, { walletId: platformId }, { actor });

    const audits = await prisma.auditLog.findMany({
      where: { entityId: link.id },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(audits.map((row) => row.action)).toEqual([
      "stripe_account_link.create",
      "stripe_account_link.update",
      "stripe_account_link.update",
      "stripe_account_link.delete",
    ]);
    expect(audits[3]?.before).toMatchObject({ stripeAccountId: "acct_FICTIONALPF02" });
    await expect(syncStripeWallet(prisma, { walletId: bankId }, { actor })).rejects.toBeInstanceOf(
      SettingsError,
    );
  });
});
