import type { DocumentSearchFilters } from "@niho-finance/db";
import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_TABS,
  type DocumentKind,
  type DocumentTab,
} from "@niho-finance/ledger";

/** The list's conditions without the page (13 §3.2). */
export type DocumentConditions = Omit<DocumentSearchFilters, "page">;

/** Any condition but the tab: an empty result then says 「条件に合う証憑がありません」. */
export function hasConditions(filters: DocumentConditions): boolean {
  return (
    filters.from !== null ||
    filters.to !== null ||
    filters.amountMin !== null ||
    filters.amountMax !== null ||
    filters.partner !== null ||
    filters.kind !== null ||
    filters.q !== null
  );
}

export function isDocumentTab(value: unknown): value is DocumentTab {
  return typeof value === "string" && (DOCUMENT_TABS as readonly string[]).includes(value);
}

/**
 * The parameters of `/documents` in a stable order: the default tab (受信箱) and page 1 are left
 * out. `explicitTab` keeps the tab even when it is the inbox (the index CSV defaults to すべて).
 */
export function documentsQuery(
  filters: Partial<DocumentSearchFilters>,
  options: { explicitTab?: boolean } = {},
): string {
  const params = new URLSearchParams();
  const tab = filters.tab ?? "inbox";
  if (tab !== "inbox" || options.explicitTab) params.set("tab", tab);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.amountMin !== null && filters.amountMin !== undefined) {
    params.set("amountMin", filters.amountMin.toString());
  }
  if (filters.amountMax !== null && filters.amountMax !== undefined) {
    params.set("amountMax", filters.amountMax.toString());
  }
  if (filters.partner) params.set("partner", filters.partner);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.q) params.set("q", filters.q);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

export function documentsHref(
  filters: Partial<DocumentSearchFilters>,
  options: { explicitTab?: boolean } = {},
): string {
  const query = documentsQuery(filters, options);
  return query ? `/documents?${query}` : "/documents";
}

/** What a document is called on the screens: its file name, else its kind (13 §4). */
export function documentTitle(document: { originalName: string | null; kind: DocumentKind }) {
  return document.originalName ?? DOCUMENT_KIND_LABELS[document.kind];
}

/** `1 KB` / `2.4 MB`: the size of a file. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
