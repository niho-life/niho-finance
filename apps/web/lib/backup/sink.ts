import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Storage, type Bucket } from "@google-cloud/storage";
import { appEnv, type AppEnv } from "../env";

/** Where the daily export is written. Paths are relative (`exports/<date>/<time>Z/<file>`). */
export interface BackupSink {
  write(path: string, body: Buffer | string, contentType: string): Promise<void>;
  /** `gs://<bucket>` or the local folder. */
  describe(): string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The backup bucket (Cloud Run: application default credentials). Objects are never replaced. */
export class GcsBackupSink implements BackupSink {
  private readonly bucket: Bucket;
  private credentials: Promise<unknown> | undefined;

  constructor(
    private readonly bucketName: string,
    private readonly storage: Storage = new Storage(),
  ) {
    this.bucket = storage.bucket(bucketName);
  }

  async write(objectPath: string, body: Buffer | string, contentType: string): Promise<void> {
    // `save` reports missing credentials only as "Cannot call write after a stream was
    // destroyed": get a token first, so that the job log says what is wrong.
    this.credentials ??= this.storage.authClient.getAccessToken();
    try {
      await this.credentials;
    } catch (error) {
      throw new Error(`GCS の認証情報を取得できません: ${errorMessage(error)}`, { cause: error });
    }
    try {
      // ifGenerationMatch 0: only create (an existing object is an error), which also makes the
      // upload safe for the client library to retry.
      await this.bucket.file(objectPath).save(body, {
        contentType,
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (error) {
      throw new Error(
        `${this.describe()}/${objectPath} に書けませんでした: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  describe(): string {
    return `gs://${this.bucketName}`;
  }
}

/** A local folder (development). Files are never replaced. */
export class LocalBackupSink implements BackupSink {
  constructor(private readonly dir: string) {}

  async write(filePath: string, body: Buffer | string): Promise<void> {
    const root = path.resolve(/* turbopackIgnore: true */ this.dir);
    const target = path.resolve(/* turbopackIgnore: true */ root, filePath);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`backup path ${filePath} is outside ${this.dir}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, { flag: "wx" });
  }

  describe(): string {
    return this.dir;
  }
}

/** `NIHO_FINANCE_BACKUP_BUCKET`, else `NIHO_FINANCE_BACKUP_DIR`. */
export function backupSinkFromEnv(
  env: Pick<AppEnv, "NIHO_FINANCE_BACKUP_BUCKET" | "NIHO_FINANCE_BACKUP_DIR"> = appEnv(),
): BackupSink {
  if (env.NIHO_FINANCE_BACKUP_BUCKET) return new GcsBackupSink(env.NIHO_FINANCE_BACKUP_BUCKET);
  if (env.NIHO_FINANCE_BACKUP_DIR) return new LocalBackupSink(env.NIHO_FINANCE_BACKUP_DIR);
  throw new Error(
    "バックアップの書き先がありません。NIHO_FINANCE_BACKUP_BUCKET（GCS）か NIHO_FINANCE_BACKUP_DIR（ローカル）を設定してください",
  );
}
