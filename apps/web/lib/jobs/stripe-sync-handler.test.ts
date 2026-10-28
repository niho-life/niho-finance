import type { ImportOutcome } from "@niho-finance/db";
import { describe, expect, it, vi } from "vitest";
import type { JobAuthResult } from "./auth";
import { handleStripeSyncJob, methodNotAllowed, type StripeSyncJobBody } from "./stripe-sync";

const PRINCIPAL = "scheduler@example-project.iam.gserviceaccount.com";

function request(): Request {
  return new Request("https://jobs.example.test/api/jobs/stripe-sync", {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
  });
}

function outcome(overrides: Partial<ImportOutcome> = {}): ImportOutcome {
  return {
    batchId: "batch-1",
    walletId: "wallet-1",
    source: "stripe",
    rowCount: 5,
    importedCount: 3,
    duplicateCount: 2,
    failedCount: 0,
    warnings: [],
    error: null,
    ...overrides,
  };
}

const accepted = (): Promise<JobAuthResult> => Promise.resolve({ ok: true, principal: PRINCIPAL });

async function bodyOf(response: Response): Promise<StripeSyncJobBody> {
  return (await response.json()) as StripeSyncJobBody;
}

describe("handleStripeSyncJob", () => {
  it.each([
    [401, "認証のトークンがありません"],
    [403, "認証のトークンの宛先が一致しません"],
    [503, "ジョブの認証が設定されていません"],
  ] as const)(
    "passes an authentication failure through (%i) without syncing",
    async (status, reason) => {
      const sync = vi.fn(() => Promise.resolve([outcome()]));
      const response = await handleStripeSyncJob(request(), {
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
    const sync = vi.fn(() =>
      Promise.resolve([
        outcome(),
        outcome({
          batchId: "batch-2",
          walletId: "wallet-2",
          rowCount: 0,
          importedCount: 0,
          duplicateCount: 0,
          error: "鍵がありません（環境変数 NIHO_FINANCE_STRIPE_KEY_TEST）",
        }),
        outcome({ batchId: null, walletId: "wallet-3", importedCount: 0, duplicateCount: 4 }),
      ]),
    );
    const response = await handleStripeSyncJob(request(), { verify: accepted, sync });
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
          importedCount: 3,
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
          error: "鍵がありません（環境変数 NIHO_FINANCE_STRIPE_KEY_TEST）",
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
    const response = await handleStripeSyncJob(request(), {
      verify: accepted,
      sync: () => Promise.resolve([]),
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true, wallets: [] });
  });

  it("never answers 5xx: an unexpected exception is logged without secrets and is 200 ok:false", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleStripeSyncJob(request(), {
        verify: accepted,
        sync: () =>
          Promise.reject(
            new Error(
              "connect failed: postgresql://user:secret@db.example.test:5432/app with rk_test_abc123DEF",
            ),
          ),
      });
      expect(response.status).toBe(200);
      expect(await bodyOf(response)).toEqual({ ok: false, error: "同期できませんでした" });
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain("stripe-sync job failed");
      expect(line).not.toContain("secret@");
      expect(line).not.toContain("rk_test_abc123DEF");
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
