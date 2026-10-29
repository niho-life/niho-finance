/**
 * 領収書 (18-invoicing §15): issued from a paid invoice with the copies of its recipient, issuer and
 * totals per tax rate, numbered `RC-<期>-<連番>` under an advisory lock like the documents (§2). It
 * never touches the ledger. After the issue only the void (once, with a reason) and the stored PDF
 * (once) change; the DB trigger refuses anything else and every DELETE.
 *
 * Every write runs in one transaction that first locks the invoice's row (the same lock as the
 * invoice's own writes, so 入金の取消 and 無効 see the receipt in force), then the receipt's row and
 * the number's lock, and appends to the audit log (`receipt.*`).
 */
import {
  defaultReceiptProviso,
  displayDate,
  formatReceiptNumber,
  INVOICE_STATUS_LABELS,
  nextInvoiceSequence,
  RECEIPT_STAMP_HELP,
  receiptDateProblem,
  receiptNumberPrefix,
  receiptStampNote,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";
import type { FiscalYear, Invoice, Receipt } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, todayInJapan, toDbDate } from "./dates";
import { linkDocument } from "./documents";
import { isUniqueViolation, SettingsError } from "./errors";
import { newId } from "./ids";
import {
  fiscalYearOn,
  json,
  lockInvoice,
  noFiscalYearMessage,
  readIssuerSnapshot,
  readPayments,
  readRecipientSnapshot,
  storedRates,
  type InvoiceIssuerSnapshot,
  type InvoiceRateRow,
  type InvoiceRecipientSnapshot,
  type StoredInvoicePayment,
} from "./invoices";
import type { ActorOptions } from "./journal";
import {
  receiptIssueSchema,
  receiptVoidSchema,
  type ReceiptIssueInput,
  type ReceiptVoidInput,
} from "./schemas";
import { runInTransaction, type Tx } from "./transaction";

/** The advisory lock of the receipts' numbering, next to the documents' (7_316_00x). */
const RECEIPT_NUMBER_LOCK_KEY = 7_316_004;

const NOT_FOUND = "領収書が見つかりません。画面を読み込み直してください";
const ONLY_PAID = "領収書を発行できるのは入金済みの請求書だけです";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A receipt as the invoice's detail and the PDF show it. */
export interface ReceiptView {
  id: string;
  invoiceId: string;
  /** RC-2026-0001 */
  number: string;
  issueDate: CalendarDate;
  /** 入金日: the last payment of the invoice. */
  receivedOn: CalendarDate;
  amount: Money;
  /** 但し書き */
  proviso: string;
  /** 宛名 as copied (the screens and the PDF add 「様」). */
  recipientName: string;
  /** The stored copy of the issued PDF (証憑); `null` until it is saved. */
  pdfDocumentId: string | null;
  issuedAt: Date;
  issuedBy: string;
  voided: boolean;
  voidedAt: Date | null;
  voidReason: string | null;
}

function toView(row: Receipt): ReceiptView {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    number: row.number,
    issueDate: fromDbDate(row.issueDate),
    receivedOn: fromDbDate(row.receivedOn),
    amount: row.amount,
    proviso: row.proviso,
    recipientName: readRecipientSnapshot(row.recipientSnapshot)?.name ?? "",
    pdfDocumentId: row.pdfDocumentId,
    issuedAt: row.issuedAt,
    issuedBy: row.issuedBy,
    voided: row.voidedAt !== null,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
  };
}

function paymentsInForce(invoice: Pick<Invoice, "payments">): StoredInvoicePayment[] {
  return readPayments(invoice.payments).filter((payment) => payment.cancelledAt === null);
}

/** 入金日 of a receipt: the date of the last payment in force. */
function lastPaidOn(invoice: Pick<Invoice, "payments">): CalendarDate | null {
  return paymentsInForce(invoice).reduce<CalendarDate | null>(
    (latest, payment) => (latest === null || payment.paidOn > latest ? payment.paidOn : latest),
    null,
  );
}

/** Why the invoice takes no receipt now (not paid, a payment dated after today), or `null`. */
function issueProblem(
  invoice: Pick<Invoice, "docType" | "status" | "payments">,
  today: CalendarDate,
): string | null {
  if (invoice.docType !== "invoice" || invoice.status !== "paid") return ONLY_PAID;
  const receivedOn = lastPaidOn(invoice);
  if (receivedOn === null) return ONLY_PAID;
  if (receivedOn > today) {
    return `入金日（${displayDate(receivedOn)}）が来てから発行できます`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reads (18 §15.4, §15.2)
// ---------------------------------------------------------------------------

/** The 領収書 section of an invoice's detail (18 §15.4). */
export interface InvoiceReceipts {
  invoiceId: string;
  /** Only a paid invoice shows the section; void receipts show whatever the state. */
  available: boolean;
  /** The receipt in force. */
  current: ReceiptView | null;
  /** Void receipts, the newest first (番号・無効の理由). */
  voided: ReceiptView[];
  /** 「領収書を発行」: paid, no receipt in force, the last payment not after today. */
  canIssue: boolean;
  /** Why not, when the invoice is paid and none is in force (e.g. a payment dated later). */
  blocked: string | null;
  /** The issue sheet's defaults and its 見本. */
  defaults: {
    /** Today. */
    issueDate: CalendarDate;
    proviso: string;
    receivedOn: CalendarDate | null;
    amount: Money;
    /** 宛名 without 「様」. */
    recipientName: string;
    /** 「紙に印刷して渡すときは収入印紙が要ります（5 万円以上）」 at or above 50,000 円 without tax. */
    stampHelp: string | null;
  };
}

/** The receipts of an invoice and what can be done (18 §15.4); `null` when the invoice is missing. */
export async function getInvoiceReceipts(
  db: Db,
  invoiceId: string,
  options: { today?: CalendarDate } = {},
): Promise<InvoiceReceipts | null> {
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return null;
  const today = options.today ?? todayInJapan();
  const rows = await db.receipt.findMany({
    where: { invoiceId },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
  });
  const receipts = rows.map(toView);
  const current = receipts.find((receipt) => !receipt.voided) ?? null;
  const paid = invoice.docType === "invoice" && invoice.status === "paid";
  const problem = issueProblem(invoice, today);
  return {
    invoiceId,
    available: paid,
    current,
    voided: receipts.filter((receipt) => receipt.voided),
    canIssue: current === null && problem === null,
    blocked: paid && current === null ? problem : null,
    defaults: {
      issueDate: today,
      proviso: defaultReceiptProviso(invoice.title),
      receivedOn: lastPaidOn(invoice),
      amount: invoice.total,
      recipientName: readRecipientSnapshot(invoice.recipientSnapshot)?.name ?? "",
      stampHelp: receiptStampNote(storedRates(invoice)) === null ? null : RECEIPT_STAMP_HELP,
    },
  };
}

/** What the PDF of a receipt draws (18 §15.2), all from the copies on the receipt. */
export interface ReceiptPdfData {
  receipt: ReceiptView;
  /** The invoice the receipt refers to (件名・請求書番号). */
  invoice: { id: string; number: string; title: string | null };
  recipient: InvoiceRecipientSnapshot;
  issuer: InvoiceIssuerSnapshot;
  /** 適格請求書 → 登録番号 and per rate 対価の額・消費税額; else 税込の対価 and うち消費税相当額. */
  qualified: boolean;
  rates: InvoiceRateRow[];
  amountExclusive: Money;
  taxTotal: Money;
  /** 「電子領収書につき収入印紙は不要です」 at or above 50,000 円 without the tax, else `null`. */
  stampNote: string | null;
}

/**
 * The PDF data of an invoice's receipt: `receiptId`, else the receipt in force, else the latest void
 * one (the PDF then says 無効 with the reason). `null` when the invoice has none.
 */
export async function getReceiptPdfData(
  db: Db,
  invoiceId: string,
  options: { receiptId?: string | null } = {},
): Promise<ReceiptPdfData | null> {
  const rows = await db.receipt.findMany({
    where: { invoiceId, ...(options.receiptId ? { id: options.receiptId } : {}) },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    include: { invoice: { select: { id: true, number: true, title: true } } },
  });
  const row = rows.find((item) => item.voidedAt === null) ?? rows[0];
  if (!row) return null;
  const issuer = readIssuerSnapshot(row.issuerSnapshot);
  const recipient = readRecipientSnapshot(row.recipientSnapshot);
  if (!issuer || !recipient) return null;
  const rates = storedRates(row);
  let amountExclusive = 0n;
  let taxTotal = 0n;
  for (const rate of rates) {
    amountExclusive += rate.amountExclusive;
    taxTotal += rate.taxAmount;
  }
  return {
    receipt: toView(row),
    invoice: row.invoice,
    recipient,
    issuer,
    qualified: issuer.qualified,
    rates,
    amountExclusive,
    taxTotal,
    stampNote: receiptStampNote(rates),
  };
}

// ---------------------------------------------------------------------------
// Writes (18 §15.1, §15.3, §15.4)
// ---------------------------------------------------------------------------

async function lockNumbering(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${RECEIPT_NUMBER_LOCK_KEY}::bigint)::text AS "locked"`;
}

/** The next receipt number of the fiscal year (void ones count: no gaps). */
async function nextReceiptNumber(tx: Tx, fiscalYear: FiscalYear): Promise<string> {
  const startDate = fromDbDate(fiscalYear.startDate);
  const prefix = receiptNumberPrefix(startDate);
  const given = await tx.receipt.findMany({
    where: { number: { startsWith: prefix } },
    select: { number: true },
  });
  return formatReceiptNumber(
    startDate,
    nextInvoiceSequence(
      given.map((row) => row.number),
      prefix,
    ),
  );
}

/** Locks the receipt's invoice, then the receipt, and reads it. */
async function lockReceipt(tx: Tx, receiptId: string): Promise<{ invoice: Invoice; row: Receipt }> {
  const found = await tx.receipt.findUnique({
    where: { id: receiptId },
    select: { invoiceId: true },
  });
  if (!found) throw new SettingsError(NOT_FOUND);
  const invoice = await lockInvoice(tx, found.invoiceId);
  await tx.$queryRaw`SELECT "id" FROM "receipt" WHERE "id" = ${receiptId} FOR UPDATE`;
  const row = await tx.receipt.findUniqueOrThrow({ where: { id: receiptId } });
  return { invoice, row };
}

/**
 * 領収書を発行 (18 §15.1): a paid invoice gets a receipt of its total (the payments' applied amounts:
 * a fee the customer deducted is received in full), dated `issueDate` (on or after the last payment,
 * not after today, in a fiscal year), with the 但し書き (empty → 「<件名> の代金として」), the copies
 * of the invoice's recipient, issuer and totals per rate, and the next number `RC-<期>-<連番>`.
 * Refused while a receipt is in force (void it first).
 */
export async function issueReceipt(
  db: Db,
  invoiceId: string,
  input: ReceiptIssueInput,
  options: ActorOptions & { today?: CalendarDate },
): Promise<ReceiptView> {
  const data = receiptIssueSchema.parse(input);
  const today = options.today ?? todayInJapan();
  return runInTransaction(db, async (tx) => {
    const invoice = await lockInvoice(tx, invoiceId);
    if (invoice.docType !== "invoice" || invoice.status !== "paid") {
      const state = INVOICE_STATUS_LABELS[invoice.status];
      throw new SettingsError(
        invoice.docType === "invoice" ? `${ONLY_PAID}（この請求書は${state}です）` : ONLY_PAID,
      );
    }
    const inForce = await tx.receipt.findFirst({
      where: { invoiceId, voidedAt: null },
      select: { number: true },
    });
    if (inForce) {
      throw new SettingsError(
        `領収書 ${inForce.number} を発行済みです。発行し直すには、先にその領収書を無効にしてください`,
      );
    }
    const payments = paymentsInForce(invoice);
    const receivedOn = lastPaidOn(invoice);
    const applied = payments.reduce(
      (sum, payment) => sum + BigInt(payment.amount) + BigInt(payment.fee),
      0n,
    );
    if (receivedOn === null || applied !== invoice.total) {
      throw new SettingsError(`${ONLY_PAID}。画面を読み込み直してください`);
    }
    const dateProblem = receiptDateProblem(data.issueDate, receivedOn, today);
    if (dateProblem) throw new SettingsError(dateProblem, { field: "issueDate" });
    const recipient = readRecipientSnapshot(invoice.recipientSnapshot);
    const issuer = readIssuerSnapshot(invoice.issuerSnapshot);
    if (!recipient || !issuer) {
      throw new SettingsError(
        "請求書の宛名と発行者の写しがありません。画面を読み込み直してください",
      );
    }

    await lockNumbering(tx);
    const fiscalYear = await fiscalYearOn(tx, data.issueDate);
    if (!fiscalYear) {
      throw new SettingsError(noFiscalYearMessage(data.issueDate), { field: "issueDate" });
    }
    const number = await nextReceiptNumber(tx, fiscalYear);
    let row: Receipt;
    try {
      row = await tx.receipt.create({
        data: {
          id: newId(),
          invoiceId,
          number,
          issueDate: toDbDate(data.issueDate),
          receivedOn: toDbDate(receivedOn),
          amount: invoice.total,
          proviso: data.proviso ?? defaultReceiptProviso(invoice.title),
          recipientSnapshot: json(recipient),
          issuerSnapshot: json(issuer),
          subtotalByRate: json(invoice.subtotalByRate),
          taxByRate: json(invoice.taxByRate),
          issuedBy: options.actor,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SettingsError(
          "領収書を同時に発行しようとしました。画面を読み込み直して確かめてください",
        );
      }
      throw error;
    }
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "receipt.issue",
      entity: "receipt",
      entityId: row.id,
      after: row,
    });
    return toView(row);
  });
}

/**
 * 領収書を無効にする (18 §15.1): the receipt keeps its number with the reason; a new one can then be
 * issued (with a new number), and the invoice's payments can be cancelled again.
 */
export async function voidReceipt(
  db: Db,
  receiptId: string,
  input: ReceiptVoidInput,
  options: ActorOptions,
): Promise<ReceiptView> {
  const data = receiptVoidSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const { row: current } = await lockReceipt(tx, receiptId);
    if (current.voidedAt !== null) {
      throw new SettingsError("この領収書はすでに無効です。画面を読み込み直してください");
    }
    const row = await tx.receipt.update({
      where: { id: receiptId },
      data: { voidedAt: new Date(), voidReason: data.reason },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "receipt.void",
      entity: "receipt",
      entityId: receiptId,
      before: { voidedAt: null },
      after: { voidedAt: row.voidedAt, voidReason: row.voidReason },
      reason: data.reason,
    });
    return toView(row);
  });
}

/**
 * Ties the stored copy of an issued receipt's PDF (a document the app saved with
 * `source = generated`, 18 §15.3) to the receipt: `Receipt.pdfDocumentId` (set once; the DB trigger
 * refuses a second value) and the 証憑's links to the invoice and to its payments' entries in force.
 * A void receipt never changes. Attaching the same document again changes nothing.
 */
export async function attachReceiptPdf(
  db: Db,
  receiptId: string,
  input: { documentId: string },
  options: ActorOptions,
): Promise<ReceiptView> {
  return runInTransaction(db, async (tx) => {
    const { invoice, row: current } = await lockReceipt(tx, receiptId);
    if (current.voidedAt !== null) {
      throw new SettingsError("無効の領収書には PDF を保存できません");
    }
    if (current.pdfDocumentId === input.documentId) return toView(current);
    if (current.pdfDocumentId !== null) {
      throw new SettingsError("この領収書の PDF はすでに証憑に保存しています");
    }
    await linkDocument(
      tx,
      { kind: "invoice", id: invoice.id, documentId: input.documentId },
      options,
    );
    // The copy is the evidence of the payments too (it shows on their entries' detail).
    const entryIds = [
      ...new Set(paymentsInForce(invoice).map((payment) => payment.journalEntryId)),
    ];
    for (const entryId of entryIds) {
      await linkDocument(
        tx,
        { kind: "journal_entry", id: entryId, documentId: input.documentId },
        options,
      );
    }
    const row = await tx.receipt.update({
      where: { id: receiptId },
      data: { pdfDocumentId: input.documentId },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "receipt.attach_pdf",
      entity: "receipt",
      entityId: receiptId,
      before: { pdfDocumentId: null },
      after: { pdfDocumentId: input.documentId },
    });
    return toView(row);
  });
}
