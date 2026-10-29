import type { ParsedSearchQuery, SearchGroup, SearchHit, SearchKind } from "@niho-finance/db";
import {
  DOCUMENT_KIND_LABELS,
  formatYen,
  INVOICE_DOC_TYPE_LABELS,
  INVOICE_STATUS_LABELS,
  isDraftInvoiceNumber,
  PARTNER_KIND_LABELS,
  WALLET_TRANSACTION_STATUS_LABELS,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";
import { entryNo, formatDate } from "@/lib/format";

/*
 * How a hit of 全体検索 reads and where it opens (10 §7.2), for the palette and `/search`. Plain data
 * (no bigint): the Server Action sends it to the client as it is. Types only from the server packages.
 */

export const SEARCH_HINT = "摘要の一部・金額・取引先名・請求番号で探せます";

export function noHitsMessage(query: string): string {
  return `「${query}」に合うものはありません。${SEARCH_HINT}`;
}

/** One hit: a title line and a meta line (`meta` joined with 「 · 」). */
export interface HitView {
  /** Unique within the results (the kind and the id). */
  key: string;
  href: string;
  title: string;
  meta: string[];
  /** 取消済み・無効: shown muted. */
  muted: boolean;
  /** The accessible name: the title and the meta. */
  label: string;
}

export interface GroupView {
  kind: SearchKind;
  /** 取引 / 明細 / 証憑 / 取引先 / 請求. */
  label: string;
  total: number;
  hits: HitView[];
  /** 「すべて見る（n 件）」: only when the kind has more matches than hits. */
  more: { href: string; label: string } | null;
}

export interface SearchView {
  /** The input as searched (trimmed). */
  query: string;
  groups: GroupView[];
}

/** `−1,650` for money out (the statements' sign), `1,650` for money in. */
function signedAmount(amount: Money): string {
  return amount < 0n ? `−${formatYen(-amount)}` : formatYen(amount);
}

function compact(values: (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function view(key: string, href: string, title: string, meta: string[], muted: boolean): HitView {
  return { key, href, title, meta, muted, label: [title, ...meta].join("、") };
}

/** 「請求書 INV-2026-0001」 / 「見積書（下書き）」 (a draft's placeholder number is never shown). */
function documentName(hit: Extract<SearchHit, { kind: "invoice" }>): string {
  const type = INVOICE_DOC_TYPE_LABELS[hit.docType];
  return isDraftInvoiceNumber(hit.number) ? `${type}（下書き）` : `${type} ${hit.number}`;
}

export function hitView(hit: SearchHit): HitView {
  const key = `${hit.kind}-${hit.id}`;
  switch (hit.kind) {
    case "entry": {
      const voided = hit.status === "voided";
      return view(
        key,
        `/entries/${encodeURIComponent(hit.id)}`,
        hit.description || entryNo(hit.no),
        compact([
          entryNo(hit.no),
          formatDate(hit.entryDate),
          formatYen(hit.amount),
          voided ? "取消済み" : null,
        ]),
        voided,
      );
    }
    case "statement": {
      // The list the line appears in: its state, its wallet and its amount (15 §3).
      const size = hit.amount < 0n ? -hit.amount : hit.amount;
      return view(
        key,
        withQuery("/statements", {
          status: hit.status,
          wallet: hit.walletId,
          q: size.toString(),
        }),
        hit.descriptionRaw,
        [
          formatDate(hit.txnDate),
          hit.walletName,
          signedAmount(hit.amount),
          WALLET_TRANSACTION_STATUS_LABELS[hit.status],
        ],
        false,
      );
    }
    case "document": {
      const voided = hit.status === "voided";
      const kindLabel = DOCUMENT_KIND_LABELS[hit.documentKind];
      return view(
        key,
        `/documents/${encodeURIComponent(hit.id)}`,
        hit.originalName ?? hit.partnerName ?? kindLabel,
        compact([
          kindLabel,
          hit.txnDate ? formatDate(hit.txnDate) : null,
          hit.amount === null ? null : formatYen(hit.amount),
          hit.originalName ? hit.partnerName : null,
          voided ? "無効" : null,
        ]),
        voided,
      );
    }
    case "partner":
      return view(
        key,
        withQuery("/settings/partners", { q: hit.name }),
        hit.name,
        compact([
          PARTNER_KIND_LABELS[hit.partnerKind],
          hit.invoiceRegistrationNumber,
          hit.isActive ? null : "無効",
        ]),
        !hit.isActive,
      );
    case "invoice":
      return view(
        key,
        `/invoices/${encodeURIComponent(hit.id)}`,
        documentName(hit),
        compact([
          hit.partnerName,
          hit.title,
          formatDate(hit.issueDate),
          formatYen(hit.total),
          INVOICE_STATUS_LABELS[hit.status],
        ]),
        hit.status === "void",
      );
  }
}

/** `/search?q=…[&kind=…][&page=…]`. */
export function searchHref(options: {
  q: string;
  kind?: SearchKind | null;
  page?: number;
}): string {
  return withQuery("/search", {
    q: options.q,
    kind: options.kind ?? null,
    page: options.page && options.page > 1 ? String(options.page) : null,
  });
}

/**
 * 「すべて見る」 (10 §7.2): the kind's own list with its filter for the text, `/search?kind=` where
 * the list cannot say it (an entry's amount or No., an invoice's total).
 */
export function moreHref(
  kind: SearchKind,
  query: ParsedSearchQuery,
  period: { from: CalendarDate; to: CalendarDate } | null = null,
): string {
  const q = query.raw;
  const byNumber = query.amount !== null || query.entryNo !== null;
  switch (kind) {
    case "entry":
      // Without dates the journal shows 今期 only: open it over the dates of the matches.
      return byNumber
        ? searchHref({ q, kind })
        : withQuery("/entries", { from: period?.from, to: period?.to, q, status: "all" });
    case "statement":
      return withQuery("/statements", { q });
    case "document":
      return query.amount !== null
        ? withQuery("/documents", {
            tab: "all",
            amountMin: query.amount.toString(),
            amountMax: query.amount.toString(),
          })
        : withQuery("/documents", { tab: "all", q });
    case "partner":
      return withQuery("/settings/partners", { q });
    case "invoice":
      // The list's 種類 defaults to 請求書: 見積書・納品書 are hits too.
      return query.amount !== null
        ? searchHref({ q, kind })
        : withQuery("/invoices", { type: "all", status: "all", q });
  }
}

export function groupView(
  group: SearchGroup,
  query: ParsedSearchQuery,
  label: string,
  perKind: number,
): GroupView {
  return {
    kind: group.kind,
    label,
    total: group.total,
    hits: group.hits.map(hitView),
    more:
      group.total > perKind
        ? {
            href: moreHref(group.kind, query, group.period),
            label: `すべて見る（${group.total.toLocaleString("ja-JP")} 件）`,
          }
        : null,
  };
}

/** The result of `searchAll` as the palette and `/search` show it. */
export function searchView(
  result: { query: ParsedSearchQuery; groups: SearchGroup[] },
  labels: Readonly<Record<SearchKind, string>>,
  perKind: number,
): SearchView {
  return {
    query: result.query.raw,
    groups: result.groups.map((group) =>
      groupView(group, result.query, labels[group.kind], perKind),
    ),
  };
}
