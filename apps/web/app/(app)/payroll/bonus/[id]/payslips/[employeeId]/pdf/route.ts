import {
  getPrismaClient,
  getSetupProgress,
  loadBonusPayslip,
  recordExport,
} from "@niho-finance/db";
import { redirect } from "next/navigation";
import { createElement } from "react";
import { actor } from "@/lib/actor";
import { pdfResponse } from "@/lib/pdf/download";
import { PayslipDocument } from "@/lib/pdf/payslip";
import { renderPdf } from "@/lib/pdf/render";
import { bonusPayslipData, bonusPayslipFileNames } from "../../../../../_lib/payslip-lines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 賞与明細の PDF (22-payroll §10.5): the printable page's lines on A4 through `lib/pdf`. Every
 * download is written to the audit log (`export.download`, 14-reports §2).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; employeeId: string }> },
): Promise<Response> {
  const prisma = getPrismaClient();
  if (!(await getSetupProgress(prisma)).ready) redirect("/setup");

  const { id, employeeId } = await params;
  const payslip = await loadBonusPayslip(prisma, id, employeeId);
  if (!payslip) {
    return new Response("賞与明細が見つかりません。給与 › 賞与 から確定した賞与を開きます。", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const bytes = await renderPdf(
    createElement(PayslipDocument, { payslip: bonusPayslipData(payslip) }),
  );
  await recordExport(
    prisma,
    { kind: "payslip-bonus", format: "pdf", from: payslip.paymentDate, to: payslip.paymentDate },
    { actor: await actor() },
  );
  const names = bonusPayslipFileNames(payslip);
  return pdfResponse(bytes, names.ascii, names.utf8);
}
