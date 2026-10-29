import { loadAnnualTotals, type AnnualTotals } from "@niho-finance/db";
import { authorizeRoute } from "@/lib/authz";
import { pathYear, readCategories } from "../../../_lib/params";
import {
  formsPdfResponse,
  plainResponse,
  setUpPrisma,
  tableMissingResponse,
} from "../../../_lib/route-helpers";
import { annualTotalsForm, eraYearLabel } from "../../../_lib/statement-forms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 法定調書合計表の元データの PDF (22-payroll §12.2): 給与 (375) and 報酬 (309) of the year, the 報酬's
 * 区分 from the query (`cat.<partnerId>.<accountCode>`). Audit-logged.
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
  let totals: AnnualTotals;
  try {
    totals = await loadAnnualTotals(prisma, year, categories);
  } catch (error) {
    return tableMissingResponse(error);
  }
  return formsPdfResponse(prisma, {
    kind: "statutory-totals",
    year,
    title: `${eraYearLabel(year)} 法定調書合計表（元データ）`,
    author: totals.payer.name,
    forms: [annualTotalsForm(totals)],
    fileName: {
      ascii: `statutory-totals_${year}.pdf`,
      utf8: `法定調書合計表_元データ_${year}年分.pdf`,
    },
  });
}
