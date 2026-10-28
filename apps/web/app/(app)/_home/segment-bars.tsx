import type { Money } from "@niho-finance/ledger";
import { formatAmount } from "@/lib/format";

export interface SegmentBar {
  key: string;
  label: string;
  value: Money;
}

function abs(value: Money): Money {
  return value < 0n ? -value : value;
}

/**
 * Profit by segment as bars (14-reports §5, §9): the largest absolute value is 100%; a loss is
 * drawn from the left in the muted grey instead of the primary colour, and its amount keeps the
 * sign. Phones put the bar under the label and the amount.
 */
export function SegmentBars({ bars, label }: { bars: readonly SegmentBar[]; label: string }) {
  if (bars.length === 0) return null;
  const max = bars.reduce<Money>(
    (largest, bar) => (abs(bar.value) > largest ? abs(bar.value) : largest),
    0n,
  );
  return (
    <ul aria-label={label} className="flex flex-col gap-2.5 sm:gap-2">
      {bars.map((bar) => {
        // Per mille of the largest bar, as bigint (amounts never go through floating point).
        const perMille = max === 0n ? 0n : (abs(bar.value) * 1000n) / max;
        return (
          <li
            key={bar.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 text-[13px] sm:grid-cols-[minmax(0,8.5rem)_minmax(3rem,1fr)_auto]"
          >
            <span className="min-w-0 truncate">{bar.label}</span>
            <span
              aria-hidden="true"
              className="col-span-2 row-start-2 flex h-2.5 overflow-hidden rounded-full sm:col-span-1 sm:col-start-2 sm:row-start-1"
            >
              <span
                className={`block h-full rounded-full ${bar.value < 0n ? "bg-border-2" : "bg-primary"}`}
                style={{ width: `${Number(perMille) / 10}%` }}
              />
            </span>
            <span className="num text-right sm:col-start-3 sm:row-start-1">
              {formatAmount(bar.value)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
