import { loadRootEnv } from "@niho-finance/db";
import { z } from "zod";
import { appEnvironment } from "@/lib/env";
import { createGcsDocumentStorage } from "./gcs";
import { createLocalDocumentStorage } from "./local";
import type { DocumentStorage } from "./types";

export {
  FILE_RESPONSE_HEADERS,
  StoredFileExistsError,
  StoredFileNotFoundError,
  StoredFileTooLargeError,
  type DocumentStorage,
  type UploadTarget,
} from "./types";

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const storageEnvironmentSchema = z.object({
  NIHO_FINANCE_STORAGE: z.preprocess(blankToUndefined, z.enum(["local", "gcs"]).default("local")),
  NIHO_FINANCE_GCS_BUCKET: z.preprocess(blankToUndefined, z.string().trim().optional()),
});

const globalForStorage = globalThis as typeof globalThis & {
  __nihoFinanceDocumentStorage?: DocumentStorage;
};

/**
 * The storage chosen by `NIHO_FINANCE_STORAGE` (`local` when unset), one per process. Production
 * (`NIHO_FINANCE_ENV=prod`) refuses `local` on first use: evidence never lives on a container disk.
 */
export function getDocumentStorage(): DocumentStorage {
  const cached = globalForStorage.__nihoFinanceDocumentStorage;
  if (cached) return cached;
  loadRootEnv();
  const environment = storageEnvironmentSchema.parse(process.env);
  let storage: DocumentStorage;
  if (environment.NIHO_FINANCE_STORAGE === "gcs") {
    const bucket = environment.NIHO_FINANCE_GCS_BUCKET;
    if (!bucket) throw new Error("NIHO_FINANCE_STORAGE=gcs needs NIHO_FINANCE_GCS_BUCKET.");
    storage = createGcsDocumentStorage({ bucket });
  } else {
    if (appEnvironment() === "prod") {
      throw new Error(
        "NIHO_FINANCE_ENV=prod needs NIHO_FINANCE_STORAGE=gcs: evidence files are never stored on a local disk in production.",
      );
    }
    storage = createLocalDocumentStorage();
  }
  globalForStorage.__nihoFinanceDocumentStorage = storage;
  return storage;
}
