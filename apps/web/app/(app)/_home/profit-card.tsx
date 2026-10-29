import type { Money } from "@niho-finance/ledger";
import Link from "next/link";
import { formatAmount } from "@/lib/format";
import { HomeCard } from "./card";
import { SegmentBars, type SegmentBar } from "./segment-bars";

export interface ProfitFigures {
  revenue: Money;
  expenses: Money;
  profit: Money;
}

/** 損益's period on the home: the URL's `pl` (14-reports §9). */
export const PROFIT_PERIODS = ["month", "year"] as const;
export type ProfitPeriod = (typeof PROFIT_PERIODS)[number];

const PROFIT_PERIOD_LABELS: Readonly<Record<ProfitPeriod, string>> = {
  month: "今月",
  year: "今期",
};

/** `pl=year` is 今期; anything else (none, another value, repeated) is the default 今月. */
export function parseProfitPeriod(value: string | string[] | undefined): ProfitPeriod {
  return value === "year" ? "year" : "month";
}

/**
 * 「今月 | 今期」 as links (the URL is the state). The page keeps its scroll position: on phones the
 * card is below 現預金 and やること.
 */
function ProfitPeriodSwitch({ current }: { current: ProfitPeriod }) {
  return (
    <div
      role="group"
      aria-label="損益の期間"
      className="inline-flex rounded-[10px] border border-border bg-surface p-[3px]"
    >
      {PROFIT_PERIODS.map((period) => {
        const active = period === current;
        return (
          <Link
            key={period}
            href={`/?pl=${period}`}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-7 items-center rounded-[7px] px-3 text-[13px] font-semibold whitespace-nowrap ${
              active ? "bg-text text-white" : "text-muted hover:text-text"
            }`}
          >
            {PROFIT_PERIOD_LABELS[period]}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * 損益 (14-reports §9): one card switched between 今月 and 今期. Under the heading the period, 売上 ・
 * 費用 ・ 利益 (a profit in primary-ink) and the profit by segment, all of the chosen period. The
 * heading opens 試算表 with the same period.
 */
export function ProfitCard({
  period,
  periodLabel,
  figures,
  bars,
  className = "",
}: {
  period: ProfitPeriod;
  periodLabel: string;
  figures: ProfitFigures;
  bars: readonly SegmentBar[];
  className?: string;
}) {
  const items = [
    { key: "revenue", label: "売上", value: figures.revenue, className: "" },
    { key: "expenses", label: "費用", value: figures.expenses, className: "" },
    {
      key: "profit",
      label: "利益",
      value: figures.profit,
      // The brand colour marks a profit; a loss keeps the text colour (never red, 05-ui-ux §3).
      className: figures.profit >= 0n ? "text-primary-ink" : "",
    },
  ];
  return (
    <HomeCard
      id="home-profit"
      title="損益"
      href={`/reports/trial-balance?period=${period}`}
      controls={<ProfitPeriodSwitch current={period} />}
      className={className}
    >
      <p className="mb-3 text-[12px] text-muted-2">{periodLabel}</p>
      <dl className="mb-4 grid gap-1 sm:grid-cols-3 sm:gap-2.5">
        {items.map((item) => (
          <div
            key={item.key}
            className="flex min-w-0 items-baseline justify-between gap-3 sm:block"
          >
            <dt className="text-[12px] text-muted">{item.label}</dt>
            <dd
              className={`num text-[18px] leading-snug font-extrabold sm:mt-0.5 sm:text-[22px] ${item.className}`}
            >
              {formatAmount(item.value)}
              <span className="ml-0.5 text-[11px] font-semibold text-muted">円</span>
            </dd>
          </div>
        ))}
      </dl>
      <SegmentBars bars={bars} label={`${PROFIT_PERIOD_LABELS[period]}のセグメント別の利益`} />
    </HomeCard>
  );
}
