import type { ReactNode } from "react";
import { BottomTabs } from "./bottom-tabs";
import { SideNav } from "./side-nav";

export function Brand({
  companyName,
  fiscalYearNo,
}: {
  companyName: string | null;
  fiscalYearNo: number | null;
}) {
  const sub = [companyName, fiscalYearNo ? `第${fiscalYearNo}期` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-center gap-2.5 px-2.5 pt-1.5 pb-[18px] font-extrabold">
      <span aria-hidden="true" className="relative size-[26px] shrink-0 rounded-lg bg-primary">
        <span className="absolute inset-[7px] rounded bg-accent" />
      </span>
      <span className="min-w-0">
        NIHO finance
        {sub ? (
          <span className="block truncate text-[11px] font-normal text-muted">{sub}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The app frame: left navigation on PC, bottom tabs on phones (10 §1). `viewer`: 閲覧 sees 報告 and
 * 書き出し only (23 §3.4).
 */
export function AppShell({
  companyName,
  fiscalYearNo,
  viewer = false,
  children,
}: {
  companyName: string | null;
  fiscalYearNo: number | null;
  viewer?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[216px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface-2 px-3 py-[18px] md:flex">
        <Brand companyName={companyName} fiscalYearNo={fiscalYearNo} />
        <SideNav viewer={viewer} />
      </aside>
      <main className="min-w-0 px-4 pt-5 pb-[calc(96px+env(safe-area-inset-bottom))] md:px-7 md:pt-[22px] md:pb-10">
        <div className="mx-auto w-full max-w-[1080px]">{children}</div>
      </main>
      <BottomTabs viewer={viewer} />
    </div>
  );
}
