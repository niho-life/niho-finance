/**
 * 請求 (18-invoicing): 見積書・納品書・請求書. A draft is saved with its totals per tax rate (one
 * rounding per rate, 18 §3); issuing gives the number under a per-type advisory lock, copies the
 * issuer and the recipient, and for an invoice posts 売掛金 / 売上 through
 * `postJournalEntryInTransaction`; a payment posts 口座 / 売掛金 (with the transfer fee); cancelling a
 * payment and voiding a document reverse the entries (nothing posted is rewritten, 02 §1).
 *
 * Every write runs in one transaction (`runInTransaction`) that first locks the document's row and
 * then checks its state, and appends to the audit log (`invoice.*`). Lock order: the document's row →
 * the number's advisory lock → the statement line's row → the fiscal year's row (taken by
 * `lockFiscalYearOn` and `postJournalEntryInTransaction`).
 */
import {
  buildInvoiceIssueEntry,
  buildInvoicePaymentEntry,
  CONTRACT_REVENUE_ACCOUNT_CODE,
  CONTRACT_SEGMENT_CODE,
  computeInvoiceTotals,
  displayDate,
  draftInvoiceNumber,
  formatInvoiceNumber,
  formatQuantity,
  formatYen,
  INVOICE_CONVERSIONS,
  INVOICE_DOC_TYPE_LABELS,
  invoiceBalance,
  invoiceChecklist,
  invoiceNumberPrefix,
  invoiceRateLabel,
  isDraftInvoiceNumber,
  isInvoiceOverdue,
  isLocked,
  isQualifiedInvoice,
  LedgerValidationError,
  nextInvoiceSequence,
  overdueDays,
  parseQuantity,
  REDUCED_TAX_CATEGORY_CODES,
  SALES_TAX_CATEGORY_CODES,
  type AccountingMethod,
  type CalendarDate,
  type ConsumptionTaxMethod,
  type FiscalYearStatus,
  type InvoiceChecklist,
  type InvoiceDocType,
  type InvoiceIssuer,
  type InvoiceLineAmountInput,
  type InvoicePaymentAmounts,
  type InvoiceRateTotal,
  type InvoiceStatus,
  type InvoiceTotals,
  type JournalEntryInput,
  type LedgerError,
  type LedgerErrorCode,
  type Money,
  type PartnerKind,
  type SalesTaxCategoryCode,
  type TaxRateRule,
  type WalletKind,
} from "@niho-finance/ledger";
import { Prisma, type Account, type FiscalYear, type Invoice } from "@prisma/client";
import { appendAuditLog, toAuditJson, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, toDbDate } from "./dates";
import { linkDocument } from "./documents";
import {
  loadSimpleEntryContext,
  loadTaxRules,
  lockFiscalYearOn,
  voidJournalEntryWithOpenDate,
} from "./entries";
import { isUniqueViolation, SettingsError } from "./errors";
import { newId } from "./ids";
import { postJournalEntryInTransaction, type ActorOptions } from "./journal";
import {
  cancelInvoicePaymentSchema,
  invoiceDraftSchema,
  invoiceDraftUpdateSchema,
  invoicePaymentSchema,
  invoiceSendSchema,
  invoiceSettingsSchema,
  invoiceVoidSchema,
  type CancelInvoicePaymentInput,
  type InvoiceBankAccount,
  type InvoiceDraftInput,
  type InvoiceDraftUpdateInput,
  type InvoicePaymentInput,
  type InvoicesFilter,
  type InvoiceSendInput,
  type InvoiceSettingsInput,
  type InvoiceStatusFilter,
  type InvoiceVoidInput,
  type ParsedInvoiceLine,
} from "./schemas";
import { requireCompanyRow } from "./settings";
import { lockSettings, runInTransaction, type Tx } from "./transaction";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rows of the list per page (18 §7). */
export const INVOICE_PAGE_SIZE = 50;
/** The list reads at most this many matching rows, then sorts and pages them in the application. */
export const INVOICE_LIST_LIMIT = 1_000;
/** Statement lines read for the deposit candidates, and how many are offered (18 §9.4). */
const CANDIDATE_SCAN = 200;
const CANDIDATE_LIMIT = 20;

/**
 * Transaction-scoped advisory lock keys of the numbering, one per type (18 §2). Apart from the
 * settings locks of `transaction.ts` (7_301_xxx).
 */
const NUMBER_LOCK_KEYS: Readonly<Record<InvoiceDocType, number>> = {
  quote: 7_316_001,
  delivery: 7_316_002,
  invoice: 7_316_003,
};

/** The states after the issue that keep the number in force (a conversion source must be one). */
const ISSUED_STATUSES: readonly InvoiceStatus[] = ["issued", "sent", "paid"];

const NOT_FOUND = "書類が見つかりません。画面を読み込み直してください";
const DISCARD_REASON = "下書きを破棄";
const ISSUED_NOT_EDITABLE = "発行済みのため編集できません。直すには無効にして複製します";
const VOID_NOT_EDITABLE = "無効の書類は編集できません。複製して新しい下書きを作ります";

/** Ledger errors about the date of the entry (the issue date, the payment date). */
const DATE_CODES: ReadonlySet<LedgerErrorCode> = new Set([
  "INVALID_DATE",
  "OUT_OF_FISCAL_YEAR",
  "PERIOD_LOCKED",
  "FISCAL_YEAR_CLOSED",
  "FISCAL_YEAR_CLOSING",
]);

/** Ledger errors about the account of a line. */
const ACCOUNT_CODES: ReadonlySet<LedgerErrorCode> = new Set([
  "UNKNOWN_ACCOUNT",
  "ACCOUNT_INACTIVE",
  "ACCOUNT_NOT_ALLOWED",
  "UNKNOWN_SUB_ACCOUNT",
  "SUB_ACCOUNT_MISMATCH",
]);

// ---------------------------------------------------------------------------
// Stored JSON (18 §3.3): amounts are decimal strings, never floating point
// ---------------------------------------------------------------------------

/** A line as stored in `lines`. */
export interface StoredInvoiceLine {
  date: CalendarDate | null;
  name: string;
  /** `formatQuantity`: `"1.5"`. */
  quantity: string;
  unit: string | null;
  unitPrice: string;
  taxCategoryCode: string;
  amount: string;
}

/** One tax category of `subtotalByRate`; its tax is in `taxByRate`. */
export interface StoredRateTotal {
  ratePercent: number;
  reduced: boolean;
  taxable: boolean;
  lineCount: number;
  subtotal: string;
  amountExclusive: string;
  amountInclusive: string;
}

/** A payment in `payments` (18 §5.2). A cancelled one stays with its reversal. */
export interface StoredInvoicePayment {
  id: string;
  paidOn: CalendarDate;
  walletId: string;
  walletTransactionId: string | null;
  /** 入金額 */
  amount: string;
  /** 振込手数料 */
  fee: string;
  journalEntryId: string;
  /** ISO timestamp. */
  createdAt: string;
  createdBy: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  reversalEntryId: string | null;
}

/** 発行者 as copied on issue (`issuerSnapshot`): later settings changes never reach the document. */
export interface InvoiceIssuerSnapshot {
  name: string;
  address: string | null;
  representative: string | null;
  /** Only on a 適格請求書; `null` on a 区分記載請求書. */
  invoiceRegistrationNumber: string | null;
  /** Only on a 適格請求書. */
  invoiceRegisteredOn: CalendarDate | null;
  qualified: boolean;
  /** 振込先 of an invoice; `null` for quotes and delivery notes, or when none is set. */
  bankAccount: InvoiceBankAccount | null;
}

/** 宛名 as copied on issue (`recipientSnapshot`). */
export interface InvoiceRecipientSnapshot {
  name: string;
  address: string | null;
}

function json(value: unknown): Prisma.InputJsonValue {
  return toAuditJson(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with sorted keys: jsonb does not keep the key order, so compare through this. */
function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item instanceof Date) return item.toISOString();
    if (typeof item === "bigint") return item.toString();
    if (!isRecord(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, sort(item[key])]),
    );
  };
  return JSON.stringify(sort(value) ?? null);
}

function readLines(value: Prisma.JsonValue): StoredInvoiceLine[] {
  return Array.isArray(value) ? (value as unknown as StoredInvoiceLine[]) : [];
}

function readPayments(value: Prisma.JsonValue | null): StoredInvoicePayment[] {
  return Array.isArray(value) ? (value as unknown as StoredInvoicePayment[]) : [];
}

function readIssuerSnapshot(value: Prisma.JsonValue | null): InvoiceIssuerSnapshot | null {
  return isRecord(value) ? (value as unknown as InvoiceIssuerSnapshot) : null;
}

function readRecipientSnapshot(value: Prisma.JsonValue | null): InvoiceRecipientSnapshot | null {
  return isRecord(value) ? (value as unknown as InvoiceRecipientSnapshot) : null;
}

/** The stored 振込先 (`Company.bankAccountForInvoice`), normalized; `null` when none. */
function readBankAccount(value: Prisma.JsonValue | null): InvoiceBankAccount | null {
  if (!isRecord(value)) return null;
  const parsed = invoiceSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function paymentAmounts(payment: StoredInvoicePayment): InvoicePaymentAmounts {
  return {
    amount: BigInt(payment.amount),
    fee: BigInt(payment.fee),
    cancelled: payment.cancelledAt !== null,
  };
}

/** 残高 of an invoice; `null` for quotes and delivery notes (18 §1). */
function balanceOf(row: Pick<Invoice, "docType" | "total" | "payments">): Money | null {
  if (row.docType !== "invoice") return null;
  return invoiceBalance(row.total, readPayments(row.payments).map(paymentAmounts));
}

const SALES_ORDER = new Map<string, number>(
  SALES_TAX_CATEGORY_CODES.map((code, index) => [code, index]),
);

/** The rows per tax category as stored (never recomputed: 18 §3.3), in the order of the totals. */
function storedRates(row: Pick<Invoice, "subtotalByRate" | "taxByRate">): InvoiceRateRow[] {
  const subtotals = isRecord(row.subtotalByRate)
    ? (row.subtotalByRate as unknown as Record<string, StoredRateTotal>)
    : {};
  const taxes = isRecord(row.taxByRate) ? (row.taxByRate as unknown as Record<string, string>) : {};
  return Object.keys(subtotals)
    .sort((a, b) => (SALES_ORDER.get(a) ?? 99) - (SALES_ORDER.get(b) ?? 99))
    .flatMap((code) => {
      const stored = subtotals[code];
      if (!stored) return [];
      const rate: InvoiceRateTotal = {
        taxCategoryCode: code as SalesTaxCategoryCode,
        ratePercent: stored.ratePercent,
        reduced: stored.reduced,
        taxable: stored.taxable,
        lineCount: stored.lineCount,
        subtotal: BigInt(stored.subtotal),
        amountExclusive: BigInt(stored.amountExclusive),
        taxAmount: BigInt(taxes[code] ?? "0"),
        amountInclusive: BigInt(stored.amountInclusive),
      };
      return [{ ...rate, label: invoiceRateLabel(rate) }];
    });
}

/** The stored totals in the shape the checklist reads. */
function storedTotals(row: Invoice): InvoiceTotals {
  const rates = storedRates(row);
  let amountExclusive = 0n;
  let taxTotal = 0n;
  for (const rate of rates) {
    amountExclusive += rate.amountExclusive;
    taxTotal += rate.taxAmount;
  }
  return {
    pricesIncludeTax: row.pricesIncludeTax,
    lineAmounts: readLines(row.lines).map((line) => BigInt(line.amount)),
    rates,
    amountExclusive,
    taxTotal,
    total: row.total,
  };
}

/** A line with its quantity in hundredths, as the totals take it. */
interface DraftLine {
  date: CalendarDate | null;
  name: string;
  quantity: bigint;
  unit: string | null;
  unitPrice: Money;
  taxCategoryCode: string;
}

function fromStoredLine(line: StoredInvoiceLine): DraftLine {
  return {
    date: line.date,
    name: line.name,
    quantity: parseQuantity(line.quantity) ?? 0n,
    unit: line.unit,
    unitPrice: BigInt(line.unitPrice),
    taxCategoryCode: line.taxCategoryCode,
  };
}

function amountInputs(lines: readonly DraftLine[]): InvoiceLineAmountInput[] {
  return lines.map((line) => ({
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxCategoryCode: line.taxCategoryCode,
  }));
}

/** The columns of the body that hold the lines and their totals (18 §3.3). */
function totalsColumns(lines: readonly DraftLine[], totals: InvoiceTotals) {
  const stored: StoredInvoiceLine[] = lines.map((line, index) => ({
    date: line.date,
    name: line.name,
    quantity: formatQuantity(line.quantity),
    unit: line.unit,
    unitPrice: line.unitPrice.toString(),
    taxCategoryCode: line.taxCategoryCode,
    amount: (totals.lineAmounts[index] ?? 0n).toString(),
  }));
  const subtotalByRate: Record<string, StoredRateTotal> = {};
  const taxByRate: Record<string, string> = {};
  for (const rate of totals.rates) {
    subtotalByRate[rate.taxCategoryCode] = {
      ratePercent: rate.ratePercent,
      reduced: rate.reduced,
      taxable: rate.taxable,
      lineCount: rate.lineCount,
      subtotal: rate.subtotal.toString(),
      amountExclusive: rate.amountExclusive.toString(),
      amountInclusive: rate.amountInclusive.toString(),
    };
    taxByRate[rate.taxCategoryCode] = rate.taxAmount.toString();
  }
  return {
    lines: json(stored),
    subtotalByRate: json(subtotalByRate),
    taxByRate: json(taxByRate),
    total: totals.total,
  };
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** A document as a link target: its type and number (`invoiceNumberLabel` shows a draft's). */
export interface InvoiceRef {
  id: string;
  docType: InvoiceDocType;
  /** Raw: a draft's placeholder is shown as 「下書き」 by `invoiceNumberLabel`. */
  number: string;
  status: InvoiceStatus;
}

/** What the writes return. */
export interface InvoiceRecord extends InvoiceRef {
  partnerId: string;
  issueDate: CalendarDate;
  dueDate: CalendarDate | null;
  total: Money;
  /** 残高 (請求書 only). */
  balance: Money | null;
  journalEntryId: string | null;
  issuedAt: Date | null;
  sentAt: Date | null;
  voidedAt: Date | null;
  updatedAt: Date;
}

function toRecord(row: Invoice): InvoiceRecord {
  return {
    id: row.id,
    docType: row.docType,
    number: row.number,
    status: row.status,
    partnerId: row.partnerId,
    issueDate: fromDbDate(row.issueDate),
    dueDate: fromDbDateOrNull(row.dueDate),
    total: row.total,
    balance: balanceOf(row),
    journalEntryId: row.journalEntryId,
    issuedAt: row.issuedAt,
    sentAt: row.sentAt,
    voidedAt: row.voidedAt,
    updatedAt: row.updatedAt,
  };
}

const refSelect = { id: true, docType: true, number: true, status: true } as const;

/** A conversion counts unless it is a discarded draft (void without ever being issued). */
const CONVERSION_IN_FORCE = { NOT: { status: "void", issuedAt: null } } as const;

function overdueOf(
  row: Pick<Invoice, "docType" | "status" | "dueDate">,
  today: CalendarDate,
): { overdue: boolean; overdueDays: number } {
  const dueDate = fromDbDateOrNull(row.dueDate);
  const overdue = isInvoiceOverdue({ docType: row.docType, status: row.status, dueDate }, today);
  return { overdue, overdueDays: overdue && dueDate ? overdueDays(dueDate, today) : 0 };
}

// ---------------------------------------------------------------------------
// Locks and shared checks
// ---------------------------------------------------------------------------

/** Locks the document's row until the transaction ends, then reads it. */
async function lockInvoice(tx: Tx, id: string): Promise<Invoice> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "invoice" WHERE "id" = ${id} FOR UPDATE`;
  if (locked.length === 0) throw new SettingsError(NOT_FOUND);
  return tx.invoice.findUniqueOrThrow({ where: { id } });
}

/** Serializes the numbering of one type (18 §2): the next number is read under this lock. */
async function lockNumbering(tx: Tx, docType: InvoiceDocType): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${NUMBER_LOCK_KEYS[docType]}::bigint)::text AS "locked"`;
}

/** Locks a statement line (`wallet_transaction`) and reads it; `null` when there is none. */
async function lockWalletTransaction(tx: Tx, id: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "wallet_transaction" WHERE "id" = ${id} FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.walletTransaction.findUnique({ where: { id } });
}

/** The next number of the type in the fiscal year (issued and void numbers count: no gaps). */
async function nextNumber(
  db: Db,
  docType: InvoiceDocType,
  fiscalYear: FiscalYear,
): Promise<string> {
  const startDate = fromDbDate(fiscalYear.startDate);
  const prefix = invoiceNumberPrefix(docType, startDate);
  const given = await db.invoice.findMany({
    where: { docType, number: { startsWith: prefix }, status: { not: "draft" } },
    select: { number: true },
  });
  return formatInvoiceNumber(
    docType,
    startDate,
    nextInvoiceSequence(
      given.map((row) => row.number),
      prefix,
    ),
  );
}

/** The fiscal year containing `date` when there is exactly one (read, not locked). */
async function fiscalYearOn(db: Db, date: CalendarDate): Promise<FiscalYear | null> {
  const day = toDbDate(date);
  const years = await db.fiscalYear.findMany({
    where: { startDate: { lte: day }, endDate: { gte: day } },
  });
  const [only] = years;
  return only && years.length === 1 ? only : null;
}

function noFiscalYearMessage(date: CalendarDate): string {
  return `${displayDate(date)} を含む会計期間がありません。会計期間の中の日付にするか、設定 › 会計期間 で期を作ってください`;
}

/** Re-throws the ledger's errors with the form field each belongs to. */
function withLedgerFields(
  error: LedgerValidationError,
  fieldOf: (item: LedgerError) => string | undefined,
): LedgerValidationError {
  return new LedgerValidationError(
    error.errors.map((item) => {
      const field = fieldOf(item);
      return field ? { ...item, field } : item;
    }),
  );
}

/** The fiscal year containing the date, locked; its errors name `field`. */
async function lockFiscalYearFor(tx: Tx, date: CalendarDate, field: string): Promise<FiscalYear> {
  try {
    return await lockFiscalYearOn(tx, date);
  } catch (error) {
    if (error instanceof LedgerValidationError) throw withLedgerFields(error, () => field);
    throw error;
  }
}

interface CompanyIssuer extends InvoiceIssuer {
  name: string;
  address: string | null;
  representative: string | null;
  bankAccount: InvoiceBankAccount | null;
}

async function loadIssuer(db: Db): Promise<CompanyIssuer | null> {
  const company = await db.company.findFirst({ orderBy: { createdAt: "asc" } });
  if (!company) return null;
  return {
    name: company.name,
    address: company.address,
    representative: company.representative,
    invoiceRegistrationNumber: company.invoiceRegistrationNumber,
    invoiceRegisteredOn: fromDbDateOrNull(company.invoiceRegisteredOn),
    bankAccount: readBankAccount(company.bankAccountForInvoice),
  };
}

// ---------------------------------------------------------------------------
// Reads: the list (18 §7)
// ---------------------------------------------------------------------------

/** The filters of the list; left out = the defaults (請求書, 未完了). */
export type InvoiceListFilters = Partial<Omit<InvoicesFilter, "page">>;

export interface InvoiceListRow {
  id: string;
  docType: InvoiceDocType;
  /** Raw (`invoiceNumberLabel` shows a draft's as 「下書き」). */
  number: string;
  partnerId: string;
  /** The name on the document (the copy once issued). */
  partnerName: string;
  title: string | null;
  issueDate: CalendarDate;
  /** 支払期限 / 有効期限 (a delivery note has none). */
  dueDate: CalendarDate | null;
  total: Money;
  /** 残高 (請求書 only). */
  balance: Money | null;
  status: InvoiceStatus;
  overdue: boolean;
  overdueDays: number;
  /** The first document converted from this one (「→ 請求書 INV-…」). */
  convertedTo: InvoiceRef | null;
  createdAt: Date;
}

export interface InvoicePage {
  rows: InvoiceListRow[];
  /** Matching rows read (at most `INVOICE_LIST_LIMIT`). */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** More rows matched than were read: the screen asks to narrow the filters. */
  truncated: boolean;
}

const STATUS_FILTERS: Readonly<Record<InvoiceStatusFilter, readonly InvoiceStatus[] | null>> = {
  open: ["draft", "issued", "sent"],
  draft: ["draft"],
  issued: ["issued", "sent"],
  paid: ["paid"],
  void: ["void"],
  all: null,
};

function invoicesWhere(filters: InvoiceListFilters): Prisma.InvoiceWhereInput {
  const and: Prisma.InvoiceWhereInput[] = [];
  const type = filters.type ?? "invoice";
  if (type !== "all") and.push({ docType: type });
  const statuses = STATUS_FILTERS[filters.status ?? "open"];
  if (statuses) and.push({ status: { in: [...statuses] } });
  if (filters.partner) and.push({ partnerId: filters.partner });
  if (filters.q) {
    and.push({
      OR: [
        // A draft's placeholder number is not a number: only issued ones are searched.
        { issuedAt: { not: null }, number: { contains: filters.q, mode: "insensitive" } },
        { title: { contains: filters.q, mode: "insensitive" } },
      ],
    });
  }
  return { AND: and };
}

const listInclude = {
  partner: { select: { name: true } },
  convertedTo: {
    where: CONVERSION_IN_FORCE,
    orderBy: { createdAt: "asc" },
    take: 1,
    select: refSelect,
  },
} as const;

type ListInvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof listInclude }>;

function toListRow(row: ListInvoiceRow, today: CalendarDate): InvoiceListRow {
  const recipient = readRecipientSnapshot(row.recipientSnapshot);
  return {
    id: row.id,
    docType: row.docType,
    number: row.number,
    partnerId: row.partnerId,
    partnerName: recipient?.name ?? row.partner.name,
    title: row.title,
    issueDate: fromDbDate(row.issueDate),
    dueDate: fromDbDateOrNull(row.dueDate),
    total: row.total,
    balance: balanceOf(row),
    status: row.status,
    ...overdueOf(row, today),
    convertedTo: row.convertedTo[0] ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * The list (18 §7): the matching rows by issue date (newest first, then the newest created), at most
 * `INVOICE_LIST_LIMIT`; the overdue invoices first (the oldest due date first); `pageSize` (50) per
 * page. A page past the end shows the last page.
 */
export async function listInvoices(
  db: Db,
  filters: InvoiceListFilters,
  page: number,
  options: { today: CalendarDate; pageSize?: number },
): Promise<InvoicePage> {
  const pageSize = options.pageSize ?? INVOICE_PAGE_SIZE;
  const rows = await db.invoice.findMany({
    where: invoicesWhere(filters),
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: INVOICE_LIST_LIMIT + 1,
    include: listInclude,
  });
  const truncated = rows.length > INVOICE_LIST_LIMIT;
  const listed = rows.slice(0, INVOICE_LIST_LIMIT).map((row) => toListRow(row, options.today));
  const overdue = listed
    .filter((row) => row.overdue)
    .sort((a, b) => ((a.dueDate ?? "") < (b.dueDate ?? "") ? -1 : a.dueDate === b.dueDate ? 0 : 1));
  const ordered = [...overdue, ...listed.filter((row) => !row.overdue)];
  const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  return {
    rows: ordered.slice((current - 1) * pageSize, current * pageSize),
    total: ordered.length,
    page: current,
    pageSize,
    pageCount,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Reads: the detail (18 §9)
// ---------------------------------------------------------------------------

export interface InvoiceDocLine {
  date: CalendarDate | null;
  name: string;
  /** The quantity as text (`"1.5"`). */
  quantity: string;
  unit: string | null;
  unitPrice: Money;
  taxCategoryCode: string;
  /** 軽減税率: marked ※ on the document. */
  reduced: boolean;
  amount: Money;
}

/** A tax category of the totals, as stored, with its name on the documents (「10%」「8%（軽減）」). */
export interface InvoiceRateRow extends InvoiceRateTotal {
  label: string;
}

/** 発行者: the copy once issued; the current settings for a draft. */
export interface InvoiceIssuerView {
  name: string | null;
  address: string | null;
  representative: string | null;
  /** Shown only on a 適格請求書. */
  invoiceRegistrationNumber: string | null;
  invoiceRegisteredOn: CalendarDate | null;
  qualified: boolean;
  /** 振込先 of an invoice. */
  bankAccount: InvoiceBankAccount | null;
}

/** 宛名: the copy once issued; the current partner for a draft. */
export interface InvoiceRecipientView {
  partnerId: string;
  name: string;
  address: string | null;
  /** The partner's email: the default destination of 送付済みにする. */
  email: string | null;
  partnerIsActive: boolean;
}

export interface InvoicePaymentRow {
  id: string;
  paidOn: CalendarDate;
  walletId: string;
  walletName: string;
  walletTransactionId: string | null;
  amount: Money;
  fee: Money;
  /** 充当額 = 入金額 + 振込手数料. */
  applied: Money;
  journalEntry: { id: string; no: number } | null;
  createdAt: Date;
  createdBy: string;
  cancelled: boolean;
  cancelledAt: Date | null;
  cancelReason: string | null;
  reversalEntry: { id: string; no: number } | null;
}

/** The 売掛金 / 売上 entry of an invoice. */
export interface InvoiceEntryRef {
  id: string;
  no: number;
  voided: boolean;
  /** The reversal that cancels it, once voided. */
  reversal: { id: string; no: number } | null;
}

/** What can be done now; `blocked` says why not, for the state's own operations. */
export interface InvoiceActions {
  canEdit: boolean;
  canIssue: boolean;
  canDiscard: boolean;
  canSend: boolean;
  canPay: boolean;
  canVoid: boolean;
  blocked: {
    edit: string | null;
    issue: string | null;
    discard: string | null;
    send: string | null;
    pay: string | null;
    void: string | null;
  };
  /** The types a document can be converted into (issued 見積書 → 納品書 / 請求書, 納品書 → 請求書). */
  convertTo: InvoiceDocType[];
}

export interface InvoiceDetail {
  id: string;
  docType: InvoiceDocType;
  /** Raw (`invoiceNumberLabel` shows a draft's as 「下書き」). */
  number: string;
  status: InvoiceStatus;
  partnerId: string;
  title: string | null;
  issueDate: CalendarDate;
  dueDate: CalendarDate | null;
  pricesIncludeTax: boolean;
  note: string | null;
  revenueAccount: { id: string; code: string; name: string } | null;
  segment: { id: string; code: string; name: string } | null;
  issuer: InvoiceIssuerView;
  recipient: InvoiceRecipientView;
  /** 適格請求書 (else 区分記載請求書): the copy once issued, judged on the issue date for a draft. */
  qualified: boolean;
  lines: InvoiceDocLine[];
  /** Per tax category, as stored (never recomputed). */
  rates: InvoiceRateRow[];
  /** A line is 軽減税率 (「※ 軽減税率対象」 under the table). */
  hasReducedRate: boolean;
  amountExclusive: Money;
  taxTotal: Money;
  total: Money;
  /** 残高 (請求書 only). */
  balance: Money | null;
  overdue: boolean;
  overdueDays: number;
  /** The date of the last payment in force, once paid. */
  paidOn: CalendarDate | null;
  payments: InvoicePaymentRow[];
  /** 変換元 */
  source: InvoiceRef | null;
  /** 変換先 (discarded drafts left out). */
  convertedTo: InvoiceRef[];
  /** 売掛金 / 売上 of an issued invoice. */
  journalEntry: InvoiceEntryRef | null;
  /** 記載事項の確認 (drafts only). */
  checklist: InvoiceChecklist | null;
  /** The number the issue would give now (drafts only; not reserved). */
  plannedNumber: string | null;
  issuedAt: Date | null;
  sentAt: Date | null;
  sentTo: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  /** The stored copy of the issued PDF (証憑 `invoice_out`, 18 §11); `null` until it is saved. */
  pdfDocumentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  actions: InvoiceActions;
}

const detailInclude = {
  partner: { select: { id: true, name: true, address: true, email: true, isActive: true } },
  revenueAccount: { select: { id: true, code: true, name: true } },
  segment: { select: { id: true, code: true, name: true } },
  sourceInvoice: { select: refSelect },
  convertedTo: {
    where: CONVERSION_IN_FORCE,
    orderBy: { createdAt: "asc" },
    select: refSelect,
  },
  journalEntry: {
    select: { id: true, no: true, status: true, reversal: { select: { id: true, no: true } } },
  },
} as const;

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** Why a draft cannot be issued now, besides the checklist (no fiscal year, a closed date). */
function issueDateProblem(
  docType: InvoiceDocType,
  issueDate: CalendarDate,
  fiscalYear: FiscalYear | null,
): string | null {
  if (!fiscalYear) return noFiscalYearMessage(issueDate);
  if (docType !== "invoice") return null;
  if (fiscalYear.status === "closed") {
    return `第 ${fiscalYear.no} 期は決算済みのため、この発行日では発行できません。発行日を変えてください`;
  }
  if (fiscalYear.status === "closing") {
    return `第 ${fiscalYear.no} 期は決算整理中のため、この発行日では発行できません。発行日を変えてください`;
  }
  const lockedThrough = fromDbDateOrNull(fiscalYear.lockedThrough);
  if (isLocked(issueDate, { lockedThrough })) {
    return `${displayDate(lockedThrough ?? issueDate)} までは締めています。発行日を変えるか、設定 › 会計期間 で締めを戻してください`;
  }
  return null;
}

/** An invoice whose 売掛金 entry was voided on the transaction screen takes no payment. */
function voidedReceivableMessage(no: number): string {
  return `売掛金の仕訳 No. ${no} が取消済みです。書類を無効にして、必要なら複製して発行し直してください`;
}

function invoiceActions(input: {
  docType: InvoiceDocType;
  status: InvoiceStatus;
  sentAt: Date | null;
  balance: Money | null;
  activePayments: number;
  issueProblem: string | null;
  /** The number of the 売掛金 entry when it was voided elsewhere (the transaction screen). */
  voidedReceivableNo: number | null;
}): InvoiceActions {
  const { docType, status } = input;
  const draft = status === "draft";
  const open = status === "issued" || status === "sent";
  const isVoid = status === "void";
  const notEditable = isVoid ? VOID_NOT_EDITABLE : ISSUED_NOT_EDITABLE;

  const canSend = open || (status === "paid" && input.sentAt === null);
  let send: string | null = null;
  if (draft) send = "下書きは送付済みにできません。先に発行してください";
  else if (isVoid) send = "無効の書類は送付済みにできません";
  else if (!canSend) send = "送付済みの記録があります";

  let pay: string | null = null;
  if (docType !== "invoice") pay = "入金を登録できるのは請求書だけです";
  else if (draft) pay = "下書きには入金を登録できません。先に発行してください";
  else if (isVoid) pay = "無効の書類には入金を登録できません";
  else if (input.voidedReceivableNo !== null)
    pay = voidedReceivableMessage(input.voidedReceivableNo);
  else if (status === "paid" || (input.balance ?? 0n) <= 0n) pay = "入金済みのため残高はありません";

  let voidBlocked: string | null = null;
  if (draft) voidBlocked = "下書きは無効にできません。破棄してください";
  else if (isVoid) voidBlocked = "この書類はすでに無効です";
  else if (input.activePayments > 0)
    voidBlocked = "入金が残っています。先に入金を取り消してください";

  return {
    canEdit: draft,
    canIssue: draft && input.issueProblem === null,
    canDiscard: draft,
    canSend,
    canPay: pay === null,
    canVoid: voidBlocked === null,
    blocked: {
      edit: draft ? null : notEditable,
      issue: draft ? input.issueProblem : null,
      discard: draft ? null : "破棄できるのは下書きだけです。発行済みの書類は無効にします",
      send,
      pay,
      void: voidBlocked,
    },
    convertTo: ISSUED_STATUSES.includes(status) ? [...INVOICE_CONVERSIONS[docType]] : [],
  };
}

/**
 * One document with everything the detail draws (18 §9): the document itself (issuer and recipient
 * from the copies once issued, from the current settings for a draft; the stored totals), its state,
 * balance and payments, the conversions, the 売掛金 entry, and for a draft the checklist and the
 * number the issue would give. `null` when not found.
 */
export async function getInvoiceDetail(
  db: Db,
  id: string,
  options: { today: CalendarDate },
): Promise<InvoiceDetail | null> {
  const row = await db.invoice.findUnique({ where: { id }, include: detailInclude });
  if (!row) return null;
  const issueDate = fromDbDate(row.issueDate);
  const draft = row.status === "draft";

  const issuerCopy = readIssuerSnapshot(row.issuerSnapshot);
  const recipientCopy = readRecipientSnapshot(row.recipientSnapshot);
  const company = issuerCopy ? null : await loadIssuer(db);
  const qualified = issuerCopy?.qualified ?? isQualifiedInvoice(company, issueDate);
  const issuer: InvoiceIssuerView = issuerCopy
    ? { ...issuerCopy }
    : {
        name: company?.name ?? null,
        address: company?.address ?? null,
        representative: company?.representative ?? null,
        invoiceRegistrationNumber: qualified ? (company?.invoiceRegistrationNumber ?? null) : null,
        invoiceRegisteredOn: qualified ? (company?.invoiceRegisteredOn ?? null) : null,
        qualified,
        bankAccount: row.docType === "invoice" ? (company?.bankAccount ?? null) : null,
      };
  const recipient: InvoiceRecipientView = {
    partnerId: row.partnerId,
    name: recipientCopy?.name ?? row.partner.name,
    address: recipientCopy ? recipientCopy.address : row.partner.address,
    email: row.partner.email,
    partnerIsActive: row.partner.isActive,
  };

  const storedLines = readLines(row.lines);
  const lines: InvoiceDocLine[] = storedLines.map((line) => ({
    date: line.date,
    name: line.name,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: BigInt(line.unitPrice),
    taxCategoryCode: line.taxCategoryCode,
    reduced: (REDUCED_TAX_CATEGORY_CODES as readonly string[]).includes(line.taxCategoryCode),
    amount: BigInt(line.amount),
  }));
  const totals = storedTotals(row);

  const stored = readPayments(row.payments);
  const wallets = await db.wallet.findMany({
    where: { id: { in: unique(stored.map((payment) => payment.walletId)) } },
    select: { id: true, name: true },
  });
  const walletNames = new Map(wallets.map((wallet) => [wallet.id, wallet.name]));
  const entryIds = unique(
    stored.flatMap((payment) =>
      payment.reversalEntryId
        ? [payment.journalEntryId, payment.reversalEntryId]
        : [payment.journalEntryId],
    ),
  );
  const entries = await db.journalEntry.findMany({
    where: { id: { in: entryIds } },
    select: { id: true, no: true },
  });
  const entryNos = new Map(entries.map((entry) => [entry.id, entry.no]));
  const entryRef = (entryId: string | null) => {
    const no = entryId ? entryNos.get(entryId) : undefined;
    return entryId && no !== undefined ? { id: entryId, no } : null;
  };
  const payments: InvoicePaymentRow[] = stored.map((payment) => {
    const amount = BigInt(payment.amount);
    const fee = BigInt(payment.fee);
    return {
      id: payment.id,
      paidOn: payment.paidOn,
      walletId: payment.walletId,
      walletName: walletNames.get(payment.walletId) ?? "（不明な口座）",
      walletTransactionId: payment.walletTransactionId,
      amount,
      fee,
      applied: amount + fee,
      journalEntry: entryRef(payment.journalEntryId),
      createdAt: new Date(payment.createdAt),
      createdBy: payment.createdBy,
      cancelled: payment.cancelledAt !== null,
      cancelledAt: payment.cancelledAt ? new Date(payment.cancelledAt) : null,
      cancelReason: payment.cancelReason,
      reversalEntry: entryRef(payment.reversalEntryId),
    };
  });
  const inForce = payments.filter((payment) => !payment.cancelled);
  const balance = balanceOf(row);

  let checklist: InvoiceChecklist | null = null;
  let plannedNumber: string | null = null;
  let issueProblem: string | null = null;
  if (draft) {
    checklist = invoiceChecklist({
      issuer: company,
      issueDate,
      recipientName: row.partner.name,
      lines: storedLines.map((line) => ({
        name: line.name,
        date: line.date,
        taxCategoryCode: line.taxCategoryCode,
      })),
      totals,
    });
    const fiscalYear = await fiscalYearOn(db, issueDate);
    if (fiscalYear) plannedNumber = await nextNumber(db, row.docType, fiscalYear);
    issueProblem = checklist.ready
      ? issueDateProblem(row.docType, issueDate, fiscalYear)
      : checklist.items
          .filter((item) => item.state === "error")
          .map((item) => item.detail)
          .join(" / ");
  }

  const lastPaid = inForce.reduce<CalendarDate | null>(
    (latest, payment) => (latest === null || payment.paidOn > latest ? payment.paidOn : latest),
    null,
  );

  return {
    id: row.id,
    docType: row.docType,
    number: row.number,
    status: row.status,
    partnerId: row.partnerId,
    title: row.title,
    issueDate,
    dueDate: fromDbDateOrNull(row.dueDate),
    pricesIncludeTax: row.pricesIncludeTax,
    note: row.note,
    revenueAccount: row.revenueAccount,
    segment: row.segment,
    issuer,
    recipient,
    qualified,
    lines,
    rates: storedRates(row),
    hasReducedRate: lines.some((line) => line.reduced),
    amountExclusive: totals.amountExclusive,
    taxTotal: totals.taxTotal,
    total: row.total,
    balance,
    ...overdueOf(row, options.today),
    paidOn: row.status === "paid" ? lastPaid : null,
    payments,
    source: row.sourceInvoice,
    convertedTo: row.convertedTo,
    journalEntry: row.journalEntry
      ? {
          id: row.journalEntry.id,
          no: row.journalEntry.no,
          voided: row.journalEntry.status === "voided",
          reversal: row.journalEntry.reversal,
        }
      : null,
    checklist,
    plannedNumber,
    issuedAt: row.issuedAt,
    sentAt: row.sentAt,
    sentTo: row.sentTo,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    pdfDocumentId: row.pdfDocumentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    actions: invoiceActions({
      docType: row.docType,
      status: row.status,
      sentAt: row.sentAt,
      balance,
      activePayments: inForce.length,
      issueProblem,
      voidedReceivableNo: row.journalEntry?.status === "voided" ? row.journalEntry.no : null,
    }),
  };
}

// ---------------------------------------------------------------------------
// Reads: the form, the deposit candidates, the history, the settings
// ---------------------------------------------------------------------------

export interface InvoiceIssuerInfo {
  name: string;
  address: string | null;
  representative: string | null;
  invoiceRegistrationNumber: string | null;
  invoiceRegisteredOn: CalendarDate | null;
}

export interface InvoiceFormOptions {
  /** 顧客・両方・その他 (vendors left out unless named in `includeIds`). */
  partners: {
    id: string;
    name: string;
    kind: PartnerKind;
    address: string | null;
    email: string | null;
    defaultAccountId: string | null;
    defaultSegmentId: string | null;
    isActive: boolean;
  }[];
  /** 収益の科目 */
  revenueAccounts: {
    id: string;
    code: string;
    name: string;
    defaultSegmentId: string | null;
    isActive: boolean;
  }[];
  segments: { id: string; code: string; name: string; isActive: boolean }[];
  /** 売上の税区分, in the order of the totals. */
  taxCategories: { code: SalesTaxCategoryCode; name: string; isActive: boolean }[];
  /** Every rule: the form computes the totals with `computeInvoiceTotals` too. */
  taxRules: TaxRateRule[];
  fiscalYears: {
    id: string;
    no: number;
    startDate: CalendarDate;
    endDate: CalendarDate;
    lockedThrough: CalendarDate | null;
    status: FiscalYearStatus;
    consumptionTax: ConsumptionTaxMethod;
    accountingMethod: AccountingMethod;
  }[];
  /** 入金先: active wallets on an asset account (bank, cash, Stripe …). */
  wallets: {
    id: string;
    name: string;
    kind: WalletKind;
    accountName: string;
    subAccountName: string | null;
  }[];
  /** For the checklist (`invoiceChecklist`); `null` before the company is registered. */
  issuer: InvoiceIssuerInfo | null;
  bankAccount: InvoiceBankAccount | null;
  defaults: {
    /** 4040 売上高 受託開発 */
    revenueAccountId: string | null;
    /** 受託 */
    segmentId: string | null;
    taxCategoryCode: SalesTaxCategoryCode;
  };
}

/**
 * The choices of the new and edit forms (18 §8): active rows, plus the rows named in `includeIds`
 * even when inactive (a draft keeps its values; `isActive` tells).
 */
export async function loadInvoiceFormOptions(
  db: Db,
  options: { includeIds?: readonly string[] } = {},
): Promise<InvoiceFormOptions> {
  const include = unique(options.includeIds ?? []);
  const activeOr = { OR: [{ isActive: true }, { id: { in: include } }] };
  const partners = await db.partner.findMany({
    where: {
      OR: [
        { isActive: true, kind: { in: ["customer", "both", "other"] } },
        { id: { in: include } },
      ],
    },
    orderBy: [{ nameKana: { sort: "asc", nulls: "last" } }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      kind: true,
      address: true,
      email: true,
      defaultAccountId: true,
      defaultSegmentId: true,
      isActive: true,
    },
  });
  const revenueAccounts = await db.account.findMany({
    where: { kind: "revenue", ...activeOr },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, defaultSegmentId: true, isActive: true },
  });
  const segments = await db.segment.findMany({
    where: activeOr,
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: { id: true, code: true, name: true, isActive: true },
  });
  const categories = await db.taxCategory.findMany({
    where: { code: { in: [...SALES_TAX_CATEGORY_CODES] } },
    select: { code: true, name: true, isActive: true },
  });
  const fiscalYears = await db.fiscalYear.findMany({ orderBy: { no: "asc" } });
  const wallets = await db.wallet.findMany({
    where: { isActive: true, account: { kind: "asset", isActive: true } },
    orderBy: { id: "asc" },
    include: { account: { select: { name: true } }, subAccount: { select: { name: true } } },
  });
  const issuer = await loadIssuer(db);
  const defaultAccount = await db.account.findUnique({
    where: { code: CONTRACT_REVENUE_ACCOUNT_CODE },
    select: { id: true },
  });
  const defaultSegment = await db.segment.findUnique({
    where: { code: CONTRACT_SEGMENT_CODE },
    select: { id: true },
  });
  return {
    partners,
    revenueAccounts,
    segments,
    taxCategories: categories
      .map((category) => ({ ...category, code: category.code as SalesTaxCategoryCode }))
      .sort((a, b) => (SALES_ORDER.get(a.code) ?? 99) - (SALES_ORDER.get(b.code) ?? 99)),
    taxRules: await loadTaxRules(db),
    fiscalYears: fiscalYears.map((year) => ({
      id: year.id,
      no: year.no,
      startDate: fromDbDate(year.startDate),
      endDate: fromDbDate(year.endDate),
      lockedThrough: fromDbDateOrNull(year.lockedThrough),
      status: year.status,
      consumptionTax: year.consumptionTax,
      accountingMethod: year.accountingMethod,
    })),
    wallets: wallets.map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
      kind: wallet.kind,
      accountName: wallet.account.name,
      subAccountName: wallet.subAccount?.name ?? null,
    })),
    issuer: issuer
      ? {
          name: issuer.name,
          address: issuer.address,
          representative: issuer.representative,
          invoiceRegistrationNumber: issuer.invoiceRegistrationNumber,
          invoiceRegisteredOn: issuer.invoiceRegisteredOn,
        }
      : null,
    bankAccount: issuer?.bankAccount ?? null,
    defaults: {
      revenueAccountId: defaultAccount?.id ?? null,
      segmentId: defaultSegment?.id ?? null,
      taxCategoryCode: "sales_10",
    },
  };
}

/** A line of the form, as text. */
export interface InvoiceLineFormValues {
  date: string;
  name: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxCategoryCode: string;
}

/** The values of the new / edit form (strings, as the form holds them). */
export interface InvoiceDraftFormValues {
  docType: InvoiceDocType;
  partnerId: string;
  title: string;
  issueDate: string;
  dueDate: string;
  pricesIncludeTax: boolean;
  note: string;
  revenueAccountId: string;
  segmentId: string;
  sourceInvoiceId: string;
  lines: InvoiceLineFormValues[];
}

/** A document whose body fills a form: edited (a draft), converted (`from`) or copied (`copy`). */
export interface InvoiceDraftSource extends InvoiceRef {
  values: InvoiceDraftFormValues;
}

/**
 * The body of a document as the form's initial values (18 §8): the edit form takes them as they
 * are; a conversion or a copy changes the type, the dates and the source as the screen decides.
 */
export async function loadInvoiceDraftInput(
  db: Db,
  id: string,
): Promise<InvoiceDraftSource | null> {
  const row = await db.invoice.findUnique({ where: { id } });
  if (!row) return null;
  const dueDate = fromDbDateOrNull(row.dueDate);
  return {
    id: row.id,
    docType: row.docType,
    number: row.number,
    status: row.status,
    values: {
      docType: row.docType,
      partnerId: row.partnerId,
      title: row.title ?? "",
      issueDate: fromDbDate(row.issueDate),
      dueDate: dueDate ?? "",
      pricesIncludeTax: row.pricesIncludeTax,
      note: row.note ?? "",
      revenueAccountId: row.revenueAccountId ?? "",
      segmentId: row.segmentId ?? "",
      sourceInvoiceId: row.sourceInvoiceId ?? "",
      lines: readLines(row.lines).map((line) => ({
        date: line.date ?? "",
        name: line.name,
        quantity: line.quantity,
        unit: line.unit ?? "",
        unitPrice: line.unitPrice,
        taxCategoryCode: line.taxCategoryCode,
      })),
    },
  };
}

/** A statement line that can pay the invoice (18 §9.4). */
export interface DepositCandidate {
  id: string;
  walletId: string;
  walletName: string;
  txnDate: CalendarDate;
  description: string;
  counterparty: string | null;
  amount: Money;
  /** 残高 − 入金額: the shortfall (a fee or a partial payment). */
  difference: Money;
}

/**
 * Unhandled deposits that can pay an issued invoice: `pending` statement lines with a positive amount
 * on active asset wallets, dated on or after the issue date and not above the balance, the 200 newest
 * read; the 20 closest to the balance (then the newest) are offered. Empty when nothing is payable.
 */
export async function loadDepositCandidates(
  db: Db,
  invoiceId: string,
): Promise<DepositCandidate[]> {
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.docType !== "invoice") return [];
  if (invoice.status !== "issued" && invoice.status !== "sent") return [];
  const balance = balanceOf(invoice) ?? 0n;
  if (balance <= 0n) return [];
  const rows = await db.walletTransaction.findMany({
    where: {
      status: "pending",
      amount: { gt: 0n },
      txnDate: { gte: invoice.issueDate },
      wallet: { isActive: true, account: { kind: "asset" } },
    },
    orderBy: [{ txnDate: "desc" }, { id: "desc" }],
    take: CANDIDATE_SCAN,
    include: { wallet: { select: { name: true } } },
  });
  return rows
    .filter((row) => row.amount <= balance)
    .map((row) => ({
      id: row.id,
      walletId: row.walletId,
      walletName: row.wallet.name,
      txnDate: fromDbDate(row.txnDate),
      description: row.descriptionRaw,
      counterparty: row.counterpartyRaw,
      amount: row.amount,
      difference: balance - row.amount,
    }))
    .sort((a, b) => {
      if (a.difference !== b.difference) return a.difference < b.difference ? -1 : 1;
      return a.txnDate === b.txnDate ? 0 : a.txnDate > b.txnDate ? -1 : 1;
    })
    .slice(0, CANDIDATE_LIMIT);
}

/** An invoice a statement line can pay (18 §9.4: 明細から「この請求に充てる」). */
export interface InvoiceForDeposit {
  id: string;
  number: string;
  partnerName: string;
  title: string | null;
  issueDate: CalendarDate;
  dueDate: CalendarDate | null;
  total: Money;
  balance: Money;
  /** 残高 − 入金額: the shortfall (a fee or a partial payment). */
  difference: Money;
  overdue: boolean;
}

/** A deposit of the statement and the invoices it can pay. */
export interface DepositForInvoices {
  line: {
    id: string;
    walletId: string;
    walletName: string;
    txnDate: CalendarDate;
    description: string;
    counterparty: string | null;
    amount: Money;
  };
  /** Why the line cannot pay an invoice (owner-facing); `null` when it can. */
  problem: string | null;
  /** Nearest to the amount first (an exact match first), then the oldest due date. */
  invoices: InvoiceForDeposit[];
}

/**
 * 明細から「この請求に充てる」 (18 §9.4, S5's statement screen): a `pending` deposit on an active asset
 * wallet and the issued (or sent) invoices it can pay: issued on or before the deposit, with a
 * balance of at least its amount, and a 売掛金 entry still in force. `null` when the line is missing.
 */
export async function loadInvoicesForDeposit(
  db: Db,
  walletTransactionId: string,
  options: { today: CalendarDate },
): Promise<DepositForInvoices | null> {
  const row = await db.walletTransaction.findUnique({
    where: { id: walletTransactionId },
    include: {
      wallet: { select: { name: true, isActive: true, account: { select: { kind: true } } } },
    },
  });
  if (!row) return null;
  const line: DepositForInvoices["line"] = {
    id: row.id,
    walletId: row.walletId,
    walletName: row.wallet.name,
    txnDate: fromDbDate(row.txnDate),
    description: row.descriptionRaw,
    counterparty: row.counterpartyRaw,
    amount: row.amount,
  };
  let problem: string | null = null;
  if (row.status !== "pending") {
    problem = "この明細は処理済みです。未処理の入金の明細から選んでください";
  } else if (row.amount <= 0n) {
    problem = "出金の明細は請求に充てられません。入金の明細から選んでください";
  } else if (!row.wallet.isActive || row.wallet.account.kind !== "asset") {
    problem = `口座「${row.wallet.name}」の明細は請求に充てられません。銀行などの有効な口座の入金から選んでください`;
  }
  if (problem) return { line, problem, invoices: [] };

  const rows = await db.invoice.findMany({
    where: {
      docType: "invoice",
      status: { in: ["issued", "sent"] },
      issueDate: { lte: row.txnDate },
    },
    orderBy: [{ issueDate: "asc" }, { id: "asc" }],
    take: INVOICE_LIST_LIMIT,
    include: {
      partner: { select: { name: true } },
      journalEntry: { select: { status: true } },
    },
  });
  const invoices = rows
    .filter((invoice) => invoice.journalEntry?.status !== "voided")
    .flatMap((invoice): InvoiceForDeposit[] => {
      const balance = balanceOf(invoice) ?? 0n;
      if (balance < row.amount) return [];
      const recipient = readRecipientSnapshot(invoice.recipientSnapshot);
      return [
        {
          id: invoice.id,
          number: invoice.number,
          partnerName: recipient?.name ?? invoice.partner.name,
          title: invoice.title,
          issueDate: fromDbDate(invoice.issueDate),
          dueDate: fromDbDateOrNull(invoice.dueDate),
          total: invoice.total,
          balance,
          difference: balance - row.amount,
          overdue: overdueOf(invoice, options.today).overdue,
        },
      ];
    })
    .sort((a, b) => {
      if (a.difference !== b.difference) return a.difference < b.difference ? -1 : 1;
      const due = (value: CalendarDate | null) => value ?? "9999-12-31";
      return due(a.dueDate) < due(b.dueDate) ? -1 : due(a.dueDate) > due(b.dueDate) ? 1 : 0;
    })
    .slice(0, CANDIDATE_LIMIT);
  return { line, problem: null, invoices };
}

export interface InvoiceHistoryRow {
  id: string;
  at: Date;
  actor: string;
  action: string;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string | null;
}

/** The audit log of the document (`entity = invoice`), oldest first (18 §9.5). Read only. */
export async function loadInvoiceHistory(db: Db, invoiceId: string): Promise<InvoiceHistoryRow[]> {
  const rows = await db.auditLog.findMany({
    where: { entity: "invoice", entityId: invoiceId },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    before: row.before,
    after: row.after,
    reason: row.reason,
  }));
}

/** 請求の設定 (18 §10): the issuer (read only here) and the 振込先. */
export interface InvoiceSettings {
  /** `null` before the company is registered. */
  issuer: InvoiceIssuerInfo | null;
  bankAccount: InvoiceBankAccount | null;
}

export async function getInvoiceSettings(db: Db): Promise<InvoiceSettings> {
  const issuer = await loadIssuer(db);
  if (!issuer) return { issuer: null, bankAccount: null };
  const { bankAccount, ...info } = issuer;
  return { issuer: info, bankAccount };
}

// ---------------------------------------------------------------------------
// Writes: drafts (18 §8)
// ---------------------------------------------------------------------------

interface DraftFields {
  partnerId: string;
  title: string | null;
  issueDate: CalendarDate;
  dueDate: CalendarDate | null;
  pricesIncludeTax: boolean;
  note: string | null;
  revenueAccountId: string | null;
  segmentId: string | null;
  lines: ParsedInvoiceLine[];
}

function usableRevenueAccount(account: Account | null): account is Account {
  return account !== null && account.kind === "revenue" && account.isActive;
}

/** The chosen revenue account, or the partner's default revenue account, or 4040 (18 §8). */
async function resolveRevenueAccount(
  tx: Tx,
  accountId: string | null,
  partnerDefaultId: string | null,
): Promise<Account> {
  const field = "revenueAccountId";
  if (accountId) {
    const account = await tx.account.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new SettingsError("売上の科目が見つかりません。一覧から選んでください", { field });
    }
    if (account.kind !== "revenue") {
      throw new SettingsError("売上の科目は収益の科目から選んでください", { field });
    }
    if (!account.isActive) {
      throw new SettingsError(`勘定科目「${account.name}」は無効です。有効な科目を選んでください`, {
        field,
      });
    }
    return account;
  }
  if (partnerDefaultId) {
    const account = await tx.account.findUnique({ where: { id: partnerDefaultId } });
    if (usableRevenueAccount(account)) return account;
  }
  const fallback = await tx.account.findUnique({ where: { code: CONTRACT_REVENUE_ACCOUNT_CODE } });
  if (!usableRevenueAccount(fallback)) {
    throw new SettingsError(
      `勘定科目 ${CONTRACT_REVENUE_ACCOUNT_CODE} が使えません。売上の科目を選んでください`,
      { field },
    );
  }
  return fallback;
}

/** The chosen segment, or the first active default (account, partner), or 受託 (18 §8). */
async function resolveSegment(
  tx: Tx,
  segmentId: string | null,
  defaults: readonly (string | null)[],
): Promise<string | null> {
  if (segmentId) {
    const segment = await tx.segment.findUnique({ where: { id: segmentId } });
    if (!segment) {
      throw new SettingsError("セグメントが見つかりません。一覧から選んでください", {
        field: "segmentId",
      });
    }
    if (!segment.isActive) {
      throw new SettingsError(
        `セグメント「${segment.name}」は無効です。有効なセグメントを選んでください`,
        { field: "segmentId" },
      );
    }
    return segment.id;
  }
  for (const id of defaults) {
    if (!id) continue;
    const segment = await tx.segment.findUnique({ where: { id } });
    if (segment?.isActive) return segment.id;
  }
  const contract = await tx.segment.findUnique({ where: { code: CONTRACT_SEGMENT_CODE } });
  return contract?.id ?? null;
}

/** 変換 (18 §8): 見積書 → 納品書 / 請求書, 納品書 → 請求書, from an issued source only. */
async function assertConvertible(tx: Tx, sourceId: string, docType: InvoiceDocType): Promise<void> {
  const field = "sourceInvoiceId";
  const source = await tx.invoice.findUnique({
    where: { id: sourceId },
    select: { docType: true, status: true },
  });
  if (!source) {
    throw new SettingsError("変換元の書類が見つかりません。画面を読み込み直してください", {
      field,
    });
  }
  const from = INVOICE_DOC_TYPE_LABELS[source.docType];
  const to = INVOICE_DOC_TYPE_LABELS[docType];
  if (!INVOICE_CONVERSIONS[source.docType].includes(docType)) {
    throw new SettingsError(
      `${from}から${to}は作れません。見積書から納品書・請求書を、納品書から請求書を作れます`,
      { field },
    );
  }
  if (source.status === "draft") {
    throw new SettingsError(`変換元の${from}は下書きです。発行してから${to}を作ってください`, {
      field,
    });
  }
  if (!ISSUED_STATUSES.includes(source.status)) {
    throw new SettingsError(`変換元の${from}は無効です。発行済みの書類から作ってください`, {
      field,
    });
  }
}

/**
 * The body of a draft: the partner (active), the revenue account and the segment (請求書 only,
 * defaulted), and the lines with their totals on the issue date's rules (18 §3).
 */
async function draftBody(tx: Tx, docType: InvoiceDocType, data: DraftFields) {
  const partner = await tx.partner.findUnique({ where: { id: data.partnerId } });
  if (!partner) {
    throw new SettingsError("取引先が見つかりません。一覧から選んでください", {
      field: "partnerId",
    });
  }
  if (!partner.isActive) {
    throw new SettingsError(
      `取引先「${partner.name}」は無効です。有効な取引先を選ぶか、設定 › 取引先 で有効にしてください`,
      { field: "partnerId" },
    );
  }
  let revenueAccountId: string | null = null;
  let segmentId: string | null = null;
  if (docType === "invoice") {
    const account = await resolveRevenueAccount(
      tx,
      data.revenueAccountId,
      partner.defaultAccountId,
    );
    revenueAccountId = account.id;
    segmentId = await resolveSegment(tx, data.segmentId, [
      account.defaultSegmentId,
      partner.defaultSegmentId,
    ]);
  }
  // Throws naming the line (`lines.<n>.taxCategoryCode`) for a category without a rule.
  const totals = computeInvoiceTotals(amountInputs(data.lines), {
    pricesIncludeTax: data.pricesIncludeTax,
    issueDate: data.issueDate,
    taxRules: await loadTaxRules(tx),
  });
  return {
    partnerId: partner.id,
    title: data.title,
    issueDate: toDbDate(data.issueDate),
    dueDate: docType === "delivery" || data.dueDate === null ? null : toDbDate(data.dueDate),
    pricesIncludeTax: data.pricesIncludeTax,
    note: data.note,
    revenueAccountId,
    segmentId,
    ...totalsColumns(data.lines, totals),
  };
}

/**
 * 新規 / 変換 / 複製 (18 §8): saves a draft (no number yet: the placeholder `<接頭辞>-draft-<id>`).
 * A conversion (`sourceInvoiceId`) must come from an issued 見積書 / 納品書 of a type it converts to.
 */
export async function createInvoiceDraft(
  db: Db,
  input: InvoiceDraftInput,
  options: ActorOptions,
): Promise<InvoiceRecord> {
  const data = invoiceDraftSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    if (data.sourceInvoiceId) await assertConvertible(tx, data.sourceInvoiceId, data.docType);
    const body = await draftBody(tx, data.docType, data);
    const id = newId();
    const row = await tx.invoice.create({
      data: {
        id,
        docType: data.docType,
        number: draftInvoiceNumber(data.docType, id),
        status: "draft",
        sourceInvoiceId: data.sourceInvoiceId,
        ...body,
      },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "invoice.create",
      entity: "invoice",
      entityId: id,
      after: row,
    });
    return toRecord(row);
  });
}

function assertDraft(row: Invoice, notDraft: { issued: string; void: string }): void {
  if (row.status === "draft") return;
  throw new SettingsError(row.status === "void" ? notDraft.void : notDraft.issued);
}

const BODY_KEYS = [
  "partnerId",
  "title",
  "issueDate",
  "dueDate",
  "pricesIncludeTax",
  "note",
  "revenueAccountId",
  "segmentId",
  "lines",
  "subtotalByRate",
  "taxByRate",
  "total",
] as const;

/**
 * 編集 of a draft (18 §8): the body is rewritten and its totals recomputed. The type and the
 * conversion source never change. An issued document is never edited (void it and copy it).
 */
export async function updateInvoiceDraft(
  db: Db,
  id: string,
  input: InvoiceDraftUpdateInput,
  options: ActorOptions,
): Promise<InvoiceRecord> {
  const data = invoiceDraftUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockInvoice(tx, id);
    assertDraft(current, { issued: ISSUED_NOT_EDITABLE, void: VOID_NOT_EDITABLE });
    const body = await draftBody(tx, current.docType, data);
    const pick = (row: Record<string, unknown>) =>
      Object.fromEntries(BODY_KEYS.map((key) => [key, row[key]]));
    if (stableJson(pick(current)) === stableJson(pick(body))) return toRecord(current);
    const row = await tx.invoice.update({ where: { id }, data: body });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "invoice.update",
      entity: "invoice",
      entityId: id,
      before: current,
      after: row,
    });
    return toRecord(row);
  });
}

/** 破棄 (18 §1): a draft becomes void (logical deletion); it leaves the default list. */
export async function discardInvoiceDraft(
  db: Db,
  id: string,
  options: ActorOptions,
): Promise<InvoiceRecord> {
  return runInTransaction(db, async (tx) => {
    const current = await lockInvoice(tx, id);
    assertDraft(current, {
      issued: "破棄できるのは下書きだけです。発行済みの書類は無効にします",
      void: "この下書きはすでに破棄しています。画面を読み込み直してください",
    });
    const row = await tx.invoice.update({
      where: { id },
      data: { status: "void", voidedAt: new Date(), voidReason: DISCARD_REASON },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "invoice.discard",
      entity: "invoice",
      entityId: id,
      before: { status: current.status },
      after: { status: row.status, voidedAt: row.voidedAt, voidReason: row.voidReason },
    });
    return toRecord(row);
  });
}

// ---------------------------------------------------------------------------
// Writes: 発行 (18 §1, §2, §4, §5.1)
// ---------------------------------------------------------------------------

/** A ledger error of the issue → the form field: the issue date, the segment, the account. */
function issueField(entry: JournalEntryInput | undefined, revenueAccountId: string | null) {
  return (item: LedgerError): string | undefined => {
    if (DATE_CODES.has(item.code)) return "issueDate";
    if (item.code === "SEGMENT_REQUIRED") return "segmentId";
    if (ACCOUNT_CODES.has(item.code)) {
      const line = item.lineIndex === undefined ? undefined : entry?.lines[item.lineIndex];
      if (item.field === "revenueAccountId" || line?.accountId === revenueAccountId) {
        return "revenueAccountId";
      }
    }
    return item.field;
  };
}

/**
 * 発行 (18 §1): a draft gets its number (`INV-2026-0001`: the highest of the type and fiscal year,
 * void ones included, + 1, under the type's advisory lock), the totals recomputed on the issue date's
 * rules, the copies of the issuer and the recipient, and for an invoice the 売掛金 / 売上 entry
 * (`sourceKind = invoice`). Refused while the checklist has an error (18 §4); ledger errors name the
 * issue date, the segment or the revenue account.
 */
export async function issueInvoice(
  db: Db,
  id: string,
  options: ActorOptions,
): Promise<InvoiceRecord> {
  return runInTransaction(db, async (tx) => {
    const current = await lockInvoice(tx, id);
    assertDraft(current, {
      issued: "この書類は発行済みです。画面を読み込み直してください",
      void: "無効の書類は発行できません。複製して新しい下書きから発行します",
    });
    const docType = current.docType;
    const issueDate = fromDbDate(current.issueDate);
    await lockNumbering(tx, docType);
    const fiscalYear = await lockFiscalYearFor(tx, issueDate, "issueDate");

    const lines = readLines(current.lines).map(fromStoredLine);
    const totals = computeInvoiceTotals(amountInputs(lines), {
      pricesIncludeTax: current.pricesIncludeTax,
      issueDate,
      taxRules: await loadTaxRules(tx),
    });
    const company = await loadIssuer(tx);
    const partner = await tx.partner.findUniqueOrThrow({ where: { id: current.partnerId } });
    const checklist = invoiceChecklist({
      issuer: company,
      issueDate,
      recipientName: partner.name,
      lines,
      totals,
    });
    if (!checklist.ready || !company) {
      throw new SettingsError(
        checklist.items
          .filter((item) => item.state === "error")
          .map((item) => item.detail)
          .join(" / "),
      );
    }

    const number = await nextNumber(tx, docType, fiscalYear);
    const qualified = checklist.qualified;
    const issuerSnapshot: InvoiceIssuerSnapshot = {
      name: company.name,
      address: company.address,
      representative: company.representative,
      invoiceRegistrationNumber: qualified ? company.invoiceRegistrationNumber : null,
      invoiceRegisteredOn: qualified ? company.invoiceRegisteredOn : null,
      qualified,
      bankAccount: docType === "invoice" ? company.bankAccount : null,
    };
    const recipientSnapshot: InvoiceRecipientSnapshot = {
      name: partner.name,
      address: partner.address,
    };

    let journalEntryId: string | null = null;
    let revenueAccountId = current.revenueAccountId;
    if (docType === "invoice") {
      revenueAccountId ??= (await resolveRevenueAccount(tx, null, partner.defaultAccountId)).id;
      let entry: JournalEntryInput | undefined;
      try {
        entry = buildInvoiceIssueEntry(
          {
            invoiceId: id,
            number,
            issueDate,
            partnerId: partner.id,
            partnerName: partner.name,
            title: current.title,
            revenueAccountId,
            segmentId: current.segmentId,
            totals,
          },
          await loadSimpleEntryContext(tx, fiscalYear),
        );
        const posted = await postJournalEntryInTransaction(
          tx,
          { ...entry, fiscalYearId: fiscalYear.id },
          options,
        );
        journalEntryId = posted.id;
      } catch (error) {
        if (error instanceof LedgerValidationError) {
          throw withLedgerFields(error, issueField(entry, revenueAccountId));
        }
        throw error;
      }
    }

    let row: Invoice;
    try {
      row = await tx.invoice.update({
        where: { id },
        data: {
          status: "issued",
          number,
          issuedAt: new Date(),
          issuerSnapshot: json(issuerSnapshot),
          recipientSnapshot: json(recipientSnapshot),
          journalEntryId,
          revenueAccountId,
          ...totalsColumns(lines, totals),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SettingsError(
          `番号 ${number} は別の書類に付いています。画面を読み込み直して、もう一度発行してください`,
        );
      }
      throw error;
    }
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "invoice.issue",
      entity: "invoice",
      entityId: id,
      before: {
        status: current.status,
        docType,
        partnerId: current.partnerId,
        issueDate,
        dueDate: fromDbDateOrNull(current.dueDate),
        title: current.title,
        total: current.total,
      },
      after: {
        number,
        status: row.status,
        issuedAt: row.issuedAt,
        journalEntryId,
        total: row.total,
        issuerSnapshot,
        recipientSnapshot,
      },
    });
    return toRecord(row);
  });
}

// ---------------------------------------------------------------------------
// Writes: 送付・無効 (18 §1, §5.3)
// ---------------------------------------------------------------------------

/**
 * 送付済みにする (18 §1): 発行済み → 送付済み with the date and the destination. A sent document
 * records the new sending (再送); a paid one records it only when it had none, and stays paid.
 */
export async function markInvoiceSent(
  db: Db,
  id: string,
  input: InvoiceSendInput,
  options: ActorOptions,
): Promise<InvoiceRecord> {
  const data = invoiceSendSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockInvoice(tx, id);
    let status: InvoiceStatus = current.status;
    switch (current.status) {
      case "draft":
        throw new SettingsError("下書きは送付済みにできません。先に発行してください");
      case "void":
        throw new SettingsError("無効の書類は送付済みにできません");
      case "paid":
        // A paid document is marked sent once by hand; a mail (re)sending is always recorded.
        if (current.sentAt !== null && data.mailSubject === null) {
          throw new SettingsError("送付の記録があります。画面を読み込み直してください");
        }
        break;
      case "issued":
        status = "sent";
        break;
      case "sent":
        break;
    }
    const row = await tx.invoice.update({
      where: { id },
      data: { status, sentAt: new Date(), sentTo: data.sentTo },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "invoice.send",
      entity: "invoice",
      entityId: id,
      before: { status: current.status, sentAt: current.sentAt, sentTo: current.sentTo },
      after: {
        status: row.status,
        sentAt: row.sentAt,
        sentTo: row.sentTo,
        ...(data.mailSubject === null ? {} : { mailSubject: data.mailSubject }),
      },
    });
    return toRecord(row);
  });
}

/** The reversal of an entry that was already voided elsewhere (e.g. on the transaction screen). */
async function existingReversal(
  tx: Tx,
  entryId: string,
): Promise<{ voided: boolean; reversalId: string | null }> {
  const entry = await tx.journalEntry.findUnique({
    where: { id: entryId },
    select: { status: true, reversal: { select: { id: true } } },
  });
  return { voided: entry?.status === "voided", reversalId: entry?.reversal?.id ?? null };
}

/**
 * 無効にする (18 §1, §5.3): an issued (or sent) document becomes void; its number stays. An
 * invoice's 売掛金 / 売上 entry is reversed (`voidJournalEntryWithOpenDate`: dated on the first open
 * day when its month is closed). Refused while a payment is in force.
 */
export async function voidInvoice(
  db: Db,
  id: string,
  input: InvoiceVoidInput,
  options: ActorOptions,
): Promise<InvoiceRecord> {
  const data = invoiceVoidSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockInvoice(tx, id);
    if (current.status === "draft") {
      throw new SettingsError("下書きは無効にできません。破棄してください");
    }
    if (current.status === "void") {
      throw new SettingsError("この書類はすでに無効です。画面を読み込み直してください");
    }
    const inForce = readPayments(current.payments).filter((payment) => !payment.cancelledAt);
    if (inForce.length > 0) {
      throw new SettingsError("入金が残っています。先に入金を取り消してください");
    }
    let reversalEntryId: string | null = null;
    if (current.journalEntryId) {
      const existing = await existingReversal(tx, current.journalEntryId);
      if (existing.voided) {
        reversalEntryId = existing.reversalId;
      } else {
        const { reversal } = await voidJournalEntryWithOpenDate(
          tx,
          current.journalEntryId,
          { reason: data.reason },
          options,
        );
        reversalEntryId = reversal.id;
      }
    }
    const row = await tx.invoice.update({
      where: { id },
      data: { status: "void", voidedAt: new Date(), voidReason: data.reason },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "invoice.void",
      entity: "invoice",
      entityId: id,
      before: { status: current.status, journalEntryId: current.journalEntryId },
      after: {
        status: row.status,
        voidedAt: row.voidedAt,
        voidReason: row.voidReason,
        reversalEntryId,
      },
      reason: data.reason,
    });
    return toRecord(row);
  });
}

// ---------------------------------------------------------------------------
// Writes: 入金 and its cancellation (18 §5.2)
// ---------------------------------------------------------------------------

/** A ledger error of a payment → the form field. */
function paymentField(entry: JournalEntryInput | undefined) {
  return (item: LedgerError): string | undefined => {
    if (DATE_CODES.has(item.code)) return "paidOn";
    if (item.field) return item.field;
    if (item.code === "SEGMENT_REQUIRED") return "fee";
    if (ACCOUNT_CODES.has(item.code) && item.lineIndex === 0 && entry) return "walletId";
    return undefined;
  };
}

/**
 * 入金の登録 (18 §5.2): 口座 / 売掛金 (+ 支払手数料 for the fee the customer deducted) on the
 * payment date, `sourceKind = invoice`. The amount and the fee together are at most the balance; a
 * partial payment only lowers it, and the invoice is paid when it reaches 0. A statement line
 * (`walletTransactionId`, `pending`, a deposit of the chosen wallet) gives the date, the wallet and
 * the amount, and becomes `registered` with the entry.
 */
export async function recordInvoicePayment(
  db: Db,
  id: string,
  input: InvoicePaymentInput,
  options: ActorOptions,
): Promise<InvoiceRecord> {
  const data = invoicePaymentSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockInvoice(tx, id);
    if (current.docType !== "invoice") {
      throw new SettingsError("入金を登録できるのは請求書だけです");
    }
    switch (current.status) {
      case "draft":
        throw new SettingsError("下書きには入金を登録できません。先に発行してください");
      case "void":
        throw new SettingsError("無効の書類には入金を登録できません");
      case "paid":
        throw new SettingsError("入金済みのため残高はありません。画面を読み込み直してください");
      case "issued":
      case "sent":
        break;
    }
    if (current.journalEntryId) {
      const receivable = await tx.journalEntry.findUnique({
        where: { id: current.journalEntryId },
        select: { no: true, status: true },
      });
      if (receivable?.status === "voided") {
        throw new SettingsError(voidedReceivableMessage(receivable.no));
      }
    }

    let { paidOn, walletId, amount } = data;
    const fee = data.fee;
    let statementLineId: string | null = null;
    if (data.walletTransactionId) {
      const field = "walletTransactionId";
      const line = await lockWalletTransaction(tx, data.walletTransactionId);
      if (!line) {
        throw new SettingsError("明細が見つかりません。画面を読み込み直してください", { field });
      }
      if (line.status !== "pending") {
        throw new SettingsError(
          "この明細は処理済みです。別の明細を選ぶか、手入力で登録してください",
          { field },
        );
      }
      if (line.amount <= 0n) {
        throw new SettingsError("この明細は出金です。入金の明細を選んでください", { field });
      }
      if (line.walletId !== data.walletId) {
        throw new SettingsError("口座が明細の口座と違います。明細の口座を選んでください", {
          field: "walletId",
        });
      }
      paidOn = fromDbDate(line.txnDate);
      walletId = line.walletId;
      amount = line.amount;
      statementLineId = line.id;
    }

    if (paidOn < fromDbDate(current.issueDate)) {
      throw new SettingsError("入金日は発行日以後にしてください", { field: "paidOn" });
    }
    const payments = readPayments(current.payments);
    const balance = invoiceBalance(current.total, payments.map(paymentAmounts));
    if (amount + fee > balance) {
      throw new SettingsError(`入金額と手数料の合計が残高 ${formatYen(balance)} 円を超えています`, {
        field: "amount",
      });
    }

    const fiscalYear = await lockFiscalYearFor(tx, paidOn, "paidOn");
    const recipient = readRecipientSnapshot(current.recipientSnapshot);
    const partnerName =
      recipient?.name ??
      (await tx.partner.findUniqueOrThrow({ where: { id: current.partnerId } })).name;
    let entry: JournalEntryInput | undefined;
    let journalEntryId: string;
    try {
      entry = buildInvoicePaymentEntry(
        {
          invoiceId: id,
          number: current.number,
          partnerId: current.partnerId,
          partnerName,
          paidOn,
          walletId,
          amount,
          fee,
          segmentId: current.segmentId,
        },
        await loadSimpleEntryContext(tx, fiscalYear),
      );
      const posted = await postJournalEntryInTransaction(
        tx,
        { ...entry, fiscalYearId: fiscalYear.id },
        options,
      );
      journalEntryId = posted.id;
    } catch (error) {
      if (error instanceof LedgerValidationError) {
        throw withLedgerFields(error, paymentField(entry));
      }
      throw error;
    }

    if (statementLineId) {
      await tx.walletTransaction.update({
        where: { id: statementLineId },
        data: { status: "registered", journalEntryId },
      });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "wallet_transaction.register",
        entity: "wallet_transaction",
        entityId: statementLineId,
        before: { status: "pending", journalEntryId: null },
        after: { status: "registered", journalEntryId },
      });
    }

    const payment: StoredInvoicePayment = {
      id: newId(),
      paidOn,
      walletId,
      walletTransactionId: statementLineId,
      amount: amount.toString(),
      fee: fee.toString(),
      journalEntryId,
      createdAt: new Date().toISOString(),
      createdBy: options.actor,
      cancelledAt: null,
      cancelReason: null,
      reversalEntryId: null,
    };
    const next = [...payments, payment];
    const remaining = invoiceBalance(current.total, next.map(paymentAmounts));
    const row = await tx.invoice.update({
      where: { id },
      data: { payments: json(next), status: remaining === 0n ? "paid" : current.status },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "invoice.pay",
      entity: "invoice",
      entityId: id,
      after: payment,
    });
    return toRecord(row);
  });
}

/**
 * 入金の取消 (18 §5.2): the payment's entry is reversed (`voidJournalEntryWithOpenDate`), the payment
 * keeps its row with the cancellation and the reversal, the balance comes back, a statement line goes
 * back to `pending`, and a paid invoice returns to 送付済み (when it was sent) or 発行済み.
 */
export async function cancelInvoicePayment(
  db: Db,
  id: string,
  input: CancelInvoicePaymentInput,
  options: ActorOptions,
): Promise<InvoiceRecord> {
  const data = cancelInvoicePaymentSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockInvoice(tx, id);
    const payments = readPayments(current.payments);
    const index = payments.findIndex((payment) => payment.id === data.paymentId);
    const payment = payments[index];
    if (!payment) {
      throw new SettingsError("入金が見つかりません。画面を読み込み直してください", {
        field: "paymentId",
      });
    }
    if (payment.cancelledAt) {
      throw new SettingsError("この入金は取消済みです。画面を読み込み直してください", {
        field: "paymentId",
      });
    }
    const line = payment.walletTransactionId
      ? await lockWalletTransaction(tx, payment.walletTransactionId)
      : null;

    const existing = await existingReversal(tx, payment.journalEntryId);
    let reversalEntryId = existing.reversalId;
    if (!existing.voided) {
      const { reversal } = await voidJournalEntryWithOpenDate(
        tx,
        payment.journalEntryId,
        { reason: data.reason },
        options,
      );
      reversalEntryId = reversal.id;
    }

    if (line && line.status === "registered" && line.journalEntryId === payment.journalEntryId) {
      await tx.walletTransaction.update({
        where: { id: line.id },
        data: { status: "pending", journalEntryId: null },
      });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "wallet_transaction.unregister",
        entity: "wallet_transaction",
        entityId: line.id,
        before: { status: line.status, journalEntryId: line.journalEntryId },
        after: { status: "pending", journalEntryId: null },
        reason: data.reason,
      });
    }

    const cancelled: StoredInvoicePayment = {
      ...payment,
      cancelledAt: new Date().toISOString(),
      cancelReason: data.reason,
      reversalEntryId,
    };
    const next = payments.map((item, position) => (position === index ? cancelled : item));
    const status: InvoiceStatus =
      current.status === "paid" ? (current.sentAt ? "sent" : "issued") : current.status;
    const row = await tx.invoice.update({
      where: { id },
      data: { payments: json(next), status },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "invoice.cancel_payment",
      entity: "invoice",
      entityId: id,
      before: { status: current.status, payment },
      after: { status: row.status, payment: cancelled },
      reason: data.reason,
    });
    return toRecord(row);
  });
}

// ---------------------------------------------------------------------------
// Writes: 発行した PDF を証憑に (18 §11)
// ---------------------------------------------------------------------------

/**
 * Ties the stored copy of an issued document's PDF (a document the app saved with
 * `source = generated`) to the document: `Invoice.pdfDocumentId` (set once; the DB trigger refuses
 * a second value) and the 証憑's links to the invoice and to its 売掛金 entry (`linkDocument`). Drafts have
 * no copy and void documents never change. Attaching the same document again changes nothing.
 */
export async function attachInvoicePdf(
  db: Db,
  id: string,
  input: { documentId: string },
  options: ActorOptions,
): Promise<InvoiceRecord> {
  return runInTransaction(db, async (tx) => {
    const current = await lockInvoice(tx, id);
    switch (current.status) {
      case "draft":
        throw new SettingsError("下書きの PDF は証憑にしません。発行してから保存します");
      case "void":
        throw new SettingsError("無効の書類には PDF を保存できません");
      case "issued":
      case "sent":
      case "paid":
        break;
    }
    if (current.pdfDocumentId === input.documentId) return toRecord(current);
    if (current.pdfDocumentId !== null) {
      throw new SettingsError("この書類の PDF はすでに証憑に保存しています");
    }
    await linkDocument(tx, { kind: "invoice", id, documentId: input.documentId }, options);
    // The copy is the evidence of the 売掛金 / 売上 entry too (it shows on the entry's detail).
    if (current.journalEntryId) {
      await linkDocument(
        tx,
        { kind: "journal_entry", id: current.journalEntryId, documentId: input.documentId },
        options,
      );
    }
    const row = await tx.invoice.update({
      where: { id },
      data: { pdfDocumentId: input.documentId },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "invoice.attach_pdf",
      entity: "invoice",
      entityId: id,
      before: { pdfDocumentId: null },
      after: { pdfDocumentId: input.documentId },
    });
    return toRecord(row);
  });
}

// ---------------------------------------------------------------------------
// Writes: 請求の設定 (18 §10)
// ---------------------------------------------------------------------------

/**
 * Saves the 振込先 printed on invoices (`Company.bankAccountForInvoice`). Issued invoices keep the
 * copy they were issued with. Audited as `company.update` with the bank account only.
 */
export async function updateInvoiceSettings(
  db: Db,
  input: InvoiceSettingsInput,
  options: ActorOptions,
): Promise<InvoiceSettings> {
  const bankAccount = invoiceSettingsSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "company");
    const company = await requireCompanyRow(tx);
    const before = readBankAccount(company.bankAccountForInvoice);
    if (stableJson(before) !== stableJson(bankAccount)) {
      await tx.company.update({
        where: { id: company.id },
        data: { bankAccountForInvoice: bankAccount ? json(bankAccount) : Prisma.DbNull },
      });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "company.update",
        entity: "company",
        entityId: company.id,
        before: { bankAccountForInvoice: before },
        after: { bankAccountForInvoice: bankAccount },
      });
    }
    return getInvoiceSettings(tx);
  });
}

/** 「見積書（下書き）」 / the number: how the audit log names a document. */
export function invoiceAuditName(row: { docType: InvoiceDocType; number: string }): string {
  return isDraftInvoiceNumber(row.number)
    ? `${INVOICE_DOC_TYPE_LABELS[row.docType]}（下書き）`
    : row.number;
}
