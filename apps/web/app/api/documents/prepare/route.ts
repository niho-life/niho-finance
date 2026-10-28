import { findDocumentBySha256, getPrismaClient } from "@niho-finance/db";
import {
  assertSameOrigin,
  handleApi,
  NO_STORE,
  prepareRequestSchema,
  readJson,
} from "@/lib/documents/api";
import type { PrepareResponse } from "@/lib/documents/api-types";
import { getDocumentStorage } from "@/lib/storage";
import { newDocumentKey } from "@/lib/storage/keys";

export const dynamic = "force-dynamic";

/**
 * Before an upload (13-documents §7): checks the format, the size and the file name, and either
 * points to the document that already has the same file or issues the upload target.
 */
export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const body = await readJson(request, prepareRequestSchema);
    const existing = await findDocumentBySha256(getPrismaClient(), body.sha256);
    if (existing) {
      const duplicate: PrepareResponse = { kind: "duplicate", documentId: existing.id };
      return Response.json(duplicate, { headers: NO_STORE });
    }
    const key = newDocumentKey(body.mime);
    const target = await getDocumentStorage().createUploadTarget({
      key,
      mime: body.mime,
      byteSize: body.byteSize,
    });
    const upload: PrepareResponse = {
      kind: "upload",
      key,
      url: target.url,
      method: target.method,
      headers: target.headers,
      mime: body.mime,
      expiresAt: target.expiresAt.toISOString(),
    };
    return Response.json(upload, { headers: NO_STORE });
  });
}
