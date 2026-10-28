"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { NavIcon } from "./icons";
import { isActivePath } from "./nav-items";

function Tab({
  href,
  active,
  label,
  children,
}: {
  href: string | null;
  active?: boolean;
  label: string;
  children: ReactNode;
}) {
  const base = "flex min-h-12 flex-col items-center justify-center gap-0.5 text-[10px] font-bold";
  if (!href) {
    return (
      <span aria-disabled="true" className={`${base} text-muted-2 opacity-50`}>
        {children}
        <span>{label}</span>
        <span className="sr-only">（準備中）</span>
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`${base} ${active ? "text-text" : "text-muted-2"}`}
    >
      {children}
      <span>{label}</span>
    </Link>
  );
}

/** The sections reached through その他 on phones (11 §2). */
const MORE_PATHS = ["/more", "/entries", "/settings"];

/** Phone navigation under 768px: ホーム / 明細 / 証憑 / 報告 / その他 (→ 取引・設定). */
export function BottomTabs() {
  const pathname = usePathname();
  const inMore = MORE_PATHS.some((path) => isActivePath(pathname, path));
  return (
    <nav
      aria-label="メイン"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border bg-surface px-1.5 pt-1.5 pb-[calc(8px+env(safe-area-inset-bottom))] md:hidden"
    >
      <Tab href="/" active={isActivePath(pathname, "/")} label="ホーム">
        <NavIcon name="home" className="size-[22px]" />
      </Tab>
      <Tab href={null} label="明細">
        <NavIcon name="statements" className="size-[22px]" />
      </Tab>
      <span
        aria-disabled="true"
        className="flex min-h-12 flex-col items-center justify-center opacity-50"
      >
        <span className="-mt-4 flex size-11 items-center justify-center rounded-full bg-track text-muted shadow-float">
          <NavIcon name="camera" className="size-[22px]" />
        </span>
        <span className="sr-only">証憑（準備中）</span>
      </span>
      <Tab href={null} label="報告">
        <NavIcon name="reports" className="size-[22px]" />
      </Tab>
      <Tab href="/more" active={inMore} label="その他">
        <NavIcon name="more" className="size-[22px]" />
      </Tab>
    </nav>
  );
}
