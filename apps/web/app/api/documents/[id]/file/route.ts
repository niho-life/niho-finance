import { getDocumentFile, getPrismaClient } from "@niho-finance/db";
import { extensionForMime } from "@niho-finance/ledger";
import { handleApi, jsonError } from "@/lib/documents/api";
import { getDocumentStorage, StoredFileNotFoundError } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * The file of a document (voided ones too): a redirect to a signed URL (GCS) or the bytes (local),
 * never cached, `inline` with the original file name.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(async () => {
    const { id } = await context.params;
    const file = await getDocumentFile(getPrismaClient(), id);
    if (!file) return jsonError(404, "証憑が見つかりません。画面を読み込み直してください");
    const filename = file.originalName ?? `${file.id}.${extensionForMime(file.mime) ?? "bin"}`;
    try {
      return await getDocumentStorage().fileResponse(file.storageKey, {
        mime: file.mime,
        filename,
      });
    } catch (error) {
      if (error instanceof StoredFileNotFoundError) {
        return jsonError(404, "ファイルが見つかりません。保存先を確かめてください");
      }
      throw error;
    }
  });
}
