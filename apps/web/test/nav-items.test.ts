import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOTTOM_TAB_ITEMS,
  isActivePath,
  isMorePath,
  MORE_GROUPS,
  MORE_SETTINGS_ITEM,
  NAV_GROUPS,
  SETTINGS_NAV_ITEM,
} from "@/components/app-shell/nav-items";

/* ナビの群 (10 §1): the tables of the design are the order of the side navigation and of その他. */

const spec = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../docs/design/10-settings-and-setup.md",
  ),
  "utf8",
);

/** The rows of the first table after `marker`, as [群, 項目…] (the items are joined by `・`). */
function tableAfter(marker: string): [string, string[]][] {
  const start = spec.indexOf(marker);
  expect(start, marker).toBeGreaterThanOrEqual(0);
  const lines = spec.slice(start).split("\n");
  const first = lines.findIndex((line) => line.trim().startsWith("|"));
  const rows: [string, string[]][] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.trim().startsWith("|")) break;
    const [group = "", items = ""] = line
      .trim()
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    rows.push([group, items.split("・")]);
  }
  return rows;
}

const labels = (items: readonly { label: string }[]) => items.map((item) => item.label);

describe("navigation groups", () => {
  it("follow the table of 10 §1, with 設定 at the bottom", () => {
    expect(tableAfter("**ナビの群**")).toEqual([
      ...NAV_GROUPS.map((group) => [group.label, labels(group.items)]),
      ["（最下部）", [SETTINGS_NAV_ITEM.label]],
    ]);
  });

  it("その他 follows its table: the same groups without the bottom tabs, 設定 last", () => {
    expect(tableAfter("「その他」（`/more`）")).toEqual([
      ...MORE_GROUPS.map((group) => [group.label, labels(group.items)]),
      ["（最後）", [MORE_SETTINGS_ITEM.label]],
    ]);
    for (const item of [...MORE_GROUPS.flatMap((group) => group.items), MORE_SETTINGS_ITEM]) {
      expect(item.summary, item.label).not.toBe("");
    }
  });

  it("reaches every section on phones: a bottom tab or a row of その他", () => {
    const tabs = BOTTOM_TAB_ITEMS.map((item) => item.href);
    const more = [...MORE_GROUPS.flatMap((group) => group.items), MORE_SETTINGS_ITEM].map(
      (item) => item.href,
    );
    for (const item of [...NAV_GROUPS.flatMap((group) => group.items), SETTINGS_NAV_ITEM]) {
      expect(tabs.includes(item.href) || more.includes(item.href), item.label).toBe(true);
    }
  });

  it("makes その他 the current tab on its sections, /more and /search", () => {
    for (const pathname of [
      "/more",
      "/search",
      "/documents",
      "/documents/doc-1",
      "/imports",
      "/closing",
      "/settings/export",
    ]) {
      expect(isMorePath(pathname), pathname).toBe(true);
    }
    for (const pathname of ["/", "/statements", "/reports/trial-balance"]) {
      expect(isMorePath(pathname), pathname).toBe(false);
    }
  });

  it("isActivePath: / only on itself, the others on their subpaths", () => {
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/entries", "/")).toBe(false);
    expect(isActivePath("/entries", "/entries")).toBe(true);
    expect(isActivePath("/entries/new", "/entries")).toBe(true);
    expect(isActivePath("/entries-old", "/entries")).toBe(false);
  });
});
