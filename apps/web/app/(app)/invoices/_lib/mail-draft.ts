import type { InvoiceDetail } from "@niho-finance/db";
import {
  BANK_ACCOUNT_TYPE_LABELS,
  dateParts,
  formatYen,
  INVOICE_DOC_TYPE_LABELS,
  INVOICE_DUE_DATE_LABELS,
  invoiceNumberLabel,
  type CalendarDate,
  type InvoiceDocType,
} from "@niho-finance/ledger";

/** What the mail form starts with (18 §11); the owner edits it before sending. */
export interface InvoiceMailDraft {
  /** The partner's address, else the last destination, else empty. */
  to: string;
  subject: string;
  text: string;
}

export type InvoiceMailSource = Pick<
  InvoiceDetail,
  "docType" | "number" | "dueDate" | "total" | "issuer" | "recipient" | "sentTo"
>;

const AMOUNT_LABELS: Readonly<Record<InvoiceDocType, string>> = {
  invoice: "ご請求金額",
  quote: "お見積金額",
  delivery: "合計金額",
};

/** `2027年1月31日`, as the PDF writes dates. */
function japaneseDate(date: CalendarDate): string {
  const { year, month, day } = dateParts(date);
  return `${year}年${month}月${day}日`;
}

/** The last destination when it was a mail address (送付済みにする may have recorded a method). */
function lastAddress(sentTo: string | null): string | null {
  if (!sentTo) return null;
  return /^[^\s@,;]+@[^\s@,;]+(\s*,\s*[^\s@,;]+@[^\s@,;]+)*$/.test(sentTo.trim())
    ? sentTo.trim()
    : null;
}

/**
 * The default mail of a document: a plain-text business letter to the partner with the amount, the
 * due date and (請求書) the 振込先, signed with the company's name. The PDF goes as an attachment.
 */
export function buildInvoiceMailDraft(invoice: InvoiceMailSource): InvoiceMailDraft {
  const typeLabel = INVOICE_DOC_TYPE_LABELS[invoice.docType];
  const number = invoiceNumberLabel(invoice.number);
  const issuer = invoice.issuer.name ?? "";
  const dueLabel = INVOICE_DUE_DATE_LABELS[invoice.docType];
  const facts = [`${AMOUNT_LABELS[invoice.docType]}：¥ ${formatYen(invoice.total)}（税込）`];
  if (dueLabel && invoice.dueDate) facts.push(`${dueLabel}：${japaneseDate(invoice.dueDate)}`);
  const bank = invoice.docType === "invoice" ? invoice.issuer.bankAccount : null;
  if (bank) {
    const account = [
      bank.bankName,
      bank.branchName,
      bank.accountType ? BANK_ACCOUNT_TYPE_LABELS[bank.accountType] : null,
      bank.accountNumber,
    ].filter(Boolean);
    if (account.length > 0) facts.push(`お振込先：${account.join(" ")}`);
    if (bank.accountHolder) facts.push(`口座名義：${bank.accountHolder}`);
    if (bank.note) facts.push(bank.note);
  }
  const lines = [
    `${invoice.recipient.name} ご担当者様`,
    "",
    `いつもお世話になっております。${issuer ? `${issuer}です。` : ""}`,
    `${typeLabel}（${number}）をお送りします。添付の PDF をご確認ください。`,
    "",
    ...facts,
    "",
    "ご不明な点がありましたら、このメールにご返信ください。",
    "よろしくお願いいたします。",
    ...(issuer ? ["", issuer] : []),
  ];
  return {
    to: invoice.recipient.email ?? lastAddress(invoice.sentTo) ?? "",
    subject: `${typeLabel}（${number}）のご送付${issuer ? `｜${issuer}` : ""}`,
    text: `${lines.join("\n")}\n`,
  };
}
