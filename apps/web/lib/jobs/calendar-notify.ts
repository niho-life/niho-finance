import {
  loadOpenCalendarItems,
  markCalendarItemsNotified,
  selectCalendarNotices,
  syncCalendarItems,
  type CalendarNotice,
  type CalendarNoticeStage,
} from "@niho-finance/db";
import { appEnv } from "../env";
import { checkMail, sendMail } from "../mail";
import { JOB_ACTOR, type JobContext, type JobSummary } from "./run";

/*
 * calendar-notify (daily, 09:00 JST; docs/ops/deploy.md §6): brings the deadlines in line with the
 * fiscal years, then mails the ones within 7 days, due today or overdue in one message. Items are
 * marked as notified only after the mail went out; a failed mail fails the job and is retried by
 * the next day's run. On a day without notices the mail route is still checked (SMTP login), so a
 * broken app password fails the job, and alerts, before a deadline mail is due.
 */

const SECTIONS: readonly (readonly [CalendarNoticeStage, string])[] = [
  ["week", "7 日以内"],
  ["today", "本日"],
  ["overdue", "期限超過"],
];

/** The mail body: one heading per stage that has items, then the screens' URL. */
export function calendarNoticeText(notices: readonly CalendarNotice[], appUrl?: string): string {
  const blocks: string[] = [];
  for (const [stage, heading] of SECTIONS) {
    const lines = notices
      .filter((notice) => notice.stage === stage)
      .map(({ item }) => `- ${item.dueDate} ${item.title}${item.note ? `（${item.note}）` : ""}`);
    if (lines.length > 0) blocks.push([heading, ...lines].join("\n"));
  }
  if (appUrl) blocks.push(appUrl);
  return `${blocks.join("\n\n")}\n`;
}

export async function calendarNotifyJob({ prisma, today }: JobContext): Promise<JobSummary> {
  const { created, updated } = await syncCalendarItems(prisma, { actor: JOB_ACTOR });
  const notices = selectCalendarNotices(await loadOpenCalendarItems(prisma), today);
  if (notices.length === 0) {
    const check = await checkMail();
    if (!check.ok) throw new Error(check.error);
    return { created, updated, notified: 0, transport: check.transport };
  }

  const result = await sendMail({
    subject: `期限のお知らせ（${today}）`,
    text: calendarNoticeText(notices, appEnv().NIHO_FINANCE_APP_URL),
  });
  if (!result.ok) throw new Error(result.error);
  await markCalendarItemsNotified(
    prisma,
    notices.map((notice) => notice.item.id),
    today,
    { actor: JOB_ACTOR },
  );
  const count = (stage: CalendarNoticeStage) =>
    notices.filter((notice) => notice.stage === stage).length;
  return {
    created,
    updated,
    notified: notices.length,
    week: count("week"),
    today: count("today"),
    overdue: count("overdue"),
    transport: result.transport,
  };
}
