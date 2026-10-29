import { loadStatements, recordExport, type StatementsOverview } from "@niho-finance/db";
import { statementCsvText, unifiedCsvRow } from "@niho-finance/payroll";
import { actor } from "@/lib/actor";
import { authorizeRoute } from "@/lib/authz";
import {
  isSameOrigin,
  readEncoding,
  statementCsvBytes,
  statementCsvResponse,
  typedNumber,
} from "../../../_lib/csv-download";
import { pathYear } from "../../../_lib/params";
import {
  plainResponse,
  setUpPrisma,
  tableMissingResponse,
  yearPeriod,
} from "../../../_lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBMISSION_KINDS = { "0": 0, "1": 1, "2": 2, "3": 3 } as const;

/**
 * 給与支払報告書‐源泉徴収票の統一 CSV (22-payroll §12.2), POSTed from the form with the マイナンバー
 * typed for this download: they go into this response only (never stored, never logged, `no-store`).
 * A malformed number is refused by the person's name, without echoing it. The download is written to
 * the audit log (`export.download`, without any number).
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
  const kind = form.get("submissionKind");
  const submissionKind =
    typeof kind === "string" && kind in SUBMISSION_KINDS
      ? SUBMISSION_KINDS[kind as keyof typeof SUBMISSION_KINDS]
      : 0;
  const included = new Set(
    form.getAll("include").filter((value): value is string => typeof value === "string"),
  );
  let overview: StatementsOverview;
  try {
    overview = await loadStatements(prisma, year);
  } catch (error) {
    return tableMissingResponse(error);
  }
  const chosen = overview.recipients.filter((recipient) => included.has(recipient.employee.id));
  if (chosen.length === 0) return plainResponse("CSV に入れる受給者を選んでください。", 400);
  const refused = chosen.find(
    (recipient) => recipient.state === "pending" || !recipient.inSalaryReport,
  );
  if (refused) {
    return plainResponse(
      `${refused.employee.name}さんは CSV に入れられません（年末調整が未確定か、給与支払報告書の範囲外です）。画面を読み込み直してください。`,
      409,
    );
  }
  const rows: string[][] = [];
  for (const recipient of chosen) {
    const id = recipient.employee.id;
    const field = (suffix: string) => typedNumber(form.get(`mn.${id}.${suffix}`), [12]);
    const recipientNumber = field("recipient");
    const spouse = field("spouse");
    const dependents = [0, 1, 2, 3].map((index) => field(`dep.${index}`));
    const minors = [0, 1, 2, 3].map((index) => field(`minor.${index}`));
    if ([recipientNumber, spouse, ...dependents, ...minors].includes(null)) {
      return plainResponse(
        `${recipient.employee.name}さんの欄に 12 桁でない個人番号があります。戻って直してください（入れた番号は保存していません）。`,
        400,
      );
    }
    rows.push(
      unifiedCsvRow(recipient.slip, {
        submissionKind,
        myNumbers: {
          recipient: recipientNumber ?? "",
          spouse: spouse ?? "",
          dependents: dependents.map((value) => value ?? ""),
          minors: minors.map((value) => value ?? ""),
        },
      }),
    );
  }
  const encoded = statementCsvBytes(statementCsvText(rows), encoding);
  if (!encoded.ok) {
    return plainResponse(
      `Shift_JIS にできない文字があります（${encoded.characters.join(" ")}）。UTF-8 で書き出すか、氏名・住所の文字を直してください。`,
      422,
    );
  }
  await recordExport(
    prisma,
    { kind: "salary-report-csv", format: "csv", encoding, ...yearPeriod(year) },
    { actor: await actor() },
  );
  return statementCsvResponse(encoded.bytes, `salary-report_${year}.csv`, encoding);
}
