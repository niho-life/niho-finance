import {
  getDocumentFile,
  getInvoiceDetail,
  invoiceMailSchema,
  markInvoiceSent,
  SettingsError,
  todayInJapan,
  type Db,
  type InvoiceMailInput,
} from "@niho-finance/db";
import { invoicePdfFileNames, renderInvoicePdf } from "@/lib/pdf/invoice";
import { sendMail, type MailTransport } from "@/lib/mail";
import { getDocumentStorage, StoredFileNotFoundError } from "@/lib/storage";

export interface SentInvoiceMail {
  transport: MailTransport;
  to: string[];
  /** `true` when the document was recorded as sent (only a mail that really went out). */
  recorded: boolean;
}

/** The PDF a mail attaches: the stored copy of the issued PDF, else one drawn now. */
async function pdfBytes(
  db: Db,
  detail: NonNullable<Awaited<ReturnType<typeof getInvoiceDetail>>>,
): Promise<Uint8Array> {
  if (detail.pdfDocumentId) {
    const file = await getDocumentFile(db, detail.pdfDocumentId);
    if (file) {
      try {
        return await getDocumentStorage().read(file.storageKey);
      } catch (error) {
        if (!(error instanceof StoredFileNotFoundError)) throw error;
      }
    }
  }
  return renderInvoicePdf(detail);
}

/**
 * メールで送付 (18 §11): the document's PDF goes to the partner as an attachment through S8's mail
 * (`sendMail`, the subject without the internal prefix). Only a mail that went out by SMTP records
 * 送付済み (`markInvoiceSent` with the subject, so a paid document can be sent again); the `log`
 * transport of development logs it and records nothing. A failed send throws with what is wrong.
 */
export async function sendInvoiceMail(
  db: Db,
  id: string,
  input: InvoiceMailInput,
  options: { actor: string },
): Promise<SentInvoiceMail> {
  const data = invoiceMailSchema.parse(input);
  const detail = await getInvoiceDetail(db, id, { today: todayInJapan() });
  if (!detail) throw new SettingsError("書類が見つかりません。画面を読み込み直してください");
  if (detail.status === "draft") {
    throw new SettingsError("下書きはメールで送れません。発行してから送ります");
  }
  if (detail.status === "void") throw new SettingsError("無効の書類はメールで送れません");

  const bytes = await pdfBytes(db, detail);
  const result = await sendMail({
    to: data.to,
    subject: data.subject,
    text: data.text,
    prefixSubject: false,
    attachments: [
      {
        filename: invoicePdfFileNames(detail).utf8FileName,
        content: Buffer.from(bytes),
        contentType: "application/pdf",
      },
    ],
  });
  if (!result.ok) {
    throw new SettingsError(
      `メールを送れませんでした（${result.error}）。設定を確かめてから、もう一度送ってください`,
    );
  }
  if (result.transport !== "smtp")
    return { transport: result.transport, to: data.to, recorded: false };
  await markInvoiceSent(db, id, { sentTo: data.to.join(", "), mailSubject: data.subject }, options);
  return { transport: result.transport, to: data.to, recorded: true };
}
