import type { ReceiptPdfData } from "@niho-finance/db";
import { formatYen } from "@niho-finance/ledger";
import { Document, Page, Text, View } from "@react-pdf/renderer";
import { createElement, type ReactNode } from "react";
import { formatPdfDateTime } from "./document";
import { japaneseDate, RateRows, recipientForFileName } from "./invoice";
import { renderPdf } from "./render";
import { PDF_COLORS, pdfStyles } from "./styles";
import { PdfCell, PdfRow, PdfTable } from "./table";

/**
 * 領収書の PDF (18-invoicing §15.2) on the PDF base of the invoices: A4, one page, drawn from the
 * copies on the receipt only (the recipient, the issuer and the totals per rate of the invoice when
 * it was issued), so it never changes after the issue. The documents customers receive follow the
 * NIHO app's receipts: 「2026年12月15日」, 「¥ 138,622 -」, 「<宛名> 様」. A 適格請求書's receipt
 * carries the registration number and the tax per rate; a 区分記載's the tax-inclusive amount per
 * rate with 「うち消費税相当額」.
 */

const AMOUNT_WIDTH = 98;

function Small({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[pdfStyles.small, muted ? pdfStyles.muted : {}]}>{children}</Text>;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: 1 }}>
      <Text style={[pdfStyles.muted, { width: 64, textAlign: "right", marginRight: 8 }]}>
        {label}
      </Text>
      <Text style={{ minWidth: 92 }}>{value}</Text>
    </View>
  );
}

function VoidNotice({ reason }: { reason: string | null }) {
  return (
    <View
      style={{
        borderWidth: 0.75,
        borderColor: PDF_COLORS.warn,
        color: PDF_COLORS.warn,
        paddingVertical: 4,
        paddingHorizontal: 8,
        marginBottom: 10,
      }}
    >
      <Text>無効{reason ? `（理由: ${reason}）` : ""}。この領収書は効力がありません</Text>
    </View>
  );
}

export function ReceiptPdf({
  data,
  exportedAt = new Date(),
}: {
  data: ReceiptPdfData;
  exportedAt?: Date;
}) {
  const { receipt, invoice, recipient, issuer } = data;
  return (
    <Document
      title={`領収書 ${receipt.number}`}
      author={issuer.name}
      creator="NIHO finance"
      producer="NIHO finance"
      language="ja"
    >
      <Page size="A4" style={pdfStyles.page}>
        {receipt.voided ? <VoidNotice reason={receipt.voidReason} /> : null}
        <View style={{ alignItems: "flex-end" }}>
          <MetaRow label="発行日" value={japaneseDate(receipt.issueDate)} />
          <MetaRow label="領収書番号" value={receipt.number} />
        </View>
        <Text
          style={[
            pdfStyles.title,
            { fontSize: 20, letterSpacing: 10, textAlign: "center", marginVertical: 18 },
          ]}
        >
          領収書
        </Text>

        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 24 }}>
          <View style={{ width: "56%" }}>
            <Text
              style={{
                fontSize: 13,
                fontWeight: 700,
                borderBottomWidth: 0.75,
                borderBottomColor: PDF_COLORS.text,
                paddingBottom: 3,
              }}
            >
              {recipient.name} 様
            </Text>
            <View style={{ marginTop: 8, gap: 2 }}>
              {invoice.title ? (
                <Text>
                  <Text style={pdfStyles.muted}>件名 </Text>
                  {invoice.title}
                </Text>
              ) : null}
              <Text>
                <Text style={pdfStyles.muted}>請求書番号 </Text>
                {invoice.number}
              </Text>
              <Text>
                <Text style={pdfStyles.muted}>入金日 </Text>
                {japaneseDate(receipt.receivedOn)}
              </Text>
            </View>
            <Text style={{ marginTop: 12 }}>下記のとおり領収いたしました。</Text>
            <View
              style={{
                marginTop: 8,
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "flex-end",
                borderBottomWidth: 1,
                borderBottomColor: PDF_COLORS.text,
                paddingBottom: 3,
              }}
            >
              <Text style={{ fontWeight: 700 }}>領収金額</Text>
              <Text style={{ fontSize: 18, fontWeight: 700 }}>¥ {formatYen(receipt.amount)} -</Text>
            </View>
            <Text style={{ marginTop: 8 }}>
              <Text style={pdfStyles.muted}>但し </Text>
              {receipt.proviso}
            </Text>
          </View>

          <View style={{ width: "38%", alignItems: "flex-end", paddingTop: 2 }}>
            <Text style={{ fontWeight: 700, fontSize: 11 }}>{issuer.name}</Text>
            {issuer.address ? <Small>{issuer.address}</Small> : null}
            {issuer.representative ? <Small>{issuer.representative}</Small> : null}
            {data.qualified && issuer.invoiceRegistrationNumber ? (
              <Text style={{ marginTop: 2 }}>登録番号 {issuer.invoiceRegistrationNumber}</Text>
            ) : null}
          </View>
        </View>

        <View wrap={false} style={{ marginTop: 22, flexDirection: "row" }}>
          <View style={{ flexGrow: 1 }} />
          <View style={{ width: "52%" }}>
            <Text style={pdfStyles.heading}>内訳</Text>
            <PdfTable style={{ marginBottom: 0 }}>
              {data.rates.map((rate) => (
                <RateRows
                  key={rate.taxCategoryCode}
                  rate={rate}
                  qualified={data.qualified}
                  pricesIncludeTax={false}
                />
              ))}
              <PdfRow variant="total">
                <PdfCell flex={1}>合計</PdfCell>
                <PdfCell width={AMOUNT_WIDTH} align="right" bold>
                  {formatYen(receipt.amount)} 円
                </PdfCell>
              </PdfRow>
            </PdfTable>
            {data.stampNote ? (
              <View style={{ marginTop: 6 }}>
                <Small muted>{data.stampNote}</Small>
              </View>
            ) : null}
          </View>
        </View>

        <View style={pdfStyles.footer} fixed>
          <Text>
            領収書 {receipt.number} · 出力日時 {formatPdfDateTime(exportedAt)}
          </Text>
          <Text>1 / 1 ページ</Text>
        </View>
      </Page>
    </Document>
  );
}

/** The PDF bytes of a receipt (fonts registered on the first call). */
export async function renderReceiptPdf(
  data: ReceiptPdfData,
  options: { exportedAt?: Date } = {},
): Promise<Uint8Array> {
  return renderPdf(
    createElement(ReceiptPdf, {
      data,
      ...(options.exportedAt ? { exportedAt: options.exportedAt } : {}),
    }),
  );
}

/**
 * File names (18 §15.2): ASCII `RC-2026-0001.pdf` and UTF-8 `20261215-<宛名>様_領収書_RC-2026-0001.pdf`
 * (the NIHO app's rule `発行日-宛名様_領収書_…`).
 */
export function receiptPdfFileNames(data: Pick<ReceiptPdfData, "receipt" | "recipient">): {
  fileName: string;
  utf8FileName: string;
} {
  const date = data.receipt.issueDate.replaceAll("-", "");
  const recipient = recipientForFileName(data.recipient.name);
  return {
    fileName: `${data.receipt.number}.pdf`,
    utf8FileName: `${date}-${recipient}様_領収書_${data.receipt.number}.pdf`,
  };
}
