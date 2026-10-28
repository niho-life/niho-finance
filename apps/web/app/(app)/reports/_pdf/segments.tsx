import type { SegmentReport } from "@niho-finance/reports";
import { ReportDocument } from "@/lib/pdf/document";
import { PdfCell, PdfRow, PdfTable } from "@/lib/pdf/table";
import { amountText, type PdfReportHeader } from "./common";

/** セグメント損益 (14-reports §5): A4 portrait, segments and 合計 as columns. */
export function SegmentsPdf({
  report,
  header,
}: {
  report: SegmentReport;
  header: PdfReportHeader;
}) {
  const count = report.columns.length;
  const width = Math.min(80, Math.floor(400 / count));
  return (
    <ReportDocument
      title="セグメント損益"
      company={header.company}
      periodLabel={header.periodLabel}
      subtitle={header.subtitle}
      exportedAt={header.exportedAt}
      orientation="portrait"
    >
      <PdfTable style={count > 5 ? { fontSize: 7.5 } : {}}>
        <PdfRow variant="header" fixed>
          <PdfCell flex={1}>科目（円）</PdfCell>
          {report.columns.map((column) => (
            <PdfCell key={column.key} width={width} align="right">
              {column.label}
            </PdfCell>
          ))}
        </PdfRow>
        {report.rows.map((row) =>
          row.kind === "section" ? (
            <PdfRow key={row.key} variant="group">
              <PdfCell flex={1}>{row.label}</PdfCell>
            </PdfRow>
          ) : (
            <PdfRow key={row.key} variant={row.kind === "account" ? "body" : row.kind}>
              <PdfCell flex={1} indent={row.kind === "account" ? 1 : 0}>
                {row.label}
              </PdfCell>
              {row.values.map((value, i) => (
                <PdfCell key={i} width={width} align="right" bold={i === count - 1}>
                  {amountText(value)}
                </PdfCell>
              ))}
            </PdfRow>
          ),
        )}
      </PdfTable>
    </ReportDocument>
  );
}
