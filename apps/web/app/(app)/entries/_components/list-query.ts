import type { EntriesFilter } from "@niho-finance/db";

/** The parameters of `/entries` (11 §3) that differ from the defaults, in a stable order. */
export function entriesQuery(filters: Partial<EntriesFilter>): string {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "account", "partner", "segment", "tag", "q"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (filters.status && filters.status !== "posted") params.set("status", filters.status);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

const LIST_KEYS = new Set([
  "from",
  "to",
  "account",
  "partner",
  "segment",
  "tag",
  "status",
  "q",
  "page",
]);

/**
 * The list a detail was opened from (`?list=` carries its query), so that 戻る keeps the filters
 * (11 §5). Only the list's own parameters are kept.
 */
export function listHref(list: unknown): string {
  if (typeof list !== "string" || list.length > 1_000) return "/entries";
  const kept = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(list)) {
    if (LIST_KEYS.has(key) && value.length <= 100) kept.set(key, value);
  }
  const query = kept.toString();
  return query ? `/entries?${query}` : "/entries";
}

export function detailHref(id: string, listQuery: string): string {
  return listQuery ? `/entries/${id}?list=${encodeURIComponent(listQuery)}` : `/entries/${id}`;
}
