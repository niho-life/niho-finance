import {
  asOfLabel,
  type FinancialBalanceSheet,
  type FinancialStatementsReport,
} from "@niho-finance/reports";
import { ReportDocument } from "@/lib/pdf/document";
import {
  BalanceSheetPdf,
  BusinessReportPdf,
  EquityStatementPdf,
  IncomeStatementPdf,
  NotesPdf,
  SchedulesPdf,
  StatementTitle,
  UnitLine,
} from "./parts";

/**
 * The PDFs of 決算書 (17 §4): 計算書類 in one file (貸借対照表 · 損益計算書 · 株主資本等変動計算書 ·
 * 個別注記表 · 附属明細書 · 事業報告, each from a new page), and 開始貸借対照表, 事業報告 and 附属明細書 on
 * their own. The header of every page has 会社名 and 「第 n 期 自 … 至 …」.
 */

interface PdfProps {
  report: FinancialStatementsReport;
  exportedAt?: Date;
}

export function FinancialStatementsPdf({ report, exportedAt }: PdfProps) {
  return (
    <ReportDocument
      title="計算書類"
      company={report.company.name}
      periodLabel={report.periodLabel}
      exportedAt={exportedAt}
    >
      <StatementTitle title="貸借対照表" sub={asOfLabel(report.balanceSheet.asOf)} />
      <BalanceSheetPdf sheet={report.balanceSheet} edition={report.edition} />

      <StatementTitle title="損益計算書" sub={report.periodLabel} breakBefore />
      <IncomeStatementPdf statement={report.incomeStatement} />

      <StatementTitle title="株主資本等変動計算書" sub={report.periodLabel} breakBefore />
      <EquityStatementPdf statement={report.equityStatement} />

      <StatementTitle title="個別注記表" sub={report.periodLabel} breakBefore unit={false} />
      <NotesPdf notes={report.notes} />

      <StatementTitle title="附属明細書" sub={report.periodLabel} breakBefore />
      <SchedulesPdf schedules={report.schedules} />

      <StatementTitle title="事業報告" sub={report.periodLabel} breakBefore unit={false} />
      <BusinessReportPdf report={report.businessReport} />
    </ReportDocument>
  );
}

/** 貸借対照表（成立の日）: the founding year only. */
export function OpeningBalanceSheetPdf({
  report,
  sheet,
  exportedAt,
}: PdfProps & { sheet: FinancialBalanceSheet }) {
  return (
    <ReportDocument
      title="貸借対照表（成立の日）"
      company={report.company.name}
      periodLabel={asOfLabel(sheet.asOf)}
      exportedAt={exportedAt}
    >
      <UnitLine />
      <BalanceSheetPdf sheet={sheet} edition={report.edition} />
    </ReportDocument>
  );
}

export function BusinessReportDocumentPdf({ report, exportedAt }: PdfProps) {
  return (
    <ReportDocument
      title="事業報告"
      company={report.company.name}
      periodLabel={report.periodLabel}
      exportedAt={exportedAt}
    >
      <BusinessReportPdf report={report.businessReport} />
    </ReportDocument>
  );
}

export function SchedulesDocumentPdf({ report, exportedAt }: PdfProps) {
  return (
    <ReportDocument
      title="附属明細書"
      company={report.company.name}
      periodLabel={report.periodLabel}
      exportedAt={exportedAt}
    >
      <UnitLine />
      <SchedulesPdf schedules={report.schedules} />
    </ReportDocument>
  );
}
