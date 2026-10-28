import { attachImportBatchDocument, type Db } from "@niho-finance/db";
import { saveBytesAsDocument } from "@/lib/storage/save";

/**
 * Keeps the CSV an import read as evidence (13-documents §9, 12-imports §308): the file becomes a
 * 明細書 document and the batch points at it (`ImportBatch.documentId`, its `fileBytes` dropped).
 * The same file already stored is reused. Best effort: the import has already succeeded, so a
 * failure is logged and the batch keeps its bytes — nothing is lost. Returns the document's id.
 */
export async function keepImportFileAsDocument(
  db: Db,
  input: { batchId: string; bytes: Uint8Array; fileName: string | null },
  options: { actor: string },
): Promise<string | null> {
  try {
    const saved = await saveBytesAsDocument(
      db,
      {
        bytes: input.bytes,
        mime: "text/csv",
        originalName: input.fileName,
        kind: "statement",
        source: "upload",
      },
      options,
    );
    await attachImportBatchDocument(
      db,
      { batchId: input.batchId, documentId: saved.documentId },
      options,
    );
    return saved.documentId;
  } catch (error) {
    console.error("[niho-finance] the imported file was not kept as a document", error);
    return null;
  }
}
