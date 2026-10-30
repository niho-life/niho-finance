import {
  attachInvoicePdf,
  attachReceiptPdf,
  getInvoiceDetail,
  getReceiptPdfData,
  todayInJapan,
  type Db,
} from "@niho-finance/db";
import { INVOICE_DOC_TYPE_LABELS, invoiceNumberLabel } from "@niho-finance/ledger";
import { invoicePdfFileNames, renderInvoicePdf } from "@/lib/pdf/invoice";
import { receiptPdfFileNames, renderReceiptPdf } from "@/lib/pdf/receipt";
import { saveBytesAsDocument } from "@/lib/storage/save";

/**
 * Keeps the PDF of an issued document as evidence (18 §11, 03 §2.3: the copy of an issued invoice is
 * kept 7 years): the PDF drawn from the stored document becomes a 証憑 (`source = generated`; 請求書
 * → `invoice_out`, 見積書・納品書 → `other`) linked to the document (`attachInvoicePdf`). Best
 * effort, like the CSV of an import: the document is already issued, so a failure is logged and
 * the detail offers to save it again. Returns the document's id, or `null`.
 */
export async function keepInvoicePdfAsDocument(
  db: Db,
  invoiceId: string,
  options: { actor: string },
): Promise<string | null> {
  try {
    const detail = await getInvoiceDetail(db, invoiceId, { today: todayInJapan() });
    if (!detail || detail.status === "draft" || detail.status === "void") return null;
    if (detail.pdfDocumentId) return detail.pdfDocumentId;
    const bytes = await renderInvoicePdf(detail);
    const typeLabel = INVOICE_DOC_TYPE_LABELS[detail.docType];
    const saved = await saveBytesAsDocument(
      db,
      {
        bytes,
        mime: "application/pdf",
        originalName: invoicePdfFileNames(detail).utf8FileName,
        kind: detail.docType === "invoice" ? "invoice_out" : "other",
        source: "generated",
        txnDate: detail.issueDate,
        amount: detail.total,
        // A partner deactivated since cannot be chosen on a document: its name is kept instead.
        partnerId: detail.recipient.partnerIsActive ? detail.recipient.partnerId : null,
        partnerName: detail.recipient.name,
        note: `${typeLabel} ${invoiceNumberLabel(detail.number)} の写し（発行した PDF）`,
      },
      options,
    );
    await attachInvoicePdf(db, invoiceId, { documentId: saved.documentId }, options);
    return saved.documentId;
  } catch (error) {
    console.error("[niho-finance] the issued PDF was not kept as a document", error);
    return null;
  }
}

/**
 * Keeps the PDF of an issued receipt as evidence (18 §15.3): the PDF drawn from the receipt's copies
 * becomes a 証憑 (`source = generated`, `other`, dated on the issue date, the amount and the partner,
 * 「領収書 RC-… の控え（発行した PDF）」) tied to the receipt, the invoice and its payments
 * (`attachReceiptPdf`). Best effort like the invoices' copy: the receipt is issued already, so a
 * failure is logged and the detail offers to save it again. Returns the document's id, or `null`.
 */
export async function keepReceiptPdfAsDocument(
  db: Db,
  input: { invoiceId: string; receiptId: string },
  options: { actor: string },
): Promise<string | null> {
  try {
    const data = await getReceiptPdfData(db, input.invoiceId, { receiptId: input.receiptId });
    if (!data || data.receipt.voided) return null;
    if (data.receipt.pdfDocumentId) return data.receipt.pdfDocumentId;
    const invoice = await getInvoiceDetail(db, input.invoiceId, { today: todayInJapan() });
    const bytes = await renderReceiptPdf(data);
    const saved = await saveBytesAsDocument(
      db,
      {
        bytes,
        mime: "application/pdf",
        originalName: receiptPdfFileNames(data).utf8FileName,
        kind: "other",
        source: "generated",
        txnDate: data.receipt.issueDate,
        amount: data.receipt.amount,
        // A partner deactivated since cannot be chosen on a document: its name is kept instead.
        partnerId: invoice?.recipient.partnerIsActive ? invoice.recipient.partnerId : null,
        partnerName: data.recipient.name,
        note: `領収書 ${data.receipt.number} の控え（発行した PDF）`,
      },
      options,
    );
    await attachReceiptPdf(db, input.receiptId, { documentId: saved.documentId }, options);
    return saved.documentId;
  } catch (error) {
    console.error("[niho-finance] the issued receipt PDF was not kept as a document", error);
    return null;
  }
}
