import { newId } from "@niho-finance/db";
import { extensionForMime } from "@niho-finance/ledger";

const JAPAN_YEAR_MONTH = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
});

/**
 * A new storage key `documents/<yyyy>/<mm>/<ulid>.<ext>`: the month of `now` in Japan and the
 * extension of the MIME type. The original file name never goes into the key.
 */
export function newDocumentKey(mime: string, now: Date = new Date()): string {
  const extension = extensionForMime(mime);
  if (extension === null) throw new RangeError(`newDocumentKey: ${mime} is not an accepted type`);
  const parts = JAPAN_YEAR_MONTH.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `documents/${year}/${month}/${newId()}.${extension}`;
}

const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A key the storage accepts: under `documents/`, plain segments of letters, digits, `.` `_` `-`
 * (no empty or hidden segment, no `..`, no backslash), at most 300 characters.
 */
export function isSafeDocumentKey(key: string): boolean {
  if (key.length > 300) return false;
  const segments = key.split("/");
  return (
    segments.length >= 2 &&
    segments[0] === "documents" &&
    segments.every((segment) => KEY_SEGMENT.test(segment) && !segment.includes(".."))
  );
}

/** RFC 8187 `ext-value` of a file name (UTF-8, percent-encoded). */
function encodeFilename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition` with the file name in UTF-8 (`filename*=UTF-8''…`). `asciiFallback`
 * adds a plain `filename="…"` for clients that ignore `filename*`.
 */
export function contentDisposition(
  type: "inline" | "attachment",
  filename: string,
  asciiFallback?: string,
): string {
  const fallback = asciiFallback?.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${type};${fallback ? ` filename="${fallback}";` : ""} filename*=UTF-8''${encodeFilename(filename)}`;
}
