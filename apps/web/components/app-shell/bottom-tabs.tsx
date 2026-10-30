"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CaptureTab } from "./capture-tab";
import { NavIcon, type NavIconName } from "./icons";
import { NavPendingHint } from "./nav-pending-hint";
import { BOTTOM_TAB_ITEMS, isActivePath, isMorePath, VIEWER_NAV_ITEMS } from "./nav-items";

interface TabItem {
  key: NavIconName | "more";
  label: string;
  href: string;
}

const MORE_TAB: TabItem = { key: "more", label: "その他", href: "/more" };

/** 現在地: the icon sits on the light grey pill of the side navigation, the label is bold (10 §1). */
function Tab({ item, active }: { item: TabItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`group relative flex min-h-12 flex-col items-center justify-center gap-0.5 text-[10px] ${
        active ? "font-bold text-text" : "font-medium text-muted"
      }`}
    >
      <span
        className={`flex h-7 w-12 items-center justify-center rounded-full ${
          active ? "bg-track" : "group-hover:bg-black/[0.04]"
        }`}
      >
        <NavIcon name={item.key} className="size-[22px]" />
      </span>
      {item.label}
      <NavPendingHint className="absolute right-1.5 top-1.5" />
    </Link>
  );
}

const BAR =
  "fixed inset-x-0 bottom-0 z-40 grid border-t border-border bg-surface px-1.5 pt-1.5 pb-[calc(8px+env(safe-area-inset-bottom))] md:hidden";

/** 閲覧 on phones: 報告 / 書き出し only (23 §3.4). */
function ViewerTabs({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="メイン" className={`${BAR} grid-cols-2`}>
      {VIEWER_NAV_ITEMS.map((item) => (
        <Tab key={item.key} item={item} active={isActivePath(pathname, item.href)} />
      ))}
    </nav>
  );
}

/**
 * Phone navigation under 768px: ホーム / 明細 / 証憑を撮影 (the camera, 10 §1.1) / 報告 / その他. その他
 * is current on its own sections, `/search` and `/more` (`isMorePath`, 10 §1); 証憑 too, as the
 * centre tab opens the camera and the list is reached through その他.
 */
export function BottomTabs({ viewer = false }: { viewer?: boolean }) {
  const pathname = usePathname();
  if (viewer) return <ViewerTabs pathname={pathname} />;
  const [home, statements, reports] = BOTTOM_TAB_ITEMS;
  return (
    <nav aria-label="メイン" className={`${BAR} grid-cols-5`}>
      <Tab item={home} active={isActivePath(pathname, home.href)} />
      <Tab item={statements} active={isActivePath(pathname, statements.href)} />
      <CaptureTab />
      <Tab item={reports} active={isActivePath(pathname, reports.href)} />
      <Tab item={MORE_TAB} active={isMorePath(pathname)} />
    </nav>
  );
}
