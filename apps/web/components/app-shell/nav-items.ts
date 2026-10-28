import type { NavIconName } from "./icons";

export interface NavItem {
  key: NavIconName;
  label: string;
  /** `null` until the section exists: shown muted, not as a link (S3–S7 enable them). */
  href: string | null;
}

/** The left navigation (10 §1, 18 §6). 明細 S5 is not built yet. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", label: "ホーム", href: "/" },
  { key: "statements", label: "明細", href: null },
  { key: "entries", label: "取引", href: "/entries" },
  { key: "documents", label: "証憑", href: "/documents" },
  { key: "reports", label: "報告", href: "/reports" },
  { key: "invoices", label: "請求", href: "/invoices" },
  { key: "payroll", label: "給与", href: "/payroll" },
  { key: "settings", label: "設定", href: "/settings" },
];

export function isActivePath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
