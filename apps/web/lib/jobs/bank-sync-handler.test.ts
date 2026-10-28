import type { ImportOutcome } from "@niho-finance/db";
import { describe, expect, it, vi } from "vitest";
import type { JobAuthResult } from "./auth";
import {
  bankSyncFinished,
  handleBankSyncJob,
  methodNotAllowed,
  type BankSyncJobBody,
} from "./bank-sync";

const PRINCIPAL = "scheduler@example-project.iam.gserviceaccount.com";

function request(): Request {
  return new Request("https://jobs.example.test/api/jobs/bank-sync", {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
  });
}

function outcome(overrides: Partial<ImportOutcome> = {}): ImportOutcome {
  return {
    batchId: "batch-1",
    walletId: "wallet-1",
    source: "api",
    rowCount: 30,
    importedCount: 28,
    duplicateCount: 2,
    failedCount: 0,
    warnings: [],
    error: null,
    ...overrides,
  };
}

const accepted = (): Promise<JobAuthResult> => Promise.resolve({ ok: true, principal: PRINCIPAL });

async function bodyOf(response: Response): Promise<BankSyncJobBody> {
  return (await response.json()) as BankSyncJobBody;
}

describe("handleBankSyncJob", () => {
  it("refuses a request without a token (401) without syncing", async () => {
    const sync = vi.fn(() => Promise.resolve([outcome()]));
    const response = await handleBankSyncJob(
      new Request("https://jobs.example.test/api/jobs/bank-sync", { method: "POST" }),
      {
        verify: () =>
          Promise.resolve({ ok: false, status: 401, reason: "認証のトークンがありません" }),
        sync,
      },
    );
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ ok: false, error: "認証のトークンがありません" });
    expect(sync).not.toHaveBeenCalled();
  });

  it.each([
    [401, "認証のトークンの署名が正しくありません"],
    [403, "認証のトークンの宛先が一致しません"],
    [503, "ジョブの認証が設定されていません"],
  ] as const)(
    "passes an authentication failure through (%i) without syncing",
    async (status, reason) => {
      const sync = vi.fn(() => Promise.resolve([outcome()]));
      const response = await handleBankSyncJob(request(), {
        verify: () => Promise.resolve({ ok: false, status, reason }),
        sync,
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await bodyOf(response)).toEqual({ ok: false, error: reason });
      expect(sync).not.toHaveBeenCalled();
    },
  );

  it("syncs as the job's principal and answers 200 with each wallet's outcome", async () => {
    const reauth =
      "銀行 API がトークンを受け付けませんでした（401 WG_ERR_101）。再接続してください";
    const sync = vi.fn(() =>
      Promise.resolve([
        outcome(),
        outcome({
          batchId: "batch-2",
          walletId: "wallet-2",
          rowCount: 0,
          importedCount: 0,
          duplicateCount: 0,
          error: reauth,
        }),
        // Nothing new: no batch.
        outcome({ batchId: null, walletId: "wallet-3", importedCount: 0, duplicateCount: 4 }),
      ]),
    );
    const response = await handleBankSyncJob(request(), { verify: accepted, sync });
    expect(sync).toHaveBeenCalledWith(PRINCIPAL);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toEqual({
      ok: true,
      wallets: [
        {
          walletId: "wallet-1",
          ok: true,
          batchId: "batch-1",
          importedCount: 28,
          duplicateCount: 2,
          failedCount: 0,
          error: null,
        },
        {
          walletId: "wallet-2",
          ok: false,
          batchId: "batch-2",
          importedCount: 0,
          duplicateCount: 0,
          failedCount: 0,
          error: reauth,
        },
        {
          walletId: "wallet-3",
          ok: true,
          batchId: null,
          importedCount: 0,
          duplicateCount: 4,
          failedCount: 0,
          error: null,
        },
      ],
    });
  });

  it("answers 200 with no wallets when none is connected", async () => {
    const response = await handleBankSyncJob(request(), {
      verify: accepted,
      sync: () => Promise.resolve([]),
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true, wallets: [] });
  });

  it("never answers 5xx: an unexpected exception is logged without secrets and is 200 ok:false", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleBankSyncJob(request(), {
        verify: accepted,
        sync: () =>
          Promise.reject(
            new Error(
              "connect failed: postgresql://user:secret@db.example.test:5432/app with x-access-token fakeAccessToken0123456789abcdefABCDEF for 301019999999 and Bearer fake-bearer",
            ),
          ),
      });
      expect(response.status).toBe(200);
      expect(await bodyOf(response)).toEqual({ ok: false, error: "同期できませんでした" });
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain("bank-sync job failed");
      expect(line).not.toContain("secret@");
      expect(line).not.toContain("fakeAccessToken0123456789abcdefABCDEF");
      expect(line).not.toContain("301019999999");
      expect(line).not.toContain("fake-bearer");
    } finally {
      log.mockRestore();
    }
  });
});

describe("methodNotAllowed", () => {
  it("is 405 with Allow: POST", async () => {
    const response = methodNotAllowed();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect((await bodyOf(response)).ok).toBe(false);
  });
});

describe("bankSyncFinished", () => {
  const wallet = {
    walletId: "w1",
    ok: true,
    batchId: null,
    importedCount: 3,
    duplicateCount: 2,
    failedCount: 1,
    error: null,
  };

  it("is ok when every wallet synced, with the totals", () => {
    const finished = bankSyncFinished(200, {
      ok: true,
      wallets: [wallet, { ...wallet, walletId: "w2" }],
    });
    expect(finished.ok).toBe(true);
    expect(finished.fields).toEqual({ wallets: 2, imported: 6, duplicates: 4, failedRows: 2 });
  });

  it("is not ok when a wallet failed (a lapsed authorization reaches the alert)", () => {
    const lapsed = { ...wallet, walletId: "w2", ok: false, error: "銀行 API の再接続が必要です" };
    const finished = bankSyncFinished(200, { ok: true, wallets: [wallet, lapsed] });
    expect(finished.ok).toBe(false);
    expect(finished.fields).toMatchObject({ failedWallets: [lapsed] });
  });

  it("is not ok for a refused request", () => {
    expect(bankSyncFinished(401, { ok: false, error: "no token" })).toEqual({
      ok: false,
      fields: { status: 401, error: "no token" },
    });
  });
});
