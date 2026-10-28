import type { InvoicesFilter } from "@niho-finance/db";
import {
  INVOICE_DOC_TYPE_LABELS,
  invoiceNumberLabel,
  isDraftInvoiceNumber,
  type InvoiceDocType,
} from "@niho-finance/ledger";

/** The parameters of `/invoices` (18 §7) that differ from the defaults, in a stable order. */
export function invoicesQuery(filters: Partial<InvoicesFilter>): string {
  const params = new URLSearchParams();
  if (filters.type && filters.type !== "invoice") params.set("type", filters.type);
  if (filters.status && filters.status !== "open") params.set("status", filters.status);
  if (filters.partner) params.set("partner", filters.partner);
  if (filters.q) params.set("q", filters.q);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

const LIST_KEYS = new Set(["type", "status", "partner", "q", "page"]);

/**
 * The list a detail was opened from (`?list=` carries its query), so that 戻る keeps the filters
 * (18 §9.1). Only the list's own parameters are kept.
 */
export function listHref(list: unknown): string {
  if (typeof list !== "string" || list.length > 1_000) return "/invoices";
  const kept = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(list)) {
    if (LIST_KEYS.has(key) && value.length <= 100) kept.set(key, value);
  }
  const query = kept.toString();
  return query ? `/invoices?${query}` : "/invoices";
}

export function detailHref(id: string, listQuery: string): string {
  return listQuery ? `/invoices/${id}?list=${encodeURIComponent(listQuery)}` : `/invoices/${id}`;
}

/** 「請求書 INV-2026-0001」, or 「請求書（下書き）」 before the issue: never the placeholder number. */
export function documentName(document: { docType: InvoiceDocType; number: string }): string {
  const type = INVOICE_DOC_TYPE_LABELS[document.docType];
  return isDraftInvoiceNumber(document.number)
    ? `${type}（下書き）`
    : `${type} ${invoiceNumberLabel(document.number)}`;
}
