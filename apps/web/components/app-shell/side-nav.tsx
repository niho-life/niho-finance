"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavIcon } from "./icons";
import { isActivePath, NAV_ITEMS } from "./nav-items";

/** PC navigation (216px). Sections not built yet are muted text, not links. */
export function SideNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="メイン" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const base =
          "flex min-h-10 items-center gap-2.5 rounded-[10px] px-2.5 text-[14px] font-semibold";
        if (!item.href) {
          return (
            <span key={item.key} aria-disabled="true" className={`${base} text-muted opacity-45`}>
              <NavIcon name={item.key} />
              {item.label}
              <span className="sr-only">（準備中）</span>
            </span>
          );
        }
        const active = isActivePath(pathname, item.href);
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`${base} ${
              active ? "bg-surface text-text shadow-raised" : "text-muted hover:bg-black/[0.04]"
            }`}
          >
            <NavIcon name={item.key} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
