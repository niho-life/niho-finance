import { loadFirstMonthGuide, todayInJapan, type FirstMonthGuide as Guide } from "@niho-finance/db";
import { db } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { FirstMonthGuideCard, type GuideView } from "./first-month-guide-client";

/** What the card shows, as plain values (no Date or bigint crosses to the client). */
function toGuideView(guide: Guide): GuideView {
  return {
    doneCount: guide.doneCount,
    total: guide.total,
    allDone: guide.allDone,
    shownAgain: guide.shownAgain,
    steps: guide.steps.map((step) => ({
      key: step.key,
      title: step.title,
      description: step.description,
      href: step.href,
      cta: step.cta,
      done: step.done,
      doneBy: step.doneBy,
      deadlines: step.deadlines.map((deadline) => ({
        id: deadline.id,
        title: deadline.title,
        dateText: formatDate(deadline.dueDate),
        statusText: deadline.statusText,
        status: deadline.status,
      })),
      moreDeadlines: step.moreDeadlines,
      noDeadlinesYet: step.noDeadlinesYet,
    })),
  };
}

/**
 * 初月のガイド「はじめの手順」(10 §3.1, 14 §9): the top card of the home, until every step is done
 * (or again after 設定 › 事業所 「ホームに表示する」). Derived on every render.
 */
export async function FirstMonthGuide() {
  const guide = await loadFirstMonthGuide(await db(), todayInJapan());
  if (!guide?.visible) return null;
  return <FirstMonthGuideCard guide={toGuideView(guide)} />;
}
