import { CSV_CONTENT_TYPES, encodeCsv, type CsvEncoding } from "@niho-finance/reports";
import { downloadResponse } from "@/lib/pdf/download";

/*
 * The CSV files of 法定調書 (22-payroll §12.2) as downloads: UTF-8 without a BOM (the first item is
 * the 法定資料の種類, which a BOM would break) or Shift_JIS through the `iconv-lite` of
 * `@niho-finance/reports` — eLTAX PCdesk's import may require Shift_JIS. A character Shift_JIS cannot
 * hold is refused by name rather than written as `?`. The body may hold マイナンバー typed for this
 * download: it is never logged, and the response is not cached (`downloadResponse`).
 */

export type StatementCsvEncoding = CsvEncoding;

export function readEncoding(value: FormDataEntryValue | null): StatementCsvEncoding {
  return value === "sjis" ? "sjis" : "utf8";
}

/** The characters of `text` that Shift_JIS (CP932) cannot hold. */
export function unmappableInShiftJis(text: string): string[] {
  const decoder = new TextDecoder("shift_jis");
  return [...new Set(text)].filter(
    (char) => char !== "\r" && char !== "\n" && decoder.decode(encodeCsv(char, "sjis")) !== char,
  );
}

export function statementCsvBytes(
  text: string,
  encoding: StatementCsvEncoding,
): { ok: true; bytes: Uint8Array } | { ok: false; characters: string[] } {
  if (encoding === "utf8") return { ok: true, bytes: new TextEncoder().encode(text) };
  const characters = unmappableInShiftJis(text);
  if (characters.length > 0) return { ok: false, characters };
  return { ok: true, bytes: encodeCsv(text, "sjis") };
}

export function statementCsvResponse(
  bytes: Uint8Array,
  fileName: string,
  encoding: StatementCsvEncoding,
): Response {
  return downloadResponse(bytes, { fileName, contentType: CSV_CONTENT_TYPES[encoding] });
}

/**
 * A form POSTed from another site is refused (the response would carry the typed numbers): the
 * `Origin` must name this host (as the request, the proxy's `x-forwarded-host` or `host` gives it).
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    const hosts = [
      new URL(request.url).host,
      ...(request.headers.get("x-forwarded-host") ?? "").split(",").map((host) => host.trim()),
      request.headers.get("host") ?? "",
    ].filter((host) => host !== "");
    return hosts.includes(new URL(origin).host);
  } catch {
    return false;
  }
}

/** A typed 個人番号 / 法人番号: digits only (full-width folded), or `null` when it is malformed. */
export function typedNumber(
  value: FormDataEntryValue | null,
  lengths: readonly number[],
): string | null {
  if (typeof value !== "string") return "";
  const digits = value.normalize("NFKC").replace(/[\s-]/g, "");
  if (digits === "") return "";
  return /^\d+$/.test(digits) && lengths.includes(digits.length) ? digits : null;
}
