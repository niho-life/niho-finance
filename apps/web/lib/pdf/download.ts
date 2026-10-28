/**
 * Responses that the browser saves as a file (14-reports §1, §12): `Content-Disposition:
 * attachment` with an ASCII `filename` and the UTF-8 `filename*` (RFC 6266), never cached.
 */
export const ZIP_CONTENT_TYPE = "application/zip";
export const PDF_CONTENT_TYPE = "application/pdf";

/** Non-ASCII and unsafe characters become `_` (the fallback name for old clients). */
export function asciiFileName(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\/;]/g, "_");
  return ascii.trim() === "" ? "download" : ascii;
}

export function contentDisposition(fileName: string, utf8FileName: string = fileName): string {
  return `attachment; filename="${asciiFileName(fileName)}"; filename*=UTF-8''${encodeURIComponent(utf8FileName)}`;
}

export interface DownloadOptions {
  /** The ASCII file name (e.g. `trial-balance_20261102-20270331.pdf`). */
  fileName: string;
  /** A UTF-8 name for clients that read `filename*` (defaults to `fileName`). */
  utf8FileName?: string | undefined;
  contentType: string;
}

export function downloadResponse(body: Uint8Array | string, options: DownloadOptions): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    status: 200,
    headers: {
      "content-type": options.contentType,
      "content-disposition": contentDisposition(options.fileName, options.utf8FileName),
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function pdfResponse(bytes: Uint8Array, fileName: string, utf8FileName?: string): Response {
  return downloadResponse(bytes, { fileName, utf8FileName, contentType: PDF_CONTENT_TYPE });
}

/** `contentType` comes from `CSV_CONTENT_TYPES` of `@niho-finance/reports` (UTF-8 / Shift_JIS). */
export function csvResponse(bytes: Uint8Array, fileName: string, contentType: string): Response {
  return downloadResponse(bytes, { fileName, contentType });
}

export function zipResponse(bytes: Uint8Array, fileName: string): Response {
  return downloadResponse(bytes, { fileName, contentType: ZIP_CONTENT_TYPE });
}

export function textResponse(text: string, fileName: string, contentType: string): Response {
  return downloadResponse(text, { fileName, contentType });
}
