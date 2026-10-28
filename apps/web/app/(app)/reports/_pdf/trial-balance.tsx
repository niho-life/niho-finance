import { Text } from "@react-pdf/renderer";
import { slashDate, slashPeriod } from "@niho-finance/reports";
import { ReportDocument } from "@/lib/pdf/document";
import { pdfStyles } from "@/lib/pdf/styles";
import { PdfCell, PdfRow, PdfTable } from "@/lib/pdf/table";
import type { TrialBalanceLine, TrialBalanceView } from "../_lib/trial-balance-view";
import { amountText, type PdfReportHeader } from "./common";

const AMOUNT_WIDTH = 66;

function Header() {
  return (
    <PdfRow variant="header" fixed>
      <PdfCell flex={1}>科目</PdfCell>
      <PdfCell width={AMOUNT_WIDTH} align="right">
        期首（円）
      </PdfCell>
      <PdfCell width={AMOUNT_WIDTH} align="right">
        借方（円）
      </PdfCell>
      <PdfCell width={AMOUNT_WIDTH} align="right">
        貸方（円）
      </PdfCell>
      <PdfCell width={AMOUNT_WIDTH + 6} align="right">
        残高（円）
      </PdfCell>
    </PdfRow>
  );
}

function Line({ line }: { line: TrialBalanceLine }) {
  if (line.kind === "section") {
    return (
      <PdfRow variant="group">
        <PdfCell flex={1}>{line.label}</PdfCell>
      </PdfRow>
    );
  }
  if (line.kind === "subtotal" || line.kind === "total") {
    return (
      <PdfRow variant={line.kind}>
        <PdfCell flex={1}>{line.label}</PdfCell>
        <PdfCell width={AMOUNT_WIDTH} align="right">
          {amountText(line.opening)}
        </PdfCell>
        <PdfCell width={AMOUNT_WIDTH * 2} align="right">
          {line.period === null ? "" : `期間 ${amountText(line.period)}`}
        </PdfCell>
        <PdfCell width={AMOUNT_WIDTH + 6} align="right">
          {amountText(line.balance)}
        </PdfCell>
      </PdfRow>
    );
  }
  const indent = line.kind === "group" ? 0 : line.kind === "account" ? 1 : 2;
  return (
    <PdfRow muted={line.kind === "subAccount"}>
      <PdfCell flex={1} indent={indent} bold={line.kind === "group"}>
        {line.label}
      </PdfCell>
      <PdfCell width={AMOUNT_WIDTH} align="right">
        {amountText(line.opening)}
      </PdfCell>
      <PdfCell width={AMOUNT_WIDTH} align="right">
        {amountText(line.debit)}
      </PdfCell>
      <PdfCell width={AMOUNT_WIDTH} align="right">
        {amountText(line.credit)}
      </PdfCell>
      <PdfCell width={AMOUNT_WIDTH + 6} align="right">
        {amountText(line.balance)}
      </PdfCell>
    </PdfRow>
  );
}

/** 試算表 (14-reports §3): 貸借対照表 and 損益計算書 on A4 portrait. */
export function TrialBalancePdf({
  view,
  header,
}: {
  view: TrialBalanceView;
  header: PdfReportHeader;
}) {
  const { period } = view.report;
  return (
    <ReportDocument
      title="試算表"
      company={header.company}
      periodLabel={header.periodLabel}
      subtitle={header.subtitle}
      exportedAt={header.exportedAt}
      orientation="portrait"
    >
      {view.report.check.ok
        ? null
        : view.report.check.messages.map((message) => (
            <Text key={message} style={[pdfStyles.note, { color: "#b7791f" }]}>
              {message}
            </Text>
          ))}
      <Text style={pdfStyles.heading}>貸借対照表（{slashDate(period.to)} 時点）</Text>
      {view.report.incomeStatement.filteredBySegment ? (
        <Text style={pdfStyles.note}>貸借対照表は全社の数字です。</Text>
      ) : null}
      <PdfTable>
        <Header />
        {view.balanceSheet.map((line) => (
          <Line key={line.key} line={line} />
        ))}
      </PdfTable>
      <Text style={pdfStyles.heading} minPresenceAhead={80}>
        損益計算書（{slashPeriod(period.from, period.to)}）
      </Text>
      <PdfTable>
        <Header />
        {view.incomeStatement.map((line) => (
          <Line key={line.key} line={line} />
        ))}
      </PdfTable>
    </ReportDocument>
  );
}
