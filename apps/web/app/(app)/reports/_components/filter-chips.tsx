import type { BreakdownFilterLabel } from "@niho-finance/reports";
import Link from "next/link";

/**
 * 「取引先: 架空クラウド株式会社 ×」 (14-reports §15.3): the filters 集計 adds, on 集計 and on 総勘定元帳.
 * × is a link to the same page without that filter.
 */
export function FilterChips({
  chips,
}: {
  chips: readonly { filter: BreakdownFilterLabel; removeHref: string }[];
}) {
  if (chips.length === 0) return null;
  return (
    <ul aria-label="絞り込み" className="mb-3 flex flex-wrap gap-1.5">
      {chips.map(({ filter, removeHref }) => (
        <li
          key={filter.name}
          className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-full border border-border-2 py-0.5 pr-0.5 pl-3 text-[12px] font-semibold"
        >
          <span className="min-w-0 truncate">
            {filter.name}: {filter.label}
          </span>
          <Link
            href={removeHref}
            aria-label={`${filter.name}の絞り込みを外す`}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[14px] text-muted hover:bg-black/5 hover:text-text"
          >
            <span aria-hidden="true">×</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
