import type { NavIconName } from "./icons";

export interface NavItem {
  key: NavIconName;
  label: string;
  /** `null` until the section exists: shown muted, not as a link (S3–S7 enable them). */
  href: string | null;
}

/**
 * The left navigation (10 §1, 18 §6, 16 §2: 決算 between 請求 and 設定, 24 §3: 期限 after 報告,
 * 23 §6: 立替精算 after 給与).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", label: "ホーム", href: "/" },
  { key: "statements", label: "明細", href: "/statements" },
  { key: "entries", label: "取引", href: "/entries" },
  { key: "documents", label: "証憑", href: "/documents" },
  { key: "reports", label: "報告", href: "/reports" },
  { key: "calendar", label: "期限", href: "/calendar" },
  { key: "invoices", label: "請求", href: "/invoices" },
  { key: "payroll", label: "給与", href: "/payroll" },
  { key: "expenses", label: "立替精算", href: "/expenses" },
  { key: "closing", label: "決算", href: "/closing" },
  { key: "settings", label: "設定", href: "/settings" },
];

/** 閲覧 opens 報告 and the exports of the books only (23-users-and-expenses §3.4). */
export const VIEWER_NAV_ITEMS: readonly NavItem[] = [
  { key: "reports", label: "報告", href: "/reports" },
  { key: "export", label: "書き出し", href: "/settings/export" },
];

export function isActivePath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
