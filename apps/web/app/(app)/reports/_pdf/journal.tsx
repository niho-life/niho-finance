import { Text, View } from "@react-pdf/renderer";
import { slashDate, type JournalEntryRow } from "@niho-finance/reports";
import { ReportDocument } from "@/lib/pdf/document";
import { PDF_COLORS, pdfStyles } from "@/lib/pdf/styles";
import { PdfCell, PdfRow, PdfTable } from "@/lib/pdf/table";
import { amountText, type PdfReportHeader } from "./common";

const W = { side: 30, debit: 66, credit: 66, tax: 112, segment: 72, partner: 92 } as const;

function TableHeader() {
  return (
    <PdfRow variant="header" fixed>
      <PdfCell width={W.side}>貸借</PdfCell>
      <PdfCell flex={2}>科目 / 補助科目</PdfCell>
      <PdfCell width={W.debit} align="right">
        借方（円）
      </PdfCell>
      <PdfCell width={W.credit} align="right">
        貸方（円）
      </PdfCell>
      <PdfCell width={W.tax}>税区分（税額）</PdfCell>
      <PdfCell width={W.segment}>セグメント</PdfCell>
      <PdfCell width={W.partner}>取引先</PdfCell>
      <PdfCell flex={1.6}>行の摘要</PdfCell>
    </PdfRow>
  );
}

/** One entry: its heading and its lines kept on one page when they fit (14-reports §7). */
function Entry({ entry }: { entry: JournalEntryRow }) {
  const voided = entry.status === "voided";
  return (
    <View wrap={entry.lines.length > 24}>
      <View
        wrap={false}
        minPresenceAhead={30}
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          paddingVertical: 3,
          paddingHorizontal: 4,
          backgroundColor: PDF_COLORS.fill,
          borderBottomWidth: 0.5,
          borderBottomColor: PDF_COLORS.border,
          color: voided ? PDF_COLORS.muted : PDF_COLORS.text,
        }}
      >
        <Text style={{ marginRight: 10 }}>{slashDate(entry.entryDate)}</Text>
        <Text style={{ marginRight: 10 }}>No. {entry.no}</Text>
        <Text style={{ marginRight: 10, fontWeight: 700 }}>{entry.description}</Text>
        <Text style={[pdfStyles.small, pdfStyles.muted, { marginRight: 8 }]}>
          {entry.kindLabel}
        </Text>
        {entry.stateLabel ? (
          <Text style={[pdfStyles.small, pdfStyles.muted]}>{entry.stateLabel}</Text>
        ) : null}
      </View>
      {entry.lines.map((line) => (
        <PdfRow key={line.lineNo} muted={voided}>
          <PdfCell width={W.side} muted>
            {line.side === "debit" ? "借方" : "貸方"}
          </PdfCell>
          <PdfCell flex={2}>
            {line.subAccountName
              ? `${line.accountName} / ${line.subAccountName}`
              : line.accountName}
          </PdfCell>
          <PdfCell width={W.debit} align="right">
            {line.side === "debit" ? amountText(line.amount) : ""}
          </PdfCell>
          <PdfCell width={W.credit} align="right">
            {line.side === "credit" ? amountText(line.amount) : ""}
          </PdfCell>
          <PdfCell width={W.tax}>
            {line.taxAmount !== 0n
              ? `${line.taxName}（${amountText(line.taxAmount)}）`
              : line.taxName}
          </PdfCell>
          <PdfCell width={W.segment}>{line.segmentName ?? ""}</PdfCell>
          <PdfCell width={W.partner}>{line.partnerName ?? ""}</PdfCell>
          <PdfCell flex={1.6}>
            {[line.description ?? "", ...line.memoTagNames.map((name) => `#${name}`)]
              .filter(Boolean)
              .join(" ")}
          </PdfCell>
        </PdfRow>
      ))}
    </View>
  );
}

/** 仕訳帳 (14-reports §7): every entry of the period on A4 landscape, with the totals. */
export function JournalPdf({
  entries,
  header,
}: {
  entries: readonly JournalEntryRow[];
  header: PdfReportHeader;
}) {
  let debit = 0n;
  let credit = 0n;
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.side === "debit") debit += line.amount;
      else credit += line.amount;
    }
  }
  return (
    <ReportDocument
      title="仕訳帳"
      company={header.company}
      periodLabel={header.periodLabel}
      subtitle={header.subtitle}
      exportedAt={header.exportedAt}
      orientation="landscape"
    >
      <PdfTable>
        <TableHeader />
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
        <PdfRow variant="total">
          <PdfCell width={W.side} />
          <PdfCell flex={2}>合計（{entries.length} 件）</PdfCell>
          <PdfCell width={W.debit} align="right">
            {amountText(debit)}
          </PdfCell>
          <PdfCell width={W.credit} align="right">
            {amountText(credit)}
          </PdfCell>
          <PdfCell width={W.tax} />
          <PdfCell width={W.segment} />
          <PdfCell width={W.partner} />
          <PdfCell flex={1.6} />
        </PdfRow>
      </PdfTable>
    </ReportDocument>
  );
}
