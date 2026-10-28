import Link from "next/link";
import type { ReactNode } from "react";

/** A section of the home: one white card with thin border (no cards inside it, D14). */
export function HomeCard({
  id,
  title,
  href,
  aside,
  className = "",
  children,
}: {
  id: string;
  title: string;
  /** The report behind the numbers (the heading becomes a link). */
  href?: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`min-w-0 rounded-card border border-border bg-surface px-5 py-[18px] ${className}`}
    >
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 id={id} className="text-[13px] font-bold text-muted">
          {href ? (
            <Link href={href} className="inline-flex items-center gap-1 hover:text-text">
              {title}
              <span aria-hidden="true" className="text-muted-2">
                ›
              </span>
            </Link>
          ) : (
            title
          )}
        </h2>
        {aside ? <span className="text-[12px] text-muted-2">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}
