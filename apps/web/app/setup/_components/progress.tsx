import type { SetupProgress } from "@niho-finance/db";
import Link from "next/link";
import { isReachable, stepHref, WIZARD_STEPS, type WizardStep } from "../steps";

/**
 * 1 事業所 → 2 会計期間 → 3 勘定科目 → 4 口座 → 5 開始仕訳 → 完了. Steps that can be opened are links
 * (going back shows what was saved); on phones only the step on screen is named.
 */
export function SetupProgressBar({
  current,
  progress,
}: {
  current: WizardStep;
  progress: SetupProgress;
}) {
  const index = WIZARD_STEPS.findIndex((item) => item.step === current);
  const currentItem = WIZARD_STEPS[index];
  return (
    <nav aria-label="初期設定の進み具合">
      <p className="mb-2 text-[12px] font-bold text-muted md:hidden">
        {current === "complete" ? "完了" : `${index + 1} / 5 ${currentItem?.label ?? ""}`}
      </p>
      <ol className="grid grid-cols-6 gap-1.5">
        {WIZARD_STEPS.map((item, position) => {
          const done = item.step === "complete" ? false : progress.done[item.step];
          const isCurrent = item.step === current;
          const reachable = isReachable(item.step, progress);
          const bar = isCurrent ? "bg-primary" : done ? "bg-accent" : "bg-track";
          const label = (
            <>
              <span className={`block h-1.5 rounded-full ${bar}`} aria-hidden="true" />
              <span
                className={`mt-1.5 hidden text-[12px] md:block ${
                  isCurrent ? "font-extrabold text-text" : done ? "text-muted" : "text-muted-2"
                }`}
              >
                {item.step === "complete" ? item.label : `${position + 1} ${item.label}`}
              </span>
              <span className="sr-only">
                {isCurrent ? "（いまのステップ）" : done ? "（済み）" : ""}
              </span>
            </>
          );
          return (
            <li key={item.step} className="min-w-0">
              {reachable && !isCurrent ? (
                <Link href={stepHref(item.step)} className="block rounded hover:opacity-80">
                  {label}
                </Link>
              ) : (
                <span aria-current={isCurrent ? "step" : undefined} className="block">
                  {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
