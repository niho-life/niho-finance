import { BREAKDOWN_AXIS_LABELS, type BreakdownReport } from "@niho-finance/reports";
import { ReportDocument } from "@/lib/pdf/document";
import { PdfCell, PdfRow, PdfTable } from "@/lib/pdf/table";
import { amountText, type PdfReportHeader } from "./common";

/**
 * 集計 (14-reports §15.4): A4 landscape (12 months), the axis's rows with 合計 and 構成比. The title
 * names the axis and the side: 「集計（取引先別・収益）」.
 */
export function BreakdownPdf({
  report,
  header,
}: {
  report: BreakdownReport;
  header: PdfReportHeader;
}) {
  const count = report.columns.length + 1;
  // 12 months, 合計 and 構成比 fit A4 landscape at 7.5pt.
  const width = Math.min(70, Math.floor(600 / count));
  const shareWidth = 40;
  return (
    <ReportDocument
      title={report.title}
      company={header.company}
      periodLabel={header.periodLabel}
      subtitle={header.subtitle}
      exportedAt={header.exportedAt}
      orientation="landscape"
    >
      <PdfTable style={count > 7 ? { fontSize: 7.5 } : {}}>
        <PdfRow variant="header" fixed>
          <PdfCell flex={1}>{BREAKDOWN_AXIS_LABELS[report.axis]}（円）</PdfCell>
          {report.columns.map((column) => (
            <PdfCell key={column.key} width={width} align="right">
              {column.label}
            </PdfCell>
          ))}
          <PdfCell width={width} align="right">
            合計
          </PdfCell>
          <PdfCell width={shareWidth} align="right">
            構成比
          </PdfCell>
        </PdfRow>
        {report.rows.map((row) => (
          <PdfRow
            key={row.key}
            variant={row.kind === "total" ? "total" : "body"}
            muted={row.kind === "none" || row.kind === "other"}
          >
            <PdfCell flex={1}>{row.code ? `${row.code} ${row.label}` : row.label}</PdfCell>
            {row.values.map((value, i) => (
              <PdfCell key={i} width={width} align="right" bold={i === row.values.length - 1}>
                {amountText(value)}
              </PdfCell>
            ))}
            <PdfCell width={shareWidth} align="right">
              {row.share}
            </PdfCell>
          </PdfRow>
        ))}
      </PdfTable>
    </ReportDocument>
  );
}
