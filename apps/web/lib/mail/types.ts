import type { AppEnv } from "../env";

export interface MailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface MailMessage {
  /** Defaults to `NIHO_FINANCE_MAIL_TO`. */
  to?: string[];
  /** `[NIHO finance] ` is put in front. */
  subject: string;
  /** Plain text (no HTML). */
  text: string;
  attachments?: MailAttachment[];
}

export type MailTransport = "log" | "smtp";

export type MailResult =
  { ok: true; transport: MailTransport; messageId: string | null } | { ok: false; error: string };

export type MailCheckResult = { ok: true; transport: MailTransport } | { ok: false; error: string };

/** What sending reads from the environment (`appEnv()`); tests pass their own. */
export type MailEnv = Pick<
  AppEnv,
  | "NIHO_FINANCE_MAIL"
  | "NIHO_FINANCE_MAIL_FROM"
  | "NIHO_FINANCE_MAIL_TO"
  | "NIHO_FINANCE_SMTP_HOST"
  | "NIHO_FINANCE_SMTP_PORT"
  | "NIHO_FINANCE_SMTP_USER"
  | "NIHO_FINANCE_SMTP_PASSWORD"
>;
