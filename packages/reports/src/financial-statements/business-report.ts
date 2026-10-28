/**
 * 事業報告 (17-financial-statements §4.6): for a non-public company, 「株式会社の状況に関する重要な事項」
 * (会社法施行規則 118 条) on one or two A4 pages — 会社の現況, 株式の状況, 会社役員の状況 and その他の
 * 重要な事項, dated on the shareholders' meeting (or left blank) and signed by the representative.
 */
import { formatYen, type CalendarDate } from "@niho-finance/ledger";
import { CORPORATE_SEGMENT_CODE } from "../labels";
import type { ReportSegment } from "../source";
import { fiscalYearPeriodLabel } from "./format";
import type { ResolvedStatementSettings } from "./settings";
import type { FinancialStatementsCompany, FinancialStatementsFiscalYear } from "./source";

export interface BusinessReportItem {
  /** `null` for a paragraph without a label. */
  label: string | null;
  body: string;
}

export interface BusinessReportSection {
  /** 「1. 会社の現況」 */
  heading: string;
  items: BusinessReportItem[];
}

export interface BusinessReport {
  title: string;
  companyName: string;
  /** 「第1期 自 2026年11月2日 至 2027年3月31日」 */
  periodLabel: string;
  sections: BusinessReportSection[];
  /** 作成日: the shareholders' meeting, or `null` (a blank to fill in by hand). */
  createdOn: CalendarDate | null;
  representative: string | null;
}

export const BUSINESS_REPORT_TITLE = "事業報告";
/** 株主数 (17 §4.6: 1 名; a different number goes into その他の重要な事項). */
export const DEFAULT_SHAREHOLDER_COUNT = 1;

/** 事業の内容: the segments' names, 共通 left out. */
export function businessDescription(segments: readonly ReportSegment[]): string {
  const names = [...segments]
    .filter((segment) => segment.isActive && segment.code !== CORPORATE_SEGMENT_CODE)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((segment) => segment.name);
  return names.length > 0 ? names.join("、") : "（記入する）";
}

export function buildBusinessReport(input: {
  company: FinancialStatementsCompany;
  fiscalYear: FinancialStatementsFiscalYear;
  segments: readonly ReportSegment[];
  settings: ResolvedStatementSettings;
}): BusinessReport {
  const { settings } = input;
  const shares =
    settings.issuedShares === null
      ? "（記入する）"
      : `${formatYen(BigInt(settings.issuedShares))}株`;
  return {
    title: BUSINESS_REPORT_TITLE,
    companyName: input.company.name,
    periodLabel: fiscalYearPeriodLabel(input.fiscalYear),
    sections: [
      {
        heading: "1. 会社の現況",
        items: [
          { label: "事業の内容", body: businessDescription(input.segments) },
          { label: "事業の経過及びその成果", body: settings.businessReport.progress },
          { label: "対処すべき課題", body: settings.businessReport.issues },
        ],
      },
      {
        heading: "2. 株式の状況",
        items: [
          { label: "発行済株式の総数", body: shares },
          { label: "株主数", body: `${DEFAULT_SHAREHOLDER_COUNT}名` },
        ],
      },
      {
        heading: "3. 会社役員の状況",
        items: [{ label: "代表取締役", body: input.company.representative ?? "（記入する）" }],
      },
      {
        heading: "4. その他の重要な事項",
        items: [{ label: null, body: settings.businessReport.otherMatters }],
      },
    ],
    createdOn: settings.shareholdersMeetingOn,
    representative: input.company.representative,
  };
}
