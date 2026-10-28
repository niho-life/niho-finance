import { appEnv } from "../env";
import { logEvent } from "../log";
import { sendSmtp, verifySmtp, type SmtpSettings } from "./smtp";
import type { MailCheckResult, MailEnv, MailMessage, MailResult } from "./types";

export type {
  MailAttachment,
  MailCheckResult,
  MailEnv,
  MailMessage,
  MailResult,
  MailTransport,
} from "./types";

export const MAIL_SUBJECT_PREFIX = "[NIHO finance] ";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SmtpConfig = { ok: true; from: string; settings: SmtpSettings } | { ok: false; error: string };

/** The SMTP settings, or which of them are missing (names only, never values). */
function smtpConfig(env: MailEnv): SmtpConfig {
  const from = env.NIHO_FINANCE_MAIL_FROM;
  const user = env.NIHO_FINANCE_SMTP_USER;
  const password = env.NIHO_FINANCE_SMTP_PASSWORD;
  if (!from || !user || !password) {
    const missing = [
      from ? null : "NIHO_FINANCE_MAIL_FROM",
      user ? null : "NIHO_FINANCE_SMTP_USER",
      password ? null : "NIHO_FINANCE_SMTP_PASSWORD",
    ].filter((name) => name !== null);
    return { ok: false, error: `SMTP の設定が足りません（${missing.join("、")}）` };
  }
  return {
    ok: true,
    from,
    settings: {
      host: env.NIHO_FINANCE_SMTP_HOST,
      port: env.NIHO_FINANCE_SMTP_PORT,
      user,
      password,
    },
  };
}

/**
 * Sends a plain-text mail (deadline notices, invoices) through `NIHO_FINANCE_MAIL`: `log` only
 * logs it (`mail.logged`), `smtp` sends it. Never throws: a failure comes back as `{ ok: false }`
 * with what is wrong (setting names, never their values). `settings` defaults to `appEnv()`.
 */
export async function sendMail(message: MailMessage, settings?: MailEnv): Promise<MailResult> {
  try {
    const env = settings ?? appEnv();
    const to = message.to ?? env.NIHO_FINANCE_MAIL_TO;
    if (to.length === 0) {
      return { ok: false, error: "メールの宛先がありません（NIHO_FINANCE_MAIL_TO）" };
    }
    const subject = `${MAIL_SUBJECT_PREFIX}${message.subject}`;
    const attachments = message.attachments ?? [];

    if (env.NIHO_FINANCE_MAIL === "log") {
      logEvent("INFO", "mail.logged", {
        to,
        subject,
        bytes: Buffer.byteLength(message.text, "utf8"),
        attachments: attachments.map((attachment) => ({
          filename: attachment.filename,
          bytes: Buffer.byteLength(attachment.content),
        })),
      });
      return { ok: true, transport: "log", messageId: null };
    }

    const config = smtpConfig(env);
    if (!config.ok) return config;
    const messageId = await sendSmtp(config.settings, {
      from: config.from,
      to,
      subject,
      text: message.text,
      attachments,
    });
    return { ok: true, transport: "smtp", messageId };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Checks that mail can go out without sending any: the recipients are set and, with `smtp`, the
 * server accepts the login. The daily calendar job runs it on days without a notice, so a revoked
 * app password fails the job (and alerts) before a deadline mail is due. Never throws.
 */
export async function checkMail(settings?: MailEnv): Promise<MailCheckResult> {
  try {
    const env = settings ?? appEnv();
    if (env.NIHO_FINANCE_MAIL_TO.length === 0) {
      return { ok: false, error: "メールの宛先がありません（NIHO_FINANCE_MAIL_TO）" };
    }
    if (env.NIHO_FINANCE_MAIL === "log") return { ok: true, transport: "log" };
    const config = smtpConfig(env);
    if (!config.ok) return config;
    await verifySmtp(config.settings);
    return { ok: true, transport: "smtp" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
