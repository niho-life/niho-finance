import {
  getCompany,
  listPayrollRuns,
  loadStatements,
  type StatementsOverview,
} from "@niho-finance/db";
import { dateParts } from "@niho-finance/ledger";
import { authorizeRoute } from "@/lib/authz";
import { pathYear } from "../../../_lib/params";
import {
  formsPdfResponse,
  plainResponse,
  setUpPrisma,
  tableMissingResponse,
} from "../../../_lib/route-helpers";
import { eraYearLabel, payDayLabel, salaryReportSummaryForms } from "../../../_lib/statement-forms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 給与支払報告書（総括表）の PDF (22-payroll §12.2): one page per 提出先の市区町村 (by 市町村コード),
 * with 受給者総人員 and 報告人員 (特別徴収・普通徴収〔退職者〕). Audit-logged.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ year: string }> },
): Promise<Response> {
  const denied = await authorizeRoute("accountant");
  if (denied) return denied;
  const prisma = await setUpPrisma();
  const year = pathYear((await params).year);
  if (year === null) return plainResponse("年分が正しくありません。", 404);
  let overview: StatementsOverview;
  try {
    overview = await loadStatements(prisma, year);
  } catch (error) {
    return tableMissingResponse(error);
  }
  if (overview.recipients.length === 0) {
    return plainResponse(`${year} 年に支給した人がいません。`, 404);
  }
  const [company, runs] = await Promise.all([getCompany(prisma), listPayrollRuns(prisma)]);
  const days = runs
    .filter((run) => dateParts(run.paymentDate).year === year)
    .reverse()
    .map((run) => dateParts(run.paymentDate).day);
  return formsPdfResponse(prisma, {
    kind: "salary-report-summary",
    year,
    title: `${eraYearLabel(year)} 給与支払報告書（総括表）`,
    author: overview.payer.name,
    forms: salaryReportSummaryForms(overview, {
      payDayLabel: payDayLabel(days),
      nameKana: company?.nameKana ?? "",
      representative: company?.representative ?? "",
    }),
    fileName: {
      ascii: `salary-report-summary_${year}.pdf`,
      utf8: `給与支払報告書_総括表_${year}年分.pdf`,
    },
  });
}
