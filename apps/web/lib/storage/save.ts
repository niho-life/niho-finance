import { createHash } from "node:crypto";
import {
  findDocumentBySha256,
  getDocumentDetail,
  registerDocument,
  SettingsError,
  type Db,
  type DocumentDetail,
} from "@niho-finance/db";
import {
  DOCUMENT_MAX_BYTES,
  normalizeDocumentMime,
  type CalendarDate,
  type DocumentKind,
  type DocumentSource,
  type Money,
} from "@niho-finance/ledger";
import { getDocumentStorage } from "./index";
import { newDocumentKey } from "./keys";
import { matchesDeclaredMime, sniffDocumentMime } from "./mime";
import type { DocumentStorage } from "./types";

/** SHA-256 of the bytes, lower-case hex (what `Document.sha256` stores). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const CONTENT_MISMATCH =
  "ファイルの中身が形式と合いません。ファイルを確かめてから選び直してください";

/**
 * Checks a file the browser uploaded against what it declared (13-documents §7 `complete`): the
 * size (`stat`), the SHA-256 and the first bytes (`read`). Throws `SettingsError` (→ 400); the
 * object is left as it is. Returns the bytes.
 */
export async function verifyUploadedFile(
  storage: DocumentStorage,
  expected: { key: string; sha256: string; mime: string; byteSize: number },
): Promise<Uint8Array<ArrayBuffer>> {
  const stored = await storage.stat(expected.key);
  if (!stored) {
    throw new SettingsError("送信したファイルが見つかりません。もう一度アップロードしてください");
  }
  if (stored.byteSize !== expected.byteSize) {
    throw new SettingsError(
      "送信したファイルの大きさが合いません。もう一度アップロードしてください",
    );
  }
  const bytes = await storage.read(expected.key);
  if (sha256Hex(bytes) !== expected.sha256.toLowerCase()) {
    throw new SettingsError(
      "送信したファイルの中身が選んだファイルと合いません。もう一度アップロードしてください",
    );
  }
  if (!matchesDeclaredMime(expected.mime, sniffDocumentMime(bytes))) {
    throw new SettingsError(CONTENT_MISMATCH);
  }
  return bytes;
}

export interface SaveBytesAsDocumentInput {
  bytes: Uint8Array;
  /** The declared type (e.g. `text/csv`); normalized with the file name, then checked against the bytes. */
  mime: string;
  originalName?: string | null;
  /** Defaults to 領収書. */
  kind?: DocumentKind;
  source: DocumentSource;
  txnDate?: CalendarDate | null;
  amount?: Money | null;
  partnerId?: string | null;
  partnerName?: string | null;
  invoiceRegistrationNumber?: string | null;
  note?: string | null;
}

export interface SavedDocument {
  documentId: string;
  /** `true`: the same file was already stored; nothing was written. */
  duplicate: boolean;
  document: DocumentDetail;
}

/**
 * Stores bytes the server holds as a document (13 §9: the CSV of an import, a generated PDF):
 * checks the format, writes the file under a new key, then `registerDocument`. When a document
 * with the same file exists, nothing is written and that one is returned.
 */
export async function saveBytesAsDocument(
  db: Db,
  input: SaveBytesAsDocumentInput,
  options: { actor: string; storage?: DocumentStorage; now?: Date },
): Promise<SavedDocument> {
  const { bytes, mime: declared, ...items } = input;
  const mime = normalizeDocumentMime(declared, input.originalName);
  if (mime === null) {
    throw new SettingsError(
      "この形式のファイルは保存できません。画像（JPEG・PNG・WebP・HEIC）・PDF・CSV を選んでください",
    );
  }
  if (bytes.byteLength === 0) {
    throw new SettingsError("空のファイルは保存できません。中身のあるファイルを選んでください");
  }
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) {
    throw new SettingsError("ファイルは 20 MB までです。小さくしてから選び直してください");
  }
  if (!matchesDeclaredMime(mime, sniffDocumentMime(bytes))) {
    throw new SettingsError(CONTENT_MISMATCH);
  }
  const sha256 = sha256Hex(bytes);
  const existing = await findDocumentBySha256(db, sha256);
  if (existing) {
    const document = await getDocumentDetail(db, existing.id);
    if (document) return { documentId: document.id, duplicate: true, document };
  }

  const storage = options.storage ?? getDocumentStorage();
  const key = newDocumentKey(mime, options.now);
  await storage.write(key, bytes, mime);
  const { document, duplicate } = await registerDocument(
    db,
    { ...items, storageKey: key, sha256, mime, byteSize: bytes.byteLength },
    { actor: options.actor },
  );
  return { documentId: document.id, duplicate, document };
}
