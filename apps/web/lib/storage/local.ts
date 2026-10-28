import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { findRepoRoot } from "@niho-finance/db";
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
 * Local storage for development (`NIHO_FINANCE_STORAGE=local`, 13-documents §6): files live in a
 * folder, and the browser uploads to `PUT /api/documents/upload` with a signed, expiring URL (the
 * local stand-in for a GCS signed URL). Never used in production (`index.ts` refuses it).
 */

/** The upload endpoint of the local storage. */
export const LOCAL_UPLOAD_PATH = "/api/documents/upload";
/** Upload URLs are valid for 15 minutes, like GCS's. */
export const UPLOAD_URL_SECONDS = 15 * 60;

export interface UploadTokenFields {
  key: string;
  mime: string;
  /** Bytes. */
  size: number;
  /** Expiry, Unix seconds. */
  exp: number;
}

/** HMAC-SHA256 (hex) of `key\nmime\nsize\nexp`. */
export function signUploadToken(fields: UploadTokenFields, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${fields.key}\n${fields.mime}\n${fields.size}\n${fields.exp}`)
    .digest("hex");
}

export type UploadTokenCheck =
  { ok: true; fields: UploadTokenFields } | { ok: false; reason: "invalid" | "expired" };

/**
 * Checks the query of an upload URL (`key` `mime` `size` `exp` `sig`): the signature first, then
 * the expiry and the shape of the key.
 */
export function verifyUploadToken(
  params: URLSearchParams,
  secret: string,
  now: Date = new Date(),
): UploadTokenCheck {
  const key = params.get("key");
  const mime = params.get("mime");
  const size = params.get("size");
  const exp = params.get("exp");
  const sig = params.get("sig");
  if (!key || !mime || !size || !exp || !sig) return { ok: false, reason: "invalid" };
  if (!/^\d{1,12}$/.test(size) || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) {
    return { ok: false, reason: "invalid" };
  }
  const fields: UploadTokenFields = { key, mime, size: Number(size), exp: Number(exp) };
  const expected = Buffer.from(signUploadToken(fields, secret), "hex");
  if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) return { ok: false, reason: "invalid" };
  if (!isSafeDocumentKey(key)) return { ok: false, reason: "invalid" };
  if (fields.exp * 1000 < now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, fields };
}

const globalForUpload = globalThis as typeof globalThis & { __nihoFinanceUploadSecret?: string };

/** `NIHO_FINANCE_UPLOAD_SECRET`, or a random key per process (kept across dev reloads). */
export function uploadSecret(): string {
  const configured = process.env.NIHO_FINANCE_UPLOAD_SECRET?.trim();
  if (configured) return configured;
  globalForUpload.__nihoFinanceUploadSecret ??= randomBytes(32).toString("hex");
  return globalForUpload.__nihoFinanceUploadSecret;
}

/** `NIHO_FINANCE_STORAGE_DIR`, by default `<repo root>/tmp/documents` (`tmp/` is git-ignored). */
export function localStorageDir(): string {
  // Local development only: keep these paths out of Next.js output file tracing.
  const configured = process.env.NIHO_FINANCE_STORAGE_DIR?.trim();
  if (configured) return path.resolve(/* turbopackIgnore: true */ configured);
  const root = findRepoRoot() ?? process.cwd();
  return path.join(/* turbopackIgnore: true */ root, "tmp", "documents");
}

export interface LocalDocumentStorage extends DocumentStorage {
  readonly kind: "local";
  readonly rootDir: string;
  /** `verifyUploadToken` with this storage's secret. */
  verifyUpload(params: URLSearchParams, now?: Date): UploadTokenCheck;
}

export interface LocalDocumentStorageOptions {
  /** Defaults to `localStorageDir()`. */
  rootDir?: string;
  /** Defaults to `uploadSecret()`. */
  secret?: string;
  now?: () => Date;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export function isLocalDocumentStorage(storage: DocumentStorage): storage is LocalDocumentStorage {
  return storage.kind === "local" && "verifyUpload" in storage;
}

export function createLocalDocumentStorage(
  options: LocalDocumentStorageOptions = {},
): LocalDocumentStorage {
  const rootDir = path.resolve(/* turbopackIgnore: true */ options.rootDir ?? localStorageDir());
  const secret = options.secret ?? uploadSecret();
  const clock = options.now ?? (() => new Date());

  /** The file of a key, refusing anything that is not a plain key under the root. */
  function fileOf(key: string): string {
    if (!isSafeDocumentKey(key)) throw new RangeError(`unsafe document key "${key}"`);
    const file = path.resolve(/* turbopackIgnore: true */ rootDir, ...key.split("/"));
    if (!file.startsWith(`${rootDir}${path.sep}`)) {
      throw new RangeError(`document key "${key}" leaves the storage folder`);
    }
    return file;
  }

  async function stat(key: string): Promise<{ byteSize: number } | null> {
    try {
      const info = await lstat(fileOf(key));
      return info.isFile() ? { byteSize: info.size } : null;
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
      throw error;
    }
  }

  async function read(key: string): Promise<Uint8Array<ArrayBuffer>> {
    const info = await stat(key);
    if (!info) throw new StoredFileNotFoundError(key);
    if (info.byteSize > DOCUMENT_MAX_BYTES) throw new StoredFileTooLargeError(key);
    return new Uint8Array(await readFile(fileOf(key)));
  }

  async function write(key: string, bytes: Uint8Array, _mime: string): Promise<void> {
    if (bytes.byteLength > DOCUMENT_MAX_BYTES) throw new StoredFileTooLargeError(key);
    const file = fileOf(key);
    const dir = path.dirname(file);
    await mkdir(dir, { recursive: true });
    // Written in full under a temporary name first; a hard link then publishes it atomically and,
    // unlike rename, fails when the key exists (a stored file is never replaced).
    const temporary = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await link(temporary, file);
    } catch (error) {
      if (isErrno(error, "EEXIST")) throw new StoredFileExistsError(key);
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  return {
    kind: "local",
    rootDir,
    createUploadTarget({ key, mime, byteSize }): Promise<UploadTarget> {
      // A rejected promise (not a synchronous throw) for an unsafe key, like the GCS storage.
      return Promise.resolve().then(() => {
        fileOf(key);
        const exp = Math.floor(clock().getTime() / 1000) + UPLOAD_URL_SECONDS;
        const fields: UploadTokenFields = { key, mime, size: byteSize, exp };
        const query = new URLSearchParams({
          key,
          mime,
          size: String(byteSize),
          exp: String(exp),
          sig: signUploadToken(fields, secret),
        });
        return {
          url: `${LOCAL_UPLOAD_PATH}?${query.toString()}`,
          method: "PUT" as const,
          headers: { "Content-Type": mime },
          expiresAt: new Date(exp * 1000),
        };
      });
    },
    stat,
    read,
    write,
    async fileResponse(key, { mime, filename }): Promise<Response> {
      const bytes = await read(key);
      return new Response(bytes, {
        status: 200,
        headers: {
          ...FILE_RESPONSE_HEADERS,
          "Content-Type": mime,
          "Content-Length": String(bytes.byteLength),
          "Content-Disposition": contentDisposition("inline", filename),
        },
      });
    },
    verifyUpload(params, now) {
      return verifyUploadToken(params, secret, now ?? clock());
    },
  };
}
