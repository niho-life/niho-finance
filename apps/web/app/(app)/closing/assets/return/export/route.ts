import {
  getPrismaClient,
  getSetupProgress,
  loadDepreciableAssetsReturn,
  recordExport,
  todayInJapan,
} from "@niho-finance/db";
import {
  CSV_CONTENT_TYPES,
  csvText,
  depreciableAssetsReturnCsv,
  depreciableAssetsReturnFileName,
  encodeCsv,
} from "@niho-finance/reports";
import { redirect } from "next/navigation";
import { createElement } from "react";
import { actor } from "@/lib/actor";
import { csvResponse, pdfResponse } from "@/lib/pdf/download";
import { renderPdf } from "@/lib/pdf/render";
import { isReturnExportFormat, returnYearOf } from "../_lib/year";
import { DepreciableAssetsReturnPdf } from "../_pdf/return-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The audit log `kind` of this export (16 §14.4). */
const EXPORT_KIND = "depreciable-assets-return";

/**
 * `GET /closing/assets/return/export?year=&format=csv|pdf` (16 §14.4): the CSV (UTF-8 with a BOM;
 * 全資産・増加・減少 in one file with 区分) or the PDF (A4 landscape) of return year `year`, written
 * to the audit log (`export.download`). Without the setup it goes to `/setup`; any other format goes
 * back to the page.
 */
export async function GET(request: Request): Promise<Response> {
  const prisma = getPrismaClient();
  if (!(await getSetupProgress(prisma)).ready) redirect("/setup");

  const params = new URL(request.url).searchParams;
  const today = todayInJapan();
  const year = returnYearOf(params.get("year"), today);
  const format = params.get("format");
  if (!isReturnExportFormat(format)) redirect(`/closing/assets/return?year=${year}`);

  const data = await loadDepreciableAssetsReturn(prisma, { year, today });
  const response =
    format === "csv"
      ? csvResponse(
          encodeCsv(csvText(depreciableAssetsReturnCsv(data)), "utf8"),
          depreciableAssetsReturnFileName(year, "csv"),
          CSV_CONTENT_TYPES.utf8,
        )
      : pdfResponse(
          await renderPdf(createElement(DepreciableAssetsReturnPdf, { data })),
          depreciableAssetsReturnFileName(year, "pdf"),
        );
  await recordExport(
    prisma,
    {
      kind: EXPORT_KIND,
      format,
      from: data.window.from,
      to: data.window.to,
      encoding: format === "csv" ? "utf8" : null,
    },
    { actor: await actor() },
  );
  return response;
}
