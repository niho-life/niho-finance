import {
  getPrismaClient,
  getSetupProgress,
  loadWithholdingLedger,
  recordExport,
} from "@niho-finance/db";
import { redirect } from "next/navigation";
import { createElement } from "react";
import { actor } from "@/lib/actor";
import { authorizeRoute } from "@/lib/authz";
import { pdfResponse } from "@/lib/pdf/download";
import { renderPdf } from "@/lib/pdf/render";
import { WithholdingLedgerDocument } from "@/lib/pdf/withholding-ledger";
import {
  withholdingLedgerData,
  withholdingLedgerFileNames,
} from "../../../../../_lib/withholding-ledger-lines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFoundResponse = () =>
  new Response("源泉徴収簿が見つかりません。給与 › 年末調整 から従業員を開きます。", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * 源泉徴収簿の PDF (22-payroll §11.4): the printable page's tables on A4 landscape through
 * `lib/pdf`. Every download is written to the audit log (`export.download`, 14-reports §2).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ year: string; employeeId: string }> },
): Promise<Response> {
  const denied = await authorizeRoute("accountant");
  if (denied) return denied;
  const prisma = getPrismaClient();
  if (!(await getSetupProgress(prisma)).ready) redirect("/setup");

  const { year: yearText, employeeId } = await params;
  if (!/^\d{4}$/.test(yearText)) return notFoundResponse();
  const year = Number(yearText);
  const ledger = await loadWithholdingLedger(prisma, year, employeeId);
  if (!ledger) return notFoundResponse();

  const bytes = await renderPdf(
    createElement(WithholdingLedgerDocument, { ledger: withholdingLedgerData(ledger) }),
  );
  await recordExport(
    prisma,
    {
      kind: "withholding-ledger",
      format: "pdf",
      from: `${year}-01-01`,
      to: `${year}-12-31`,
    },
    { actor: await actor() },
  );
  const names = withholdingLedgerFileNames(ledger);
  return pdfResponse(bytes, names.ascii, names.utf8);
}
