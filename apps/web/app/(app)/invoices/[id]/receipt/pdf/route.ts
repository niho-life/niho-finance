import { getDocumentFile, getReceiptPdfData } from "@niho-finance/db";
import { authorizeRoute } from "@/lib/authz";
import { db } from "@/lib/data";
import { contentDisposition, pdfResponse } from "@/lib/pdf/download";
import { receiptPdfFileNames, renderReceiptPdf } from "@/lib/pdf/receipt";
import { getDocumentStorage, StoredFileNotFoundError } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound(): Response {
  return new Response("領収書が見つかりません", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * 領収書の PDF (18 §15.2, §15.3): the invoice's receipt in force (`?receipt=<id>` for a void one),
 * shown in the browser or saved with `?download=1`. A receipt whose PDF was kept as a 証憑 returns
 * that copy as it was stored; a void one is drawn again with 無効 and the reason on top.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/invoices/[id]/receipt/pdf">,
): Promise<Response> {
  const denied = await authorizeRoute("accountant");
  if (denied) return denied;
  const { id } = await params;
  const search = new URL(request.url).searchParams;
  const receiptId = search.get("receipt");
  if (id.length > 64 || (receiptId !== null && receiptId.length > 64)) return notFound();
  const prisma = await db();
  const data = await getReceiptPdfData(prisma, id, { receiptId });
  if (!data) return notFound();
  const { fileName, utf8FileName } = receiptPdfFileNames(data);

  let bytes: Uint8Array | null = null;
  if (data.receipt.pdfDocumentId && !data.receipt.voided) {
    const file = await getDocumentFile(prisma, data.receipt.pdfDocumentId);
    if (file) {
      try {
        bytes = await getDocumentStorage().read(file.storageKey);
      } catch (error) {
        // The copy's file is missing from the storage: draw it again rather than fail.
        if (!(error instanceof StoredFileNotFoundError)) throw error;
        console.error("[niho-finance] the stored PDF of a receipt is missing", error);
      }
    }
  }
  bytes ??= await renderReceiptPdf(data);

  const response = pdfResponse(bytes, fileName, utf8FileName);
  if (search.get("download") !== "1") {
    response.headers.set(
      "content-disposition",
      contentDisposition(fileName, utf8FileName).replace(/^attachment/, "inline"),
    );
  }
  return response;
}
