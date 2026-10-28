import type { CashflowForecast } from "@niho-finance/reports";
import Link from "next/link";
import { formatAmount, formatDate } from "@/lib/format";
import { ForecastChart } from "../reports/_components/forecast-chart";
import {
  CASHFLOW_NOTES_HREF,
  negativeWarning,
  NO_RECURRING_GUIDANCE,
  RECURRING_SETTINGS_HREF,
} from "../reports/_lib/cashflow-text";
import { HomeCard } from "./card";

/**
 * 資金繰り（90 日） (21-cashflow §5): the warning of a day below 0, 「90 日後」 and 「最低」, the line,
 * and one line about what is missing. A book with nothing in it still shows a flat line and the
 * way to fill it.
 */
export function CashflowCard({
  forecast,
  className = "",
}: {
  forecast: CashflowForecast;
  className?: string;
}) {
  const figures = [
    { key: "final", label: "90 日後", point: forecast.final },
    { key: "lowest", label: "最低", point: forecast.lowest },
  ];
  const noRecurring = forecast.notes.some((note) => note.kind === "noRecurring");
  const link = "font-bold text-text underline underline-offset-4";
  return (
    <HomeCard
      id="home-cashflow"
      title="資金繰り（90 日）"
      href="/reports/cashflow"
      className={className}
    >
      {forecast.firstNegative ? (
        <p role="alert" className="mb-2 text-[13px] font-bold text-danger">
          {negativeWarning(forecast.firstNegative)}
        </p>
      ) : null}
      <dl className="mb-3 flex flex-wrap gap-x-7 gap-y-1">
        {figures.map((figure) => (
          <div key={figure.key} className="flex min-w-0 items-baseline gap-2">
            <dt className="text-[12px] text-muted">{figure.label}</dt>
            <dd>
              <span className="num text-[18px] leading-snug font-extrabold sm:text-[22px]">
                {formatAmount(figure.point.balance)}
              </span>
              <span className="ml-0.5 text-[11px] font-semibold text-muted">円</span>
              <span className="num ml-1.5 text-[12px] text-muted">
                {formatDate(figure.point.date)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <ForecastChart forecast={forecast} size="home" />
      {noRecurring ? (
        <p className="mt-2 text-[13px] text-muted">
          <Link href={RECURRING_SETTINGS_HREF} className={link}>
            {NO_RECURRING_GUIDANCE}
          </Link>
        </p>
      ) : forecast.notes.length > 0 ? (
        <p className="mt-2 text-[13px] text-muted">
          <Link href={CASHFLOW_NOTES_HREF} className={link}>
            入っていない入力が {forecast.notes.length} 件あります
          </Link>
        </p>
      ) : null}
    </HomeCard>
  );
}
