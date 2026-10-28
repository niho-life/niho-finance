import type { RegistryCheckResult } from "@niho-finance/db";
import { describe, expect, it, vi } from "vitest";
import type { JobAuthResult } from "@/lib/jobs/auth";
import { handleRegistryCheckJob, type RegistryCheckJobBody } from "./job";

const PRINCIPAL = "scheduler@example-project.iam.gserviceaccount.com";
/** A fictional application ID (13 digits). */
const APPLICATION_ID = "1234567890123";

function request(): Request {
  return new Request("https://jobs.example.test/api/jobs/registry-check", {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
  });
}

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

const accepted = (): Promise<JobAuthResult> => Promise.resolve({ ok: true, principal: PRINCIPAL });
const configured = () => true;

async function bodyOf(response: Response): Promise<RegistryCheckJobBody> {
  return (await response.json()) as RegistryCheckJobBody;
}

describe("handleRegistryCheckJob", () => {
  it.each([
    [401, "認証のトークンがありません"],
    [403, "認証のトークンの宛先が一致しません"],
    [503, "ジョブの認証が設定されていません"],
  ] as const)(
    "passes an authentication failure through (%i) without checking",
    async (status, reason) => {
      const check = vi.fn(() => Promise.resolve(result()));
      const response = await handleRegistryCheckJob(request(), {
        verify: () => Promise.resolve({ ok: false, status, reason }),
        configured,
        check,
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await bodyOf(response)).toEqual({ ok: false, error: reason });
      expect(check).not.toHaveBeenCalled();
    },
  );

  it("answers 200 ok:false without the application ID, checking nothing", async () => {
    const check = vi.fn(() => Promise.resolve(result()));
    const response = await handleRegistryCheckJob(request(), {
      verify: accepted,
      configured: () => false,
      check,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toEqual({
      ok: false,
      error: "国税庁の照合が設定されていません",
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("checks as the job's principal and answers 200 with the counts", async () => {
    const check = vi.fn(() =>
      Promise.resolve(
        result({
          checked: 11,
          registered: 9,
          failed: 1,
          errors: ["国税庁の公表サイトに接続できませんでした（HTTP 503）"],
        }),
      ),
    );
    const response = await handleRegistryCheckJob(request(), {
      verify: accepted,
      configured,
      check,
    });
    expect(check).toHaveBeenCalledWith(PRINCIPAL);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toEqual({
      ok: true,
      checked: 11,
      registered: 9,
      notRegistered: 1,
      ended: 1,
      failed: 1,
      errors: ["国税庁の公表サイトに接続できませんでした（HTTP 503）"],
    });
  });

  it("never answers 5xx: an exception is 200 ok:false, logged without the URL or the ID", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleRegistryCheckJob(request(), {
        verify: accepted,
        configured,
        check: () =>
          Promise.reject(
            new Error(
              `fetch failed: https://web-api.example.test/1/num?id=${APPLICATION_ID}&number=T1111111111111 (id=${APPLICATION_ID})`,
            ),
          ),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: "照合できませんでした" });
      expect(text).not.toContain(APPLICATION_ID);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain("registry-check job failed");
      expect(line).not.toContain(APPLICATION_ID);
      expect(line).not.toContain("web-api.example.test");
    } finally {
      log.mockRestore();
    }
  });
});
