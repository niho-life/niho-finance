import { loadFeeReports, recordExport } from "@niho-finance/db";
import { feeReportCsvRows, statementCsvText } from "@niho-finance/payroll";
import { actor } from "@/lib/actor";
import { authorizeRoute } from "@/lib/authz";
import {
  isSameOrigin,
  readEncoding,
  statementCsvBytes,
  statementCsvResponse,
  typedNumber,
} from "../../../../_lib/csv-download";
import { pathYear, readCategories } from "../../../../_lib/params";
import { plainResponse, setUpPrisma, yearPeriod } from "../../../../_lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 報酬、料金、契約金及び賞金の支払調書の CSV (e-Tax 309, docs/research/etax-309-csv.md), POSTed with
 * the 区分 chosen on the screen and the payees' 個人番号又は法人番号 typed for this download only
 * (never stored, never logged, `no-store`). Audit-logged without any number.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ year: string }> },
): Promise<Response> {
  const denied = await authorizeRoute("accountant");
  if (denied) return denied;
  if (!isSameOrigin(request)) return plainResponse("この画面からは書き出せません。", 403);
  const prisma = await setUpPrisma();
  const year = pathYear((await params).year);
  if (year === null) return plainResponse("年分が正しくありません。", 404);
  const form = await request.formData();
  const encoding = readEncoding(form.get("encoding"));
  const included = new Set(
    form.getAll("include").filter((value): value is string => typeof value === "string"),
  );
  const overview = await loadFeeReports(prisma, year, readCategories(form.entries()));
  const chosen = overview.aggregation.payees.filter(
    (payee) => payee.reportable && included.has(payee.partner.id),
  );
  if (chosen.length === 0) return plainResponse("CSV に入れる取引先を選んでください。", 400);
  const rows: string[][] = [];
  for (const payee of chosen) {
    const number = typedNumber(form.get(`pn.${payee.partner.id}`), [12, 13]);
    if (number === null) {
      return plainResponse(
        `${payee.partner.name}の番号が個人番号（12 桁）でも法人番号（13 桁）でもありません。戻って直してください（入れた番号は保存していません）。`,
        400,
      );
    }
    const remarks = form.get(`remarks.${payee.partner.id}`);
    rows.push(
      ...feeReportCsvRows(year, overview.payer, payee, {
        payeeNumber: number,
        remarks: typeof remarks === "string" ? remarks.slice(0, 100) : "",
      }),
    );
  }
  const encoded = statementCsvBytes(statementCsvText(rows), encoding);
  if (!encoded.ok) {
    return plainResponse(
      `Shift_JIS にできない文字があります（${encoded.characters.join(" ")}）。UTF-8 で書き出すか、名前・住所の文字を直してください。`,
      422,
    );
  }
  await recordExport(
    prisma,
    { kind: "fee-report-csv", format: "csv", encoding, ...yearPeriod(year) },
    { actor: await actor() },
  );
  return statementCsvResponse(encoded.bytes, `fee-reports_${year}.csv`, encoding);
}
