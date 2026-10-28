import Link from "next/link";
import type { ReactNode } from "react";
import { entryNo } from "@/lib/format";

/*
 * Small pieces shared by the year-end pages (server-safe: no hooks, no client imports).
 */

/** A state band (like the entry detail's): muted, or warn for what needs attention. */
export function Band({
  tone = "muted",
  children,
  actions,
}: {
  tone?: "muted" | "warn";
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3.5 py-2.5 text-[14px] ${
        tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface-2 text-text"
      }`}
    >
      <p className="min-w-0 flex-1 basis-56 break-words">{children}</p>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** `No. n` linking to the entry detail. */
export function EntryLink({ entry }: { entry: { id: string; no: number } }) {
  return (
    <Link
      href={`/entries/${entry.id}`}
      className="num font-bold whitespace-nowrap underline underline-offset-4"
    >
      {entryNo(entry.no)}
    </Link>
  );
}

/** A muted note under a table or a form. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-muted break-words">{children}</p>;
}

/** Label / value pairs (e.g. the corporate tax figures), two columns that wrap on phones. */
export function Facts({
  items,
  label,
}: {
  items: readonly { label: string; value: ReactNode; strong?: boolean }[];
  label: string;
}) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-[14px] sm:grid-cols-[minmax(0,14rem)_auto] sm:justify-start"
    >
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="min-w-0 text-[13px] text-muted">{item.label}</dt>
          <dd className={`num text-right ${item.strong ? "font-bold" : ""}`}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
