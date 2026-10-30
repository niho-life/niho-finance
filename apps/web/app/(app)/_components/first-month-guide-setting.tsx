import { loadFirstMonthGuide, todayInJapan } from "@niho-finance/db";
import { db } from "@/lib/data";
import { ShowFirstMonthGuideButton } from "./first-month-guide-client";

/**
 * 設定 › 事業所 「はじめの手順」 (10 §4.1): how many steps are done, and 「ホームに表示する」 while the
 * home does not show the card (every step done, 10 §3.1).
 */
export async function FirstMonthGuideSetting() {
  const guide = await loadFirstMonthGuide(await db(), todayInJapan());
  if (!guide) return null;
  return (
    <section
      aria-labelledby="settings-first-month-guide"
      className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-border bg-surface px-5 py-5"
    >
      <div className="min-w-0 flex-1">
        <h2 id="settings-first-month-guide" className="text-[15px] font-extrabold">
          はじめの手順
        </h2>
        <p className="num mt-0.5 text-[13px] text-muted">
          {guide.total} 項目中 {guide.doneCount} 項目済み
        </p>
      </div>
      {guide.visible ? (
        <p className="text-[13px] text-muted">ホームに表示しています</p>
      ) : (
        <ShowFirstMonthGuideButton />
      )}
    </section>
  );
}
