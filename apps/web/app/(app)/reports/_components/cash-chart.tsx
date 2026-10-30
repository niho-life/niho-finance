import type { Money } from "@niho-finance/ledger";
import type { CashSeries } from "@niho-finance/reports";
import { formatAmount, formatDate, withDisplayMinus } from "@/lib/format";

/** Wallets in grey tones, the total in the primary colour (14-reports §6). */
const WALLET_STROKES = ["#9b9b9b", "#c0c0c0", "#6b6b6b", "#d6d6d3"] as const;
const WIDTH = 800;
const HEIGHT = 240;

const COMPACT = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });

interface Line {
  key: string;
  label: string;
  values: readonly Money[];
  stroke?: string;
  className?: string;
  width: number;
}

/** Display only: amounts become coordinates here, never stored or added up. */
function toNumber(value: Money): number {
  return Number(value);
}

/**
 * The daily balances of `from`..`to` as an SVG line chart (no library): one grey line per wallet,
 * the total in primary, a baseline at 0 when the range crosses it, 3 labels on the left, the
 * legend below. The chart stretches to the width; lines keep their stroke width.
 */
export function CashChart({ series, total }: { series: CashSeries; total: Money }) {
  const count = series.dates.length;
  if (count === 0) return null;
  const lines: Line[] = [
    ...series.wallets.map((wallet, i) => ({
      key: wallet.key,
      label: wallet.label,
      values: wallet.balances,
      stroke: WALLET_STROKES[i % WALLET_STROKES.length],
      width: 1.5,
    })),
    { key: "total", label: "合計", values: series.total, className: "stroke-primary", width: 2.5 },
  ];
  const all = lines.flatMap((line) => line.values.map(toNumber));
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const span = hi - lo;
  const pad = span > 0 ? span * 0.08 : Math.max(Math.abs(hi) * 0.1, 1000);
  hi += pad;
  lo -= pad;
  const y = (value: number) => ((hi - value) / (hi - lo)) * HEIGHT;
  const x = (i: number) => (count === 1 ? 0 : (i / (count - 1)) * WIDTH);
  const points = (values: readonly Money[]) => {
    const coords = values.map((value, i) => `${x(i).toFixed(1)},${y(toNumber(value)).toFixed(1)}`);
    return count === 1
      ? `${coords[0]} ${WIDTH},${y(toNumber(values[0] ?? 0n)).toFixed(1)}`
      : coords.join(" ");
  };
  const first = series.dates[0];
  const last = series.dates[count - 1];
  const summary = `現預金の残高の推移（${formatDate(first)} – ${formatDate(last)}）。${formatDate(last)} の合計 ${formatAmount(total)} 円`;

  return (
    <figure className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <div
          aria-hidden="true"
          className="num flex h-36 w-14 shrink-0 flex-col justify-between text-right text-[11px] leading-none text-muted md:h-56"
        >
          <span>{withDisplayMinus(COMPACT.format(hi))}</span>
          <span>{withDisplayMinus(COMPACT.format((hi + lo) / 2))}</span>
          <span>{withDisplayMinus(COMPACT.format(lo))}</span>
        </div>
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="h-36 min-w-0 flex-1 md:h-56"
        >
          {[0, HEIGHT / 2, HEIGHT].map((gy) => (
            <line
              key={gy}
              x1="0"
              x2={WIDTH}
              y1={gy}
              y2={gy}
              stroke="#efefed"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {lo < 0 && hi > 0 ? (
            <line
              x1="0"
              x2={WIDTH}
              y1={y(0)}
              y2={y(0)}
              stroke="#d6d6d3"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {lines.map((line) => (
            <polyline
              key={line.key}
              points={points(line.values)}
              fill="none"
              stroke={line.stroke}
              className={line.className}
              strokeWidth={line.width}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>
      <div aria-hidden="true" className="ml-16 flex justify-between text-[11px] text-muted">
        <span>{formatDate(first)}</span>
        <span>{formatDate(last)}</span>
      </div>
      <figcaption>
        <ul className="ml-16 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
          {lines.map((line) => (
            <li key={line.key} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`inline-block h-[3px] w-3.5 rounded-full ${line.className ? "bg-primary" : ""}`}
                style={line.stroke ? { background: line.stroke } : undefined}
              />
              {line.label}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
