import { afterEach, describe, expect, it, vi } from "vitest";
import { checkMail, MAIL_SUBJECT_PREFIX, sendMail, type MailEnv } from "../lib/mail";

const createTransport = vi.hoisted(() => vi.fn());
vi.mock("nodemailer", () => ({ createTransport }));

const BASE: MailEnv = {
  NIHO_FINANCE_MAIL: "log",
  NIHO_FINANCE_MAIL_FROM: "books@example.com",
  NIHO_FINANCE_MAIL_TO: ["owner@example.com"],
  NIHO_FINANCE_SMTP_HOST: "smtp.example.com",
  NIHO_FINANCE_SMTP_PORT: 465,
  NIHO_FINANCE_SMTP_USER: "books@example.com",
  NIHO_FINANCE_SMTP_PASSWORD: "app-password",
};

function loggedLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
  createTransport.mockReset();
});

describe("sendMail", () => {
  it("logs instead of sending with the log transport, with the subject prefix", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await sendMail(
      {
        subject: "期限のお知らせ（2026-11-20）",
        text: "本日\n- 2026-11-20 テスト\n",
        attachments: [{ filename: "a.txt", content: "abc" }],
      },
      BASE,
    );
    expect(result).toEqual({ ok: true, transport: "log", messageId: null });
    const [line] = loggedLines(log);
    expect(line).toMatchObject({
      severity: "INFO",
      event: "mail.logged",
      to: ["owner@example.com"],
      subject: `${MAIL_SUBJECT_PREFIX}期限のお知らせ（2026-11-20）`,
      attachments: [{ filename: "a.txt", bytes: 3 }],
    });
    expect(line?.subject).toBe("[NIHO finance] 期限のお知らせ（2026-11-20）");
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("uses the message's recipients over NIHO_FINANCE_MAIL_TO", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await sendMail({ to: ["accountant@example.com"], subject: "s", text: "t" }, BASE);
    expect(loggedLines(log)[0]?.to).toEqual(["accountant@example.com"]);
  });

  it("fails without recipients", async () => {
    const result = await sendMail(
      { subject: "s", text: "t" },
      { ...BASE, NIHO_FINANCE_MAIL_TO: [] },
    );
    expect(result).toEqual({
      ok: false,
      error: "メールの宛先がありません（NIHO_FINANCE_MAIL_TO）",
    });
  });

  it("does not try SMTP when its settings are missing, and names them without values", async () => {
    const result = await sendMail(
      { subject: "s", text: "t" },
      {
        ...BASE,
        NIHO_FINANCE_MAIL: "smtp",
        NIHO_FINANCE_MAIL_FROM: undefined,
        NIHO_FINANCE_SMTP_PASSWORD: undefined,
      },
    );
    expect(result).toEqual({
      ok: false,
      error: "SMTP の設定が足りません（NIHO_FINANCE_MAIL_FROM、NIHO_FINANCE_SMTP_PASSWORD）",
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("returns the SMTP error instead of throwing", async () => {
    createTransport.mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(new Error("535 authentication failed")),
      close: vi.fn(),
    });
    const result = await sendMail(
      { subject: "s", text: "t" },
      { ...BASE, NIHO_FINANCE_MAIL: "smtp" },
    );
    expect(result).toEqual({ ok: false, error: "535 authentication failed" });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.example.com", port: 465, secure: true }),
    );
  });
});

describe("checkMail", () => {
  it("passes with the log transport without connecting", async () => {
    expect(await checkMail(BASE)).toEqual({ ok: true, transport: "log" });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("fails without recipients", async () => {
    expect(await checkMail({ ...BASE, NIHO_FINANCE_MAIL_TO: [] })).toEqual({
      ok: false,
      error: "メールの宛先がありません（NIHO_FINANCE_MAIL_TO）",
    });
  });

  it("logs in to the SMTP server without sending", async () => {
    const transport = {
      verify: vi.fn().mockResolvedValue(true),
      sendMail: vi.fn(),
      close: vi.fn(),
    };
    createTransport.mockReturnValue(transport);
    expect(await checkMail({ ...BASE, NIHO_FINANCE_MAIL: "smtp" })).toEqual({
      ok: true,
      transport: "smtp",
    });
    expect(transport.verify).toHaveBeenCalledOnce();
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("returns a refused login instead of throwing", async () => {
    createTransport.mockReturnValue({
      verify: vi.fn().mockRejectedValue(new Error("535 authentication failed")),
      close: vi.fn(),
    });
    expect(await checkMail({ ...BASE, NIHO_FINANCE_MAIL: "smtp" })).toEqual({
      ok: false,
      error: "535 authentication failed",
    });
  });

  it("names missing SMTP settings without connecting", async () => {
    expect(
      await checkMail({ ...BASE, NIHO_FINANCE_MAIL: "smtp", NIHO_FINANCE_SMTP_USER: undefined }),
    ).toEqual({ ok: false, error: "SMTP の設定が足りません（NIHO_FINANCE_SMTP_USER）" });
    expect(createTransport).not.toHaveBeenCalled();
  });
});
