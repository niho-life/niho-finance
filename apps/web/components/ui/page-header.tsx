import Link from "next/link";
import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  /** Muted text next to the title (e.g. the month). */
  meta?: ReactNode;
  /** The parent page, e.g. 設定 for a settings section. */
  back?: { href: string; label: string };
  actions?: ReactNode;
}

export function PageHeader({ title, meta, back, actions }: PageHeaderProps) {
  return (
    <header className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
        {back ? (
          <Link
            href={back.href}
            className="inline-flex w-fit items-center gap-1 text-[12px] font-bold text-muted hover:text-text"
          >
            <span aria-hidden="true">‹</span>
            {back.label}
          </Link>
        ) : null}
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h1 className="text-[20px] font-extrabold leading-tight">{title}</h1>
          {meta ? <span className="text-[13px] text-muted">{meta}</span> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
