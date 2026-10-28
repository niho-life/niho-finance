/**
 * 支払 (25-payables): received invoices kept unpaid until they are paid. A payable is a document
 * (`invoice_in`) with `payableEntryId` (the 計上 entry 費用 / 未払金), `payableDueDate` and
 * `payableWalletId`; there is no table of payables. What is still to pay, and the state, are derived
 * from the ledger (`payableAmounts`): the registration's 未払金 credits minus the 未払金 debits of
 * the entries in force linked to the document. Voiding a payment anywhere (here, 「未処理に戻す」 on
 * the statement screen, or the transaction screen) brings the rest back by itself.
 *
 * Every write runs in one transaction and appends to the audit log (entity `payable`, the
 * document's ID); the document's own changes and links are S6's `document.*`. Lock order: the
 * document's row → the statement line's row → the journal entry → the fiscal year's row.
 */
import {
  buildPayableEntry,
  buildPayablePaymentEntry,
  CORPORATE_SEGMENT_CODE,
  defaultPayableDueDate,
  isOpenPayableState,
  isPayableDueSoon,
  isPayableExpenseAccount,
  isPayableOverdue,
  LedgerValidationError,
  overdueDays,
  PAYABLE_ACCOUNT_CODE,
  PAYABLE_DEFAULT_EXPENSE_ACCOUNT_CODE,
  PAYABLE_DUE_SOON_DAYS,
  PAYABLE_FEE_LIMIT,
  payableAmounts,
  payableDefaults,
  payableDescription,
  payableDueDateProblem,
  payablePaymentDescription,
  payableState,
  splitPayablePayment,
  statementNamesPartner,
  INPUT_TAX_ACCOUNT_CODE,
  walletAccountIdsOf,
  type AccountingMethod,
  type AccountKind,
  type CalendarDate,
  type ConsumptionTaxMethod,
  type DocumentKind,
  type DocumentStatus,
  type EntryStatus,
  type FiscalYearStatus,
  type JournalEntryInput,
  type LedgerError,
  type LedgerErrorCode,
  type Money,
  type PayableAmounts,
  type PayableDefaults,
  type PayableHistoryVia,
  type PayableLedgerLine,
  type PayableState,
  type PaymentTerms,
  type SourceKind,
  type TaxDirection,
  type TaxKind,
  type TaxRateRule,
  type WalletKind,
} from "@niho-finance/ledger";
import type { CashflowInvoice } from "@niho-finance/reports";
import type { Document, FiscalYear, Partner, Prisma } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, toDbDate } from "./dates";
import { linkDocument, updateDocument } from "./documents";
import {
  loadSimpleEntryContext,
  loadTaxRules,
  lockFiscalYearOn,
  voidJournalEntryWithOpenDate,
} from "./entries";
import { SettingsError } from "./errors";
import { postJournalEntryInTransaction, type ActorOptions } from "./journal";
import {
  cancelPayablePaymentSchema,
  cancelPayableSchema,
  partnerPaymentTermsSchema,
  payablePaymentSchema,
  payableRegisterSchema,
  payableUpdateSchema,
  type CancelPayableInput,
  type CancelPayablePaymentInput,
  type DocumentUpdateInput,
  type PartnerPaymentTermsInput,
  type PayablePaymentInput,
  type PayableRegisterInput,
  type PayablesFilter,
  type PayableUpdateInput,
} from "./schemas";
import { reopenWalletTransaction, settleWalletTransactionWithEntry } from "./statements";
import { runInTransaction, type Tx } from "./transaction";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rows of the list per page (25 §6). */
export const PAYABLE_PAGE_SIZE = 50;
/** Statement lines read for the candidates, and how many candidates are offered (25 §7.2, §7.3). */
const CANDIDATE_SCAN = 200;
const CANDIDATE_LIMIT = 20;
/** Documents offered on the registration form (25 §7.1). */
const DOCUMENT_CHOICES = 20;
/** How far the history follows a document's replacements back. */
const HISTORY_CHAIN_LIMIT = 50;

const NOT_FOUND = "支払が見つかりません。画面を読み込み直してください";
const DOCUMENT_NOT_FOUND = "証憑が見つかりません。画面を読み込み直してください";
const VOIDED_DOCUMENT =
  "無効にした証憑の支払は変えられません。差し替え後の証憑から操作してください";

/** Ledger errors about the date of the entry. */
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

/** Ledger errors about the tax of a line. */
const TAX_CODES: ReadonlySet<LedgerErrorCode> = new Set([
  "INVALID_TAX_AMOUNT",
  "TAX_AMOUNT_NOT_ALLOWED",
  "TAX_CATEGORY_REQUIRED",
  "UNKNOWN_TAX_CATEGORY",
  "TAX_RULE_MISSING",
]);

/** 「2 行目（5100）の」: the ledger's way of naming a line, dropped once the error has its field. */
const LINE_PREFIX = /^\d+ 行目(?:（[^）]*）)?の/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An entry as a link target (「No. 12」). */
export interface PayableEntryRef {
  id: string;
  no: number;
  fiscalYearNo: number;
  entryDate: CalendarDate;
}

export interface PayableWalletRef {
  id: string;
  name: string;
  isActive: boolean;
}

/** A row of the list (25 §6). Amounts are positive yen. */
export interface PayableListRow {
  /** The document's ID: the payable's ID (`/payables/[id]`). */
  documentId: string;
  partnerId: string | null;
  partnerName: string;
  /** 内容: the document's メモ, else its file name. */
  title: string;
  originalName: string | null;
  /** 請求日: the date of the 計上 entry. */
  invoiceDate: CalendarDate;
  dueDate: CalendarDate | null;
  /** 金額 (計上額). */
  amount: Money;
  paid: Money;
  /** 残り (0 or less once paid). */
  remaining: Money;
  plannedWallet: PayableWalletRef | null;
  state: PayableState;
  /** 期限超過 (未払・一部支払 past the due date) and by how many days. */
  overdue: boolean;
  overdueDays: number;
  registration: PayableEntryRef;
}

export interface PayableTotals {
  count: number;
  /** The sum of 残り. */
  amount: Money;
}

/** The three numbers above the list (25 §6), over every open payable whatever the filters. */
export interface PayableSummary {
  /** 未払の合計 (未払・一部支払). */
  open: PayableTotals;
  /** 7 日以内に支払う: due from today to 7 days on (the overdue ones are not included). */
  dueSoon: PayableTotals;
  /** 期限超過 */
  overdue: PayableTotals;
}

/** 取引先別: a heading of the list with the subtotal of 残り (over every matching row, not the page). */
export interface PayablePartnerGroup {
  partnerId: string | null;
  partnerName: string;
  count: number;
  remaining: Money;
}

export interface PayablePage {
  /** The rows of the page in the order of the view. */
  rows: PayableListRow[];
  /** `view = partner`: the partners of the matching rows in the order of the rows; `[]` otherwise. */
  groups: PayablePartnerGroup[];
  summary: PayableSummary;
  /** Matching rows. */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** The filters of the list; left out = the defaults (未払, 期日順). */
export type PayableListFilters = Partial<Omit<PayablesFilter, "page">>;

/** A payment of the detail's table (25 §7.2): an entry in force linked to the document. */
export interface PayablePaymentRow {
  entryId: string;
  no: number;
  fiscalYearNo: number;
  paidOn: CalendarDate;
  /** The wallet the entry credits; `null` when it is not a wallet (a hand-written entry). */
  wallet: { id: string; name: string } | null;
  /** 出金額: the entry's credit total. */
  amount: Money;
  /** 充当額: its 未払金 debit. */
  applied: Money;
  /** 手数料 = 出金額 − 充当額. */
  fee: Money;
  /** The statement line it was paid from (取消 then puts the line back to 未処理). */
  walletTransactionId: string | null;
}

/** An expense line of the registration (科目・税区分・セグメント of the detail). */
export interface PayableExpenseLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  taxCategoryCode: string;
  taxCategoryName: string;
  segmentId: string | null;
  segmentName: string | null;
  /** The line's amount (without the tax in tax-exclusive years) and the tax it contains. */
  amount: Money;
  taxAmount: Money;
}

/** What the detail offers (25 §7.2). */
export interface PayableActions {
  /** 支払を登録: open and the document in force. */
  pay: boolean;
  /** 期日・支払元を変える: the document in force. */
  update: boolean;
  /** 登録を取り消す: the registration in force without payments … */
  cancel: boolean;
  /** … or why not (shown in a band instead of the button); `null` when cancelled already. */
  cancelBlocked: string | null;
  /** 登録し直す (`/payables/new?document=`): cancelled and the document in force. */
  reregister: boolean;
}

export interface PayableDetail extends PayableListRow {
  document: {
    id: string;
    kind: DocumentKind;
    status: DocumentStatus;
    originalName: string | null;
    mime: string;
    txnDate: CalendarDate | null;
    amount: Money | null;
    note: string | null;
    invoiceRegistrationNumber: string | null;
    voidReason: string | null;
    /** The document in force that carries the payable now (a replacement), if any. */
    replacedById: string | null;
  };
  partner: {
    id: string;
    name: string;
    invoiceRegistrationNumber: string | null;
    paymentTerms: PaymentTerms | null;
  } | null;
  registration: PayableEntryRef & { status: EntryStatus; voidReason: string | null };
  expenses: PayableExpenseLine[];
  /** The payments in force, oldest first (cancelled ones are not shown: they no longer count). */
  payments: PayablePaymentRow[];
  actions: PayableActions;
}

export interface PayableFormDocument {
  id: string;
  kind: DocumentKind;
  status: DocumentStatus;
  originalName: string | null;
  mime: string;
  txnDate: CalendarDate | null;
  amount: Money | null;
  partnerId: string | null;
  /** The master's name, else the free-text name. */
  partnerName: string | null;
  invoiceRegistrationNumber: string | null;
  note: string | null;
  /** Why it cannot be registered (owner-facing); `null` when it can. */
  problem: string | null;
  /** It is registered (in force): the screen offers 「支払を開く」 instead. */
  registered: boolean;
}

/** A document the registration can start from (25 §7.1). */
export interface PayableDocumentChoice {
  id: string;
  kind: DocumentKind;
  status: DocumentStatus;
  originalName: string | null;
  txnDate: CalendarDate | null;
  amount: Money | null;
  partnerName: string | null;
  uploadedAt: Date;
}

export interface PayableFormPartner {
  id: string;
  name: string;
  nameKana: string | null;
  invoiceRegistrationNumber: string | null;
  defaultAccountId: string | null;
  defaultTaxCategoryCode: string | null;
  defaultSegmentId: string | null;
  paymentTerms: PaymentTerms | null;
  isActive: boolean;
}

export interface PayableFormAccount {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  defaultTaxCategoryCode: string | null;
  defaultSegmentId: string | null;
  isActive: boolean;
}

/** The form's first values (from the document and the partner's defaults). */
export interface PayableFormValues extends PayableDefaults {
  documentId: string;
  partnerId: string | null;
  invoiceDate: CalendarDate | null;
  amount: Money | null;
  walletId: string | null;
}

export interface PayableFormOptions {
  /** The document of `?document=`; `null` when none was given or it does not exist. */
  document: PayableFormDocument | null;
  /** 受信箱か受領した請求書で、無効でなく、支払の登録がないもの (newest first, 20). */
  candidates: PayableDocumentChoice[];
  /** Active partners (and the document's), with their defaults and payment terms. */
  partners: PayableFormPartner[];
  /** Expense and non-cash asset accounts (`isPayableExpenseAccount`). */
  accounts: PayableFormAccount[];
  /** 仕入 and 対象外 categories. */
  taxCategories: {
    code: string;
    name: string;
    kind: TaxKind;
    direction: TaxDirection;
    isActive: boolean;
  }[];
  segments: { id: string; code: string; name: string; isActive: boolean }[];
  /** 支払元の予定 / the paying wallet: active wallets on an asset or liability account. */
  wallets: {
    id: string;
    name: string;
    kind: WalletKind;
    accountName: string;
    subAccountName: string | null;
  }[];
  /** For 「うち消費税」 and the 仮払消費税 row (the year of the invoice date). */
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
  taxRules: TaxRateRule[];
  defaults: {
    /** 外注費 5100 */
    accountId: string | null;
    /** 共通 */
    segmentId: string | null;
  };
  /** `null` without a document that can be registered. */
  values: PayableFormValues | null;
}

/** A pending outflow that can pay the payable (25 §7.2). */
export interface PaymentLineCandidate {
  id: string;
  walletId: string;
  walletName: string;
  txnDate: CalendarDate;
  description: string;
  counterparty: string | null;
  /** 出金額 (positive). */
  amount: Money;
  /** What the payment would apply, the fee it would book and the rest after it. */
  applied: Money;
  fee: Money;
  remainingAfter: Money;
}

/** A payable a statement line can pay (25 §7.3). */
export interface PayableForPayment {
  documentId: string;
  partnerName: string;
  title: string;
  invoiceDate: CalendarDate;
  dueDate: CalendarDate | null;
  amount: Money;
  remaining: Money;
  applied: Money;
  fee: Money;
  remainingAfter: Money;
  overdue: boolean;
  /** The line names the partner: listed first. */
  samePartner: boolean;
}

/** An outflow of the statement and the payables it can pay. */
export interface PaymentForPayables {
  line: {
    id: string;
    walletId: string;
    walletName: string;
    txnDate: CalendarDate;
    description: string;
    counterparty: string | null;
    /** Signed as stored (an outflow is negative). */
    amount: Money;
  };
  /** Why the line cannot pay a payable (owner-facing); `null` when it can. */
  problem: string | null;
  payables: PayableForPayment[];
}

export interface PayableHistoryRow {
  id: string;
  at: Date;
  actor: string;
  /** `payable.*` (`payableHistoryLabel` names it). */
  action: string;
  /**
   * `null`: done on the payables screen. Otherwise an entry of the payable voided elsewhere: the
   * statement screen (「未処理に戻す」) or the transaction screen.
   */
  via: PayableHistoryVia | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string | null;
}

/** What a document's detail (S6) needs to offer 「未払として登録」 or 「支払を開く」 (25 §5). */
export interface DocumentPayableStatus {
  /** Not voided and without a registration in force. */
  canRegister: boolean;
  /** The payable's state; `null` when it was never registered. */
  state: PayableState | null;
}

/** The result of a registration (the toast 「<取引先> の請求書を未払として登録しました（No. n）」). */
export interface PayableRecord {
  documentId: string;
  partnerName: string;
  entry: { id: string; no: number };
}

export interface PayablePaymentResult {
  documentId: string;
  entry: { id: string; no: number };
  applied: Money;
  fee: Money;
  /** 残り after the payment. */
  remaining: Money;
  state: PayableState;
}

export interface PayableReversalResult {
  documentId: string;
  /** The reversal that cancelled the entry. */
  reversal: { id: string; no: number; entryDate: CalendarDate };
  /** Statement lines put back to 未処理 (a payment from a statement line). */
  reopenedIds: string[];
}

export interface PayableUpdateResult {
  documentId: string;
  dueDate: CalendarDate | null;
  walletId: string | null;
}

// ---------------------------------------------------------------------------
// Loading payables (the rest derived, 25 §1)
// ---------------------------------------------------------------------------

/** 未払金 lines: 2100 without a sub-account (the cards' 未払金 carry theirs). */
const payableLineWhere = {
  account: { code: PAYABLE_ACCOUNT_CODE },
  subAccountId: null,
} satisfies Prisma.JournalLineWhereInput;

const payableLineSelect = { side: true, amount: true } satisfies Prisma.JournalLineSelect;

const payableInclude = {
  partner: { select: { id: true, name: true, nameKana: true } },
  payableWallet: { select: { id: true, name: true, isActive: true } },
  payableEntry: {
    select: {
      id: true,
      no: true,
      kind: true,
      status: true,
      entryDate: true,
      voidReason: true,
      fiscalYear: { select: { no: true } },
      lines: {
        where: payableLineWhere,
        select: {
          ...payableLineSelect,
          partner: { select: { id: true, name: true, nameKana: true } },
        },
      },
    },
  },
  links: {
    where: { journalEntryId: { not: null } },
    select: {
      journalEntry: {
        select: {
          id: true,
          no: true,
          kind: true,
          status: true,
          entryDate: true,
          sourceKind: true,
          sourceId: true,
          fiscalYear: { select: { no: true } },
          lines: { where: payableLineWhere, select: payableLineSelect },
        },
      },
    },
  },
} satisfies Prisma.DocumentInclude;

type PayableRow = Prisma.DocumentGetPayload<{ include: typeof payableInclude }>;

interface LoadedPayment {
  entryId: string;
  no: number;
  fiscalYearNo: number;
  entryDate: CalendarDate;
  sourceKind: SourceKind;
  sourceId: string | null;
  applied: Money;
}

interface LoadedPayable extends PayableListRow {
  row: PayableRow;
  partnerKana: string | null;
  amounts: PayableAmounts;
  registration: PayableEntryRef & { status: EntryStatus; voidReason: string | null };
  payments: LoadedPayment[];
}

function documentTitle(row: { note: string | null; originalName: string | null }): string {
  return row.note?.trim() || row.originalName || "請求書";
}

function toLoaded(row: PayableRow, today: CalendarDate | null): LoadedPayable | null {
  const entry = row.payableEntry;
  if (!entry) return null;
  const ledgerLines: PayableLedgerLine[] = entry.lines.map((line) => ({
    entryId: entry.id,
    entryStatus: entry.status,
    entryKind: entry.kind,
    side: line.side,
    amount: line.amount,
  }));
  const payments: LoadedPayment[] = [];
  for (const link of row.links) {
    const linked = link.journalEntry;
    if (!linked || linked.id === entry.id) continue;
    for (const line of linked.lines) {
      ledgerLines.push({
        entryId: linked.id,
        entryStatus: linked.status,
        entryKind: linked.kind,
        side: line.side,
        amount: line.amount,
      });
    }
    if (linked.status !== "posted" || linked.kind === "reversal") continue;
    const applied = linked.lines.reduce(
      (total, line) => (line.side === "debit" ? total + line.amount : total),
      0n,
    );
    if (applied <= 0n) continue;
    payments.push({
      entryId: linked.id,
      no: linked.no,
      fiscalYearNo: linked.fiscalYear.no,
      entryDate: fromDbDate(linked.entryDate),
      sourceKind: linked.sourceKind,
      sourceId: linked.sourceId,
      applied,
    });
  }
  payments.sort((a, b) =>
    a.entryDate === b.entryDate ? a.no - b.no : a.entryDate < b.entryDate ? -1 : 1,
  );
  const amounts = payableAmounts(entry.id, ledgerLines);
  const state = payableState({ registrationStatus: entry.status, ...amounts });
  const dueDate = fromDbDateOrNull(row.payableDueDate);
  const overdue = today !== null && isPayableOverdue(state, dueDate, today);
  const partner =
    entry.lines.find((line) => line.side === "credit" && line.partner)?.partner ?? row.partner;
  const registration = {
    id: entry.id,
    no: entry.no,
    fiscalYearNo: entry.fiscalYear.no,
    entryDate: fromDbDate(entry.entryDate),
    status: entry.status,
    voidReason: entry.voidReason,
  };
  return {
    row,
    documentId: row.id,
    partnerId: partner?.id ?? null,
    partnerName: partner?.name ?? row.partnerName ?? "",
    partnerKana: partner?.nameKana ?? null,
    title: documentTitle(row),
    originalName: row.originalName,
    invoiceDate: registration.entryDate,
    dueDate,
    amount: amounts.registered,
    paid: amounts.paid,
    remaining: amounts.remaining,
    plannedWallet: row.payableWallet,
    state,
    overdue,
    overdueDays: overdue && dueDate && today ? overdueDays(dueDate, today) : 0,
    amounts,
    registration,
    payments,
  };
}

/** The payables of the documents matching `where` (documents never registered are left out). */
async function loadPayables(
  db: Db,
  where: Prisma.DocumentWhereInput,
  today: CalendarDate | null,
): Promise<LoadedPayable[]> {
  const rows = await db.document.findMany({
    where: { AND: [{ payableEntryId: { not: null } }, where] },
    include: payableInclude,
    orderBy: [{ payableDueDate: "asc" }, { id: "asc" }],
  });
  return rows.flatMap((row) => toLoaded(row, today) ?? []);
}

/** The payables that still count: documents in force, registrations in force. */
const IN_FORCE: Prisma.DocumentWhereInput = {
  status: { not: "voided" },
  payableEntry: { status: "posted" },
};

async function loadPayable(
  db: Db,
  documentId: string,
  today: CalendarDate | null,
): Promise<LoadedPayable | null> {
  const [payable] = await loadPayables(db, { id: documentId }, today);
  return payable ?? null;
}

function toListRow(payable: LoadedPayable): PayableListRow {
  return {
    documentId: payable.documentId,
    partnerId: payable.partnerId,
    partnerName: payable.partnerName,
    title: payable.title,
    originalName: payable.originalName,
    invoiceDate: payable.invoiceDate,
    dueDate: payable.dueDate,
    amount: payable.amount,
    paid: payable.paid,
    remaining: payable.remaining,
    plannedWallet: payable.plannedWallet,
    state: payable.state,
    overdue: payable.overdue,
    overdueDays: payable.overdueDays,
    registration: {
      id: payable.registration.id,
      no: payable.registration.no,
      fiscalYearNo: payable.registration.fiscalYearNo,
      entryDate: payable.registration.entryDate,
    },
  };
}

function termsOf(partner: {
  paymentClosingDay: number | null;
  paymentDueMonths: number | null;
  paymentDueDay: number | null;
}): PaymentTerms | null {
  if (
    partner.paymentClosingDay === null ||
    partner.paymentDueMonths === null ||
    partner.paymentDueDay === null
  ) {
    return null;
  }
  return {
    closingDay: partner.paymentClosingDay,
    dueMonths: partner.paymentDueMonths,
    dueDay: partner.paymentDueDay,
  };
}

const NO_DUE_DATE = "9999-12-31";

/** 期日順 (25 §6): overdue first (the oldest due date first), then by due date, undated last. */
function compareByDue(a: LoadedPayable, b: LoadedPayable): number {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const aDue = a.dueDate ?? NO_DUE_DATE;
  const bDue = b.dueDate ?? NO_DUE_DATE;
  if (aDue !== bDue) return aDue < bDue ? -1 : 1;
  if (a.invoiceDate !== b.invoiceDate) return a.invoiceDate < b.invoiceDate ? -1 : 1;
  return a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0;
}

/** 取引先別: by the partner's kana (then name), payables without a partner last; then 期日順. */
function compareByPartner(a: LoadedPayable, b: LoadedPayable): number {
  const key = (payable: LoadedPayable) => [
    payable.partnerId === null ? 1 : 0,
    payable.partnerKana === null ? 1 : 0,
    payable.partnerKana ?? "",
    payable.partnerName,
    payable.partnerId ?? "",
  ];
  const aKey = key(a);
  const bKey = key(b);
  for (let i = 0; i < aKey.length; i += 1) {
    const x = aKey[i] ?? "";
    const y = bKey[i] ?? "";
    if (x !== y) return x < y ? -1 : 1;
  }
  return compareByDue(a, b);
}

function totals(rows: readonly LoadedPayable[]): PayableTotals {
  return {
    count: rows.length,
    amount: rows.reduce((total, row) => total + row.remaining, 0n),
  };
}

function summaryOf(open: readonly LoadedPayable[], today: CalendarDate): PayableSummary {
  return {
    open: totals(open),
    dueSoon: totals(open.filter((row) => isPayableDueSoon(row.state, row.dueDate, today))),
    overdue: totals(open.filter((row) => row.overdue)),
  };
}

function matchesQuery(payable: LoadedPayable, q: string): boolean {
  const needle = q.normalize("NFKC").toLowerCase();
  return [payable.partnerName, payable.row.originalName ?? "", payable.row.note ?? ""].some(
    (text) => text.normalize("NFKC").toLowerCase().includes(needle),
  );
}

// ---------------------------------------------------------------------------
// Reads: the list (25 §6)
// ---------------------------------------------------------------------------

/**
 * The list (25 §6): the payables of documents in force (void documents never show), filtered by
 * 状態 (未払 = 未払・一部支払, the default; 支払済み; すべて, 取消 included), 取引先 and 検索
 * (取引先名・ファイル名・メモ), in 期日順 or 取引先別, `pageSize` (50) per page. A page past the end
 * shows the last page. `summary` covers every open payable whatever the filters.
 */
export async function listPayables(
  db: Db,
  filters: PayableListFilters,
  page: number,
  options: { today: CalendarDate; pageSize?: number },
): Promise<PayablePage> {
  const pageSize = options.pageSize ?? PAYABLE_PAGE_SIZE;
  const all = await loadPayables(db, { status: { not: "voided" } }, options.today);
  const summary = summaryOf(
    all.filter((row) => isOpenPayableState(row.state)),
    options.today,
  );
  const status = filters.status ?? "open";
  const view = filters.view ?? "due";
  const matching = all
    .filter((row) =>
      status === "open"
        ? isOpenPayableState(row.state)
        : status === "paid"
          ? row.state === "paid"
          : true,
    )
    .filter((row) => !filters.partner || row.partnerId === filters.partner)
    .filter((row) => !filters.q || matchesQuery(row, filters.q))
    .sort(view === "partner" ? compareByPartner : compareByDue);

  const groups: PayablePartnerGroup[] = [];
  if (view === "partner") {
    for (const row of matching) {
      const last = groups.at(-1);
      if (last && last.partnerId === row.partnerId && last.partnerName === row.partnerName) {
        last.count += 1;
        last.remaining += row.remaining;
      } else {
        groups.push({
          partnerId: row.partnerId,
          partnerName: row.partnerName,
          count: 1,
          remaining: row.remaining,
        });
      }
    }
  }
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  return {
    rows: matching.slice((current - 1) * pageSize, current * pageSize).map(toListRow),
    groups,
    summary,
    total: matching.length,
    page: current,
    pageSize,
    pageCount,
  };
}

/** 7 日以内に支払う請求 (the home's やること): open payables due by `today + days`, overdue ones included. */
export async function countPayablesDue(
  db: Db,
  options: { today: CalendarDate; days?: number },
): Promise<{ count: number; amount: Money; overdueCount: number; overdueAmount: Money }> {
  const days = options.days ?? PAYABLE_DUE_SOON_DAYS;
  const open = (await loadPayables(db, IN_FORCE, options.today)).filter((row) =>
    isOpenPayableState(row.state),
  );
  const due = open.filter(
    (row) => row.overdue || isPayableDueSoon(row.state, row.dueDate, options.today, days),
  );
  const overdue = due.filter((row) => row.overdue);
  return {
    count: due.length,
    amount: totals(due).amount,
    overdueCount: overdue.length,
    overdueAmount: totals(overdue).amount,
  };
}

/**
 * 未払の請求 of the cash-flow forecast (21 §3.1): every open payable's rest on its due date (the
 * forecast moves past-due and undated ones to the day after its start). Every payment in force
 * counts, also one dated after the start: the forecast reads that entry on its own date.
 */
export async function listPayablesForCashflow(db: Db): Promise<CashflowInvoice[]> {
  const open = (await loadPayables(db, IN_FORCE, null)).filter(
    (row) => isOpenPayableState(row.state) && row.remaining > 0n,
  );
  return open.sort(compareByDue).map((row) => ({
    date: row.dueDate,
    amount: row.remaining,
    label: `${row.partnerName} ${row.title}`.trim(),
  }));
}

// ---------------------------------------------------------------------------
// Reads: the detail (25 §7.2)
// ---------------------------------------------------------------------------

/** The rows of the detail: `null` when the document does not exist or was never registered. */
export async function getPayableDetail(
  db: Db,
  documentId: string,
  options: { today: CalendarDate },
): Promise<PayableDetail | null> {
  const payable = await loadPayable(db, documentId, options.today);
  if (!payable) return null;
  const { row } = payable;

  const replacement =
    row.status === "voided"
      ? await db.document.findFirst({
          where: {
            payableEntryId: row.payableEntryId,
            status: { not: "voided" },
            id: { not: row.id },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        })
      : null;
  const partner = payable.partnerId
    ? await db.partner.findUnique({ where: { id: payable.partnerId } })
    : null;
  const expenseLines = await db.journalLine.findMany({
    where: {
      journalEntryId: payable.registration.id,
      side: "debit",
      account: { code: { notIn: [PAYABLE_ACCOUNT_CODE, INPUT_TAX_ACCOUNT_CODE] } },
    },
    orderBy: { lineNo: "asc" },
    include: {
      account: { select: { code: true, name: true } },
      taxCategory: { select: { name: true } },
      segment: { select: { name: true } },
    },
  });
  const paymentEntries = await db.journalEntry.findMany({
    where: { id: { in: payable.payments.map((payment) => payment.entryId) } },
    select: {
      id: true,
      lines: { select: { side: true, amount: true, accountId: true, subAccountId: true } },
    },
  });
  const wallets = await db.wallet.findMany({
    select: { id: true, name: true, accountId: true, subAccountId: true },
    orderBy: { id: "asc" },
  });
  const creditsOf = new Map(
    paymentEntries.map((entry) => [entry.id, entry.lines.filter((line) => line.side === "credit")]),
  );
  const payments = payable.payments.map((payment): PayablePaymentRow => {
    const credits = creditsOf.get(payment.entryId) ?? [];
    const amount = credits.reduce((total, line) => total + line.amount, 0n);
    const walletLine = credits.find((line) =>
      wallets.some(
        (wallet) =>
          wallet.accountId === line.accountId && wallet.subAccountId === line.subAccountId,
      ),
    );
    const wallet = walletLine
      ? wallets.find(
          (item) =>
            item.accountId === walletLine.accountId &&
            item.subAccountId === walletLine.subAccountId,
        )
      : undefined;
    return {
      entryId: payment.entryId,
      no: payment.no,
      fiscalYearNo: payment.fiscalYearNo,
      paidOn: payment.entryDate,
      wallet: wallet ? { id: wallet.id, name: wallet.name } : null,
      amount,
      applied: payment.applied,
      fee: amount - payment.applied,
      walletTransactionId: payment.sourceKind === "wallet_txn" ? payment.sourceId : null,
    };
  });

  const inForce = row.status !== "voided";
  const cancelled = payable.state === "cancelled";
  const movedAway = replacement !== null;
  const cancelBlocked = cancelled
    ? null
    : movedAway
      ? "この支払は差し替え後の証憑に移っています"
      : payments.length > 0
        ? "支払が残っているため取り消せません。先に支払を取り消してください"
        : null;
  return {
    ...toListRow(payable),
    document: {
      id: row.id,
      kind: row.kind,
      status: row.status,
      originalName: row.originalName,
      mime: row.mime,
      txnDate: fromDbDateOrNull(row.txnDate),
      amount: row.amount,
      note: row.note,
      invoiceRegistrationNumber: row.invoiceRegistrationNumber,
      voidReason: row.voidReason,
      replacedById: replacement?.id ?? null,
    },
    partner: partner
      ? {
          id: partner.id,
          name: partner.name,
          invoiceRegistrationNumber: partner.invoiceRegistrationNumber,
          paymentTerms: termsOf(partner),
        }
      : null,
    registration: payable.registration,
    expenses: expenseLines.map((line) => ({
      accountId: line.accountId,
      accountCode: line.account.code,
      accountName: line.account.name,
      taxCategoryCode: line.taxCategoryCode,
      taxCategoryName: line.taxCategory.name,
      segmentId: line.segmentId,
      segmentName: line.segment?.name ?? null,
      amount: line.amount,
      taxAmount: line.taxAmount,
    })),
    payments,
    actions: {
      pay: inForce && isOpenPayableState(payable.state),
      update: inForce,
      cancel: !cancelled && cancelBlocked === null,
      cancelBlocked,
      reregister: inForce && cancelled,
    },
  };
}

function jsonRecord(value: Prisma.JsonValue | null): Prisma.JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function jsonString(value: Prisma.JsonValue | null, key: string): string | null {
  const item = jsonRecord(value)?.[key];
  return typeof item === "string" ? item : null;
}

/**
 * The history of the payable, oldest first (25 §7.2): its audit log (`entity = payable`) on the
 * document and on the documents it replaced (the payable moved with the replacement), and the
 * voids of its entries made elsewhere, which change the rest too (derived): a payment put back
 * with its statement line (「未処理に戻す」, via `statement`) or voided on the transaction screen
 * (via `entries`), and a registration voided on the transaction screen (`payable.cancel` via
 * `entries`). Those rows are the `journal_entry.void` of the audit log (its time, actor, reason).
 * Read only.
 */
export async function loadPayableHistory(db: Db, documentId: string): Promise<PayableHistoryRow[]> {
  const ids = [documentId];
  let current: string | null = documentId;
  while (current && ids.length < HISTORY_CHAIN_LIMIT) {
    const document: { supersedesId: string | null } | null = await db.document.findUnique({
      where: { id: current },
      select: { supersedesId: true },
    });
    current = document?.supersedesId ?? null;
    if (current) ids.push(current);
  }
  const own = await db.auditLog.findMany({
    where: { entity: "payable", entityId: { in: ids } },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });

  // The entries the payables screen registered and voided itself (already in its own rows).
  const registrations = new Set<string>();
  const voidedHere = new Set<string>();
  for (const row of own) {
    const registered = row.action === "payable.register" ? jsonString(row.after, "entryId") : null;
    if (registered) registrations.add(registered);
    if (row.action === "payable.cancel_payment" || row.action === "payable.cancel") {
      const voided = jsonString(row.before, "entryId");
      if (voided) voidedHere.add(voided);
    }
  }
  for (const document of await db.document.findMany({
    where: { id: { in: ids } },
    select: { payableEntryId: true },
  })) {
    if (document.payableEntryId) registrations.add(document.payableEntryId);
  }

  const voided = await db.journalEntry.findMany({
    where: {
      status: "voided",
      kind: { not: "reversal" },
      id: { notIn: [...voidedHere] },
      documentLinks: { some: { documentId: { in: ids } } },
    },
    select: {
      id: true,
      no: true,
      sourceKind: true,
      sourceId: true,
      lines: { where: { ...payableLineWhere, side: "debit" }, select: { amount: true } },
    },
  });
  const elsewhere = voided.filter(
    (entry) => registrations.has(entry.id) || entry.lines.some((line) => line.amount > 0n),
  );
  const voidRows = await db.auditLog.findMany({
    where: {
      entity: "journal_entry",
      action: "journal_entry.void",
      entityId: { in: elsewhere.map((entry) => entry.id) },
    },
  });
  // A payment from a statement line put back on the statement screen: the line's 「未処理に戻す」
  // row says which entry it left.
  const lineIds = elsewhere.flatMap((entry) =>
    entry.sourceKind === "wallet_txn" && entry.sourceId ? [entry.sourceId] : [],
  );
  const reopened = new Set(
    (
      await db.auditLog.findMany({
        where: {
          entity: "wallet_transaction",
          action: "wallet_transaction.reopen",
          entityId: { in: lineIds },
        },
        select: { before: true },
      })
    ).flatMap((row) => jsonString(row.before, "journalEntryId") ?? []),
  );
  const entries = new Map(elsewhere.map((entry) => [entry.id, entry]));
  const rows: PayableHistoryRow[] = own.map((row) => ({
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    via: null,
    before: row.before,
    after: row.after,
    reason: row.reason,
  }));
  for (const row of voidRows) {
    const entry = row.entityId ? entries.get(row.entityId) : undefined;
    if (!entry) continue;
    const registration = registrations.has(entry.id);
    rows.push({
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: registration ? "payable.cancel" : "payable.cancel_payment",
      via: !registration && reopened.has(entry.id) ? "statement" : "entries",
      before: { entryId: entry.id, entryNo: entry.no },
      after: row.after,
      reason: row.reason,
    });
  }
  return rows.sort((a, b) =>
    a.at.getTime() !== b.at.getTime() ? a.at.getTime() - b.at.getTime() : a.id < b.id ? -1 : 1,
  );
}

/** 「未払として登録」 or 「支払を開く」 on a document's detail (25 §5); `null` without the document. */
export async function loadDocumentPayableStatus(
  db: Db,
  documentId: string,
): Promise<DocumentPayableStatus | null> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: { status: true, payableEntryId: true },
  });
  if (!document) return null;
  const payable = document.payableEntryId ? await loadPayable(db, documentId, null) : null;
  return {
    canRegister:
      document.status !== "voided" && (payable === null || payable.state === "cancelled"),
    state: payable?.state ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reads: the registration form (25 §7.1)
// ---------------------------------------------------------------------------

/** A document without a registration in force (never registered, or its registration cancelled). */
const NOT_REGISTERED: Prisma.DocumentWhereInput = {
  OR: [{ payableEntryId: null }, { payableEntry: { status: "voided" } }],
};

async function registrationProblem(
  db: Db,
  document: Pick<Document, "status" | "payableEntryId">,
): Promise<{ problem: string | null; registered: boolean }> {
  if (document.status === "voided") {
    return {
      problem: "無効にした証憑は登録できません。有効な証憑を選んでください",
      registered: false,
    };
  }
  if (document.payableEntryId) {
    const entry = await db.journalEntry.findUnique({
      where: { id: document.payableEntryId },
      select: { status: true },
    });
    if (entry?.status === "posted") {
      return {
        problem: "この証憑は未払として登録済みです。支払の画面で開いてください",
        registered: true,
      };
    }
  }
  return { problem: null, registered: false };
}

/**
 * The choices of the registration (25 §7.1): the document of `?document=` (with why it cannot be
 * registered), the candidates (受信箱か受領した請求書で、無効でなく、支払の登録がないもの, newest
 * first, 20), the active partners with their defaults and payment terms, the accounts, tax
 * categories, segments and wallets, and the first values (`payableDefaults`).
 */
export async function loadPayableFormOptions(
  db: Db,
  options: { documentId?: string | null } = {},
): Promise<PayableFormOptions> {
  const chosen = options.documentId
    ? await db.document.findUnique({
        where: { id: options.documentId },
        include: { partner: { select: { name: true } } },
      })
    : null;
  const candidates = await db.document.findMany({
    where: {
      AND: [
        { status: { not: "voided" } },
        { OR: [{ kind: "invoice_in" }, { status: "inbox" }] },
        NOT_REGISTERED,
      ],
    },
    orderBy: [{ uploadedAt: "desc" }, { id: "desc" }],
    take: DOCUMENT_CHOICES,
    include: { partner: { select: { name: true } } },
  });

  const partnerRows = await db.partner.findMany({
    where: {
      OR: [{ isActive: true }, ...(chosen?.partnerId ? [{ id: chosen.partnerId }] : [])],
    },
    orderBy: [{ nameKana: { sort: "asc", nulls: "last" } }, { name: "asc" }],
  });
  const partners = partnerRows.map((partner): PayableFormPartner => ({
    id: partner.id,
    name: partner.name,
    nameKana: partner.nameKana,
    invoiceRegistrationNumber: partner.invoiceRegistrationNumber,
    defaultAccountId: partner.defaultAccountId,
    defaultTaxCategoryCode: partner.defaultTaxCategoryCode,
    defaultSegmentId: partner.defaultSegmentId,
    paymentTerms: termsOf(partner),
    isActive: partner.isActive,
  }));

  const walletRows = await db.wallet.findMany({
    where: { isActive: true },
    orderBy: { id: "asc" },
    include: {
      account: { select: { kind: true, name: true, isActive: true } },
      subAccount: { select: { name: true } },
    },
  });
  const walletAccountIds = walletAccountIdsOf(walletRows);
  const accountRows = await db.account.findMany({
    where: { isActive: true, kind: { in: ["expense", "asset"] } },
    orderBy: { code: "asc" },
  });
  const accounts = accountRows
    .filter((account) => isPayableExpenseAccount(account, walletAccountIds))
    .map((account): PayableFormAccount => ({
      id: account.id,
      code: account.code,
      name: account.name,
      kind: account.kind,
      defaultTaxCategoryCode: account.defaultTaxCategoryCode,
      defaultSegmentId: account.defaultSegmentId,
      isActive: account.isActive,
    }));
  const taxCategories = await db.taxCategory.findMany({
    where: { isActive: true, direction: { in: ["purchase", "none"] } },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: { code: true, name: true, kind: true, direction: true, isActive: true },
  });
  const segments = await db.segment.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: { id: true, code: true, name: true, isActive: true },
  });
  const fiscalYears = await db.fiscalYear.findMany({ orderBy: { no: "asc" } });
  const outsource = accounts.find(
    (account) => account.code === PAYABLE_DEFAULT_EXPENSE_ACCOUNT_CODE,
  );
  const corporate = await db.segment.findUnique({
    where: { code: CORPORATE_SEGMENT_CODE },
    select: { id: true },
  });

  let document: PayableFormDocument | null = null;
  let values: PayableFormValues | null = null;
  if (chosen) {
    const { problem, registered } = await registrationProblem(db, chosen);
    document = {
      id: chosen.id,
      kind: chosen.kind,
      status: chosen.status,
      originalName: chosen.originalName,
      mime: chosen.mime,
      txnDate: fromDbDateOrNull(chosen.txnDate),
      amount: chosen.amount,
      partnerId: chosen.partnerId,
      partnerName: chosen.partner?.name ?? chosen.partnerName,
      invoiceRegistrationNumber: chosen.invoiceRegistrationNumber,
      note: chosen.note,
      problem,
      registered,
    };
    if (!problem) {
      const partner = partners.find((item) => item.id === chosen.partnerId) ?? null;
      const account =
        accounts.find((item) => item.id === partner?.defaultAccountId) ?? outsource ?? null;
      const invoiceDate = fromDbDateOrNull(chosen.txnDate);
      values = {
        documentId: chosen.id,
        partnerId: partner?.id ?? null,
        invoiceDate,
        amount: chosen.amount,
        walletId: null,
        ...payableDefaults({
          partner,
          account,
          fallbackSegmentId: corporate?.id ?? null,
          documentRegistrationNumber: chosen.invoiceRegistrationNumber,
          invoiceDate,
        }),
      };
    }
  }

  return {
    document,
    candidates: candidates.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      originalName: row.originalName,
      txnDate: fromDbDateOrNull(row.txnDate),
      amount: row.amount,
      partnerName: row.partner?.name ?? row.partnerName,
      uploadedAt: row.uploadedAt,
    })),
    partners,
    accounts,
    taxCategories,
    segments,
    wallets: walletRows
      .filter(
        (wallet) =>
          wallet.account.isActive &&
          (wallet.account.kind === "asset" || wallet.account.kind === "liability"),
      )
      .map((wallet) => ({
        id: wallet.id,
        name: wallet.name,
        kind: wallet.kind,
        accountName: wallet.account.name,
        subAccountName: wallet.subAccount?.name ?? null,
      })),
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
    taxRules: await loadTaxRules(db),
    defaults: { accountId: outsource?.id ?? null, segmentId: corporate?.id ?? null },
    values,
  };
}

// ---------------------------------------------------------------------------
// Reads: statement lines and payables that match (25 §7.2, §7.3)
// ---------------------------------------------------------------------------

function closeness(amount: Money, remaining: Money): Money {
  const difference = amount - remaining;
  return difference < 0n ? -difference : difference;
}

/**
 * The statement lines that can pay the payable (25 §7.2): pending outflows on active wallets, dated
 * on or after the invoice date, of at most the rest + 1,100 yen (the fee); the 200 newest read, the
 * 20 closest to the rest offered (then the newest). Empty when nothing is to pay.
 */
export async function loadPaymentCandidates(
  db: Db,
  documentId: string,
): Promise<PaymentLineCandidate[]> {
  const payable = await loadPayable(db, documentId, null);
  if (!payable || payable.row.status === "voided" || !isOpenPayableState(payable.state)) return [];
  const remaining = payable.remaining;
  const rows = await db.walletTransaction.findMany({
    where: {
      status: "pending",
      amount: { lt: 0n },
      txnDate: { gte: toDbDate(payable.invoiceDate) },
      wallet: { isActive: true },
    },
    orderBy: [{ txnDate: "desc" }, { id: "desc" }],
    take: CANDIDATE_SCAN,
    include: { wallet: { select: { name: true } } },
  });
  return rows
    .filter((row) => -row.amount <= remaining + PAYABLE_FEE_LIMIT)
    .map((row): PaymentLineCandidate => {
      const amount = -row.amount;
      const split = splitPayablePayment(amount, remaining);
      return {
        id: row.id,
        walletId: row.walletId,
        walletName: row.wallet.name,
        txnDate: fromDbDate(row.txnDate),
        description: row.descriptionRaw,
        counterparty: row.counterpartyRaw,
        amount,
        applied: split.applied,
        fee: split.fee,
        remainingAfter: split.remainingAfter,
      };
    })
    .sort((a, b) => {
      const x = closeness(a.amount, remaining);
      const y = closeness(b.amount, remaining);
      if (x !== y) return x < y ? -1 : 1;
      return a.txnDate === b.txnDate ? 0 : a.txnDate > b.txnDate ? -1 : 1;
    })
    .slice(0, CANDIDATE_LIMIT);
}

/**
 * 明細から「この支払に充てる」 (25 §7.3): a pending outflow on an active wallet and the open payables
 * it can pay: invoiced on or before the line, with a rest of at least |出金額| − 1,100. The payables
 * of the partner the line names first, then the closest rest, then the oldest due date; 20.
 * `null` when the line is missing.
 */
export async function loadPayableCandidates(
  db: Db,
  walletTransactionId: string,
  options: { today: CalendarDate },
): Promise<PaymentForPayables | null> {
  const row = await db.walletTransaction.findUnique({
    where: { id: walletTransactionId },
    include: { wallet: { select: { name: true, isActive: true } } },
  });
  if (!row) return null;
  const line: PaymentForPayables["line"] = {
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
    problem = "この明細は処理済みです。未処理の出金の明細から選んでください";
  } else if (row.amount >= 0n) {
    problem = "入金の明細は支払に充てられません。出金の明細から選んでください";
  } else if (!row.wallet.isActive) {
    problem = `口座「${row.wallet.name}」は無効です。設定 › 口座 で有効にしてください`;
  }
  if (problem) return { line, problem, payables: [] };

  const amount = -row.amount;
  const open = (await loadPayables(db, IN_FORCE, options.today)).filter(
    (payable) =>
      isOpenPayableState(payable.state) &&
      payable.invoiceDate <= line.txnDate &&
      payable.remaining >= amount - PAYABLE_FEE_LIMIT,
  );
  const payables = open
    .map((payable): PayableForPayment & { closeness: Money } => {
      const split = splitPayablePayment(amount, payable.remaining);
      return {
        documentId: payable.documentId,
        partnerName: payable.partnerName,
        title: payable.title,
        invoiceDate: payable.invoiceDate,
        dueDate: payable.dueDate,
        amount: payable.amount,
        remaining: payable.remaining,
        applied: split.applied,
        fee: split.fee,
        remainingAfter: split.remainingAfter,
        overdue: payable.overdue,
        samePartner: statementNamesPartner(row, {
          name: payable.partnerName,
          nameKana: payable.partnerKana,
        }),
        closeness: closeness(amount, payable.remaining),
      };
    })
    .sort((a, b) => {
      if (a.samePartner !== b.samePartner) return a.samePartner ? -1 : 1;
      if (a.closeness !== b.closeness) return a.closeness < b.closeness ? -1 : 1;
      const aDue = a.dueDate ?? NO_DUE_DATE;
      const bDue = b.dueDate ?? NO_DUE_DATE;
      return aDue < bDue ? -1 : aDue > bDue ? 1 : 0;
    })
    .slice(0, CANDIDATE_LIMIT)
    .map(({ closeness: _closeness, ...payable }) => payable);
  return { line, problem: null, payables };
}

// ---------------------------------------------------------------------------
// Writes: shared
// ---------------------------------------------------------------------------

/** Locks the document's row until the transaction ends, then reads it. */
async function lockDocumentRow(tx: Tx, id: string): Promise<Document> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "document" WHERE "id" = ${id} FOR UPDATE`;
  const row = locked.length > 0 ? await tx.document.findUnique({ where: { id } }) : null;
  if (!row) throw new SettingsError(DOCUMENT_NOT_FOUND, { field: "documentId" });
  return row;
}

/** Locks a statement line and reads it with its wallet; `null` when there is none. */
async function lockStatementLine(tx: Tx, id: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "wallet_transaction" WHERE "id" = ${id} FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.walletTransaction.findUnique({
    where: { id },
    include: { wallet: { select: { name: true, isActive: true } } },
  });
}

/** Re-throws the ledger's errors with the form field each belongs to. */
function withLedgerFields(
  error: LedgerValidationError,
  fieldOf: (item: LedgerError) => string | undefined,
): LedgerValidationError {
  return new LedgerValidationError(
    error.errors.map((item) => {
      if (item.field) return item;
      const field = fieldOf(item);
      return field ? { ...item, field, message: item.message.replace(LINE_PREFIX, "") } : item;
    }),
  );
}

/** The fiscal year containing the date, locked; its errors name `field`. */
async function lockFiscalYearFor(tx: Tx, date: CalendarDate, field: string): Promise<FiscalYear> {
  try {
    return await lockFiscalYearOn(tx, date);
  } catch (error) {
    if (error instanceof LedgerValidationError) {
      throw new LedgerValidationError(error.errors.map((item) => ({ ...item, field })));
    }
    throw error;
  }
}

/** A payable can change only on a document in force (a void one's payable moved, or is history). */
function assertDocumentInForce(document: Document): void {
  if (document.status === "voided") throw new SettingsError(VOIDED_DOCUMENT);
}

/**
 * Cancelling stays possible on a voided document (its payable still counts in the book) unless a
 * replacement carries the payable now: then that document is the one to act on.
 */
async function assertNotMoved(tx: Tx, document: Document): Promise<void> {
  if (document.status !== "voided" || !document.payableEntryId) return;
  const moved = await tx.document.findFirst({
    where: {
      payableEntryId: document.payableEntryId,
      status: { not: "voided" },
      id: { not: document.id },
    },
    select: { id: true },
  });
  if (moved) throw new SettingsError(VOIDED_DOCUMENT);
}

async function requirePayable(tx: Tx, document: Document): Promise<LoadedPayable> {
  const payable = document.payableEntryId ? await loadPayable(tx, document.id, null) : null;
  if (!payable) throw new SettingsError(NOT_FOUND);
  return payable;
}

async function assertWalletChoosable(
  tx: Tx,
  walletId: string,
  current: string | null,
): Promise<void> {
  const wallet = await tx.wallet.findUnique({
    where: { id: walletId },
    select: { name: true, isActive: true },
  });
  if (!wallet) {
    throw new SettingsError("口座が見つかりません。一覧から選んでください", { field: "walletId" });
  }
  if (!wallet.isActive && walletId !== current) {
    throw new SettingsError(`口座「${wallet.name}」は無効です。別の口座を選んでください`, {
      field: "walletId",
    });
  }
}

function payableSnapshot(document: {
  payableEntryId: string | null;
  payableDueDate: Date | null;
  payableWalletId: string | null;
}) {
  return {
    entryId: document.payableEntryId,
    dueDate: fromDbDateOrNull(document.payableDueDate),
    walletId: document.payableWalletId,
  };
}

// ---------------------------------------------------------------------------
// Writes: 登録 (25 §4.1)
// ---------------------------------------------------------------------------

/** A ledger error of the registration → the form field. */
function registerField(item: LedgerError): string | undefined {
  if (DATE_CODES.has(item.code)) return "invoiceDate";
  if (item.code === "SEGMENT_REQUIRED") return "segmentId";
  if (item.lineIndex !== 0) return undefined;
  if (ACCOUNT_CODES.has(item.code)) return "accountId";
  if (TAX_CODES.has(item.code)) return "taxCategoryCode";
  if (item.code === "NON_POSITIVE_AMOUNT" || item.code === "INVALID_AMOUNT") return "amount";
  return undefined;
}

/**
 * 未払として登録 (25 §4.1): 費用 / 未払金 (2100・補助科目なし・取引先) on the invoice date
 * (`sourceKind = manual`); the document becomes 受領した請求書 with its empty search items filled
 * (`updateDocument`), is linked to the entry (`linkDocument`) and keeps the entry, the due date and
 * the planned wallet. One registration in force per document; after a cancel it can be registered
 * again (the new entry replaces the old one on the document). A void document cannot be registered.
 */
export async function registerPayable(
  db: Db,
  input: PayableRegisterInput,
  options: ActorOptions,
): Promise<PayableRecord> {
  const data = payableRegisterSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const document = await lockDocumentRow(tx, data.documentId);
    const { problem } = await registrationProblem(tx, document);
    if (problem) throw new SettingsError(problem, { field: "documentId" });

    const partner = await tx.partner.findUnique({ where: { id: data.partnerId } });
    if (!partner) {
      throw new SettingsError("取引先が見つかりません。画面を読み込み直してください", {
        field: "partnerId",
      });
    }
    if (!partner.isActive) {
      throw new SettingsError(
        "無効にした取引先は選べません。設定 › 取引先 で有効にするか、別の取引先を選んでください",
        { field: "partnerId" },
      );
    }
    if (data.walletId) await assertWalletChoosable(tx, data.walletId, null);
    const dueDate = data.dueDate ?? defaultPayableDueDate(data.invoiceDate, termsOf(partner));
    const dueProblem = payableDueDateProblem(data.invoiceDate, dueDate);
    if (dueProblem) throw new SettingsError(dueProblem, { field: "dueDate" });
    const segmentId = data.segmentId ?? (await defaultSegmentId(tx, partner, data.accountId));
    const description = data.description ?? payableDescription(partner.name);

    const fiscalYear = await lockFiscalYearFor(tx, data.invoiceDate, "invoiceDate");
    let posted: { id: string; no: number };
    try {
      const entry = buildPayableEntry(
        {
          invoiceDate: data.invoiceDate,
          partnerId: partner.id,
          qualifiedInvoice: Boolean(
            partner.invoiceRegistrationNumber || document.invoiceRegistrationNumber,
          ),
          description,
          lines: [
            {
              accountId: data.accountId,
              amount: data.amount,
              taxCategoryCode: data.taxCategoryCode,
              segmentId,
            },
          ],
        },
        await loadSimpleEntryContext(tx, fiscalYear),
      );
      posted = await postJournalEntryInTransaction(
        tx,
        { ...entry, fiscalYearId: fiscalYear.id },
        options,
      );
    } catch (error) {
      if (error instanceof LedgerValidationError) throw withLedgerFields(error, registerField);
      throw error;
    }

    // The document: 受領した請求書, its empty search items, the link (S6's audit `document.*`).
    const fill: DocumentUpdateInput = { id: document.id };
    if (document.kind !== "invoice_in") fill.kind = "invoice_in";
    if (document.txnDate === null) fill.txnDate = data.invoiceDate;
    if (document.amount === null) fill.amount = data.amount;
    if (document.partnerId === null && document.partnerName === null) fill.partnerId = partner.id;
    if (Object.keys(fill).length > 1) await updateDocument(tx, fill, options);
    await linkDocument(
      tx,
      { kind: "journal_entry", id: posted.id, documentId: document.id },
      options,
    );
    const row = await tx.document.update({
      where: { id: document.id },
      data: {
        payableEntryId: posted.id,
        payableDueDate: toDbDate(dueDate),
        payableWalletId: data.walletId,
      },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "payable.register",
      entity: "payable",
      entityId: document.id,
      ...(document.payableEntryId ? { before: payableSnapshot(document) } : {}),
      after: {
        ...payableSnapshot(row),
        entryNo: posted.no,
        partnerId: partner.id,
        invoiceDate: data.invoiceDate,
        amount: data.amount,
        accountId: data.accountId,
        taxCategoryCode: data.taxCategoryCode,
        segmentId,
      },
    });
    return { documentId: document.id, partnerName: partner.name, entry: posted };
  });
}

/** セグメントの既定 (25 §4.1): the partner's, else the account's, else 共通. */
async function defaultSegmentId(
  tx: Tx,
  partner: Pick<Partner, "defaultSegmentId">,
  accountId: string,
): Promise<string | null> {
  if (partner.defaultSegmentId) return partner.defaultSegmentId;
  const account = await tx.account.findUnique({
    where: { id: accountId },
    select: { defaultSegmentId: true },
  });
  if (account?.defaultSegmentId) return account.defaultSegmentId;
  const corporate = await tx.segment.findUnique({
    where: { code: CORPORATE_SEGMENT_CODE },
    select: { id: true },
  });
  return corporate?.id ?? null;
}

// ---------------------------------------------------------------------------
// Writes: 期日・支払元の予定 (25 §4.3) and the partner's payment terms (25 §3)
// ---------------------------------------------------------------------------

/**
 * 期日・支払元を変える (25 §4.3): not a ledger change, so at any time while the document is in force
 * (a cleared due date leaves the payable undated). Audit `payable.update`; nothing is written
 * without a change.
 */
export async function updatePayable(
  db: Db,
  documentId: string,
  input: PayableUpdateInput,
  options: ActorOptions,
): Promise<PayableUpdateResult> {
  const data = payableUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const document = await lockDocumentRow(tx, documentId);
    assertDocumentInForce(document);
    const payable = await requirePayable(tx, document);
    const patch: Prisma.DocumentUncheckedUpdateInput = {};
    const before = payableSnapshot(document);
    let { dueDate, walletId } = before;
    if (data.dueDate !== undefined) {
      const problem = payableDueDateProblem(payable.invoiceDate, data.dueDate);
      if (problem) throw new SettingsError(problem, { field: "dueDate" });
      dueDate = data.dueDate;
    }
    if (data.walletId !== undefined) {
      if (data.walletId) await assertWalletChoosable(tx, data.walletId, document.payableWalletId);
      walletId = data.walletId;
    }
    if (dueDate !== before.dueDate) patch.payableDueDate = dueDate ? toDbDate(dueDate) : null;
    if (walletId !== before.walletId) patch.payableWalletId = walletId;
    if (Object.keys(patch).length > 0) {
      const row = await tx.document.update({ where: { id: document.id }, data: patch });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "payable.update",
        entity: "payable",
        entityId: document.id,
        before,
        after: payableSnapshot(row),
      });
    }
    return { documentId: document.id, dueDate, walletId };
  });
}

/**
 * 「この取引先の支払条件として保存」 (25 §3): 締め日・何か月後・支払日 of the partner (all three or
 * none). Audit `partner.update` (before / after, as 設定 › 取引先 writes it). Returns the terms.
 */
export async function updatePartnerPaymentTerms(
  db: Db,
  input: PartnerPaymentTermsInput,
  options: ActorOptions,
): Promise<PaymentTerms | null> {
  const data = partnerPaymentTermsSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.partner.findUnique({ where: { id: data.partnerId } });
    if (!current) {
      throw new SettingsError("取引先が見つかりません。画面を読み込み直してください", {
        field: "partnerId",
      });
    }
    const patch = {
      paymentClosingDay: data.terms?.closingDay ?? null,
      paymentDueMonths: data.terms?.dueMonths ?? null,
      paymentDueDay: data.terms?.dueDay ?? null,
    };
    const unchanged =
      current.paymentClosingDay === patch.paymentClosingDay &&
      current.paymentDueMonths === patch.paymentDueMonths &&
      current.paymentDueDay === patch.paymentDueDay;
    if (unchanged) return data.terms;
    const row = await tx.partner.update({ where: { id: current.id }, data: patch });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "partner.update",
      entity: "partner",
      entityId: row.id,
      before: current,
      after: row,
    });
    return termsOf(row);
  });
}

// ---------------------------------------------------------------------------
// Writes: 支払 (25 §4.2)
// ---------------------------------------------------------------------------

/** A ledger error of a payment → the form field. */
function paymentField(entry: JournalEntryInput | undefined) {
  return (item: LedgerError): string | undefined => {
    if (DATE_CODES.has(item.code)) return "paidOn";
    if (item.code === "SEGMENT_REQUIRED") return "amount";
    if (ACCOUNT_CODES.has(item.code) && entry && item.lineIndex === entry.lines.length - 1) {
      return "walletId";
    }
    return undefined;
  };
}

/**
 * 支払の登録 (25 §4.2): 未払金 / 口座 on the payment date. 充当額 = min(出金額, 残り); what exceeds the
 * rest, up to 1,100 yen, is the transfer fee (支払手数料); more is refused; less is a partial payment.
 * A statement line (`walletTransactionId`: a pending outflow of the chosen wallet) gives the date,
 * the wallet and the amount; the entry is the line's (`sourceKind = wallet_txn`) and the line becomes
 * 登録済み (`settleWalletTransactionWithEntry`). The document is linked to the entry and the line.
 */
export async function payPayable(
  db: Db,
  documentId: string,
  input: PayablePaymentInput,
  options: ActorOptions,
): Promise<PayablePaymentResult> {
  const data = payablePaymentSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const document = await lockDocumentRow(tx, documentId);
    assertDocumentInForce(document);
    const payable = await requirePayable(tx, document);
    if (payable.state === "cancelled") {
      throw new SettingsError(
        "登録を取り消した請求書には支払えません。未払として登録し直してください",
      );
    }
    if (payable.state === "paid") {
      throw new SettingsError("支払済みのため残りはありません。画面を読み込み直してください");
    }

    let { paidOn, walletId, amount } = data;
    let lineId: string | null = null;
    if (data.walletTransactionId) {
      const field = "walletTransactionId";
      const line = await lockStatementLine(tx, data.walletTransactionId);
      if (!line) {
        throw new SettingsError("明細が見つかりません。画面を読み込み直してください", { field });
      }
      if (line.status !== "pending") {
        throw new SettingsError(
          "この明細は処理済みです。別の明細を選ぶか、手入力で登録してください",
          { field },
        );
      }
      if (line.amount >= 0n) {
        throw new SettingsError("この明細は入金です。出金の明細を選んでください", { field });
      }
      if (line.walletId !== data.walletId) {
        throw new SettingsError("口座が明細の口座と違います。明細の口座を選んでください", {
          field: "walletId",
        });
      }
      paidOn = fromDbDate(line.txnDate);
      walletId = line.walletId;
      amount = -line.amount;
      lineId = line.id;
    }
    if (paidOn < payable.invoiceDate) {
      throw new SettingsError("支払日は請求書の日付以後にしてください", { field: "paidOn" });
    }
    const split = splitPayablePayment(amount, payable.remaining);
    if (split.problem) throw new SettingsError(split.problem, { field: "amount" });

    const fiscalYear = await lockFiscalYearFor(tx, paidOn, "paidOn");
    const expense = await tx.journalLine.findFirst({
      where: { journalEntryId: payable.registration.id, side: "debit", segmentId: { not: null } },
      orderBy: { lineNo: "asc" },
      select: { segmentId: true },
    });
    let entry: JournalEntryInput | undefined;
    let posted: { id: string; no: number };
    try {
      entry = buildPayablePaymentEntry(
        {
          paidOn,
          walletId,
          amount,
          fee: split.fee,
          partnerId: payable.partnerId,
          description: payablePaymentDescription(payable.partnerName, payable.title),
          segmentId: expense?.segmentId ?? null,
          walletTransactionId: lineId,
        },
        await loadSimpleEntryContext(tx, fiscalYear),
      );
      posted = await postJournalEntryInTransaction(
        tx,
        { ...entry, fiscalYearId: fiscalYear.id },
        options,
      );
    } catch (error) {
      if (error instanceof LedgerValidationError) {
        throw withLedgerFields(error, paymentField(entry));
      }
      throw error;
    }

    if (lineId) await settleWalletTransactionWithEntry(tx, lineId, posted.id, options);
    await linkDocument(tx, { kind: "journal_entry", id: posted.id, documentId }, options);
    if (lineId) {
      await linkDocument(tx, { kind: "wallet_transaction", id: lineId, documentId }, options);
    }
    const state = payableState({
      registrationStatus: "posted",
      registered: payable.amount,
      remaining: split.remainingAfter,
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "payable.pay",
      entity: "payable",
      entityId: documentId,
      before: { remaining: payable.remaining, state: payable.state },
      after: {
        entryId: posted.id,
        entryNo: posted.no,
        paidOn,
        walletId,
        walletTransactionId: lineId,
        amount,
        applied: split.applied,
        fee: split.fee,
        remaining: split.remainingAfter,
        state,
      },
    });
    return {
      documentId,
      entry: posted,
      applied: split.applied,
      fee: split.fee,
      remaining: split.remainingAfter,
      state,
    };
  });
}

// ---------------------------------------------------------------------------
// Writes: 支払の取消・登録の取消 (25 §4.3)
// ---------------------------------------------------------------------------

/**
 * 支払の取消 (25 §4.3, the reason is required): a payment from a statement line goes back with the
 * line (`reopenWalletTransaction`: the entry is reversed and the line is 未処理 again); any other
 * payment is reversed with `voidJournalEntryWithOpenDate` (on the first open date when its month is
 * closed). The rest comes back by itself (derived).
 */
export async function cancelPayablePayment(
  db: Db,
  documentId: string,
  input: CancelPayablePaymentInput,
  options: ActorOptions,
): Promise<PayableReversalResult> {
  const data = cancelPayablePaymentSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const document = await lockDocumentRow(tx, documentId);
    await assertNotMoved(tx, document);
    const payable = await requirePayable(tx, document);
    const payment = payable.payments.find((item) => item.entryId === data.entryId);
    if (!payment) {
      throw new SettingsError(
        "この支払は見つからないか、取り消されています。画面を読み込み直してください",
        { field: "entryId" },
      );
    }
    const line =
      payment.sourceKind === "wallet_txn" && payment.sourceId
        ? await tx.walletTransaction.findUnique({
            where: { id: payment.sourceId },
            select: { id: true, journalEntryId: true },
          })
        : null;
    let result: PayableReversalResult;
    if (line && line.journalEntryId === payment.entryId) {
      const reopened = await reopenWalletTransaction(tx, line.id, { reason: data.reason }, options);
      if (!reopened.reversal) throw new SettingsError(NOT_FOUND);
      result = { documentId, reversal: reopened.reversal, reopenedIds: reopened.reopenedIds };
    } else {
      const { reversal } = await voidJournalEntryWithOpenDate(
        tx,
        payment.entryId,
        { reason: data.reason },
        options,
      );
      result = {
        documentId,
        reversal: { id: reversal.id, no: reversal.no, entryDate: reversal.entryDate },
        reopenedIds: [],
      };
    }
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "payable.cancel_payment",
      entity: "payable",
      entityId: documentId,
      before: {
        entryId: payment.entryId,
        entryNo: payment.no,
        paidOn: payment.entryDate,
        applied: payment.applied,
        remaining: payable.remaining,
      },
      after: {
        reversalEntryId: result.reversal.id,
        reversalNo: result.reversal.no,
        reopenedIds: result.reopenedIds,
        remaining: payable.remaining + payment.applied,
      },
      reason: data.reason,
    });
    return result;
  });
}

/**
 * 登録の取消 (25 §4.3, the reason is required): refused while payments remain (先に支払を取り消す);
 * the 計上 entry is reversed (`voidJournalEntryWithOpenDate`) and the payable becomes 取消. The
 * document keeps its columns (history); registering it again replaces them.
 */
export async function cancelPayable(
  db: Db,
  documentId: string,
  input: CancelPayableInput,
  options: ActorOptions,
): Promise<PayableReversalResult> {
  const data = cancelPayableSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const document = await lockDocumentRow(tx, documentId);
    await assertNotMoved(tx, document);
    const payable = await requirePayable(tx, document);
    if (payable.state === "cancelled") {
      throw new SettingsError("この登録は取り消されています。画面を読み込み直してください");
    }
    if (payable.payments.length > 0) {
      throw new SettingsError("支払が残っているため取り消せません。先に支払を取り消してください");
    }
    const { reversal } = await voidJournalEntryWithOpenDate(
      tx,
      payable.registration.id,
      { reason: data.reason },
      options,
    );
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "payable.cancel",
      entity: "payable",
      entityId: documentId,
      before: { ...payableSnapshot(document), state: payable.state },
      after: { reversalEntryId: reversal.id, reversalNo: reversal.no, state: "cancelled" },
      reason: data.reason,
    });
    return {
      documentId,
      reversal: { id: reversal.id, no: reversal.no, entryDate: reversal.entryDate },
      reopenedIds: [],
    };
  });
}

/** For the audit log screen: what an `entity = payable` row names (「支払 <取引先> <内容>」). */
export function payableAuditName(row: {
  partnerName: string | null;
  note: string | null;
  originalName: string | null;
}): string {
  return [row.partnerName ?? "", documentTitle(row)].filter((part) => part !== "").join(" ");
}
