import {
  getPrismaClient,
  performDocumentReading,
  SettingsError,
  todayInJapan,
  type DocumentReadingResult,
} from "@niho-finance/db";
import { ReaderError } from "@niho-finance/reader";
import { getDocumentStorage, StoredFileNotFoundError } from "@/lib/storage";
import { getNtaLookup, getReader } from "./config";

const NOT_CONFIGURED = "読み取りは設定されていません";
const FILE_MISSING =
  "証憑のファイルが見つかりません。画面を読み込み直しても続くときは、差し替えてください";

/**
 * 読み取る (20-reader §5.1) as `actor`: the stored file goes to the provider and the number to the
 * registry (when the application ID is set); the proposal is stored on the document. A failed
 * reading is stored too and comes back as `status: "failed"`; what stops before the provider
 * (not configured, voided, unreadable format, missing file) throws a `SettingsError`.
 */
export async function readDocumentForActor(
  documentId: string,
  actor: string,
): Promise<DocumentReadingResult> {
  let reader;
  try {
    reader = getReader();
  } catch (error) {
    // A recorded provider whose file cannot be read (development only).
    if (error instanceof ReaderError) throw new SettingsError(error.message);
    throw error;
  }
  if (!reader) throw new SettingsError(NOT_CONFIGURED);
  const storage = getDocumentStorage();
  try {
    return await performDocumentReading(
      getPrismaClient(),
      {
        reader,
        readFile: (key) => storage.read(key),
        registry: getNtaLookup(),
        today: todayInJapan(),
      },
      { documentId },
      { actor },
    );
  } catch (error) {
    if (error instanceof StoredFileNotFoundError) throw new SettingsError(FILE_MISSING);
    throw error;
  }
}
