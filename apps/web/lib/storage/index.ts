import { loadRootEnv } from "@niho-finance/db";
import { documentStorageConfig } from "./config";
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

const globalForStorage = globalThis as typeof globalThis & {
  __nihoFinanceDocumentStorage?: DocumentStorage;
};

/**
 * The storage chosen by the environment (`documentStorageConfig`: GCS when
 * `NIHO_FINANCE_DOCUMENTS_BUCKET` is set, a local folder otherwise), one per process. Production
 * (`NIHO_FINANCE_ENV=prod`) refuses the local folder on first use.
 */
export function getDocumentStorage(): DocumentStorage {
  const cached = globalForStorage.__nihoFinanceDocumentStorage;
  if (cached) return cached;
  loadRootEnv();
  const config = documentStorageConfig(process.env);
  const storage =
    config.kind === "gcs"
      ? createGcsDocumentStorage({ bucket: config.bucket })
      : createLocalDocumentStorage();
  globalForStorage.__nihoFinanceDocumentStorage = storage;
  return storage;
}
