import {
  getPrismaClient,
  getSetupProgress,
  loadFinancialStatementsSource,
  loadFixedAssetRegister,
  recordExport,
  todayInJapan,
  type StatementExportKind,
} from "@niho-finance/db";
import {
  accountDetailsCsv,
  buildAccountDetails,
  buildAnnouncementHtml,
  buildConsumptionTaxSummary,
  buildFinancialStatements,
  buildHot010File,
  buildHot010Zip,
  consumptionTaxCsv,
  CSV_CONTENT_TYPES,
  ETAX_STATEMENTS,
  EtaxCharacterError,
  reportFileName,
  type EtaxStatement,
  type FinancialStatementsFiscalYear,
  type FinancialStatementsReport,
  type FinancialStatementsSource,
} from "@niho-finance/reports";
import { redirect } from "next/navigation";
import { createElement, type ReactElement } from "react";
import { actor } from "@/lib/actor";
import { csvResponse, pdfResponse, textResponse, zipResponse } from "@/lib/pdf/download";
import { renderPdf } from "@/lib/pdf/render";
import {
  BusinessReportDocumentPdf,
  FinancialStatementsPdf,
  OpeningBalanceSheetPdf,
  SchedulesDocumentPdf,
} from "../_pdf/documents";
import {
  DOC_FORMATS,
  isStatementDoc,
  isStatementFormat,
  type StatementDoc,
  type StatementFormat,
} from "./links";
import { defaultStatementsYear, yearOfParam } from "./query";

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

/** The audit log `kind` of each document (17 §1). */
const EXPORT_KINDS: Readonly<Record<StatementDoc, StatementExportKind>> = {
  statements: "financial-statements",
  opening: "opening-balance-sheet",
  "business-report": "business-report",
  schedules: "supplementary-schedules",
  etax: "etax-csv",
  "account-details": "account-details",
  "consumption-tax": "consumption-tax",
  announcement: "announcement",
};

/** The Japanese file names of the PDFs (`filename*`; the ASCII name stays for old clients). */
const PDF_NAMES: Partial<Record<StatementDoc, { ascii: string; japanese: string }>> = {
  statements: { ascii: "financial-statements", japanese: "計算書類" },
  opening: { ascii: "opening-balance-sheet", japanese: "開始貸借対照表" },
  "business-report": { ascii: "business-report", japanese: "事業報告" },
  schedules: { ascii: "supplementary-schedules", japanese: "附属明細書" },
};

function isEtaxStatement(value: unknown): value is EtaxStatement {
  return typeof value === "string" && (ETAX_STATEMENTS as readonly string[]).includes(value);
}

interface Target {
  doc: StatementDoc;
  format: StatementFormat;
  statement: EtaxStatement | null;
}

/** `doc` · `format` · `statement` checked against each other; `null` for any other combination. */
function parseTarget(params: URLSearchParams): Target | null {
  const doc = params.get("doc");
  const format = params.get("format");
  const statement = params.get("statement");
  if (!isStatementDoc(doc) || !isStatementFormat(format)) return null;
  if (!DOC_FORMATS[doc].includes(format)) return null;
  if (doc === "etax" && format === "csv") {
    return isEtaxStatement(statement) ? { doc, format, statement } : null;
  }
  if (statement !== null && statement !== "") return null;
  return { doc, format, statement: null };
}

interface Written {
  response: Response;
  encoding: "utf8" | "sjis" | null;
}

async function pdf(
  doc: StatementDoc,
  year: FinancialStatementsFiscalYear,
  element: ReactElement,
): Promise<Written> {
  const names = PDF_NAMES[doc];
  if (!names) throw new Error(`closing/statements: ${doc} is not a PDF`);
  const bytes = await renderPdf(element);
  return {
    response: pdfResponse(
      bytes,
      reportFileName(names.ascii, year.startDate, year.endDate, "pdf"),
      `${names.japanese}_第${year.no}期.pdf`,
    ),
    encoding: null,
  };
}

async function write(
  target: Target,
  source: FinancialStatementsSource,
  year: FinancialStatementsFiscalYear,
  report: FinancialStatementsReport,
  back: (error: string) => never,
): Promise<Written> {
  switch (target.doc) {
    case "statements":
      return pdf(target.doc, year, createElement(FinancialStatementsPdf, { report }));
    case "opening": {
      const sheet = report.openingBalanceSheet;
      if (!sheet) back("opening");
      return pdf(target.doc, year, createElement(OpeningBalanceSheetPdf, { report, sheet }));
    }
    case "business-report":
      return pdf(target.doc, year, createElement(BusinessReportDocumentPdf, { report }));
    case "schedules":
      return pdf(target.doc, year, createElement(SchedulesDocumentPdf, { report }));
    case "etax": {
      try {
        if (target.statement) {
          const file = buildHot010File(report, target.statement);
          return {
            response: csvResponse(file.bytes, file.fileName, CSV_CONTENT_TYPES.sjis),
            encoding: "sjis",
          };
        }
        const zip = buildHot010Zip(report);
        return { response: zipResponse(zip.bytes, zip.fileName), encoding: "sjis" };
      } catch (error) {
        // The page finds and shows the characters (and where they are) again.
        if (error instanceof EtaxCharacterError) back("etax");
        throw error;
      }
    }
    case "account-details": {
      const csv = accountDetailsCsv(buildAccountDetails(source, year.id));
      return {
        response: csvResponse(csv.bytes, csv.fileName, CSV_CONTENT_TYPES.utf8),
        encoding: "utf8",
      };
    }
    case "consumption-tax": {
      const csv = consumptionTaxCsv(buildConsumptionTaxSummary(source, year.id));
      return {
        response: csvResponse(csv.bytes, csv.fileName, CSV_CONTENT_TYPES.utf8),
        encoding: "utf8",
      };
    }
    case "announcement": {
      const page = buildAnnouncementHtml(report);
      return {
        response: textResponse(page.html, page.fileName, HTML_CONTENT_TYPE),
        encoding: null,
      };
    }
  }
}

/**
 * `GET /closing/statements/export?fy=&doc=&format=&statement=` (17 §2): one document of the year as
 * a download, written to the audit log (`export.download`). Without the setup it goes to `/setup`;
 * a request that names nothing writable goes back to 決算書 with the reason.
 */
export async function exportStatements(request: Request): Promise<Response> {
  const prisma = getPrismaClient();
  if (!(await getSetupProgress(prisma)).ready) redirect("/setup");

  const params = new URL(request.url).searchParams;
  const source = await loadFinancialStatementsSource(prisma);
  const named = yearOfParam(source.fiscalYears, params.get("fy") ?? undefined);
  const year = named ?? defaultStatementsYear(source.fiscalYears, todayInJapan());
  if (!year) redirect("/settings/fiscal-years");
  const back: (error: string) => never = (error) =>
    redirect(`/closing/statements?fy=${year.no}&error=${error}#exports`);

  const target = parseTarget(params);
  if (named === null || !target) back("export");
  const report = buildFinancialStatements(source, year.id, {
    fixedAssets: await loadFixedAssetRegister(prisma, year.id),
  });
  if (report.empty) back("empty");

  const written = await write(target, source, year, report, back);
  await recordExport(
    prisma,
    {
      kind: EXPORT_KINDS[target.doc],
      format: target.format,
      fiscalYearNo: year.no,
      from: year.startDate,
      to: year.endDate,
      encoding: written.encoding,
    },
    { actor: await actor() },
  );
  return written.response;
}
