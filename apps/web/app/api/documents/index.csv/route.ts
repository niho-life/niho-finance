import {
  documentSearchSchema,
  exportDocumentIndex,
  getPrismaClient,
  todayInJapan,
} from "@niho-finance/db";
import { DOCUMENT_INDEX_COLUMNS, documentIndexCells, toCsv } from "@niho-finance/ledger";
import { assertSameOrigin, handleApi } from "@/lib/documents/api";
import { actor } from "@/lib/actor";
import { contentDisposition } from "@/lib/storage/keys";

export const dynamic = "force-dynamic";

/**
 * The index of the documents (索引簿, 13-documents §7) for the list's search conditions (`tab`
 * defaults to all): UTF-8 CSV with a BOM and CRLF. Recorded as `document.export`.
 */
export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const filters = documentSearchSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const rows = await exportDocumentIndex(getPrismaClient(), filters, { actor: await actor() });
    const csv = toCsv([DOCUMENT_INDEX_COLUMNS, ...rows.map(documentIndexCells)]);
    const day = todayInJapan().replaceAll("-", "");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": contentDisposition(
          "attachment",
          `証憑索引簿_${day}.csv`,
          `documents-index-${day}.csv`,
        ),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
