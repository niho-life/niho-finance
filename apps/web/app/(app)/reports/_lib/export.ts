import {
  getPrismaClient,
  getSetupProgress,
  loadCashflowInputs,
  loadReportSource,
  loadWalletStatus,
  recordExport,
  todayInJapan,
} from "@niho-finance/db";
import type { CalendarDate } from "@niho-finance/ledger";
import {
  buildCashflowForecast,
  buildCashReport,
  buildGeneralLedger,
  buildMonthlyTrend,
  buildSegmentReport,
  CASHFLOW_DAYS,
  cashflowCsvRows,
  csvText,
  CSV_CONTENT_TYPES,
  encodeCsv,
  forecastStartDate,
  journalCsvRows,
  journalEntries,
  ledgerCsvRows,
  reportFileName,
  resolveReportPeriod,
  type CashflowInputs,
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
import { CashflowPdf } from "../_pdf/cashflow";
import type { PdfReportHeader } from "../_pdf/common";
import { JournalPdf } from "../_pdf/journal";
import { LedgerPdf } from "../_pdf/ledger";
import { MonthlyPdf } from "../_pdf/monthly";
import { SegmentsPdf } from "../_pdf/segments";
import { TrialBalancePdf } from "../_pdf/trial-balance";
import { cashflowPeriodLabel } from "./cashflow-text";
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
  /**
   * Dates of its own instead of the URL's period (資金繰り: the start and 90 days later, 21 §6):
   * the file name, the PDF header and the audit log use them, without a fiscal year or segment.
   */
  range?: { from: CalendarDate; to: CalendarDate; label: string };
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
  today: CalendarDate,
  loadCashflow: (start: CalendarDate) => Promise<CashflowInputs>,
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
    case "cashflow": {
      // Always the start (today) and 90 days; written even without rows (the start row).
      const start = forecastStartDate(source.fiscalYears, today);
      const forecast = buildCashflowForecast(source, await loadCashflow(start), {
        start,
        days: CASHFLOW_DAYS,
      });
      return {
        name: tab,
        csv: () => cashflowCsvRows(forecast),
        pdf: (header) => createElement(CashflowPdf, { forecast, header }),
        range: { from: forecast.start, to: forecast.end, label: cashflowPeriodLabel(forecast) },
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
  const today = todayInJapan();
  const period = resolveReportPeriod(params.query, source.fiscalYears, today);
  if (!period) redirect("/settings/fiscal-years");

  const output = await outputOf(
    tab,
    source,
    period,
    params,
    () => loadWalletStatus(prisma, { through: period.to }),
    today,
    (start) => loadCashflowInputs(prisma, { start, days: CASHFLOW_DAYS }),
  );
  if (!output) {
    return notFound("この条件では書き出す行がありません。報告の画面で条件を確かめてください。");
  }

  const response = await respond(output, format, source, period, tab);
  const { range } = output;
  await recordExport(
    prisma,
    {
      kind: tab,
      format,
      fiscalYearNo: range ? null : period.fiscalYear.no,
      from: range ? range.from : period.from,
      to: range ? range.to : period.to,
      segment: range ? null : period.segmentId,
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
  const { range } = output;
  const fileName = reportFileName(
    output.name,
    range ? range.from : period.from,
    range ? range.to : period.to,
    format,
  );
  if (format === "csv") {
    return csvResponse(encodeCsv(csvText(output.csv()), "utf8"), fileName, CSV_CONTENT_TYPES.utf8);
  }
  const segment =
    period.segmentId && !range ? segmentName(source.segments, period.segmentId) : null;
  const header: PdfReportHeader = {
    company: source.company.name,
    periodLabel: range ? range.label : pdfPeriodLabel(period),
    subtitle:
      segment && tab !== "segments" && tab !== "cash" ? `セグメント: ${segment}` : undefined,
  };
  const bytes = await renderPdf(output.pdf(header));
  return pdfResponse(bytes, fileName);
}
