import type { Money } from "@niho-finance/ledger";
import { formatAmount } from "@/lib/format";
import { HomeCard } from "./card";
import { SegmentBars, type SegmentBar } from "./segment-bars";

export interface ProfitFigures {
  revenue: Money;
  expenses: Money;
  profit: Money;
}

/**
 * 今月の損益 / 今期の損益 (14-reports §9): 売上 ・ 費用 ・ 利益 (利益 in primary-ink) and the
 * profit by segment. The heading opens 試算表 with the same period.
 */
export function ProfitCard({
  id,
  title,
  href,
  periodLabel,
  figures,
  bars,
}: {
  id: string;
  title: string;
  href: string;
  periodLabel: string;
  figures: ProfitFigures;
  bars: readonly SegmentBar[];
}) {
  const items = [
    { key: "revenue", label: "売上", value: figures.revenue, className: "" },
    { key: "expenses", label: "費用", value: figures.expenses, className: "" },
    { key: "profit", label: "利益", value: figures.profit, className: "text-primary-ink" },
  ];
  return (
    <HomeCard id={id} title={title} href={href} aside={periodLabel}>
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
      <SegmentBars bars={bars} label={`${title}（セグメント別の利益）`} />
    </HomeCard>
  );
}
