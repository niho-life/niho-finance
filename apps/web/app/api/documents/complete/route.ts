import {
  getPrismaClient,
  linkDocument,
  registerDocument,
  replaceDocument,
  runInTransaction,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import {
  assertSameOrigin,
  completeRequestSchema,
  handleApi,
  NO_STORE,
  readJson,
} from "@/lib/documents/api";
import type { CompleteResponse } from "@/lib/documents/api-types";
import { actor } from "@/lib/env";
import { getDocumentStorage } from "@/lib/storage";
import { verifyUploadedFile } from "@/lib/storage/save";

export const dynamic = "force-dynamic";

/**
 * After the browser uploaded the file (13-documents §7): the stored object is checked (size,
 * SHA-256, first bytes), then registered — or registered as the replacement of `supersedesId` —
 * and linked to `link` in the same transaction.
 */
export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const body = await readJson(request, completeRequestSchema);
    await verifyUploadedFile(getDocumentStorage(), {
      key: body.key,
      sha256: body.sha256,
      mime: body.mime,
      byteSize: body.byteSize,
    });
    const by = { actor: actor() };
    const file = {
      storageKey: body.key,
      sha256: body.sha256,
      mime: body.mime,
      byteSize: body.byteSize,
      originalName: body.originalName,
      source: body.source,
    };
    const saved = await runInTransaction(getPrismaClient(), async (tx) => {
      const result = body.supersedesId
        ? await replaceDocument(
            tx,
            { id: body.supersedesId, reason: body.reason, replacement: file },
            by,
          )
        : await registerDocument(
            tx,
            { ...file, kind: body.kind ?? (body.mime === "text/csv" ? "statement" : "receipt") },
            by,
          );
      if (body.link) {
        await linkDocument(tx, { ...body.link, documentId: result.document.id }, by);
      }
      return result;
    });
    revalidatePath("/", "layout");
    const response: CompleteResponse = {
      documentId: saved.document.id,
      duplicate: saved.duplicate,
    };
    return Response.json(response, { headers: NO_STORE });
  });
}
