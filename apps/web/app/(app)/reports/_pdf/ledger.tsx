import { slashDate, type GeneralLedgerReport } from "@niho-finance/reports";
import { ReportDocument } from "@/lib/pdf/document";
import { PdfCell, PdfRow, PdfTable } from "@/lib/pdf/table";
import { amountText, type PdfReportHeader } from "./common";

const W = { date: 58, no: 34, debit: 72, credit: 72, balance: 80 } as const;

/** 総勘定元帳 (14-reports §8): one account on A4 landscape with 繰越, 合計 and 残高. */
export function LedgerPdf({
  report,
  header,
}: {
  report: GeneralLedgerReport;
  header: PdfReportHeader;
}) {
  return (
    <ReportDocument
      title="総勘定元帳"
      company={header.company}
      periodLabel={header.periodLabel}
      subtitle={header.subtitle}
      exportedAt={header.exportedAt}
      orientation="landscape"
    >
      <PdfTable>
        <PdfRow variant="header" fixed>
          <PdfCell width={W.date}>日付</PdfCell>
          <PdfCell width={W.no}>No.</PdfCell>
          <PdfCell flex={2.2}>摘要</PdfCell>
          <PdfCell flex={1.3}>相手科目</PdfCell>
          <PdfCell width={W.debit} align="right">
            借方（円）
          </PdfCell>
          <PdfCell width={W.credit} align="right">
            貸方（円）
          </PdfCell>
          <PdfCell width={W.balance} align="right">
            残高（円）
          </PdfCell>
        </PdfRow>
        <PdfRow muted>
          <PdfCell width={W.date}>{slashDate(report.period.from)}</PdfCell>
          <PdfCell width={W.no} />
          <PdfCell flex={2.2} bold>
            繰越
          </PdfCell>
          <PdfCell flex={1.3} />
          <PdfCell width={W.debit} />
          <PdfCell width={W.credit} />
          <PdfCell width={W.balance} align="right">
            {amountText(report.opening)}
          </PdfCell>
        </PdfRow>
        {report.rows.map((row, i) => (
          <PdfRow key={`${row.entryId}:${i}`} muted={row.status === "voided"}>
            <PdfCell width={W.date}>{slashDate(row.entryDate)}</PdfCell>
            <PdfCell width={W.no}>{row.no}</PdfCell>
            <PdfCell flex={2.2}>
              {[
                row.lineDescription
                  ? `${row.description}（${row.lineDescription}）`
                  : row.description,
                row.stateLabel ?? "",
              ]
                .filter(Boolean)
                .join(" ")}
            </PdfCell>
            <PdfCell flex={1.3}>{row.counterpart}</PdfCell>
            <PdfCell width={W.debit} align="right">
              {row.debit === 0n ? "" : amountText(row.debit)}
            </PdfCell>
            <PdfCell width={W.credit} align="right">
              {row.credit === 0n ? "" : amountText(row.credit)}
            </PdfCell>
            <PdfCell width={W.balance} align="right">
              {amountText(row.balance)}
            </PdfCell>
          </PdfRow>
        ))}
        <PdfRow variant="subtotal">
          <PdfCell width={W.date} />
          <PdfCell width={W.no} />
          <PdfCell flex={2.2}>合計</PdfCell>
          <PdfCell flex={1.3} />
          <PdfCell width={W.debit} align="right">
            {amountText(report.debitTotal)}
          </PdfCell>
          <PdfCell width={W.credit} align="right">
            {amountText(report.creditTotal)}
          </PdfCell>
          <PdfCell width={W.balance} />
        </PdfRow>
        <PdfRow variant="total">
          <PdfCell width={W.date}>{slashDate(report.period.to)}</PdfCell>
          <PdfCell width={W.no} />
          <PdfCell flex={2.2}>残高</PdfCell>
          <PdfCell flex={1.3} />
          <PdfCell width={W.debit} />
          <PdfCell width={W.credit} />
          <PdfCell width={W.balance} align="right">
            {amountText(report.closing)}
          </PdfCell>
        </PdfRow>
      </PdfTable>
    </ReportDocument>
  );
}
