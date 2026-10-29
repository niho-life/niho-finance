import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { MORE_GROUPS, MORE_SETTINGS_ITEM, type MoreItem } from "@/components/app-shell/nav-items";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "その他" };

/** A row: the section on the left, what it holds on the right. */
function MoreRow({ item }: { item: MoreItem }) {
  return (
    <li>
      <Link
        href={item.href}
        className="flex min-h-12 items-center gap-3 border-b border-border px-1 py-3 hover:bg-black/[0.02]"
      >
        <span className="font-bold">{item.label}</span>
        <span className="ml-auto min-w-0 truncate text-right text-[12px] text-muted">
          {item.summary}
        </span>
        <span aria-hidden="true" className="text-muted-2">
          ›
        </span>
      </Link>
    </li>
  );
}

/**
 * その他 (10 §1): on phones, the search and the sections the bottom tabs leave out, in the groups of
 * the side navigation (`MORE_GROUPS`), with 設定 last.
 */
export default function MorePage() {
  return (
    <>
      <PageHeader title="その他" />
      {/* 全体検索の入口 on phones (10 §7.1): a GET form, usable without JavaScript. */}
      <Form action="/search" role="search" className="mb-4 flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[12px] font-bold text-muted">検索</span>
          <input
            name="q"
            type="search"
            maxLength={100}
            placeholder="摘要・金額・取引先・請求番号"
            enterKeyHint="search"
            className="control"
          />
        </label>
        <Button type="submit">検索</Button>
      </Form>
      <div className="flex flex-col gap-5">
        {MORE_GROUPS.map((group) => {
          const headingId = `more-group-${group.key}`;
          return (
            <div key={group.key}>
              <h2 id={headingId} className="px-1 pb-1 text-[12px] font-medium text-muted">
                {group.label}
              </h2>
              <ul aria-labelledby={headingId}>
                {group.items.map((item) => (
                  <MoreRow key={item.href} item={item} />
                ))}
              </ul>
            </div>
          );
        })}
        <ul className="mt-3">
          <MoreRow item={MORE_SETTINGS_ITEM} />
        </ul>
      </div>
    </>
  );
}
