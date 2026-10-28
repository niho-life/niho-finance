import type { StatementsFilter } from "@niho-finance/db";

/** The parameters of `/statements` (15 §3) that differ from the defaults, in a stable order. */
export function statementsQuery(filters: Partial<StatementsFilter>): string {
  const params = new URLSearchParams();
  if (filters.wallet) params.set("wallet", filters.wallet);
  if (filters.status && filters.status !== "pending") params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  // `by` only narrows the settled tabs.
  if (filters.by === "rule" && filters.status && filters.status !== "pending") {
    params.set("by", "rule");
  }
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

export function statementsHref(filters: Partial<StatementsFilter>): string {
  const query = statementsQuery(filters);
  return query ? `/statements?${query}` : "/statements";
}
