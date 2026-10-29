import {
  isSearchKind,
  searchAll,
  searchKind,
  SEARCH_KIND_LABELS,
  SEARCH_PER_KIND,
  type SearchKind,
} from "@niho-finance/db";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  groupView,
  noHitsMessage,
  SEARCH_HINT,
  searchHref,
  searchView,
  type GroupView,
  type HitView,
} from "@/components/app-shell/search/hit-view";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { db } from "@/lib/data";

export const metadata: Metadata = { title: "検索" };

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function HitLink({ hit }: { hit: HitView }) {
  return (
    <li className="border-b border-border">
      <Link
        href={hit.href}
        aria-label={hit.label}
        className="flex min-h-12 flex-col justify-center px-1 py-2 hover:bg-black/[0.02]"
      >
        <span
          className={`block truncate text-[14px] font-semibold ${hit.muted ? "text-muted" : ""}`}
        >
          {hit.title}
        </span>
        <span className="num block truncate text-[12px] text-muted">{hit.meta.join(" · ")}</span>
      </Link>
    </li>
  );
}

function GroupSection({ group, children }: { group: GroupView; children?: ReactNode }) {
  const headingId = `search-${group.kind}`;
  return (
    <section aria-labelledby={headingId} className="mb-6">
      <h2 id={headingId} className="mb-1 flex items-baseline gap-2 text-[15px] font-extrabold">
        {group.label}
        <span className="num text-[13px] font-normal text-muted">
          {group.total.toLocaleString("ja-JP")} 件
        </span>
      </h2>
      <ul className="border-t border-border">
        {group.hits.map((hit) => (
          <HitLink key={hit.key} hit={hit} />
        ))}
      </ul>
      {children}
    </section>
  );
}

/**
 * 検索 (10 §7.3): the palette's results as a page of links, the phone's entry (その他) and where
 * 「すべて見る」 goes when a list cannot say the query. `kind=` shows one kind, 50 per page. Reads only.
 */
export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const params = await searchParams;
  const q = firstValue(params.q).trim().slice(0, 100);
  const kindParam = firstValue(params.kind);
  const kind: SearchKind | null = isSearchKind(kindParam) ? kindParam : null;
  const requestedPage = Number.parseInt(firstValue(params.page), 10);
  const prisma = await db();

  let body: ReactNode;
  if (q === "") {
    body = <p className="text-[13px] text-muted">{SEARCH_HINT}</p>;
  } else if (kind) {
    const result = await searchKind(prisma, q, kind, {
      page: Number.isFinite(requestedPage) ? requestedPage : 1,
    });
    const group = groupView(
      result.group,
      result.query,
      SEARCH_KIND_LABELS[kind],
      Number.POSITIVE_INFINITY,
    );
    body =
      group.total === 0 ? (
        <p className="text-[14px] text-muted">{noHitsMessage(q)}</p>
      ) : (
        <GroupSection group={group}>
          <Pagination
            page={result.page}
            pageCount={result.pageCount}
            total={group.total}
            href={(page) => searchHref({ q, kind, page })}
          />
        </GroupSection>
      );
  } else {
    const view = searchView(await searchAll(prisma, q), SEARCH_KIND_LABELS, SEARCH_PER_KIND);
    body =
      view.groups.length === 0 ? (
        <p className="text-[14px] text-muted">{noHitsMessage(q)}</p>
      ) : (
        view.groups.map((group) => (
          <GroupSection key={group.kind} group={group}>
            {group.more ? (
              <Link
                href={group.more.href}
                className="num mt-2 inline-flex min-h-9 items-center text-[13px] font-bold text-muted hover:text-text"
              >
                {group.more.label}
                <span aria-hidden="true">&nbsp;›</span>
              </Link>
            ) : null}
          </GroupSection>
        ))
      );
  }

  return (
    <>
      <PageHeader
        title="検索"
        back={kind && q ? { href: searchHref({ q }), label: "すべての種類" } : undefined}
        meta={kind ? SEARCH_KIND_LABELS[kind] : undefined}
      />
      <Form action="/search" role="search" className="mb-5 flex max-w-xl gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">検索</span>
          <input
            name="q"
            type="search"
            defaultValue={q}
            maxLength={100}
            placeholder="摘要・金額・取引先・請求番号"
            enterKeyHint="search"
            className="control"
          />
        </label>
        {kind ? <input type="hidden" name="kind" value={kind} /> : null}
        <Button type="submit">検索</Button>
      </Form>
      {body}
    </>
  );
}
