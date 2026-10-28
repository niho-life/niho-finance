import { daysBetween, type Money } from "@niho-finance/ledger";
import type { CashflowForecast } from "@niho-finance/reports";
import type { CSSProperties } from "react";
import { forecastSummary } from "../_lib/cashflow-text";

const WIDTH = 900;
const HEIGHT = 220;
/** 起点・30 日後・60 日後・90 日後 (§4). */
const X_TICKS = [0, 30, 60, 90] as const;
const COMPACT = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });

/** Heights of §4: ホーム 140px (phones 120px), 報告 220px (phones 160px). */
const SIZES = {
  home: "h-[120px] md:h-[140px]",
  report: "h-[160px] md:h-[220px]",
} as const;

/** Display only: amounts become coordinates here, never stored or added up. */
function toNumber(value: Money): number {
  return Number(value);
}

/** `2026-12-27` → `12/27` */
function monthDay(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

/**
 * The 90-day line of 資金繰り (21-cashflow §4) as an SVG without a library: one line (the total of
 * 現預金) in steps — a day's balance runs flat to the next day and moves up or down on the day it
 * changes. A primary dot on the start; the 0 line when the range reaches 0 or below, dashed in
 * danger with a danger dot on the first day below 0; small muted marks at the bottom for payments
 * without an amount. The labels are HTML outside the SVG so that they never squash; the SVG
 * stretches to the width and the strokes keep their width.
 */
export function ForecastChart({
  forecast,
  size,
}: {
  forecast: CashflowForecast;
  size: keyof typeof SIZES;
}) {
  const values = forecast.balances.map(toNumber);
  const count = values.length;
  if (count === 0) return null;
  const last = count - 1;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const showZero = min <= 0;
  let lo = showZero ? Math.min(min, 0) : min;
  let hi = showZero ? Math.max(max, 0) : max;
  const span = hi - lo;
  const pad = span > 0 ? span * 0.08 : Math.max(Math.abs(hi) * 0.1, 1000);
  lo -= pad;
  hi += pad;
  const y = (value: number) => ((hi - value) / (hi - lo)) * HEIGHT;
  const x = (i: number) => (last === 0 ? 0 : (i / last) * WIDTH);
  const pct = (value: number, total: number) => `${((value / total) * 100).toFixed(3)}%`;

  let path = `M0,${y(values[0] ?? 0).toFixed(2)}`;
  for (let i = 1; i < count; i += 1) {
    path += ` H${x(i).toFixed(2)} V${y(values[i] ?? 0).toFixed(2)}`;
  }

  const negative = forecast.firstNegative;
  const negativeIndex = negative ? daysBetween(forecast.start, negative.date) : null;
  const zeroY = y(0);

  // Max and min of the line (and 0 when its line is drawn, unless it would sit on another label).
  const labels: { key: string; value: number }[] = [{ key: "max", value: max }];
  if (min !== max) labels.push({ key: "min", value: min });
  if (showZero && labels.every((label) => Math.abs(y(label.value) - zeroY) > HEIGHT * 0.14)) {
    labels.push({ key: "zero", value: 0 });
  }

  const dot = (i: number, value: number, className: string) => {
    const style: CSSProperties = { left: pct(x(i), WIDTH), top: pct(y(value), HEIGHT) };
    return (
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${className}`}
        style={style}
      />
    );
  };

  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 gap-2">
        <div aria-hidden="true" className={`relative w-11 shrink-0 ${SIZES[size]}`}>
          {labels.map((label) => (
            <span
              key={label.key}
              className={`num absolute right-0 -translate-y-1/2 text-[11px] leading-none whitespace-nowrap ${
                label.key === "zero" && negative ? "text-danger" : "text-muted-2"
              }`}
              style={{ top: pct(y(label.value), HEIGHT) }}
            >
              {COMPACT.format(label.value)}
            </span>
          ))}
        </div>
        <div className={`relative min-w-0 flex-1 ${SIZES[size]}`}>
          <svg
            role="img"
            aria-label={forecastSummary(forecast)}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="block h-full w-full overflow-visible"
          >
            {showZero ? (
              <line
                x1="0"
                x2={WIDTH}
                y1={zeroY}
                y2={zeroY}
                className={negative ? "stroke-danger" : "stroke-border-2"}
                strokeWidth="1"
                strokeDasharray={negative ? "4 3" : undefined}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <path
              d={path}
              fill="none"
              className="stroke-primary"
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {forecast.marks.map((mark, i) => {
              const at = x(daysBetween(forecast.start, mark.date));
              return (
                <g key={`${mark.date}:${i}`} className="stroke-muted-2">
                  <title>{`${mark.date.replaceAll("-", "/")} ${mark.title}（金額未定）`}</title>
                  <line
                    x1={at}
                    x2={at}
                    y1={HEIGHT - 10}
                    y2={HEIGHT}
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
          </svg>
          {dot(0, values[0] ?? 0, "bg-primary")}
          {negative && negativeIndex !== null
            ? dot(negativeIndex, toNumber(negative.balance), "bg-danger")
            : null}
        </div>
      </div>
      <div aria-hidden="true" className="relative ml-[3.25rem] h-4 text-[11px] text-muted-2">
        {X_TICKS.filter((day) => day <= last).map((day) => {
          const position = day / last;
          const shift =
            position === 0
              ? "translate-x-0"
              : position === 1
                ? "-translate-x-full"
                : "-translate-x-1/2";
          return (
            <span
              key={day}
              className={`num absolute top-0 whitespace-nowrap ${shift}`}
              style={{ left: `${(position * 100).toFixed(3)}%` }}
            >
              {monthDay(forecast.dates[day] ?? forecast.start)}
            </span>
          );
        })}
      </div>
    </figure>
  );
}
