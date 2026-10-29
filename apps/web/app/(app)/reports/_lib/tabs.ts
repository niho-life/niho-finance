import type { PdfOrientation } from "@/lib/pdf/document";

/**
 * The tabs of 報告 (14-reports §2), in the order of the tab row; 資金繰り is v2 #19 (21 §6), 集計 is
 * v2 #50 (§15).
 */
export const REPORT_TABS = [
  "trial-balance",
  "monthly",
  "segments",
  "breakdown",
  "cash",
  "cashflow",
  "journal",
  "ledger",
] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

export const REPORT_TAB_LABELS: Readonly<Record<ReportTab, string>> = {
  "trial-balance": "試算表",
  monthly: "月次推移",
  segments: "セグメント損益",
  breakdown: "集計",
  cash: "現預金",
  cashflow: "資金繰り",
  journal: "仕訳帳",
  ledger: "総勘定元帳",
};

/** 仕訳帳・総勘定元帳・月次推移・集計 are landscape (14-reports §1, §15.4). */
export const REPORT_PDF_ORIENTATION: Readonly<Record<ReportTab, PdfOrientation>> = {
  "trial-balance": "portrait",
  monthly: "landscape",
  segments: "portrait",
  breakdown: "landscape",
  cash: "portrait",
  cashflow: "portrait",
  journal: "landscape",
  ledger: "landscape",
};

/**
 * The segment switch changes these tabs; 試算表 narrows its income statement only (§1). 集計 hides
 * it on the segment axis (§15.1).
 */
export const SEGMENT_TABS: ReadonlySet<ReportTab> = new Set([
  "trial-balance",
  "monthly",
  "breakdown",
  "journal",
  "ledger",
]);

export function isReportTab(value: unknown): value is ReportTab {
  return typeof value === "string" && (REPORT_TABS as readonly string[]).includes(value);
}

export const EXPORT_FORMATS = ["csv", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}
