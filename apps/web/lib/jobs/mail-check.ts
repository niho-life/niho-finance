import { appEnv } from "../env";
import { sendMail } from "../mail";
import type { JobContext, JobSummary } from "./run";

/*
 * mail-check (manual: `scripts/run-job.sh mail-check`; docs/ops/secrets.md §3): sends one short
 * mail through the same route as the deadline notices, to confirm that they arrive (after the SMTP
 * app password is issued or rotated). Nothing is read from or written to the database.
 */

const JAPAN_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** The body of the confirmation mail. */
export function mailCheckText(context: { sentAt: Date; gitSha?: string; appUrl?: string }): string {
  const lines = [
    "NIHO finance からの送信の確認です。",
    "このメールが届いていれば、期限のお知らせも同じ経路で届きます。",
    "",
    `送信: ${JAPAN_TIME.format(context.sentAt)}（日本時間）`,
  ];
  if (context.gitSha) lines.push(`版: ${context.gitSha}`);
  if (context.appUrl) lines.push("", context.appUrl);
  return `${lines.join("\n")}\n`;
}

export async function mailCheckJob({ startedAt }: JobContext): Promise<JobSummary> {
  const env = appEnv();
  const result = await sendMail({
    subject: "送信の確認",
    text: mailCheckText({
      sentAt: startedAt,
      gitSha: env.NIHO_FINANCE_GIT_SHA,
      appUrl: env.NIHO_FINANCE_APP_URL,
    }),
  });
  if (!result.ok) throw new Error(result.error);
  return {
    transport: result.transport,
    recipients: env.NIHO_FINANCE_MAIL_TO.length,
    accepted: result.messageId !== null || result.transport === "log",
  };
}
