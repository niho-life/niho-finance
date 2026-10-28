import {
  getPrismaClient,
  getSetupProgress,
  loadReportSource,
  loadWalletStatus,
  recordExport,
  todayInJapan,
} from "@niho-finance/db";
import {
  buildCashReport,
  buildGeneralLedger,
  buildMonthlyTrend,
  buildSegmentReport,
  csvText,
  CSV_CONTENT_TYPES,
  encodeCsv,
  journalCsvRows,
  journalEntries,
  ledgerCsvRows,
  reportFileName,
  resolveReportPeriod,
  type CsvCell,
  type ReportPeriod,
  type ReportSource,
} from "@niho-finance/reports";
import { redirect } from "next/navigation";
import { createElement, type ReactElement } from "react";
import { actor } from "@/lib/env";
import { csvResponse, pdfResponse } from "@/lib/pdf/download";
import { renderPdf } from "@/lib/pdf/render";
import { CashPdf } from "../_pdf/cash";
import type { PdfReportHeader } from "../_pdf/common";
import { JournalPdf } from "../_pdf/journal";
import { LedgerPdf } from "../_pdf/ledger";
import { MonthlyPdf } from "../_pdf/monthly";
import { SegmentsPdf } from "../_pdf/segments";
import { TrialBalancePdf } from "../_pdf/trial-balance";
import { cashCsvRows, monthlyCsvRows, segmentsCsvRows, trialBalanceCsvRows } from "./csv-rows";
import { pdfPeriodLabel, segmentName } from "./format";
import { parseReportParams, searchParamsRecord, type ReportParams } from "./query";
import { isExportFormat, isReportTab, type ExportFormat, type ReportTab } from "./tabs";
import { buildTrialBalanceView } from "./trial-balance-view";

/** What a tab writes: CSV rows and the PDF document of the same report. */
interface ReportOutput {
  /** The `<report>` part of the file name (ASCII). */
  name: string;
  csv: () => CsvCell[][];
  pdf: (header: PdfReportHeader) => ReactElement;
}

function notFound(message: string): Response {
  return new Response(message, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

async function outputOf(
  tab: ReportTab,
  source: ReportSource,
  period: ReportPeriod,
  params: ReportParams,
  loadStatus: () => ReturnType<typeof loadWalletStatus>,
): Promise<ReportOutput | null> {
  const segment = period.segmentId ? segmentName(source.segments, period.segmentId) : null;
  switch (tab) {
    case "trial-balance": {
      const view = buildTrialBalanceView(source, period);
      if (view.report.empty) return null;
      return {
        name: tab,
        csv: () => trialBalanceCsvRows(view, segment),
        pdf: (header) => createElement(TrialBalancePdf, { view, header }),
      };
    }
    case "monthly": {
      const report = buildMonthlyTrend(source, period);
      if (report.empty) return null;
      return {
        name: tab,
        csv: () => monthlyCsvRows(report),
        pdf: (header) => createElement(MonthlyPdf, { report, header }),
      };
    }
    case "segments": {
      const report = buildSegmentReport(source, period);
      if (report.empty) return null;
      return {
        name: tab,
        csv: () => segmentsCsvRows(report),
        pdf: (header) => createElement(SegmentsPdf, { report, header }),
      };
    }
    case "cash": {
      const report = buildCashReport(source, period, await loadStatus());
      if (report.empty) return null;
      return {
        name: tab,
        csv: () => cashCsvRows(report),
        pdf: (header) => createElement(CashPdf, { report, header }),
      };
    }
    case "journal": {
      const entries = journalEntries(source, period, params.status);
      if (entries.length === 0) return null;
      return {
        name: tab,
        csv: () => journalCsvRows(entries),
        pdf: (header) => createElement(JournalPdf, { entries, header }),
      };
    }
    case "ledger": {
      if (!params.account) return null;
      const report = buildGeneralLedger(source, period, {
        accountId: params.account,
        subAccountId: params.sub,
      });
      if (report.empty) return null;
      const subject = `${report.account.code} ${report.account.name}${report.subAccount ? ` / ${report.subAccount.name}` : ""}`;
      return {
        name: `ledger-${report.account.code}`,
        csv: () => ledgerCsvRows(report),
        pdf: (header) =>
          createElement(LedgerPdf, {
            report,
            header: { ...header, subtitle: [subject, header.subtitle].filter(Boolean).join(" · ") },
          }),
      };
    }
  }
}

/**
 * `GET /reports/export?report=…&format=csv|pdf&…` (14-reports §2): the tab as shown, as a
 * download. Every download is written to the audit log (`export.download`).
 */
export async function exportReport(request: Request): Promise<Response> {
  const prisma = getPrismaClient();
  if (!(await getSetupProgress(prisma)).ready) redirect("/setup");

  const url = new URL(request.url);
  const tab = url.searchParams.get("report");
  const format = url.searchParams.get("format");
  if (!isReportTab(tab) || !isExportFormat(format)) {
    return notFound("書き出す報告が見つかりません。報告の画面の「CSV」「PDF」から書き出します。");
  }

  const source = await loadReportSource(prisma);
  const params = parseReportParams(searchParamsRecord(url.searchParams), source);
  const period = resolveReportPeriod(params.query, source.fiscalYears, todayInJapan());
  if (!period) redirect("/settings/fiscal-years");

  const output = await outputOf(tab, source, period, params, () =>
    loadWalletStatus(prisma, { through: period.to }),
  );
  if (!output) {
    return notFound("この条件では書き出す行がありません。報告の画面で条件を確かめてください。");
  }

  const response = await respond(output, format, source, period, tab);
  await recordExport(
    prisma,
    {
      kind: tab,
      format,
      fiscalYearNo: period.fiscalYear.no,
      from: period.from,
      to: period.to,
      segment: period.segmentId,
      encoding: format === "csv" ? "utf8" : null,
    },
    { actor: actor() },
  );
  return response;
}

async function respond(
  output: ReportOutput,
  format: ExportFormat,
  source: ReportSource,
  period: ReportPeriod,
  tab: ReportTab,
): Promise<Response> {
  const fileName = reportFileName(output.name, period.from, period.to, format);
  if (format === "csv") {
    return csvResponse(encodeCsv(csvText(output.csv()), "utf8"), fileName, CSV_CONTENT_TYPES.utf8);
  }
  const segment = period.segmentId ? segmentName(source.segments, period.segmentId) : null;
  const header: PdfReportHeader = {
    company: source.company.name,
    periodLabel: pdfPeriodLabel(period),
    subtitle:
      segment && tab !== "segments" && tab !== "cash" ? `セグメント: ${segment}` : undefined,
  };
  const bytes = await renderPdf(output.pdf(header));
  return pdfResponse(bytes, fileName);
}
