import type { ReportPeriod } from "@niho-finance/reports";
import Link from "next/link";
import { reportHref } from "../_lib/query";
import { REPORT_TAB_LABELS, REPORT_TABS, type ReportTab } from "../_lib/tabs";

/**
 * 試算表 / 月次推移 / セグメント損益 / 現預金 / 仕訳帳 / 総勘定元帳. The links keep the period and the
 * segment (14-reports §2). Phones: chips that scroll sideways; PC: underlined tabs.
 */
export function ReportTabs({ current, period }: { current: ReportTab; period: ReportPeriod }) {
  return (
    <nav aria-label="報告の種類" className="-mx-4 mb-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ul className="flex w-max min-w-full gap-1.5 md:gap-0.5 md:border-b md:border-border">
        {REPORT_TABS.map((tab) => {
          const active = tab === current;
          return (
            <li key={tab}>
              <Link
                href={reportHref(tab, period)}
                aria-current={active ? "page" : undefined}
                className={[
                  "block rounded-full border px-3 py-1.5 text-[13px] font-bold whitespace-nowrap",
                  "md:-mb-px md:rounded-none md:border-0 md:border-b-2 md:px-3 md:py-2.5",
                  active
                    ? "border-text text-text md:border-text"
                    : "border-border text-muted hover:text-text md:border-transparent",
                ].join(" ")}
              >
                {REPORT_TAB_LABELS[tab]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
