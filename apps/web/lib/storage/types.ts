/**
 * The storage of evidence files (13-documents §6): GCS in production, a local folder in
 * development. Files are only ever added: there is no delete, and an existing key is never
 * overwritten. Server-only.
 */

/** Where the browser sends a file: GCS's signed URL, or the local endpoint. */
export interface UploadTarget {
  url: string;
  method: "PUT";
  /** Headers the browser must send as they are (the signature covers `Content-Type`). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DocumentStorage {
  /** `local` (a folder; development) or `gcs` (production). */
  readonly kind: "local" | "gcs";
  /** A short-lived URL the browser uploads the file to with `PUT`. */
  createUploadTarget(input: { key: string; mime: string; byteSize: number }): Promise<UploadTarget>;
  /** The stored size, or `null` when nothing is stored under the key. */
  stat(key: string): Promise<{ byteSize: number } | null>;
  /** The whole file (at most `DOCUMENT_MAX_BYTES`). Throws `StoredFileNotFoundError`. */
  read(key: string): Promise<Uint8Array<ArrayBuffer>>;
  /** Stores a file from the server (imported CSV, generated PDF). Throws `StoredFileExistsError`. */
  write(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  /** The file for the browser: a redirect to a signed URL (GCS) or the bytes (local). */
  fileResponse(key: string, options: { mime: string; filename: string }): Promise<Response>;
}

/** Headers of every file response: never cached, never sniffed as another type. */
export const FILE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export class StoredFileNotFoundError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`no stored file under ${key}`);
    this.name = "StoredFileNotFoundError";
    this.key = key;
  }
}

export class StoredFileExistsError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`a file is already stored under ${key}`);
    this.name = "StoredFileExistsError";
    this.key = key;
  }
}

export class StoredFileTooLargeError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`the file under ${key} is larger than the limit`);
    this.name = "StoredFileTooLargeError";
    this.key = key;
  }
}
