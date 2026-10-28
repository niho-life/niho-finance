import type { MonthlyReport } from "@niho-finance/reports";
import { ReportDocument } from "@/lib/pdf/document";
import { PdfCell, PdfRow, PdfTable } from "@/lib/pdf/table";
import { amountText, type PdfReportHeader } from "./common";

/** 月次推移 (14-reports §4): A4 landscape, months and 合計 as columns. */
export function MonthlyPdf({ report, header }: { report: MonthlyReport; header: PdfReportHeader }) {
  const count = report.columns.length + 1;
  // 12 months and 合計 fit A4 landscape at 7.5pt.
  const width = Math.min(70, Math.floor(640 / count));
  return (
    <ReportDocument
      title="月次推移"
      company={header.company}
      periodLabel={header.periodLabel}
      subtitle={header.subtitle}
      exportedAt={header.exportedAt}
      orientation="landscape"
    >
      <PdfTable style={count > 7 ? { fontSize: 7.5 } : {}}>
        <PdfRow variant="header" fixed>
          <PdfCell flex={1}>科目（円）</PdfCell>
          {report.columns.map((column) => (
            <PdfCell key={column.key} width={width} align="right">
              {column.label}
            </PdfCell>
          ))}
          <PdfCell width={width} align="right">
            合計
          </PdfCell>
        </PdfRow>
        {report.rows.map((row) => {
          const variant =
            row.kind === "group"
              ? "group"
              : row.kind === "subtotal" || row.kind === "total"
                ? row.kind
                : "body";
          return (
            <PdfRow key={row.key} variant={variant}>
              <PdfCell flex={1} indent={row.kind === "account" ? 1 : 0}>
                {row.label}
              </PdfCell>
              {row.value.map((value, i) => (
                <PdfCell key={i} width={width} align="right" bold={i === row.value.length - 1}>
                  {amountText(value)}
                </PdfCell>
              ))}
            </PdfRow>
          );
        })}
      </PdfTable>
    </ReportDocument>
  );
}
