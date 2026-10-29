import type { NavIconName } from "./icons";

export interface NavItem {
  key: NavIconName;
  label: string;
  href: string;
  /** Other paths where the item is the current one (請求: 支払 too, 25 §5). */
  match?: readonly string[];
}

export type NavGroupKey = "daily" | "view" | "work" | "yearly";

/** A group of the navigation; its key names the heading's element id. */
export interface NavGroup {
  key: NavGroupKey;
  label: string;
  items: readonly NavItem[];
}

/** A row of その他 on phones: the section and what it holds, in one line. */
export interface MoreItem {
  label: string;
  href: string;
  summary: string;
}

export interface MoreGroup {
  key: NavGroupKey;
  label: string;
  items: readonly MoreItem[];
}

const HOME: NavItem = { key: "home", label: "ホーム", href: "/" };
const STATEMENTS: NavItem = { key: "statements", label: "明細", href: "/statements" };
const REPORTS: NavItem = { key: "reports", label: "報告", href: "/reports" };

/**
 * The navigation by how often it is used (10 §1, 05 §1); within a group, in the order of the daily
 * work. The table of 10 §1 is the source (test/nav-items.test.ts).
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: "daily",
    label: "日々",
    items: [
      HOME,
      STATEMENTS,
      { key: "entries", label: "取引", href: "/entries" },
      { key: "documents", label: "証憑", href: "/documents" },
    ],
  },
  {
    key: "view",
    label: "見る",
    items: [REPORTS, { key: "calendar", label: "期限", href: "/calendar" }],
  },
  {
    key: "work",
    label: "業務",
    items: [
      { key: "invoices", label: "請求", href: "/invoices", match: ["/payables"] },
      { key: "payroll", label: "給与", href: "/payroll" },
      { key: "expenses", label: "立替精算", href: "/expenses" },
    ],
  },
  { key: "yearly", label: "年次", items: [{ key: "closing", label: "決算", href: "/closing" }] },
];

/** 設定: outside the groups, at the bottom of the navigation and last in その他 (10 §1). */
export const SETTINGS_NAV_ITEM: NavItem = { key: "settings", label: "設定", href: "/settings" };

/** 閲覧 opens 報告 and the exports of the books only, without groups (23-users-and-expenses §3.4). */
export const VIEWER_NAV_ITEMS: readonly NavItem[] = [
  REPORTS,
  { key: "export", label: "書き出し", href: "/settings/export" },
];

/** The phone tabs around 証憑を撮影 and その他 (10 §1): ホーム / 明細 / 撮影 / 報告 / その他. */
export const BOTTOM_TAB_ITEMS = [HOME, STATEMENTS, REPORTS] as const;

/** 明細の取込 opens from 明細 on PC; on phones it is the first row of その他 › 日々 (10 §1). */
const IMPORTS = { label: "明細の取込", href: "/imports" };

/** 支払 opens from 請求 on PC (25 §5); on phones it is its own row of その他 › 業務, after 請求. */
const PAYABLES = { label: "支払", href: "/payables" };

/** What each row of その他 holds (by href). */
const MORE_SUMMARIES: Readonly<Record<string, string>> = {
  "/imports": "銀行・カードの CSV と Stripe の同期",
  "/entries": "仕訳の一覧・登録・訂正",
  "/documents": "受信箱・検索・索引簿",
  "/calendar": "申告・届出・納付の期限と完了の記録",
  "/invoices": "見積・納品・請求と入金の消込",
  "/payables": "受領した請求書の未払と支払期日",
  "/payroll": "従業員・支給・給与明細・納付",
  "/expenses": "社員・業務委託の立替の提出と支払",
  "/closing": "決算整理・固定資産・締め",
  "/settings": "事業所・会計期間・勘定科目・口座 …",
};

function moreItem({ label, href }: { label: string; href: string }): MoreItem {
  return { label, href, summary: MORE_SUMMARIES[href] ?? "" };
}

const BOTTOM_TAB_HREFS: readonly string[] = BOTTOM_TAB_ITEMS.map((item) => item.href);

/** その他 (10 §1): the same groups without the bottom tabs' sections, 明細の取込 first in 日々. */
export const MORE_GROUPS: readonly MoreGroup[] = NAV_GROUPS.map((group) => ({
  key: group.key,
  label: group.label,
  items: [
    ...(group.key === "daily" ? [IMPORTS] : []),
    ...group.items
      .filter((item) => !BOTTOM_TAB_HREFS.includes(item.href))
      .flatMap((item) => (item.href === "/invoices" ? [item, PAYABLES] : [item])),
  ].map(moreItem),
})).filter((group) => group.items.length > 0);

/** 設定, last in その他 after the groups. */
export const MORE_SETTINGS_ITEM: MoreItem = moreItem(SETTINGS_NAV_ITEM);

export function isActivePath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The item is the current one: its own path or one of `match`. */
export function isActiveItem(pathname: string, item: { href: string; match?: readonly string[] }) {
  return [item.href, ...(item.match ?? [])].some((path) => isActivePath(pathname, path));
}

/** その他 itself, 検索 (its form is at the top of その他, 10 §7.1) and every section it lists. */
const MORE_PATHS: readonly string[] = [
  "/more",
  "/search",
  ...MORE_GROUPS.flatMap((group) => group.items.map((item) => item.href)),
  MORE_SETTINGS_ITEM.href,
];

/** The phone tab その他 is the current one here (10 §1). */
export function isMorePath(pathname: string): boolean {
  return MORE_PATHS.some((path) => isActivePath(pathname, path));
}
