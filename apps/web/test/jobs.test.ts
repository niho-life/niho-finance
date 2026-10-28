import type * as Db from "@niho-finance/db";
import type { CalendarNotice } from "@niho-finance/db";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { backupFolder } from "../lib/jobs/backup-export";
import { calendarNoticeText } from "../lib/jobs/calendar-notify";
import { mailCheckText } from "../lib/jobs/mail-check";
import { runJob } from "../lib/jobs/run";

vi.mock("@niho-finance/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  // The handlers below never query: no database is needed.
  getPrismaClient: () => ({}),
}));

const request = new Request("http://localhost/api/jobs/test", { method: "POST" });
const service = process.env.NIHO_FINANCE_SERVICE;

beforeAll(async () => {
  // Read the repository .env first, so the values set below win over it.
  const { loadRootEnv } = await import("@niho-finance/db");
  loadRootEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.NIHO_FINANCE_SERVICE = service;
});

describe("runJob", () => {
  it("answers 404 on the web service without running the job", async () => {
    process.env.NIHO_FINANCE_SERVICE = "web";
    const handler = vi.fn();
    const response = await runJob(request, "test", handler);
    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns the summary and logs job.finished", async () => {
    process.env.NIHO_FINANCE_SERVICE = "jobs";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await runJob(request, "test", ({ today }) =>
      Promise.resolve({ today, files: 3 }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, job: "test", files: 3 });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      severity: "INFO",
      event: "job.finished",
      job: "test",
      ok: true,
      files: 3,
    });
  });

  it("turns a failure into a 500 and an ERROR line, never a throw", async () => {
    process.env.NIHO_FINANCE_SERVICE = "jobs";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await runJob(request, "test", () => Promise.reject(new Error("boom")));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, job: "test", error: "boom" });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      severity: "ERROR",
      event: "job.finished",
      ok: false,
      error: "boom",
    });
  });
});

describe("backupFolder", () => {
  it("names the folder by the UTC date and time", () => {
    expect(backupFolder(new Date("2026-11-20T18:00:05.123Z"))).toBe("exports/2026-11-20/180005Z");
  });
});

describe("calendarNoticeText", () => {
  function notice(
    stage: CalendarNotice["stage"],
    dueDate: CalendarNotice["item"]["dueDate"],
    title: string,
    note: string | null = null,
  ): CalendarNotice {
    return {
      stage,
      item: {
        id: title,
        dueDate,
        completedAt: null,
        lastNotifiedOn: null,
        title,
        note,
        kind: "filing",
      },
    };
  }

  it("lists the items under the headings that have any, then the URL", () => {
    const text = calendarNoticeText(
      [
        notice(
          "overdue",
          "2026-11-15",
          "健康保険・厚生年金 新規適用届（年金事務所）",
          "役員報酬を払う場合",
        ),
        notice("week", "2026-12-10", "給与支払事務所等の開設届出書（税務署）"),
      ],
      "https://finance.example.com",
    );
    expect(text).toBe(
      [
        "7 日以内",
        "- 2026-12-10 給与支払事務所等の開設届出書（税務署）",
        "",
        "期限超過",
        "- 2026-11-15 健康保険・厚生年金 新規適用届（年金事務所）（役員報酬を払う場合）",
        "",
        "https://finance.example.com",
        "",
      ].join("\n"),
    );
  });

  it("leaves out the URL when there is none", () => {
    expect(calendarNoticeText([notice("today", "2026-12-10", "届出")])).toBe(
      "本日\n- 2026-12-10 届出\n",
    );
  });
});

describe("mailCheckText", () => {
  it("says what the mail confirms, when it was sent (JST), the version and the URL", () => {
    expect(
      mailCheckText({
        sentAt: new Date("2026-10-28T11:45:00Z"),
        gitSha: "abc123def456",
        appUrl: "https://finance.example.com",
      }),
    ).toBe(
      [
        "NIHO finance からの送信の確認です。",
        "このメールが届いていれば、期限のお知らせも同じ経路で届きます。",
        "",
        "送信: 2026-10-28 20:45（日本時間）",
        "版: abc123def456",
        "",
        "https://finance.example.com",
        "",
      ].join("\n"),
    );
  });
});
