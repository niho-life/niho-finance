import type { ImportSource } from "@niho-finance/importers";

/* Display helpers of the import screens, shared by server and client components. */

export const IMPORT_SOURCE_LABELS: Readonly<Record<ImportSource, string>> = {
  csv: "CSV",
  stripe: "Stripe",
  api: "銀行 API",
};

const JAPAN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The JST calendar day of a timestamp: `2026/11/02`. */
export function formatJapanDate(value: Date | string): string {
  return JAPAN_DATE.format(new Date(value)).replaceAll("-", "/");
}

/** `新規 3 件・重複 1 件・失敗 0 件` */
export function countsText(counts: {
  importedCount: number;
  duplicateCount: number;
  failedCount: number;
}): string {
  return `新規 ${counts.importedCount} 件・重複 ${counts.duplicateCount} 件・失敗 ${counts.failedCount} 件`;
}

/** The first line of a reason, for one-line cells. */
export function firstLine(text: string): string {
  return text.split(/\r\n|\r|\n/, 1)[0] ?? "";
}

/** `1.2 MB` / `850 KB` / `300 B` */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
