import type { EtaxStatement } from "@niho-finance/reports";

/** `doc` of `/closing/statements/export` (17 §2). */
export const STATEMENT_DOCS = [
  "statements",
  "opening",
  "business-report",
  "schedules",
  "etax",
  "account-details",
  "consumption-tax",
  "announcement",
] as const;
export type StatementDoc = (typeof STATEMENT_DOCS)[number];

export const STATEMENT_FORMATS = ["pdf", "csv", "zip", "html"] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

/** The formats each document can be written in. */
export const DOC_FORMATS: Readonly<Record<StatementDoc, readonly StatementFormat[]>> = {
  statements: ["pdf"],
  opening: ["pdf"],
  "business-report": ["pdf"],
  schedules: ["pdf"],
  etax: ["zip", "csv"],
  "account-details": ["csv"],
  "consumption-tax": ["csv"],
  announcement: ["html"],
};

export function isStatementDoc(value: unknown): value is StatementDoc {
  return typeof value === "string" && (STATEMENT_DOCS as readonly string[]).includes(value);
}

export function isStatementFormat(value: unknown): value is StatementFormat {
  return typeof value === "string" && (STATEMENT_FORMATS as readonly string[]).includes(value);
}

export function statementsHref(fyNo: number, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ fy: String(fyNo), ...extra });
  return `/closing/statements?${params.toString()}`;
}

export function consumptionTaxHref(fyNo: number): string {
  return `/closing/statements/consumption-tax?fy=${fyNo}`;
}

/**
 * A download (`/closing/statements/export`). Pages link it with a plain `<a>`, never `next/link`:
 * a prefetch would write an export nobody asked for into the audit log.
 */
export function statementExportHref(
  fyNo: number,
  doc: StatementDoc,
  format: StatementFormat,
  statement?: EtaxStatement,
): string {
  const params = new URLSearchParams({ fy: String(fyNo), doc, format });
  if (statement) params.set("statement", statement);
  return `/closing/statements/export?${params.toString()}`;
}

/** `?error=` of the page after a download that could not be made (the e-Tax one is computed). */
export const STATEMENT_EXPORT_ERRORS: Readonly<Record<string, string>> = {
  export: "書き出す書類が見つかりません。下の「書き出し」から選んで書き出します。",
  empty: "この期の仕訳がありません。取引から登録してから書き出します。",
  opening: "開始貸借対照表は設立の期（第 1 期）だけにあります。",
};
