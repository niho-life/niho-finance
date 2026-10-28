import { describe, expect, it } from "vitest";
import type { StripeSyncJobWallet } from "../lib/jobs/stripe-sync";
import { stripeSyncFinished } from "../lib/jobs/stripe-sync-result";

function wallet(overrides: Partial<StripeSyncJobWallet> = {}): StripeSyncJobWallet {
  return {
    walletId: "w1",
    ok: true,
    batchId: "b1",
    importedCount: 3,
    duplicateCount: 1,
    failedCount: 0,
    error: null,
    ...overrides,
  };
}

describe("stripeSyncFinished", () => {
  it("is ok when every wallet synced, with the totals", () => {
    expect(
      stripeSyncFinished(200, { ok: true, wallets: [wallet(), wallet({ walletId: "w2" })] }),
    ).toEqual({
      ok: true,
      fields: { wallets: 2, imported: 6, duplicates: 2, failedRows: 0 },
    });
  });

  it("is ok with no connected wallet", () => {
    expect(stripeSyncFinished(200, { ok: true, wallets: [] })).toEqual({
      ok: true,
      fields: { wallets: 0, imported: 0, duplicates: 0, failedRows: 0 },
    });
  });

  it("fails when a wallet could not be synced, though the job answered 200", () => {
    const failed = wallet({
      walletId: "w2",
      ok: false,
      batchId: null,
      importedCount: 0,
      error: "鍵がありません",
    });
    const result = stripeSyncFinished(200, { ok: true, wallets: [wallet(), failed] });
    expect(result.ok).toBe(false);
    expect(result.fields).toMatchObject({
      wallets: 2,
      error: "同期できなかった口座があります（1 件）",
      failedWallets: [failed],
    });
  });

  it("fails when the sync threw or the request was refused", () => {
    expect(stripeSyncFinished(200, { ok: false, error: "同期できませんでした" })).toEqual({
      ok: false,
      fields: { status: 200, error: "同期できませんでした" },
    });
    expect(stripeSyncFinished(401, { ok: false, error: "認証のトークンがありません" })).toEqual({
      ok: false,
      fields: { status: 401, error: "認証のトークンがありません" },
    });
  });
});
