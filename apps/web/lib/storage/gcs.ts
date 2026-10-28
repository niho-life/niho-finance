import type { Bucket, File } from "@google-cloud/storage";
import { DOCUMENT_MAX_BYTES } from "@niho-finance/ledger";
import { contentDisposition, isSafeDocumentKey } from "./keys";
import {
  FILE_RESPONSE_HEADERS,
  StoredFileExistsError,
  StoredFileNotFoundError,
  StoredFileTooLargeError,
  type DocumentStorage,
  type UploadTarget,
} from "./types";

/**
 * GCS storage for production (`NIHO_FINANCE_STORAGE=gcs`, 13-documents §6). Authentication is ADC
 * (the Cloud Run service account; signing goes through IAM signBlob). The bucket keeps versions and
 * a retention policy, and the service account cannot delete objects (S8). The client library is
 * loaded on first use, so local development never loads it.
 */

/** Signed upload (PUT) URLs: 15 minutes, `Content-Type` fixed. */
const UPLOAD_URL_SECONDS = 15 * 60;
/** Signed download (GET) URLs: 10 minutes. */
const READ_URL_SECONDS = 10 * 60;

export interface GcsDocumentStorageOptions {
  /** `NIHO_FINANCE_GCS_BUCKET` */
  bucket: string;
  now?: () => Date;
  /**
   * The bucket client. Defaults to `new Storage().bucket(bucket)` with ADC, loaded on first use;
   * tests pass a client with fictional credentials (signing works offline).
   */
  bucketClient?: () => Bucket | Promise<Bucket>;
}

/** HTTP status of a GCS API error (404 missing, 412 precondition failed). */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

export function createGcsDocumentStorage(options: GcsDocumentStorageOptions): DocumentStorage {
  const clock = options.now ?? (() => new Date());
  let bucket: Promise<Bucket> | undefined;

  async function fileOf(key: string): Promise<File> {
    if (!isSafeDocumentKey(key)) throw new RangeError(`unsafe document key "${key}"`);
    bucket ??= options.bucketClient
      ? Promise.resolve(options.bucketClient())
      : import("@google-cloud/storage").then(({ Storage }) => new Storage().bucket(options.bucket));
    return (await bucket).file(key);
  }

  async function stat(key: string): Promise<{ byteSize: number } | null> {
    try {
      const [metadata] = await (await fileOf(key)).getMetadata();
      return { byteSize: Number(metadata.size ?? 0) };
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  return {
    kind: "gcs",
    async createUploadTarget({ key, mime }): Promise<UploadTarget> {
      const expiresAt = new Date(clock().getTime() + UPLOAD_URL_SECONDS * 1000);
      const [url] = await (
        await fileOf(key)
      ).getSignedUrl({ version: "v4", action: "write", expires: expiresAt, contentType: mime });
      return { url, method: "PUT", headers: { "Content-Type": mime }, expiresAt };
    },
    stat,
    async read(key): Promise<Uint8Array<ArrayBuffer>> {
      const info = await stat(key);
      if (!info) throw new StoredFileNotFoundError(key);
      if (info.byteSize > DOCUMENT_MAX_BYTES) throw new StoredFileTooLargeError(key);
      const [contents] = await (await fileOf(key)).download();
      return new Uint8Array(contents);
    },
    async write(key, bytes, mime): Promise<void> {
      if (bytes.byteLength > DOCUMENT_MAX_BYTES) throw new StoredFileTooLargeError(key);
      try {
        // Generation 0 = "only if there is no object yet": a stored file is never replaced.
        await (
          await fileOf(key)
        ).save(bytes, {
          contentType: mime,
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
        });
      } catch (error) {
        if (statusOf(error) === 412) throw new StoredFileExistsError(key);
        throw error;
      }
    },
    async fileResponse(key, { mime, filename }): Promise<Response> {
      const [url] = await (
        await fileOf(key)
      ).getSignedUrl({
        version: "v4",
        action: "read",
        expires: clock().getTime() + READ_URL_SECONDS * 1000,
        responseDisposition: contentDisposition("inline", filename),
        responseType: mime,
      });
      return new Response(null, {
        status: 302,
        headers: { ...FILE_RESPONSE_HEADERS, Location: url },
      });
    },
  };
}
