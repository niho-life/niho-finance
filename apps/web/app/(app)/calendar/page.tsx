import { listCalendarItems, todayInJapan } from "@niho-finance/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { CalendarSection } from "./_components/calendar-section";

export const metadata: Metadata = { title: "期限" };

/**
 * 期限 (24 §3): the deadlines of every fiscal year from 第 1 期, the open ones by due date and the
 * completed ones folded under them. 完了にする / 未完了に戻す are Server Actions (actions.ts).
 */
export default async function CalendarPage() {
  const groups = await listCalendarItems(await db());
  const today = todayInJapan();
  const open = groups.flatMap((group) => group.open);
  const overdue = open.filter((item) => item.dueDate < today).length;

  return (
    <>
      <PageHeader
        title="期限"
        meta={`未完了 ${open.length} 件${overdue > 0 ? `・期限切れ ${overdue} 件` : ""}`}
      />
      <div className="flex flex-col gap-8">
        {groups.map((group) => (
          <CalendarSection key={group.fiscalYear?.id ?? "none"} group={group} today={today} />
        ))}
      </div>
      <p className="mt-6 text-[13px] text-muted">
        期限は名目の日付です（土日祝でも動かしていません）。7
        日前・当日・期限切れの日にメールでも知らせます。
      </p>
    </>
  );
}
