import { getDocumentFile, getInvoiceDetail, todayInJapan } from "@niho-finance/db";
import { db } from "@/lib/data";
import { contentDisposition, pdfResponse } from "@/lib/pdf/download";
import { invoicePdfFileNames, renderInvoicePdf } from "@/lib/pdf/invoice";
import { getDocumentStorage, StoredFileNotFoundError } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound(): Response {
  return new Response("書類が見つかりません", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * 書類の PDF (18 §9, §11): shown in the browser (プレビューは PDF そのもの), or saved with
 * `?download=1`. An issued document whose PDF was kept as a 証憑 returns that copy as it was
 * stored; a draft, a void document (marked as such) or one without the copy is drawn from the
 * stored document, which an issued one never changes.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/invoices/[id]/pdf">,
): Promise<Response> {
  const { id } = await params;
  if (id.length > 64) return notFound();
  const prisma = await db();
  const detail = await getInvoiceDetail(prisma, id, { today: todayInJapan() });
  if (!detail) return notFound();
  const { fileName, utf8FileName } = invoicePdfFileNames(detail);

  let bytes: Uint8Array | null = null;
  if (detail.pdfDocumentId && detail.status !== "void") {
    const file = await getDocumentFile(prisma, detail.pdfDocumentId);
    if (file) {
      try {
        bytes = await getDocumentStorage().read(file.storageKey);
      } catch (error) {
        // The copy's file is missing from the storage: draw it again rather than fail.
        if (!(error instanceof StoredFileNotFoundError)) throw error;
        console.error("[niho-finance] the stored PDF of an invoice is missing", error);
      }
    }
  }
  bytes ??= await renderInvoicePdf(detail);

  const response = pdfResponse(bytes, fileName, utf8FileName);
  if (new URL(request.url).searchParams.get("download") !== "1") {
    response.headers.set(
      "content-disposition",
      contentDisposition(fileName, utf8FileName).replace(/^attachment/, "inline"),
    );
  }
  return response;
}
