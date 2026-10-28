import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "初期設定" };

/** The wizard lives outside the app frame: a light page with the progress only (10 §3). */
export default function SetupLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh px-4 pt-6 pb-16 md:px-8 md:pt-10">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
        <div className="flex items-center gap-2.5 font-extrabold">
          <span aria-hidden="true" className="relative size-[26px] shrink-0 rounded-lg bg-primary">
            <span className="absolute inset-[7px] rounded bg-accent" />
          </span>
          NIHO finance
          <span className="text-[13px] font-semibold text-muted">初期設定</span>
        </div>
        {children}
      </div>
    </div>
  );
}
