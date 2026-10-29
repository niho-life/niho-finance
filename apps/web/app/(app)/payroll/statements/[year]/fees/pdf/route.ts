import { loadFeeReports } from "@niho-finance/db";
import { authorizeRoute } from "@/lib/authz";
import { pathYear, readCategories } from "../../../_lib/params";
import { formsPdfResponse, plainResponse, setUpPrisma } from "../../../_lib/route-helpers";
import { eraYearLabel, feeReportForms } from "../../../_lib/statement-forms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 報酬、料金、契約金及び賞金の支払調書の PDF (22-payroll §12.2): one page per individual payee over
 * 5 万円, the 区分 from the query (`cat.<partnerId>.<accountCode>`, never stored). Audit-logged.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ year: string }> },
): Promise<Response> {
  const denied = await authorizeRoute("accountant");
  if (denied) return denied;
  const prisma = await setUpPrisma();
  const year = pathYear((await params).year);
  if (year === null) return plainResponse("年分が正しくありません。", 404);
  const categories = readCategories(new URL(request.url).searchParams.entries());
  const overview = await loadFeeReports(prisma, year, categories);
  const forms = feeReportForms(overview);
  if (forms.length === 0) {
    return plainResponse(
      `${year} 年分に支払調書を出す取引先はありません（個人で年間 5 万円を超える人だけに出します。個人か法人かは 給与 › 法定調書 で決めます）。`,
      404,
    );
  }
  return formsPdfResponse(prisma, {
    kind: "fee-report",
    year,
    title: `${eraYearLabel(year)} 報酬、料金、契約金及び賞金の支払調書`,
    author: overview.payer.name,
    forms,
    fileName: { ascii: `fee-reports_${year}.pdf`, utf8: `報酬の支払調書_${year}年分.pdf` },
  });
}
