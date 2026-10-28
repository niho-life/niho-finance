/**
 * CSV (14-reports §1): CRLF, fields quoted only when needed, UTF-8 with a BOM (Excel opens it as
 * UTF-8) or Shift_JIS (弥生). Amounts are plain integers; the caller formats dates.
 */
import iconv from "iconv-lite";

export type CsvCell = string | number | bigint | null | undefined;

export const CSV_ENCODINGS = ["utf8", "sjis"] as const;
export type CsvEncoding = (typeof CSV_ENCODINGS)[number];

export const CSV_ENCODING_LABELS: Readonly<Record<CsvEncoding, string>> = {
  utf8: "UTF-8",
  sjis: "Shift_JIS",
};

export function isCsvEncoding(value: unknown): value is CsvEncoding {
  return typeof value === "string" && (CSV_ENCODINGS as readonly string[]).includes(value);
}

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint" || typeof value === "number") return value.toString();
  const needsQuotes = /[",\r\n]/.test(value) || value.startsWith(" ") || value.endsWith(" ");
  return needsQuotes ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Rows → text with CRLF line ends (a trailing CRLF included). */
export function csvText(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

/** Text → bytes. UTF-8 gets a BOM; Shift_JIS (CP932) does not. */
export function encodeCsv(text: string, encoding: CsvEncoding): Uint8Array {
  if (encoding === "sjis") {
    return new Uint8Array(iconv.encode(text, "Shift_JIS"));
  }
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(UTF8_BOM.length + body.length);
  out.set(UTF8_BOM, 0);
  out.set(body, UTF8_BOM.length);
  return out;
}

export const CSV_CONTENT_TYPES: Readonly<Record<CsvEncoding, string>> = {
  utf8: "text/csv; charset=utf-8",
  sjis: "text/csv; charset=Shift_JIS",
};
