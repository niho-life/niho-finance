import { Document, Page, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import { pdfStyles } from "./styles";

export type PdfOrientation = "portrait" | "landscape";

export interface ReportDocumentProps {
  /** 試算表, 仕訳帳, 請求書 … */
  title: string;
  /** 会社名 (left of the header). */
  company: string;
  /** Right of the header: the period and 「第 n 期」, e.g. `2026/11/02 – 2027/03/31（第1期）`. */
  periodLabel: string;
  /** A muted line under the title (the segment, the account …). */
  subtitle?: string | undefined;
  orientation?: PdfOrientation;
  /** 出力日時 in the footer (defaults to now). */
  exportedAt?: Date;
  children: ReactNode;
}

const JST_DATE_TIME = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** `2026/10/28 20:15` (JST). */
export function formatPdfDateTime(date: Date): string {
  return JST_DATE_TIME.format(date);
}

/**
 * An A4 report (14-reports §12): the header (会社名 · 題名 · 期間) and the footer (出力日時 ·
 * 「n / N ページ」) repeat on every page; the body wraps across pages. Tables keep their rows
 * whole (`PdfRow` does not wrap).
 */
export function ReportDocument({
  title,
  company,
  periodLabel,
  subtitle,
  orientation = "portrait",
  exportedAt = new Date(),
  children,
}: ReportDocumentProps) {
  return (
    <Document
      title={subtitle ? `${title} ${subtitle}` : title}
      author={company}
      creator="NIHO finance"
      producer="NIHO finance"
      language="ja"
    >
      <Page size="A4" orientation={orientation} style={pdfStyles.page} wrap>
        <View style={pdfStyles.header} fixed>
          <View style={pdfStyles.headerLine}>
            <Text>{company}</Text>
            <Text>{periodLabel}</Text>
          </View>
          <Text style={pdfStyles.title}>{title}</Text>
          {subtitle ? <Text style={pdfStyles.subtitle}>{subtitle}</Text> : null}
        </View>
        {children}
        <View style={pdfStyles.footer} fixed>
          <Text>出力日時 {formatPdfDateTime(exportedAt)}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages} ページ`} />
        </View>
      </Page>
    </Document>
  );
}
