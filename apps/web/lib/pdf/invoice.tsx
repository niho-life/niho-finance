import type { InvoiceBankAccount, InvoiceDetail, InvoiceRateRow } from "@niho-finance/db";
import {
  BANK_ACCOUNT_TYPE_LABELS,
  displayDate,
  formatYen,
  INVOICE_DOC_TYPE_LABELS,
  INVOICE_DUE_DATE_LABELS,
  invoiceNumberLabel,
  type InvoiceDocType,
} from "@niho-finance/ledger";
import { Document, Page, Text, View } from "@react-pdf/renderer";
import { createElement, type ReactNode } from "react";
import { formatPdfDateTime } from "./document";
import { renderPdf } from "./render";
import { PDF_COLORS, pdfStyles } from "./styles";
import { PdfCell, PdfRow, PdfTable } from "./table";

/**
 * 見積書・納品書・請求書の PDF (18-invoicing §9.2, §11) on the PDF base of S7 (Noto Sans JP,
 * `PdfTable`). Drawn from what the document stores: the copies of the issuer and the recipient once
 * issued, the totals per rate as saved (never recomputed), so the PDF of an issued document is the
 * same whenever it is drawn. A 適格請求書 carries the registration number and the tax per rate; a
 * 区分記載請求書 the tax-inclusive amount per rate (the tax only as 「うち消費税相当額」).
 */
export type InvoicePdfData = Pick<
  InvoiceDetail,
  | "docType"
  | "number"
  | "status"
  | "title"
  | "issueDate"
  | "dueDate"
  | "pricesIncludeTax"
  | "note"
  | "issuer"
  | "recipient"
  | "qualified"
  | "lines"
  | "rates"
  | "hasReducedRate"
  | "total"
  | "voidReason"
>;

/** The amount the top of the document leads with. */
const TOTAL_LABELS: Readonly<Record<InvoiceDocType, string>> = {
  invoice: "ご請求金額",
  quote: "お見積金額",
  delivery: "合計金額",
};

const LEAD_LINES: Readonly<Record<InvoiceDocType, string>> = {
  invoice: "下記のとおりご請求申し上げます。",
  quote: "下記のとおりお見積り申し上げます。",
  delivery: "下記のとおり納品いたしました。",
};

const QUANTITY_WIDTH = 40;
const UNIT_WIDTH = 32;
const PRICE_WIDTH = 72;
const RATE_WIDTH = 68;
const AMOUNT_WIDTH = 78;
const DATE_WIDTH = 54;

function Small({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[pdfStyles.small, muted ? pdfStyles.muted : {}]}>{children}</Text>;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: 1 }}>
      <Text style={[pdfStyles.muted, { width: 56, textAlign: "right", marginRight: 8 }]}>
        {label}
      </Text>
      <Text style={{ minWidth: 92 }}>{value}</Text>
    </View>
  );
}

/** One rate of the totals: 適格 with its tax, 区分記載 tax-inclusive with the tax as a note. */
function RateRows({
  rate,
  qualified,
  pricesIncludeTax,
}: {
  rate: InvoiceRateRow;
  qualified: boolean;
  pricesIncludeTax: boolean;
}) {
  if (!rate.taxable) {
    return (
      <PdfRow>
        <PdfCell flex={1}>{rate.label}</PdfCell>
        <PdfCell width={AMOUNT_WIDTH + 20} align="right">
          {formatYen(rate.amountInclusive)} 円
        </PdfCell>
      </PdfRow>
    );
  }
  if (qualified) {
    return (
      <>
        <PdfRow>
          <PdfCell flex={1}>
            {rate.label} 対象{pricesIncludeTax ? "（税込）" : ""}
          </PdfCell>
          <PdfCell width={AMOUNT_WIDTH + 20} align="right">
            {formatYen(pricesIncludeTax ? rate.amountInclusive : rate.amountExclusive)} 円
          </PdfCell>
        </PdfRow>
        <PdfRow>
          <PdfCell flex={1}>{rate.label} 消費税</PdfCell>
          <PdfCell width={AMOUNT_WIDTH + 20} align="right">
            {formatYen(rate.taxAmount)} 円
          </PdfCell>
        </PdfRow>
      </>
    );
  }
  return (
    <PdfRow>
      <View style={{ flexGrow: 1, flexBasis: 0, paddingHorizontal: 4 }}>
        <Text>{rate.label} 対象（税込）</Text>
      </View>
      <View style={{ width: AMOUNT_WIDTH + 60, flexShrink: 0, paddingHorizontal: 4 }}>
        <Text style={{ textAlign: "right" }}>{formatYen(rate.amountInclusive)} 円</Text>
        <Text style={[pdfStyles.small, pdfStyles.muted, { textAlign: "right" }]}>
          うち消費税相当額 {formatYen(rate.taxAmount)} 円
        </Text>
      </View>
    </PdfRow>
  );
}

function BankAccount({ account }: { account: InvoiceBankAccount }) {
  const first = [
    account.bankName,
    account.branchName,
    account.accountType ? BANK_ACCOUNT_TYPE_LABELS[account.accountType] : null,
    account.accountNumber,
  ].filter(Boolean);
  return (
    <View wrap={false} style={{ marginTop: 10 }}>
      <Text style={pdfStyles.heading}>振込先</Text>
      {first.length > 0 ? <Text>{first.join(" ")}</Text> : null}
      {account.accountHolder ? <Text>口座名義 {account.accountHolder}</Text> : null}
      {account.note ? <Small muted>{account.note}</Small> : null}
    </View>
  );
}

/** The state that is not the document's own (a draft, a void one) said at the top. */
function StateNotice({ invoice }: { invoice: InvoicePdfData }) {
  let text: string | null = null;
  if (invoice.status === "draft") text = "下書き（発行前のため番号はありません）";
  if (invoice.status === "void") {
    text = `この書類は無効です${invoice.voidReason ? `（理由: ${invoice.voidReason}）` : ""}`;
  }
  if (!text) return null;
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
      <Text>{text}</Text>
    </View>
  );
}

export function InvoicePdf({
  invoice,
  exportedAt = new Date(),
}: {
  invoice: InvoicePdfData;
  exportedAt?: Date;
}) {
  const typeLabel = INVOICE_DOC_TYPE_LABELS[invoice.docType];
  const dueLabel = INVOICE_DUE_DATE_LABELS[invoice.docType];
  const number = invoiceNumberLabel(invoice.number);
  const { issuer, recipient } = invoice;
  const dated = invoice.lines.some((line) => line.date !== null);
  const reducedRate = invoice.rates.find((rate) => rate.reduced)?.ratePercent;

  return (
    <Document
      title={`${typeLabel} ${number}`}
      author={issuer.name ?? undefined}
      creator="NIHO finance"
      producer="NIHO finance"
      language="ja"
    >
      <Page size="A4" style={pdfStyles.page} wrap>
        <StateNotice invoice={invoice} />
        <Text style={[pdfStyles.title, { fontSize: 18, letterSpacing: 6, marginBottom: 14 }]}>
          {typeLabel}
        </Text>

        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 24 }}>
          <View style={{ width: "54%" }}>
            <Text
              style={{
                fontSize: 13,
                fontWeight: 700,
                borderBottomWidth: 0.75,
                borderBottomColor: PDF_COLORS.text,
                paddingBottom: 3,
              }}
            >
              {recipient.name} 御中
            </Text>
            {recipient.address ? (
              <View style={{ marginTop: 3 }}>
                <Small muted>{recipient.address}</Small>
              </View>
            ) : null}
            <Text style={{ marginTop: 10 }}>{LEAD_LINES[invoice.docType]}</Text>
            {invoice.title ? (
              <Text style={{ marginTop: 6 }}>
                <Text style={pdfStyles.muted}>件名 </Text>
                {invoice.title}
              </Text>
            ) : null}
            <View
              style={{
                marginTop: 10,
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "flex-end",
                borderBottomWidth: 1,
                borderBottomColor: PDF_COLORS.text,
                paddingBottom: 3,
              }}
            >
              <Text style={{ fontWeight: 700 }}>{TOTAL_LABELS[invoice.docType]}（税込）</Text>
              <Text style={{ fontSize: 16, fontWeight: 700 }}>{formatYen(invoice.total)} 円</Text>
            </View>
          </View>

          <View style={{ width: "40%" }}>
            <MetaRow label="番号" value={number} />
            <MetaRow label="発行日" value={displayDate(invoice.issueDate)} />
            {dueLabel ? (
              <MetaRow
                label={dueLabel}
                value={invoice.dueDate ? displayDate(invoice.dueDate) : "—"}
              />
            ) : null}
            <View style={{ marginTop: 10, alignItems: "flex-end" }}>
              <Text style={{ fontWeight: 700, fontSize: 11 }}>
                {issuer.name ?? "（商号が未設定）"}
              </Text>
              {issuer.address ? <Small>{issuer.address}</Small> : null}
              {issuer.representative ? <Small>{issuer.representative}</Small> : null}
              {invoice.qualified && issuer.invoiceRegistrationNumber ? (
                <Text style={{ marginTop: 2 }}>登録番号 {issuer.invoiceRegistrationNumber}</Text>
              ) : null}
            </View>
          </View>
        </View>

        <View style={{ marginTop: 16 }}>
          <PdfTable>
            <PdfRow variant="header" fixed>
              {dated ? <PdfCell width={DATE_WIDTH}>日付</PdfCell> : null}
              <PdfCell flex={1}>品名</PdfCell>
              <PdfCell width={QUANTITY_WIDTH} align="right">
                数量
              </PdfCell>
              <PdfCell width={UNIT_WIDTH}>単位</PdfCell>
              <PdfCell width={PRICE_WIDTH} align="right">
                単価（円）
              </PdfCell>
              <PdfCell width={RATE_WIDTH} align="right">
                税率
              </PdfCell>
              <PdfCell width={AMOUNT_WIDTH} align="right">
                金額（円）
              </PdfCell>
            </PdfRow>
            {invoice.lines.map((line, index) => (
              <PdfRow key={index}>
                {dated ? (
                  <PdfCell width={DATE_WIDTH}>{line.date ? displayDate(line.date) : ""}</PdfCell>
                ) : null}
                <PdfCell flex={1}>
                  {line.name}
                  {line.reduced ? " ※" : ""}
                </PdfCell>
                <PdfCell width={QUANTITY_WIDTH} align="right">
                  {line.quantity}
                </PdfCell>
                <PdfCell width={UNIT_WIDTH}>{line.unit ?? ""}</PdfCell>
                <PdfCell width={PRICE_WIDTH} align="right">
                  {formatYen(line.unitPrice)}
                </PdfCell>
                <PdfCell width={RATE_WIDTH} align="right">
                  {invoice.rates.find((rate) => rate.taxCategoryCode === line.taxCategoryCode)
                    ?.label ?? ""}
                </PdfCell>
                <PdfCell width={AMOUNT_WIDTH} align="right">
                  {formatYen(line.amount)}
                </PdfCell>
              </PdfRow>
            ))}
          </PdfTable>
          {invoice.hasReducedRate ? (
            <Small muted>※ は軽減税率（{reducedRate ?? 8}%）の対象です</Small>
          ) : null}
          {!invoice.pricesIncludeTax ? null : <Small muted>単価は税込です</Small>}
        </View>

        <View wrap={false} style={{ marginTop: 10, flexDirection: "row" }}>
          <View style={{ flexGrow: 1 }} />
          <View style={{ width: "50%" }}>
            <PdfTable style={{ marginBottom: 0 }}>
              {invoice.rates.map((rate) => (
                <RateRows
                  key={rate.taxCategoryCode}
                  rate={rate}
                  qualified={invoice.qualified}
                  pricesIncludeTax={invoice.pricesIncludeTax}
                />
              ))}
              <PdfRow variant="total">
                <PdfCell flex={1}>合計</PdfCell>
                <PdfCell width={AMOUNT_WIDTH + 20} align="right" bold>
                  {formatYen(invoice.total)} 円
                </PdfCell>
              </PdfRow>
            </PdfTable>
          </View>
        </View>

        {invoice.docType === "invoice" && issuer.bankAccount ? (
          <BankAccount account={issuer.bankAccount} />
        ) : null}
        {invoice.note ? (
          <View wrap={false} style={{ marginTop: 10 }}>
            <Text style={pdfStyles.heading}>備考</Text>
            <Text>{invoice.note}</Text>
          </View>
        ) : null}

        <View style={pdfStyles.footer} fixed>
          <Text>
            {typeLabel} {number} · 出力日時 {formatPdfDateTime(exportedAt)}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages} ページ`} />
        </View>
      </Page>
    </Document>
  );
}

/** The PDF bytes of a document (fonts registered on the first call). */
export async function renderInvoicePdf(
  invoice: InvoicePdfData,
  options: { exportedAt?: Date } = {},
): Promise<Uint8Array> {
  return renderPdf(
    createElement(InvoicePdf, {
      invoice,
      ...(options.exportedAt ? { exportedAt: options.exportedAt } : {}),
    }),
  );
}

/** `INV-2026-0001.pdf` (ASCII) and `請求書_INV-2026-0001_<取引先>.pdf` (UTF-8). */
export function invoicePdfFileNames(
  invoice: Pick<InvoicePdfData, "docType" | "number" | "recipient">,
): {
  fileName: string;
  utf8FileName: string;
} {
  const number = invoiceNumberLabel(invoice.number);
  const ascii = number === invoice.number ? number : `${invoice.docType}-draft`;
  const typeLabel = INVOICE_DOC_TYPE_LABELS[invoice.docType];
  return {
    fileName: `${ascii}.pdf`,
    utf8FileName: `${typeLabel}_${number}_${invoice.recipient.name}.pdf`,
  };
}
