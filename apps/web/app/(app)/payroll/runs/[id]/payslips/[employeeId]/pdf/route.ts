import { getPrismaClient, getSetupProgress, loadPayslip, recordExport } from "@niho-finance/db";
import { redirect } from "next/navigation";
import { createElement } from "react";
import { actor } from "@/lib/env";
import { pdfResponse } from "@/lib/pdf/download";
import { PayslipDocument } from "@/lib/pdf/payslip";
import { renderPdf } from "@/lib/pdf/render";
import { payslipData, payslipFileNames } from "../../../../../_lib/payslip-lines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 給与明細の PDF (22-payroll §6.5): the printable page's lines on A4 through `lib/pdf`. Every
 * download is written to the audit log (`export.download`, 14-reports §2).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; employeeId: string }> },
): Promise<Response> {
  const prisma = getPrismaClient();
  if (!(await getSetupProgress(prisma)).ready) redirect("/setup");

  const { id, employeeId } = await params;
  const payslip = await loadPayslip(prisma, id, employeeId);
  if (!payslip) {
    return new Response(
      "給与明細が見つかりません。給与 › 支給の履歴 から確定した支給を開きます。",
      {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      },
    );
  }

  const bytes = await renderPdf(createElement(PayslipDocument, { payslip: payslipData(payslip) }));
  await recordExport(
    prisma,
    { kind: "payslip", format: "pdf", from: payslip.paymentDate, to: payslip.paymentDate },
    { actor: actor() },
  );
  const names = payslipFileNames(payslip);
  return pdfResponse(bytes, names.ascii, names.utf8);
}
