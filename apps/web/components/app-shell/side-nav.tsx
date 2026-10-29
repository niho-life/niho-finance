"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavIcon } from "./icons";
import {
  isActiveItem,
  NAV_GROUPS,
  SETTINGS_NAV_ITEM,
  VIEWER_NAV_ITEMS,
  type NavItem,
} from "./nav-items";

/**
 * An item: an icon over a 10px label in the 76px rail (768–1023px), a 36px row from 1024px. 現在地
 * is the light grey fill, bold, in the text colour, without a shadow (10 §1, 05 §3).
 */
function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActiveItem(pathname, item);
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-11 flex-col items-center justify-center gap-1 rounded-[10px] px-0.5 py-1 text-[10px] leading-tight whitespace-nowrap lg:min-h-9 lg:flex-row lg:justify-start lg:gap-2.5 lg:px-2.5 lg:py-0 lg:text-[14px] ${
          active
            ? "bg-track font-bold text-text"
            : "font-medium text-muted hover:bg-black/[0.04] hover:text-text"
        }`}
      >
        <NavIcon name={item.key} className="size-5 lg:size-[18px]" />
        {item.label}
      </Link>
    </li>
  );
}

/**
 * The navigation of PC and tablets (10 §1): the 4 groups, then 設定 at the bottom. The group names
 * are shown from 1024px; in the rail a thin line separates the groups, and the name stays as the
 * list's name for screen readers. Only this part scrolls when the window is short. 閲覧 sees 報告
 * and 書き出し only, without groups (23 §3.4).
 */
export function SideNav({ viewer = false }: { viewer?: boolean }) {
  const pathname = usePathname();
  return (
    // The inset keeps the focus ring inside the scrolling box; `relative` keeps the hidden group
    // names in it too.
    <nav
      aria-label="メイン"
      className="relative -mx-1.5 flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 py-1 [scrollbar-width:thin]"
    >
      {viewer ? (
        <ul className="flex flex-col gap-0.5">
          {VIEWER_NAV_ITEMS.map((item) => (
            <NavLink key={item.key} item={item} pathname={pathname} />
          ))}
        </ul>
      ) : (
        <>
          <div className="grow">
            {NAV_GROUPS.map((group) => {
              const headingId = `nav-group-${group.key}`;
              return (
                <div
                  key={group.key}
                  className="mt-2 border-t border-border pt-2 first:mt-0 first:border-t-0 first:pt-0 lg:mt-3 lg:border-t-0 lg:pt-0"
                >
                  {/* Read once, as the name of the list. */}
                  <p
                    id={headingId}
                    aria-hidden="true"
                    className="sr-only lg:not-sr-only lg:px-2.5 lg:pb-1 lg:text-[11px] lg:font-medium lg:text-muted"
                  >
                    {group.label}
                  </p>
                  <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
                    {group.items.map((item) => (
                      <NavLink key={item.key} item={item} pathname={pathname} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          <ul className="mt-3 border-t border-border pt-2">
            <NavLink item={SETTINGS_NAV_ITEM} pathname={pathname} />
          </ul>
        </>
      )}
    </nav>
  );
}
