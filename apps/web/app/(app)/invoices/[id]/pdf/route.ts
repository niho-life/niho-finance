import { getInvoiceDetail, todayInJapan } from "@niho-finance/db";
import { db } from "@/lib/data";
import { contentDisposition, pdfResponse } from "@/lib/pdf/download";
import { invoicePdfFileNames, renderInvoicePdf } from "@/lib/pdf/invoice";

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
 * `?download=1`. Drawn from the stored document: an issued one comes out the same every time.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/invoices/[id]/pdf">,
): Promise<Response> {
  const { id } = await params;
  if (id.length > 64) return notFound();
  const detail = await getInvoiceDetail(await db(), id, { today: todayInJapan() });
  if (!detail) return notFound();
  const bytes = await renderInvoicePdf(detail);
  const { fileName, utf8FileName } = invoicePdfFileNames(detail);
  const response = pdfResponse(bytes, fileName, utf8FileName);
  if (new URL(request.url).searchParams.get("download") !== "1") {
    response.headers.set(
      "content-disposition",
      contentDisposition(fileName, utf8FileName).replace(/^attachment/, "inline"),
    );
  }
  return response;
}
