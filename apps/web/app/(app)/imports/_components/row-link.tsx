import Link from "next/link";
import type { ReactNode } from "react";

/** A row's link to its settings, looking like `OpenButton` (設定 ›). */
export function RowLink({
  href,
  label,
  children,
}: {
  href: string;
  /** Accessible name, e.g. 「〇〇 の取込の設定」. */
  label: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex min-h-8 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text"
    >
      {children}
      <span aria-hidden="true">›</span>
    </Link>
  );
}
