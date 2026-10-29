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
 * 給与支払報告書（個人別明細書）の PDF (22-payroll §12.2): the 個人番号 boxes stay empty. Refused while the 年末調整
 * is still to confirm and for someone out of range (年の中途の退職・30 万円以下). Audit-logged.
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
  if (!recipient.inSalaryReport) {
    return plainResponse(
      "年の中途で退職し支払金額が 30 万円以下の人には、給与支払報告書を出しません（源泉徴収票は本人に渡します）。",
      409,
    );
  }
  return formsPdfResponse(prisma, {
    kind: "salary-report",
    year,
    title: `${eraYearLabel(year)} 給与支払報告書（個人別明細書）`,
    author: recipient.slip.payer.name,
    forms: [withholdingSlipForm(recipient, "report")],
    fileName: {
      ascii: `salary-report_${year}_${shortId(recipient.employee.id)}.pdf`,
      utf8: `給与支払報告書_${year}年分_${fileSafe(recipient.employee.name)}.pdf`,
    },
  });
}
