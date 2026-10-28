import type { NavIconName } from "./icons";

export interface NavItem {
  key: NavIconName;
  label: string;
  /** `null` until the section exists: shown muted, not as a link (S3–S7 enable them). */
  href: string | null;
  /** Other paths where the item is the current one (請求: 支払 too, 25 §5). */
  match?: readonly string[];
}

/** The left navigation (10 §1, 18 §6, 16 §2: 決算 between 請求 and 設定, 24 §3: 期限 after 報告). */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", label: "ホーム", href: "/" },
  { key: "statements", label: "明細", href: "/statements" },
  { key: "entries", label: "取引", href: "/entries" },
  { key: "documents", label: "証憑", href: "/documents" },
  { key: "reports", label: "報告", href: "/reports" },
  { key: "calendar", label: "期限", href: "/calendar" },
  { key: "invoices", label: "請求", href: "/invoices", match: ["/payables"] },
  { key: "payroll", label: "給与", href: "/payroll" },
  { key: "closing", label: "決算", href: "/closing" },
  { key: "settings", label: "設定", href: "/settings" },
];

export function isActivePath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The item is the current one: its own path or one of `match`. */
export function isActiveItem(pathname: string, item: { href: string; match?: readonly string[] }) {
  return [item.href, ...(item.match ?? [])].some((path) => isActivePath(pathname, path));
}
