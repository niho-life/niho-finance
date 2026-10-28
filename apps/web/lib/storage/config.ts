import { z } from "zod";

/*
 * Which storage keeps the evidence files (13-documents §6), from the environment. Pure, so that
 * the choice can be tested without touching a disk or GCS.
 */

export type DocumentStorageConfig = { kind: "local" } | { kind: "gcs"; bucket: string };

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const storageEnvironmentSchema = z.object({
  /** `local` / `gcs`. Unset: `gcs` when a documents bucket is set, `local` otherwise. */
  NIHO_FINANCE_STORAGE: z.preprocess(blankToUndefined, z.enum(["local", "gcs"]).optional()),
  /** The evidence bucket; `scripts/deploy.sh` (S8) sets it on Cloud Run. */
  NIHO_FINANCE_DOCUMENTS_BUCKET: z.preprocess(blankToUndefined, z.string().trim().optional()),
  NIHO_FINANCE_ENV: z.preprocess(blankToUndefined, z.string().optional()),
});

/**
 * The storage for `env`. Throws when GCS has no bucket, and in production
 * (`NIHO_FINANCE_ENV=prod`) for a local folder: evidence never lives on a container disk.
 */
export function documentStorageConfig(
  env: Readonly<Record<string, string | undefined>>,
): DocumentStorageConfig {
  const parsed = storageEnvironmentSchema.parse(env);
  const bucket = parsed.NIHO_FINANCE_DOCUMENTS_BUCKET;
  const kind = parsed.NIHO_FINANCE_STORAGE ?? (bucket ? "gcs" : "local");
  if (kind === "gcs") {
    if (!bucket) throw new Error("NIHO_FINANCE_STORAGE=gcs needs NIHO_FINANCE_DOCUMENTS_BUCKET.");
    return { kind, bucket };
  }
  if (parsed.NIHO_FINANCE_ENV === "prod") {
    throw new Error(
      "NIHO_FINANCE_ENV=prod stores evidence files in GCS: set NIHO_FINANCE_DOCUMENTS_BUCKET (and leave NIHO_FINANCE_STORAGE unset or gcs).",
    );
  }
  return { kind };
}
