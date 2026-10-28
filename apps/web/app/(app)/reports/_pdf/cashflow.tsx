import { Text, View } from "@react-pdf/renderer";
import {
  CASHFLOW_EVENT_KIND_LABELS,
  cashflowEventText,
  slashDate,
  type CashflowForecast,
} from "@niho-finance/reports";
import { ReportDocument } from "@/lib/pdf/document";
import { PDF_COLORS, pdfStyles } from "@/lib/pdf/styles";
import { PdfCell, PdfRow, PdfTable } from "@/lib/pdf/table";
import { cashflowNoteText, CASHFLOW_BASIS_NOTE, negativeWarning } from "../_lib/cashflow-text";
import { amountText, type PdfReportHeader } from "./common";

const DATE_WIDTH = 58;
const KIND_WIDTH = 46;
const WALLET_WIDTH = 78;
const AMOUNT_WIDTH = 70;

/**
 * 資金繰り (21-cashflow §6): 予定の一覧 as the CSV has it (the start row first), A4 portrait, with
 * the three numbers above it and what is not in the forecast below it. Numbers are never red; the
 * warning of a day below 0 is a line of text.
 */
export function CashflowPdf({
  forecast,
  header,
}: {
  forecast: CashflowForecast;
  header: PdfReportHeader;
}) {
  const figures = [
    { label: "今日の現預金", value: forecast.opening.total, date: forecast.start },
    { label: "90 日後", value: forecast.final.balance, date: forecast.final.date },
    { label: "最低", value: forecast.lowest.balance, date: forecast.lowest.date },
  ];
  return (
    <ReportDocument
      title="資金繰り"
      company={header.company}
      periodLabel={header.periodLabel}
      subtitle={header.subtitle}
      exportedAt={header.exportedAt}
      orientation="portrait"
    >
      <View style={{ flexDirection: "row", marginBottom: 6 }}>
        {figures.map((figure) => (
          <View key={figure.label} style={{ flexGrow: 1, flexBasis: 0 }}>
            <Text style={{ fontSize: 7.5, color: PDF_COLORS.muted }}>
              {figure.label}（{slashDate(figure.date)}）
            </Text>
            <Text style={{ fontSize: 13, fontWeight: 700 }}>{amountText(figure.value)} 円</Text>
          </View>
        ))}
      </View>
      {forecast.firstNegative ? (
        <Text style={[pdfStyles.bold, { marginBottom: 4 }]}>
          {negativeWarning(forecast.firstNegative)}
        </Text>
      ) : null}

      <Text style={pdfStyles.heading}>予定の一覧</Text>
      <PdfTable>
        <PdfRow variant="header" fixed>
          <PdfCell width={DATE_WIDTH}>日付</PdfCell>
          <PdfCell flex={1}>内容</PdfCell>
          <PdfCell width={KIND_WIDTH}>種類</PdfCell>
          <PdfCell width={WALLET_WIDTH}>口座</PdfCell>
          <PdfCell width={AMOUNT_WIDTH} align="right">
            入出金（円）
          </PdfCell>
          <PdfCell width={AMOUNT_WIDTH} align="right">
            残高（円）
          </PdfCell>
        </PdfRow>
        <PdfRow variant="group">
          <PdfCell width={DATE_WIDTH}>{slashDate(forecast.start)}</PdfCell>
          <PdfCell flex={1}>今日の現預金</PdfCell>
          <PdfCell width={KIND_WIDTH} />
          <PdfCell width={WALLET_WIDTH} />
          <PdfCell width={AMOUNT_WIDTH} />
          <PdfCell width={AMOUNT_WIDTH} align="right">
            {amountText(forecast.opening.total)}
          </PdfCell>
        </PdfRow>
        {forecast.events.map((event) => (
          <PdfRow key={event.key} muted={event.amount === null}>
            <PdfCell width={DATE_WIDTH}>{slashDate(event.date)}</PdfCell>
            <PdfCell flex={1}>{cashflowEventText(event)}</PdfCell>
            <PdfCell width={KIND_WIDTH}>{CASHFLOW_EVENT_KIND_LABELS[event.kind]}</PdfCell>
            <PdfCell width={WALLET_WIDTH}>{event.walletName ?? ""}</PdfCell>
            <PdfCell width={AMOUNT_WIDTH} align="right">
              {event.amount === null ? "金額未定" : amountText(event.amount)}
            </PdfCell>
            <PdfCell
              width={AMOUNT_WIDTH}
              align="right"
              bold={event.balance !== null && event.balance < 0n}
            >
              {event.balance === null ? "—" : amountText(event.balance)}
            </PdfCell>
          </PdfRow>
        ))}
      </PdfTable>
      {forecast.events.length === 0 ? (
        <Text style={pdfStyles.note}>90 日のあいだに予定はありません。</Text>
      ) : null}

      {forecast.notes.length > 0 ? (
        <>
          <Text style={pdfStyles.heading} minPresenceAhead={30}>
            入っていないもの
          </Text>
          {forecast.notes.map((note) => {
            const text = cashflowNoteText(note);
            return (
              <Text key={text.key} style={{ marginBottom: 2 }}>
                ・{text.text}
              </Text>
            );
          })}
        </>
      ) : null}
      <Text style={[pdfStyles.note, { marginTop: 6 }]}>{CASHFLOW_BASIS_NOTE}</Text>
    </ReportDocument>
  );
}
