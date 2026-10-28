import { createTransport } from "nodemailer";
import type { MailAttachment } from "./types";

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface SmtpMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments: MailAttachment[];
}

/** TLS from the start on 465, STARTTLS required on other ports; bounded waits. */
function smtpTransport(settings: SmtpSettings) {
  return createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    requireTLS: settings.port !== 465,
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });
}

/** Sends one plain-text message and returns its Message-ID. Throws when the server refuses it. */
export async function sendSmtp(
  settings: SmtpSettings,
  message: SmtpMessage,
): Promise<string | null> {
  const transport = smtpTransport(settings);
  try {
    const info = await transport.sendMail({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      attachments: message.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      })),
    });
    return info.messageId || null;
  } finally {
    transport.close();
  }
}

/** Connects and logs in without sending anything. Throws when the server refuses the login. */
export async function verifySmtp(settings: SmtpSettings): Promise<void> {
  const transport = smtpTransport(settings);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}
