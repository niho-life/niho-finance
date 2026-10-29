import { loadWithholdingSlip, type StatementRecipient } from "@niho-finance/db";
import { authorizeRoute } from "@/lib/authz";
import { pathYear } from "../../../../_lib/params";
import {
  formsPdfResponse,
  plainResponse,
  setUpPrisma,
  shortId,
  tableMissingResponse,
} from "../../../../_lib/route-helpers";
import { eraYearLabel, fileSafe, withholdingSlipForm } from "../../../../_lib/statement-forms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 源泉徴収票（受給者交付用）の PDF (22-payroll §12.2): no 個人番号. Refused while the person's 年末調整
 * is still to confirm. Every download is written to the audit log.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ year: string; employeeId: string }> },
): Promise<Response> {
  const denied = await authorizeRoute("accountant");
  if (denied) return denied;
  const prisma = await setUpPrisma();
  const { year: yearText, employeeId } = await params;
  const year = pathYear(yearText);
  if (year === null) return plainResponse("年分が正しくありません。", 404);
  let recipient: StatementRecipient | null;
  try {
    recipient = await loadWithholdingSlip(prisma, year, employeeId);
  } catch (error) {
    return tableMissingResponse(error);
  }
  if (!recipient) {
    return plainResponse(
      `${year} 年に支給した人の中に見つかりません。給与 › 法定調書 から開きます。`,
      404,
    );
  }
  if (recipient.state === "pending") return plainResponse(recipient.reason ?? "", 409);
  return formsPdfResponse(prisma, {
    kind: "withholding-slip",
    year,
    title: `${eraYearLabel(year)} 給与所得の源泉徴収票`,
    author: recipient.slip.payer.name,
    forms: [withholdingSlipForm(recipient, "recipient")],
    fileName: {
      ascii: `withholding-slip_${year}_${shortId(recipient.employee.id)}.pdf`,
      utf8: `源泉徴収票_${year}年分_${fileSafe(recipient.employee.name)}.pdf`,
    },
  });
}
