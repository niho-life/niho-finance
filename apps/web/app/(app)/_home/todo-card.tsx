import type { HomeTodo } from "@niho-finance/db";
import Link from "next/link";
import { HomeCard } from "./card";

/** A row of 「やること」: S7's sources (`HOME_TODO_SOURCES`) and S2's setup rows. */
export interface TodoRow {
  key: string;
  badge: string | null;
  tone: HomeTodo["tone"];
  label: string;
  href: string | null;
}

const BADGE: Readonly<Record<HomeTodo["tone"], string>> = {
  count: "bg-track text-text font-extrabold",
  warn: "bg-warn-soft text-warn font-extrabold",
  date: "bg-surface-2 text-muted font-bold text-[12px]",
};

function RowContent({ row }: { row: TodoRow }) {
  return (
    <>
      {row.badge ? (
        <span
          className={`num inline-flex min-w-[2.25rem] shrink-0 justify-center rounded-lg px-1.5 py-0.5 text-[13px] ${BADGE[row.tone]}`}
        >
          {row.badge}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 text-[14px]">{row.label}</span>
      {row.href ? (
        <span aria-hidden="true" className="text-muted-2">
          ›
        </span>
      ) : null}
    </>
  );
}

/**
 * やること (14-reports §9): one list of the lanes' rows and the setup rows. A row is badge (count or
 * date) ・ text ・ 「›」, and the whole row is the way to its screen (at least 44px high). Rows with
 * nothing to do are not there; with none at all, 「今日やることはありません」.
 */
export function TodoCard({
  rows,
  className = "",
}: {
  rows: readonly TodoRow[];
  className?: string;
}) {
  return (
    <HomeCard id="home-todo" title="やること" className={className}>
      {rows.length === 0 ? (
        <p className="py-1 text-[14px] text-muted">今日やることはありません</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => {
            const line = "flex min-h-11 items-center gap-2.5 border-b border-border px-1 py-2";
            return (
              <li key={row.key} className="[&:last-child>*]:border-b-0">
                {row.href ? (
                  <Link href={row.href} className={`${line} hover:bg-black/[0.02]`}>
                    <RowContent row={row} />
                  </Link>
                ) : (
                  <div className={line}>
                    <RowContent row={row} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </HomeCard>
  );
}
