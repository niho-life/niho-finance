import {
  ApiError,
  assertSameOrigin,
  handleApi,
  jsonError,
  NO_STORE,
  readBodyBytes,
} from "@/lib/documents/api";
import { getDocumentStorage, StoredFileExistsError } from "@/lib/storage";
import { isLocalDocumentStorage } from "@/lib/storage/local";

export const dynamic = "force-dynamic";

/**
 * The upload endpoint of the local storage (no documents bucket set; 404 with GCS): the
 * stand-in for a GCS signed URL. The query is signed (key, type, size, expiry); an existing key is
 * never written again.
 */
export async function PUT(request: Request): Promise<Response> {
  return handleApi(async () => {
    const storage = getDocumentStorage();
    if (!isLocalDocumentStorage(storage)) return jsonError(404, "見つかりません");
    assertSameOrigin(request);
    const check = storage.verifyUpload(new URL(request.url).searchParams);
    if (!check.ok) {
      throw new ApiError(
        403,
        check.reason === "expired"
          ? "送信の期限が切れました。もう一度アップロードしてください"
          : "送信先が正しくありません。もう一度アップロードしてください",
      );
    }
    const { key, mime, size } = check.fields;
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== mime) {
      throw new ApiError(415, "送信の形式が正しくありません。もう一度アップロードしてください");
    }
    const bytes = await readBodyBytes(request, size);
    if (!bytes || bytes.byteLength !== size) {
      throw new ApiError(
        400,
        "送信したファイルの大きさが合いません。もう一度アップロードしてください",
      );
    }
    try {
      await storage.write(key, bytes, mime);
    } catch (error) {
      if (error instanceof StoredFileExistsError) {
        throw new ApiError(409, "このファイルは送信済みです。画面を読み込み直してください");
      }
      throw error;
    }
    return new Response(null, { status: 200, headers: NO_STORE });
  });
}
