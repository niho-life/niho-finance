import { Text, View } from "@react-pdf/renderer";
import { WALLET_KIND_LABELS } from "@niho-finance/ledger";
import { slashDate, type CashReport, type CashWalletRow } from "@niho-finance/reports";
import { ReportDocument } from "@/lib/pdf/document";
import { PDF_COLORS, pdfStyles } from "@/lib/pdf/styles";
import { PdfCell, PdfRow, PdfTable } from "@/lib/pdf/table";
import { cashMonthEndRows } from "../_lib/csv-rows";
import { amountText, type PdfReportHeader } from "./common";

function statementText(wallet: CashWalletRow): string {
  const statement = wallet.statement;
  if (!statement) return "明細なし";
  if (statement.difference === 0n) return `明細の残高と一致（${slashDate(statement.date)}）`;
  const difference = statement.difference < 0n ? -statement.difference : statement.difference;
  return `明細の残高と ${amountText(difference)} 円の差（${slashDate(statement.date)} 時点）`;
}

/**
 * 現預金 (14-reports §6): the total and the wallets on `to`, the cards and advances, and the
 * month-end balances (the CSV's table, turned so that months are rows and A4 portrait fits a
 * year).
 */
export function CashPdf({ report, header }: { report: CashReport; header: PdfReportHeader }) {
  const monthEnds = cashMonthEndRows(report);
  const count = monthEnds.length + 1;
  const width = Math.min(80, Math.floor(420 / count));
  return (
    <ReportDocument
      title="現預金"
      company={header.company}
      periodLabel={header.periodLabel}
      subtitle={header.subtitle}
      exportedAt={header.exportedAt}
      orientation="portrait"
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", marginBottom: 6 }}>
        <Text style={{ fontSize: 10, color: PDF_COLORS.muted, marginRight: 8 }}>
          現預金（{slashDate(report.asOf)} 時点）
        </Text>
        <Text style={{ fontSize: 16, fontWeight: 700 }}>{amountText(report.total)} 円</Text>
      </View>

      <Text style={pdfStyles.heading}>口座</Text>
      <PdfTable>
        <PdfRow variant="header" fixed>
          <PdfCell flex={2}>名前</PdfCell>
          <PdfCell width={60}>種類</PdfCell>
          <PdfCell width={80} align="right">
            残高（円）
          </PdfCell>
          <PdfCell width={46} align="right">
            未処理
          </PdfCell>
          <PdfCell flex={2.4}>明細の残高</PdfCell>
        </PdfRow>
        {report.wallets.map((wallet) => (
          <PdfRow key={wallet.walletId}>
            <PdfCell flex={2}>
              {wallet.kind === "stripe" ? `${wallet.name}（入金待ち）` : wallet.name}
            </PdfCell>
            <PdfCell width={60}>{WALLET_KIND_LABELS[wallet.kind]}</PdfCell>
            <PdfCell width={80} align="right">
              {amountText(wallet.balance)}
            </PdfCell>
            <PdfCell width={46} align="right">
              {wallet.pendingCount > 0 ? `${wallet.pendingCount} 件` : "—"}
            </PdfCell>
            <PdfCell flex={2.4} muted={wallet.statement?.difference === 0n || !wallet.statement}>
              {statementText(wallet)}
            </PdfCell>
          </PdfRow>
        ))}
        {report.unassigned.map((row) => (
          <PdfRow key={`${row.accountId}:${row.subAccountId ?? ""}`} muted>
            <PdfCell flex={2}>
              {row.subAccountName ? `${row.accountName} / ${row.subAccountName}` : row.accountName}
            </PdfCell>
            <PdfCell width={60}>口座なし</PdfCell>
            <PdfCell width={80} align="right">
              {amountText(row.balance)}
            </PdfCell>
            <PdfCell width={46} />
            <PdfCell flex={2.4} />
          </PdfRow>
        ))}
        <PdfRow variant="total">
          <PdfCell flex={2}>合計</PdfCell>
          <PdfCell width={60} />
          <PdfCell width={80} align="right">
            {amountText(report.total)}
          </PdfCell>
          <PdfCell width={46} />
          <PdfCell flex={2.4} />
        </PdfRow>
      </PdfTable>

      {report.otherWallets.length > 0 ? (
        <>
          <Text style={pdfStyles.heading}>未払・立替</Text>
          <PdfTable>
            <PdfRow variant="header" fixed>
              <PdfCell flex={2}>名前</PdfCell>
              <PdfCell width={60}>種類</PdfCell>
              <PdfCell width={80} align="right">
                残高（円）
              </PdfCell>
              <PdfCell width={46} align="right">
                未処理
              </PdfCell>
              <PdfCell flex={2.4} />
            </PdfRow>
            {report.otherWallets.map((wallet) => (
              <PdfRow key={wallet.walletId}>
                <PdfCell flex={2}>{wallet.name}</PdfCell>
                <PdfCell width={60}>{WALLET_KIND_LABELS[wallet.kind]}</PdfCell>
                <PdfCell width={80} align="right">
                  {amountText(wallet.balance)}
                </PdfCell>
                <PdfCell width={46} align="right">
                  {wallet.pendingCount > 0 ? `${wallet.pendingCount} 件` : "—"}
                </PdfCell>
                <PdfCell flex={2.4} />
              </PdfRow>
            ))}
          </PdfTable>
        </>
      ) : null}

      <Text style={pdfStyles.heading} minPresenceAhead={60}>
        月末残高
      </Text>
      <PdfTable style={count > 6 ? { fontSize: 7.5 } : {}}>
        <PdfRow variant="header" fixed>
          <PdfCell flex={1}>日付（円）</PdfCell>
          {monthEnds.map((row) => (
            <PdfCell key={row.label} width={width} align="right">
              {row.label}
            </PdfCell>
          ))}
          <PdfCell width={width} align="right">
            合計
          </PdfCell>
        </PdfRow>
        {report.monthEnds.columns.map((column, i) => (
          <PdfRow key={column.key}>
            <PdfCell flex={1}>{slashDate(column.to)}</PdfCell>
            {monthEnds.map((row) => (
              <PdfCell key={row.label} width={width} align="right">
                {amountText(row.balances[i])}
              </PdfCell>
            ))}
            <PdfCell width={width} align="right" bold>
              {amountText(report.monthEnds.total[i])}
            </PdfCell>
          </PdfRow>
        ))}
      </PdfTable>
    </ReportDocument>
  );
}
