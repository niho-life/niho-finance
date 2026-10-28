import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { finished } from "node:stream/promises";
import type { Writable } from "node:stream";
import { appEnv, type AppEnv } from "../env";
import { downloadResponse, ZIP_CONTENT_TYPE, contentDisposition } from "../pdf/download";

/*
 * Where the jobs put 受け渡しパッケージ (14-reports §15.4): the backup bucket under `packages/`
 * (kept under its retention policy; the runtime can create and read, not replace or delete), or the
 * local backup folder in development. The zip is written as a stream, never whole in memory, and
 * handed out as a 10-minute V4 signed URL (GCS) or as the bytes (local).
 */

/** Signed download URLs live 10 minutes (§15.4). */
const SIGNED_URL_SECONDS = 10 * 60;

export interface PackageWriter {
  write(chunk: Uint8Array): Promise<void>;
  /** Resolves once the object is complete in the store. */
  close(): Promise<void>;
  /** Drops a partial object (local) or the upload (GCS). */
  abort(error: unknown): Promise<void>;
}

export interface PackageStore {
  readonly kind: "gcs" | "local";
  openWriter(key: string): Promise<PackageWriter>;
  /** The download of a stored package: a 302 to a signed URL (GCS) or the bytes (local). */
  downloadResponse(key: string, fileName: string): Promise<Response>;
  /** `gs://<bucket>` or the folder. */
  describe(): string;
}

const JST_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** `packages/20270510-140312_fy1_<requestId>.zip` (作成日時 in JST). */
export function packageKey(createdAt: Date, fiscalYearNo: number, requestId: string): string {
  const parts = Object.fromEntries(
    JST_PARTS.formatToParts(createdAt).map((part) => [part.type, part.value]),
  );
  const stamp = `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
  return `packages/${stamp}_fy${fiscalYearNo}_${requestId}.zip`;
}

const KEY_PATTERN = /^packages\/[0-9]{8}-[0-9]{6}_fy[0-9]{1,4}_[0-9A-Za-z]{1,64}\.zip$/;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new RangeError(`not a package key: ${key}`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** `write` with backpressure: waits for `drain` (or the stream's error) when the buffer is full. */
function chunkWriter(stream: Writable): (chunk: Uint8Array) => Promise<void> {
  let failure: unknown = null;
  stream.on("error", (error) => {
    failure = error;
  });
  return async (chunk) => {
    if (failure) throw asError(failure);
    if (stream.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        stream.off("error", onError);
        resolve();
      };
      const onError = (error: unknown) => {
        stream.off("drain", onDrain);
        reject(asError(error));
      };
      stream.once("drain", onDrain);
      stream.once("error", onError);
    });
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The backup bucket. The client library is loaded on first use. */
export function createGcsPackageStore(bucketName: string): PackageStore {
  const bucket = import("@google-cloud/storage").then(({ Storage }) =>
    new Storage().bucket(bucketName),
  );
  return {
    kind: "gcs",
    async openWriter(key) {
      assertKey(key);
      const file = (await bucket).file(key);
      // ifGenerationMatch 0: create only (a stored package is never replaced).
      const stream = file.createWriteStream({
        contentType: ZIP_CONTENT_TYPE,
        resumable: true,
        validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { contentDisposition: contentDisposition(path.basename(key)) },
      });
      const done = finished(stream);
      done.catch(() => undefined);
      return {
        write: chunkWriter(stream),
        async close() {
          stream.end();
          try {
            await done;
          } catch (error) {
            throw new Error(
              `gs://${bucketName}/${key} に書けませんでした: ${errorMessage(error)}`,
              {
                cause: error,
              },
            );
          }
        },
        async abort(error) {
          stream.destroy(error instanceof Error ? error : new Error(String(error)));
          await done.catch(() => undefined);
        },
      };
    },
    async downloadResponse(key, fileName) {
      assertKey(key);
      const [url] = await (await bucket).file(key).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + SIGNED_URL_SECONDS * 1000,
        responseDisposition: contentDisposition(fileName),
        responseType: ZIP_CONTENT_TYPE,
      });
      return new Response(null, {
        status: 302,
        headers: { location: url, "cache-control": "no-store" },
      });
    },
    describe: () => `gs://${bucketName}`,
  };
}

/** A local folder (development). Files are never replaced. */
export function createLocalPackageStore(dir: string): PackageStore {
  const resolve = (key: string): string => {
    assertKey(key);
    const root = path.resolve(/* turbopackIgnore: true */ dir);
    const target = path.resolve(/* turbopackIgnore: true */ root, key);
    if (!target.startsWith(`${root}${path.sep}`)) throw new RangeError(`${key} is outside ${dir}`);
    return target;
  };
  return {
    kind: "local",
    async openWriter(key) {
      const target = resolve(key);
      await mkdir(path.dirname(target), { recursive: true });
      const stream: WriteStream = createWriteStream(target, { flags: "wx" });
      const done = finished(stream);
      done.catch(() => undefined);
      // An existing file (wx) fails here, before anything is written.
      await once(stream, "open");
      return {
        write: chunkWriter(stream),
        async close() {
          stream.end();
          await done;
        },
        async abort(error) {
          stream.destroy(error instanceof Error ? error : new Error(String(error)));
          await done.catch(() => undefined);
          await rm(target, { force: true });
        },
      };
    },
    async downloadResponse(key, fileName) {
      const bytes = await readFile(resolve(key));
      return downloadResponse(new Uint8Array(bytes), { fileName, contentType: ZIP_CONTENT_TYPE });
    },
    describe: () => dir,
  };
}

/** `NIHO_FINANCE_BACKUP_BUCKET`, else `NIHO_FINANCE_BACKUP_DIR` (the same targets as the backup). */
export function packageStoreFromEnv(
  env: Pick<AppEnv, "NIHO_FINANCE_BACKUP_BUCKET" | "NIHO_FINANCE_BACKUP_DIR"> = appEnv(),
): PackageStore {
  if (env.NIHO_FINANCE_BACKUP_BUCKET) return createGcsPackageStore(env.NIHO_FINANCE_BACKUP_BUCKET);
  if (env.NIHO_FINANCE_BACKUP_DIR) return createLocalPackageStore(env.NIHO_FINANCE_BACKUP_DIR);
  throw new Error(
    "受け渡しパッケージの置き場所がありません。NIHO_FINANCE_BACKUP_BUCKET（GCS）か NIHO_FINANCE_BACKUP_DIR（ローカル）を設定してください",
  );
}
