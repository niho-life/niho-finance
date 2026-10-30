/**
 * 定期請求 (18-invoicing §14): the template of an invoice with the rule of its due dates, the due
 * dates that have no invoice yet (やること and `/invoices/recurring/due`), and the drafts made from
 * them. A draft is never issued here: the owner checks it and issues it (§5.1). Nothing touches the
 * ledger.
 *
 * Nothing is stored about a month being 作成済み (derive, don't sync, 00 §5): it is the invoice that
 * carries the recurring invoice and the month of its due date (`recurringInvoiceId`,
 * `recurringMonth`), whatever its state; a partial unique index keeps one invoice per month. Every
 * write runs in one transaction that first locks the recurring invoice's row, and appends to the
 * audit log (`recurring_invoice.*`; a draft is `invoice.create`).
 */
import {
  addDays,
  computeInvoiceTotals,
  dateParts,
  describeRecurringInvoiceDueRule,
  describeRecurringInvoiceSchedule,
  expandTargetMonth,
  formatQuantity,
  invoiceMonthLabel,
  invoiceNumberLabel,
  invoiceRateLabel,
  isLastDayOfMonth,
  isRecurringMonth,
  LedgerValidationError,
  lineAmount,
  nextRecurringInvoiceDates,
  parseQuantity,
  recurringInvoiceDateInMonth,
  recurringInvoiceDates,
  recurringInvoiceDueDate,
  recurringInvoiceTargetOffsetLabel,
  recurringMonth,
  REDUCED_TAX_CATEGORY_CODES,
  type CalendarDate,
  type InvoiceStatus,
  type InvoiceTotals,
  type Money,
  type RecurringInvoiceFrequency,
  type RecurringInvoiceSchedule,
  type RecurringMonth,
  type SalesTaxCategoryCode,
  type TaxRateRule,
} from "@niho-finance/ledger";
import type { Prisma, RecurringInvoice } from "@prisma/client";
import { ZodError } from "zod";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, todayInJapan, toDbDate } from "./dates";
import { loadTaxRules } from "./entries";
import { isUniqueViolation, SettingsError } from "./errors";
import { newId } from "./ids";
import {
  insertInvoiceDraft,
  json,
  loadInvoiceFormOptions,
  requireInvoicePartner,
  resolveRevenueAccount,
  resolveSegment,
  stableJson,
  type InvoiceFormOptions,
  type InvoiceHistoryRow,
  type InvoiceRateRow,
  type InvoiceRecord,
  type InvoiceRef,
} from "./invoices";
import type { ActorOptions } from "./journal";
import { RECURRING_DUE_DAYS } from "./recurring-post";
import type { HomeTodoSource } from "./reports-query";
import {
  INVOICE_TEXT_MAX,
  recurringInvoiceDraftSchema,
  recurringInvoiceDraftsSchema,
  recurringInvoiceSchema,
  type ParsedRecurringInvoice,
  type RecurringInvoiceDraftInput,
  type RecurringInvoiceDraftsInput,
  type RecurringInvoiceInput,
} from "./schemas";
import { runInTransaction, type Tx } from "./transaction";

/** How many due dates the form and the detail show ahead (「次回 3 回の予定日」). */
export const RECURRING_INVOICE_NEXT_DATES = 3;

const NOT_FOUND = "定期請求が見つかりません。画面を読み込み直してください";
const PAUSED = "この定期請求は停止しています";
const NOT_DUE = "この月は予定日ではありません";

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/** A line of the template as stored in `lines` (18 §3.3 without the date and the amount). */
export interface StoredRecurringInvoiceLine {
  name: string;
  /** `formatQuantity`: `"1.5"`. */
  quantity: string;
  unit: string | null;
  unitPrice: string;
  taxCategoryCode: string;
}

function readLines(value: Prisma.JsonValue): StoredRecurringInvoiceLine[] {
  return Array.isArray(value) ? (value as unknown as StoredRecurringInvoiceLine[]) : [];
}

/** When a row's drafts are due (18 §14.1). */
export function recurringInvoiceScheduleOf(
  row: Pick<RecurringInvoice, "frequency" | "issueDay" | "startDate" | "endDate">,
): RecurringInvoiceSchedule {
  return {
    frequency: row.frequency,
    issueDay: row.issueDay,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDateOrNull(row.endDate),
  };
}

function quantityOf(line: StoredRecurringInvoiceLine): bigint {
  return parseQuantity(line.quantity) ?? 0n;
}

/** The totals of the template on a date's tax rules; `null` when a category has no rule then. */
function totalsOn(
  row: Pick<RecurringInvoice, "lines" | "pricesIncludeTax">,
  date: CalendarDate,
  rules: readonly TaxRateRule[],
): InvoiceTotals | null {
  try {
    return computeInvoiceTotals(
      readLines(row.lines).map((line) => ({
        quantity: quantityOf(line),
        unitPrice: BigInt(line.unitPrice),
        taxCategoryCode: line.taxCategoryCode,
      })),
      { pricesIncludeTax: row.pricesIncludeTax, issueDate: date, taxRules: rules },
    );
  } catch (error) {
    if (error instanceof LedgerValidationError) return null;
    throw error;
  }
}

/** The totals as the screens show them (per tax category with its name). */
export interface RecurringInvoiceTotals {
  rates: InvoiceRateRow[];
  amountExclusive: Money;
  taxTotal: Money;
  /** 税込の合計 */
  total: Money;
}

function totalsView(totals: InvoiceTotals | null): RecurringInvoiceTotals | null {
  if (!totals) return null;
  return {
    rates: totals.rates.map((rate) => ({ ...rate, label: invoiceRateLabel(rate) })),
    amountExclusive: totals.amountExclusive,
    taxTotal: totals.taxTotal,
    total: totals.total,
  };
}

/** The next due date after `today`, or `null` when the schedule has ended. */
function nextDateOf(row: RecurringInvoice, today: CalendarDate): CalendarDate | null {
  return (
    nextRecurringInvoiceDates(recurringInvoiceScheduleOf(row), { after: today, count: 1 })[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// 作成済み and the due dates (18 §14.2)
// ---------------------------------------------------------------------------

/** An invoice made from a recurring invoice. */
interface MadeInvoice {
  id: string;
  number: string;
  status: InvoiceStatus;
  issuedAt: Date | null;
  issueDate: Date;
  total: Money;
  recurringMonth: string | null;
}

/** The invoices made from the recurring invoices, by recurring invoice and month. */
async function madeInvoicesOf(
  db: Db,
  recurringInvoiceIds: readonly string[],
): Promise<Map<string, Map<string, MadeInvoice>>> {
  const made = new Map<string, Map<string, MadeInvoice>>();
  if (recurringInvoiceIds.length === 0) return made;
  const rows = await db.invoice.findMany({
    where: { recurringInvoiceId: { in: [...new Set(recurringInvoiceIds)] } },
    select: {
      id: true,
      number: true,
      status: true,
      issuedAt: true,
      issueDate: true,
      total: true,
      recurringInvoiceId: true,
      recurringMonth: true,
    },
  });
  for (const row of rows) {
    if (!row.recurringInvoiceId || !row.recurringMonth) continue;
    const months = made.get(row.recurringInvoiceId) ?? new Map<string, MadeInvoice>();
    months.set(row.recurringMonth, row);
    made.set(row.recurringInvoiceId, months);
  }
  return made;
}

/** 「INV-2026-0001」「下書き」「破棄した下書き」「INV-2026-0001（無効）」: the invoice of a month. */
function madeLabel(invoice: Pick<MadeInvoice, "number" | "status" | "issuedAt">): string {
  if (invoice.status === "void") {
    return invoice.issuedAt === null ? "破棄した下書き" : `${invoice.number}（無効）`;
  }
  return invoiceNumberLabel(invoice.number);
}

/** The due dates in the window `today − 92 < d ≤ today` (21 §10.2's window, 18 §14.2). */
function dueDatesOf(row: RecurringInvoice, today: CalendarDate): CalendarDate[] {
  return recurringInvoiceDates(recurringInvoiceScheduleOf(row), {
    after: addDays(today, -RECURRING_DUE_DAYS),
    through: today,
  });
}

/** A due date without an invoice: a row of `/invoices/recurring/due` (18 §14.5). */
export interface RecurringInvoiceDueRow {
  /** `<recurring invoice>:<YYYY-MM>` (React keys). */
  key: string;
  recurringInvoiceId: string;
  name: string;
  partnerId: string;
  partnerName: string;
  /** 予定日 = the draft's issue date. */
  date: CalendarDate;
  month: RecurringMonth;
  /** 件名 with the target month written in. */
  title: string | null;
  /** 税込の合計 on the date's tax rules (`null` when a category has no rule then). */
  total: Money | null;
}

const dueInclude = { partner: { select: { name: true } } } as const;

/** The due dates of the rows whose month has no invoice yet, in the order of the rows. */
async function dueWithoutInvoice<T extends RecurringInvoice>(
  db: Db,
  rows: readonly T[],
  today: CalendarDate,
): Promise<{ row: T; date: CalendarDate; month: RecurringMonth }[]> {
  if (rows.length === 0) return [];
  const made = await madeInvoicesOf(
    db,
    rows.map((row) => row.id),
  );
  return rows.flatMap((row) =>
    dueDatesOf(row, today)
      .map((date) => ({ row, date, month: recurringMonth(date) }))
      .filter((item) => !made.get(row.id)?.has(item.month)),
  );
}

async function loadDue(db: Db, today: CalendarDate): Promise<RecurringInvoiceDueRow[]> {
  const rows = await db.recurringInvoice.findMany({
    where: { isActive: true },
    include: dueInclude,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  if (rows.length === 0) return [];
  const rules = await loadTaxRules(db);
  const due = (await dueWithoutInvoice(db, rows, today)).map(
    ({ row, date, month }): RecurringInvoiceDueRow => ({
      key: `${row.id}:${month}`,
      recurringInvoiceId: row.id,
      name: row.name,
      partnerId: row.partnerId,
      partnerName: row.partner.name,
      date,
      month,
      title: row.title === null ? null : expandTargetMonth(row.title, date, row.targetMonthOffset),
      total: totalsOn(row, date, rules)?.total ?? null,
    }),
  );
  due.sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.recurringInvoiceId < b.recurringInvoiceId ? -1 : 1),
  );
  return due;
}

/**
 * The due dates without an invoice (18 §14.2): of the active recurring invoices, dated
 * `today − 92 < date ≤ today` between the start and the end date, whose month has no invoice (a
 * discarded draft and a void invoice count). Oldest first, then by name.
 */
export async function listDueRecurringInvoices(
  db: Db,
  options: { today: CalendarDate },
): Promise<RecurringInvoiceDueRow[]> {
  return loadDue(db, options.today);
}

/** 定期請求の下書きを作る n 件 (18 §14.4): the rows of `listDueRecurringInvoices`, counted. */
export async function countDueRecurringInvoices(
  db: Db,
  options: { today: CalendarDate },
): Promise<number> {
  const rows = await db.recurringInvoice.findMany({ where: { isActive: true } });
  return (await dueWithoutInvoice(db, rows, options.today)).length;
}

/** 定期請求の下書きを作る n 件 → `/invoices/recurring/due` (18 §14.4); nothing when none is due. */
export const recurringInvoicesDueTodo: HomeTodoSource = async (db, today) => {
  const count = await countDueRecurringInvoices(db, { today });
  if (count === 0) return [];
  return [
    {
      key: "recurring-invoices-due",
      badge: String(count),
      tone: "count",
      label: "定期請求の下書きを作る",
      href: "/invoices/recurring/due",
    },
  ];
};

// ---------------------------------------------------------------------------
// Reads: the list and the detail (18 §14.5)
// ---------------------------------------------------------------------------

export interface RecurringInvoiceListRow {
  id: string;
  name: string;
  partnerId: string;
  partnerName: string;
  partnerIsActive: boolean;
  frequency: RecurringInvoiceFrequency;
  /** 「毎月 25 日」「隔月 末日」「毎年 3 月 31 日」 */
  scheduleLabel: string;
  /** 税込の合計 on the next due date's tax rules (today's when it has ended). */
  total: Money | null;
  /** 次回の予定日: the first one after today; `null` once it has ended. */
  nextDate: CalendarDate | null;
  /** Due dates without an invoice (0 while paused). */
  dueCount: number;
  isActive: boolean;
}

export interface RecurringInvoiceList {
  /** Active ones first, then by name. */
  rows: RecurringInvoiceListRow[];
  /** 有効 n 件 */
  activeCount: number;
  /** 下書きを作る n 件 */
  dueCount: number;
  /** 「次回 2026/11/25 <名前>」 of the active ones (`/invoices`, 18 §14.5). */
  next: { id: string; name: string; date: CalendarDate } | null;
}

/** 定期請求の一覧 and the line of 請求の一覧 (18 §14.5). */
export async function listRecurringInvoices(
  db: Db,
  options: { today: CalendarDate },
): Promise<RecurringInvoiceList> {
  const { today } = options;
  const rows = await db.recurringInvoice.findMany({
    include: { partner: { select: { name: true, isActive: true } } },
    orderBy: [{ isActive: "desc" }, { name: "asc" }, { id: "asc" }],
  });
  const active = rows.filter((row) => row.isActive);
  const due = await dueWithoutInvoice(db, active, today);
  const rules = await loadTaxRules(db);
  let next: RecurringInvoiceList["next"] = null;
  const listed = rows.map((row): RecurringInvoiceListRow => {
    const nextDate = nextDateOf(row, today);
    if (row.isActive && nextDate !== null && (next === null || nextDate < next.date)) {
      next = { id: row.id, name: row.name, date: nextDate };
    }
    return {
      id: row.id,
      name: row.name,
      partnerId: row.partnerId,
      partnerName: row.partner.name,
      partnerIsActive: row.partner.isActive,
      frequency: row.frequency,
      scheduleLabel: describeRecurringInvoiceSchedule(recurringInvoiceScheduleOf(row)),
      total: totalsOn(row, nextDate ?? today, rules)?.total ?? null,
      nextDate,
      dueCount: due.filter((item) => item.row.id === row.id).length,
      isActive: row.isActive,
    };
  });
  return { rows: listed, activeCount: active.length, dueCount: due.length, next };
}

/** A line of the template with its amount (the amount is never stored). */
export interface RecurringInvoiceLineView {
  name: string;
  /** As text (`"1.5"`). */
  quantity: string;
  unit: string | null;
  unitPrice: Money;
  taxCategoryCode: string;
  /** 軽減税率 (※). */
  reduced: boolean;
  amount: Money;
}

/** An invoice made from the recurring invoice (作成した請求書, 18 §14.5). */
export interface RecurringInvoiceMadeRow extends InvoiceRef {
  month: RecurringMonth;
  /** 「2026年11月」 */
  monthLabel: string;
  issueDate: CalendarDate;
  total: Money;
}

export interface RecurringInvoiceDetail {
  id: string;
  name: string;
  isActive: boolean;
  partner: { id: string; name: string; address: string | null; isActive: boolean };
  /** As written, with `{対象月}`. */
  title: string | null;
  /** 件名 with the target month of the next due date (the form's 見本). */
  titlePreview: string | null;
  lines: RecurringInvoiceLineView[];
  pricesIncludeTax: boolean;
  note: string | null;
  revenueAccount: { id: string; code: string; name: string } | null;
  segment: { id: string; code: string; name: string } | null;
  frequency: RecurringInvoiceFrequency;
  issueDay: number;
  targetMonthOffset: number;
  dueMonths: number;
  dueDay: number;
  startDate: CalendarDate;
  endDate: CalendarDate | null;
  /** 「毎月 25 日」 */
  scheduleLabel: string;
  /** 「翌月末」 */
  dueRuleLabel: string;
  /** 「当月分」 */
  targetMonthLabel: string;
  /** On the tax rules of `totalsDate`; `null` when a category has no rule then. */
  totals: RecurringInvoiceTotals | null;
  /** The next due date, or today once the schedule has ended. */
  totalsDate: CalendarDate;
  /** 次回 3 回の予定日 */
  nextDates: CalendarDate[];
  /** Due dates without an invoice (empty while paused). */
  due: { date: CalendarDate; month: RecurringMonth }[];
  /** 作成した請求書, the newest month first. */
  invoices: RecurringInvoiceMadeRow[];
  createdAt: Date;
  updatedAt: Date;
}

/** One recurring invoice with everything its detail draws (18 §14.5); `null` when not found. */
export async function getRecurringInvoiceDetail(
  db: Db,
  id: string,
  options: { today: CalendarDate },
): Promise<RecurringInvoiceDetail | null> {
  const row = await db.recurringInvoice.findUnique({
    where: { id },
    include: {
      partner: { select: { id: true, name: true, address: true, isActive: true } },
      revenueAccount: { select: { id: true, code: true, name: true } },
      segment: { select: { id: true, code: true, name: true } },
      invoices: {
        select: {
          id: true,
          docType: true,
          number: true,
          status: true,
          issueDate: true,
          total: true,
          recurringMonth: true,
        },
      },
    },
  });
  if (!row) return null;
  const { today } = options;
  const schedule = recurringInvoiceScheduleOf(row);
  const nextDates = nextRecurringInvoiceDates(schedule, {
    after: today,
    count: RECURRING_INVOICE_NEXT_DATES,
  });
  const totalsDate = nextDates[0] ?? today;
  const totals = totalsOn(row, totalsDate, await loadTaxRules(db));
  const lines = readLines(row.lines).map((line, index): RecurringInvoiceLineView => {
    const quantity = quantityOf(line);
    const unitPrice = BigInt(line.unitPrice);
    return {
      name: line.name,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice,
      taxCategoryCode: line.taxCategoryCode,
      reduced: (REDUCED_TAX_CATEGORY_CODES as readonly string[]).includes(line.taxCategoryCode),
      amount: totals?.lineAmounts[index] ?? lineAmount(quantity, unitPrice),
    };
  });
  const madeMonths = new Set(row.invoices.map((invoice) => invoice.recurringMonth));
  const due = row.isActive
    ? dueDatesOf(row, today)
        .map((date) => ({ date, month: recurringMonth(date) }))
        .filter((item) => !madeMonths.has(item.month))
    : [];
  const invoices = row.invoices
    .flatMap((invoice): RecurringInvoiceMadeRow[] => {
      const month = invoice.recurringMonth;
      if (!isRecurringMonth(month)) return [];
      return [
        {
          id: invoice.id,
          docType: invoice.docType,
          number: invoice.number,
          status: invoice.status,
          month,
          monthLabel: invoiceMonthLabel(month),
          issueDate: fromDbDate(invoice.issueDate),
          total: invoice.total,
        },
      ];
    })
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    partner: row.partner,
    title: row.title,
    titlePreview:
      row.title === null ? null : expandTargetMonth(row.title, totalsDate, row.targetMonthOffset),
    lines,
    pricesIncludeTax: row.pricesIncludeTax,
    note: row.note,
    revenueAccount: row.revenueAccount,
    segment: row.segment,
    frequency: row.frequency,
    issueDay: row.issueDay,
    targetMonthOffset: row.targetMonthOffset,
    dueMonths: row.dueMonths,
    dueDay: row.dueDay,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    scheduleLabel: describeRecurringInvoiceSchedule(schedule),
    dueRuleLabel: describeRecurringInvoiceDueRule(row),
    targetMonthLabel: recurringInvoiceTargetOffsetLabel(row.targetMonthOffset),
    totals: totalsView(totals),
    totalsDate,
    nextDates,
    due,
    invoices,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The audit log of the recurring invoice (`entity = recurring_invoice`), oldest first. */
export async function loadRecurringInvoiceHistory(
  db: Db,
  id: string,
): Promise<InvoiceHistoryRow[]> {
  const rows = await db.auditLog.findMany({
    where: { entity: "recurring_invoice", entityId: id },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    entity: row.entity,
    at: row.at,
    actor: row.actor,
    action: row.action,
    before: row.before,
    after: row.after,
    reason: row.reason,
  }));
}

// ---------------------------------------------------------------------------
// Reads: the form (18 §14.5)
// ---------------------------------------------------------------------------

/** A line of the form, as text. */
export interface RecurringInvoiceLineFormValues {
  name: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxCategoryCode: string;
}

/** The values of the new / edit form (strings, as the form holds them). */
export interface RecurringInvoiceFormValues {
  name: string;
  partnerId: string;
  title: string;
  pricesIncludeTax: boolean;
  note: string;
  revenueAccountId: string;
  segmentId: string;
  lines: RecurringInvoiceLineFormValues[];
  frequency: RecurringInvoiceFrequency;
  issueDay: string;
  /** `"-1"` / `"0"` / `"1"` */
  targetMonthOffset: string;
  dueMonths: string;
  dueDay: string;
  startDate: string;
  endDate: string;
}

export interface RecurringInvoiceForm {
  /** The choices of the invoice form (partners, revenue accounts, segments, tax categories …). */
  options: InvoiceFormOptions;
  values: RecurringInvoiceFormValues;
  /** The invoice of `from` the template was taken from. */
  source: InvoiceRef | null;
  /** Why `from` cannot be a template; the values are then the defaults. */
  sourceProblem: string | null;
  /** The recurring invoice being edited. */
  recurringInvoice: { id: string; name: string; isActive: boolean } | null;
}

/** The day of a rule: 31 for the last day of the month (末日). */
function ruleDay(date: CalendarDate): number {
  return isLastDayOfMonth(date) ? 31 : dateParts(date).day;
}

function monthsBetween(from: CalendarDate, to: CalendarDate): number {
  const a = dateParts(from);
  const b = dateParts(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

function defaultValues(today: CalendarDate): RecurringInvoiceFormValues {
  return {
    name: "",
    partnerId: "",
    title: "",
    pricesIncludeTax: false,
    note: "",
    revenueAccountId: "",
    segmentId: "",
    lines: [{ name: "", quantity: "1", unit: "", unitPrice: "", taxCategoryCode: "sales_10" }],
    frequency: "monthly",
    issueDay: "31",
    targetMonthOffset: "0",
    dueMonths: "1",
    dueDay: "31",
    startDate: today,
    endDate: "",
  };
}

function valuesOfRow(row: RecurringInvoice): RecurringInvoiceFormValues {
  return {
    name: row.name,
    partnerId: row.partnerId,
    title: row.title ?? "",
    pricesIncludeTax: row.pricesIncludeTax,
    note: row.note ?? "",
    revenueAccountId: row.revenueAccountId ?? "",
    segmentId: row.segmentId ?? "",
    lines: readLines(row.lines).map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unit: line.unit ?? "",
      unitPrice: line.unitPrice,
      taxCategoryCode: line.taxCategoryCode,
    })),
    frequency: row.frequency,
    issueDay: String(row.issueDay),
    targetMonthOffset: String(row.targetMonthOffset),
    dueMonths: String(row.dueMonths),
    dueDay: String(row.dueDay),
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDateOrNull(row.endDate) ?? "",
  };
}

/**
 * The new / edit form of a recurring invoice (18 §14.5): the invoice form's choices and the initial
 * values: the recurring invoice's (`id`, edit), an invoice's body (`from`: its partner, title,
 * lines, prices, account, segment and note; its issue day and the due rule of its dates), or the
 * defaults (毎月 末日, 当月分, 翌月末, from today). `null` when `id` is not found.
 */
export async function loadRecurringInvoiceFormOptions(
  db: Db,
  options: { today: CalendarDate; id?: string | null; from?: string | null },
): Promise<RecurringInvoiceForm | null> {
  let values = defaultValues(options.today);
  let source: InvoiceRef | null = null;
  let sourceProblem: string | null = null;
  let recurringInvoice: RecurringInvoiceForm["recurringInvoice"] = null;

  if (options.id) {
    const row = await db.recurringInvoice.findUnique({ where: { id: options.id } });
    if (!row) return null;
    values = valuesOfRow(row);
    recurringInvoice = { id: row.id, name: row.name, isActive: row.isActive };
  } else if (options.from) {
    const invoice = await db.invoice.findUnique({
      where: { id: options.from },
      include: { partner: { select: { name: true } } },
    });
    if (!invoice) {
      sourceProblem = "雛形にする請求書が見つかりません。画面を読み込み直してください";
    } else if (invoice.docType !== "invoice") {
      sourceProblem = "定期請求の雛形にできるのは請求書だけです";
    } else {
      source = {
        id: invoice.id,
        docType: invoice.docType,
        number: invoice.number,
        status: invoice.status,
      };
      const issueDate = fromDbDate(invoice.issueDate);
      const dueDate = fromDbDateOrNull(invoice.dueDate);
      const dueMonths = dueDate ? monthsBetween(issueDate, dueDate) : -1;
      const keepsDueRule = dueDate !== null && dueMonths >= 0 && dueMonths <= 3;
      const lines = Array.isArray(invoice.lines)
        ? (invoice.lines as unknown as StoredRecurringInvoiceLine[])
        : [];
      values = {
        ...values,
        name: [invoice.title, invoice.partner.name]
          .filter((part): part is string => Boolean(part))
          .join(" ")
          .slice(0, 60),
        partnerId: invoice.partnerId,
        title: invoice.title ?? "",
        pricesIncludeTax: invoice.pricesIncludeTax,
        note: invoice.note ?? "",
        revenueAccountId: invoice.revenueAccountId ?? "",
        segmentId: invoice.segmentId ?? "",
        lines: lines.map((line) => ({
          name: line.name,
          quantity: line.quantity,
          unit: line.unit ?? "",
          unitPrice: line.unitPrice,
          taxCategoryCode: line.taxCategoryCode,
        })),
        issueDay: String(ruleDay(issueDate)),
        dueMonths: keepsDueRule ? String(dueMonths) : values.dueMonths,
        dueDay: keepsDueRule && dueDate ? String(ruleDay(dueDate)) : values.dueDay,
      };
    }
  }
  const includeIds = [values.partnerId, values.revenueAccountId, values.segmentId].filter(
    (value) => value !== "",
  );
  return {
    options: await loadInvoiceFormOptions(db, { includeIds }),
    values,
    source,
    sourceProblem,
    recurringInvoice,
  };
}

// ---------------------------------------------------------------------------
// Writes: the template (18 §14.1, §14.6)
// ---------------------------------------------------------------------------

/** What a recurring invoice's writes return. */
export interface RecurringInvoiceRecord {
  id: string;
  name: string;
  partnerId: string;
  isActive: boolean;
  startDate: CalendarDate;
  endDate: CalendarDate | null;
  updatedAt: Date;
}

function toRecord(row: RecurringInvoice): RecurringInvoiceRecord {
  return {
    id: row.id,
    name: row.name,
    partnerId: row.partnerId,
    isActive: row.isActive,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDateOrNull(row.endDate),
    updatedAt: row.updatedAt,
  };
}

/**
 * The columns of a template: the partner (active), the revenue account and the segment when chosen
 * (empty = the defaults when a draft is made), and the lines, whose tax categories must have a rule
 * on the first due date (or the start date).
 */
async function templateColumns(tx: Tx, data: ParsedRecurringInvoice) {
  await requireInvoicePartner(tx, data.partnerId);
  if (data.revenueAccountId) await resolveRevenueAccount(tx, data.revenueAccountId, null);
  if (data.segmentId) await resolveSegment(tx, data.segmentId, []);
  const schedule: RecurringInvoiceSchedule = {
    frequency: data.frequency,
    issueDay: data.issueDay,
    startDate: data.startDate,
    endDate: data.endDate,
  };
  const firstDate =
    nextRecurringInvoiceDates(schedule, { after: addDays(data.startDate, -1), count: 1 })[0] ??
    data.startDate;
  // Throws naming the line (`lines.<n>.taxCategoryCode`) for a category without a rule.
  computeInvoiceTotals(
    data.lines.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxCategoryCode: line.taxCategoryCode,
    })),
    {
      pricesIncludeTax: data.pricesIncludeTax,
      issueDate: firstDate,
      taxRules: await loadTaxRules(tx),
    },
  );
  const lines: StoredRecurringInvoiceLine[] = data.lines.map((line) => ({
    name: line.name,
    quantity: formatQuantity(line.quantity),
    unit: line.unit,
    unitPrice: line.unitPrice.toString(),
    taxCategoryCode: line.taxCategoryCode,
  }));
  return {
    name: data.name,
    partnerId: data.partnerId,
    title: data.title,
    lines: json(lines),
    pricesIncludeTax: data.pricesIncludeTax,
    revenueAccountId: data.revenueAccountId,
    segmentId: data.segmentId,
    note: data.note,
    frequency: data.frequency,
    issueDay: data.issueDay,
    targetMonthOffset: data.targetMonthOffset,
    dueMonths: data.dueMonths,
    dueDay: data.dueDay,
    startDate: toDbDate(data.startDate),
    endDate: data.endDate === null ? null : toDbDate(data.endDate),
  };
}

const TEMPLATE_KEYS = [
  "name",
  "partnerId",
  "title",
  "lines",
  "pricesIncludeTax",
  "revenueAccountId",
  "segmentId",
  "note",
  "frequency",
  "issueDay",
  "targetMonthOffset",
  "dueMonths",
  "dueDay",
  "startDate",
  "endDate",
] as const;

/** Locks the recurring invoice's row until the transaction ends, then reads it. */
async function lockRecurringInvoice(tx: Tx, id: string): Promise<RecurringInvoice> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "recurring_invoice" WHERE "id" = ${id} FOR UPDATE`;
  if (locked.length === 0) throw new SettingsError(NOT_FOUND);
  return tx.recurringInvoice.findUniqueOrThrow({ where: { id } });
}

/** 定期請求の追加 (18 §14.5): active from the start. */
export async function createRecurringInvoice(
  db: Db,
  input: RecurringInvoiceInput,
  options: ActorOptions,
): Promise<RecurringInvoiceRecord> {
  const data = recurringInvoiceSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const columns = await templateColumns(tx, data);
    const row = await tx.recurringInvoice.create({ data: { id: newId(), ...columns } });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "recurring_invoice.create",
      entity: "recurring_invoice",
      entityId: row.id,
      after: row,
    });
    return toRecord(row);
  });
}

/**
 * 定期請求の編集 (18 §14.5): the template and the rule are rewritten. The drafts and invoices made
 * before never change; a month already made stays 作成済み.
 */
export async function updateRecurringInvoice(
  db: Db,
  id: string,
  input: RecurringInvoiceInput,
  options: ActorOptions,
): Promise<RecurringInvoiceRecord> {
  const data = recurringInvoiceSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockRecurringInvoice(tx, id);
    const columns = await templateColumns(tx, data);
    const pick = (row: Record<string, unknown>) =>
      Object.fromEntries(TEMPLATE_KEYS.map((key) => [key, row[key]]));
    if (stableJson(pick(current)) === stableJson(pick(columns))) return toRecord(current);
    const row = await tx.recurringInvoice.update({ where: { id }, data: columns });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "recurring_invoice.update",
      entity: "recurring_invoice",
      entityId: id,
      before: current,
      after: row,
    });
    return toRecord(row);
  });
}

async function setActive(
  db: Db,
  id: string,
  isActive: boolean,
  options: ActorOptions,
): Promise<RecurringInvoiceRecord> {
  return runInTransaction(db, async (tx) => {
    const current = await lockRecurringInvoice(tx, id);
    if (current.isActive === isActive) {
      throw new SettingsError(
        isActive
          ? "この定期請求は有効です。画面を読み込み直してください"
          : "この定期請求はすでに停止しています。画面を読み込み直してください",
      );
    }
    const row = await tx.recurringInvoice.update({ where: { id }, data: { isActive } });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: isActive ? "recurring_invoice.resume" : "recurring_invoice.pause",
      entity: "recurring_invoice",
      entityId: id,
      before: { isActive: current.isActive },
      after: { isActive: row.isActive },
    });
    return toRecord(row);
  });
}

/** 停止 (18 §14.1): no due dates until it is resumed; never deleted. */
export async function pauseRecurringInvoice(
  db: Db,
  id: string,
  options: ActorOptions,
): Promise<RecurringInvoiceRecord> {
  return setActive(db, id, false, options);
}

/** 再開: the due dates in the window come back (the months already made stay 作成済み). */
export async function resumeRecurringInvoice(
  db: Db,
  id: string,
  options: ActorOptions,
): Promise<RecurringInvoiceRecord> {
  return setActive(db, id, true, options);
}

// ---------------------------------------------------------------------------
// Writes: the drafts (18 §14.3)
// ---------------------------------------------------------------------------

export interface RecurringInvoiceDraftResult {
  recurringInvoiceId: string;
  month: RecurringMonth;
  /** The recurring invoice's name (「<名前> の下書きを作りました」). */
  name: string;
  invoice: InvoiceRecord;
}

/** The template's fields: a rejection naming one says where to fix it. */
const TEMPLATE_FIELDS = new Set(["partnerId", "revenueAccountId", "segmentId"]);
const FIX_HINT = "（定期請求の編集で直してください）";

function withTemplateHint(message: string, field: string | undefined): string {
  return field && TEMPLATE_FIELDS.has(field) && !message.includes(FIX_HINT)
    ? `${message}${FIX_HINT}`
    : message;
}

/** The row's due date in `month` (18 §14.2): in force and within the window; else `null`. */
function dueDateInMonth(
  row: RecurringInvoice,
  month: RecurringMonth,
  today: CalendarDate,
): CalendarDate | null {
  const schedule = recurringInvoiceScheduleOf(row);
  const date = recurringInvoiceDateInMonth(schedule, month);
  if (date === null) return null;
  const inWindow = date > addDays(today, -RECURRING_DUE_DAYS) && date <= today;
  const inForce =
    date >= schedule.startDate && (schedule.endDate === null || date <= schedule.endDate);
  return inWindow && inForce ? date : null;
}

/**
 * Why a draft would pass the limits of an invoice (`INVOICE_TEXT_MAX`) once `{対象月}` is written
 * in (18 §14.3), or `null`: the edit form could not save such an invoice.
 */
function expandedTooLong(
  title: string | null,
  lines: readonly { name: string }[],
  note: string | null,
): string | null {
  const over = (label: string, text: string | null, max: number) =>
    text !== null && text.length > max
      ? `{対象月} を入れると${label}が ${max} 文字を超えます。定期請求の${label}を短くしてください`
      : null;
  return (
    over("件名", title, INVOICE_TEXT_MAX.title) ??
    lines
      .map((line) => over("品名", line.name, INVOICE_TEXT_MAX.lineName))
      .find((problem) => problem !== null) ??
    over("備考", note, INVOICE_TEXT_MAX.note)
  );
}

/**
 * 下書きの作成 (18 §14.3) in one transaction: the recurring invoice's row is locked (`FOR UPDATE`, so
 * two requests for the same month queue), it must be active and the month a due date (§14.2) with
 * no invoice yet (the partial unique index is the last guard); then an invoice draft is saved as
 * `createInvoiceDraft` saves one (same checks, `invoice.create` with the recurring invoice and the
 * month): issued on the due date, due by the rule, the template's body with `{対象月}` written in.
 */
export async function createRecurringInvoiceDraft(
  db: Db,
  input: RecurringInvoiceDraftInput,
  options: ActorOptions & { today?: CalendarDate },
): Promise<RecurringInvoiceDraftResult> {
  const data = recurringInvoiceDraftSchema.parse(input);
  const today = options.today ?? todayInJapan();
  return runInTransaction(db, async (tx) => {
    const row = await lockRecurringInvoice(tx, data.recurringInvoiceId);
    if (!row.isActive) throw new SettingsError(PAUSED, { field: "month" });
    const date = dueDateInMonth(row, data.month, today);
    if (date === null) throw new SettingsError(NOT_DUE, { field: "month" });
    const made = (await madeInvoicesOf(tx, [row.id])).get(row.id)?.get(data.month);
    if (made) {
      throw new SettingsError(`この月の請求書はすでに作成済みです（${madeLabel(made)}）`, {
        field: "month",
      });
    }

    const offset = row.targetMonthOffset;
    const expand = (text: string) => expandTargetMonth(text, date, offset);
    const lines = readLines(row.lines).map((line) => ({
      date: null,
      name: expand(line.name),
      quantity: quantityOf(line),
      unit: line.unit,
      unitPrice: BigInt(line.unitPrice),
      taxCategoryCode: line.taxCategoryCode as SalesTaxCategoryCode,
    }));
    const title = row.title === null ? null : expand(row.title);
    const note = row.note === null ? null : expand(row.note);
    const tooLong = expandedTooLong(title, lines, note);
    if (tooLong) throw new SettingsError(tooLong, { field: "month" });
    try {
      const invoice = await insertInvoiceDraft(
        tx,
        {
          docType: "invoice",
          partnerId: row.partnerId,
          title,
          issueDate: date,
          dueDate: recurringInvoiceDueDate(date, row),
          pricesIncludeTax: row.pricesIncludeTax,
          note,
          revenueAccountId: row.revenueAccountId,
          segmentId: row.segmentId,
          sourceInvoiceId: null,
          lines,
        },
        options,
        { recurringInvoiceId: row.id, recurringMonth: data.month },
      );
      return { recurringInvoiceId: row.id, month: data.month, name: row.name, invoice };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SettingsError(
          "この月の請求書はすでに作成済みです。画面を読み込み直してください",
          {
            field: "month",
          },
        );
      }
      if (error instanceof SettingsError) {
        throw new SettingsError(withTemplateHint(error.message, error.field), {
          field: error.field,
        });
      }
      throw error;
    }
  });
}

/** One item of `createRecurringInvoiceDrafts`: the draft, or why it was not made. */
export type RecurringInvoiceDraftsItem =
  | ({ ok: true } & RecurringInvoiceDraftResult)
  | { ok: false; recurringInvoiceId: string; month: RecurringMonth; message: string };

export interface RecurringInvoiceDraftsResult {
  items: RecurringInvoiceDraftsItem[];
  created: number;
  failed: number;
}

function rejectionMessage(error: unknown): string | null {
  if (error instanceof SettingsError) return error.message;
  if (error instanceof LedgerValidationError) {
    return error.errors.map((item) => item.message).join(" / ");
  }
  if (error instanceof ZodError) return error.issues.map((issue) => issue.message).join(" / ");
  return null;
}

/**
 * まとめて下書きを作る (18 §14.3): each item in a transaction of its own; a rejected item (paused,
 * not due, already made, an inactive partner …) is reported and does not stop the others.
 */
export async function createRecurringInvoiceDrafts(
  db: Db,
  input: RecurringInvoiceDraftsInput,
  options: ActorOptions & { today?: CalendarDate },
): Promise<RecurringInvoiceDraftsResult> {
  const data = recurringInvoiceDraftsSchema.parse(input);
  const today = options.today ?? todayInJapan();
  const items: RecurringInvoiceDraftsItem[] = [];
  for (const item of data.items) {
    try {
      const made = await createRecurringInvoiceDraft(db, item, { ...options, today });
      items.push({ ok: true, ...made });
    } catch (error) {
      const message = rejectionMessage(error);
      if (message === null) throw error;
      items.push({ ok: false, ...item, message });
    }
  }
  const created = items.filter((item) => item.ok).length;
  return { items, created, failed: items.length - created };
}
