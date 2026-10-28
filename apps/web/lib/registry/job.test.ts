import type { PrismaClient, RegistryCheckResult } from "@niho-finance/db";
import type { NtaLookup } from "@niho-finance/importers";
import { describe, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/run";
import { createRegistryCheckJob, REGISTRY_NOT_CONFIGURED } from "./job";

const lookup: NtaLookup = {
  lookup: () => Promise.resolve({ registrations: new Map(), requestCount: 0, failures: [] }),
};
const context: JobContext = {
  prisma: {} as PrismaClient,
  today: "2026-11-01",
  startedAt: new Date("2026-10-31T21:30:00Z"),
};

function result(overrides: Partial<RegistryCheckResult> = {}): RegistryCheckResult {
  return {
    checked: 12,
    registered: 10,
    notRegistered: 1,
    ended: 1,
    failed: 0,
    errors: [],
    ...overrides,
  };
}

describe("registry-check job", () => {
  it("checks every partner as the system actor and reports the counts", async () => {
    const check = vi.fn(() => Promise.resolve(result()));
    const job = createRegistryCheckJob({ lookup: () => lookup, check });
    await expect(job(context)).resolves.toEqual({
      checked: 12,
      registered: 10,
      notRegistered: 1,
      ended: 1,
    });
    expect(check).toHaveBeenCalledWith(context.prisma, lookup, {
      actor: "system",
      now: context.startedAt,
    });
  });

  it("fails without the application ID, without checking", async () => {
    const check = vi.fn(() => Promise.resolve(result()));
    const job = createRegistryCheckJob({ lookup: () => null, check });
    await expect(job(context)).rejects.toThrow(REGISTRY_NOT_CONFIGURED);
    expect(check).not.toHaveBeenCalled();
  });

  it("fails when numbers could not be looked up, with the owner-facing reason", async () => {
    const check = vi.fn(() =>
      Promise.resolve(
        result({
          checked: 10,
          failed: 2,
          errors: ["国税庁の公表サイトに接続できませんでした（HTTP 503）"],
        }),
      ),
    );
    const job = createRegistryCheckJob({ lookup: () => lookup, check });
    await expect(job(context)).rejects.toThrow(
      "照合できなかった番号があります（2 件。国税庁の公表サイトに接続できませんでした（HTTP 503））",
    );
  });
});
