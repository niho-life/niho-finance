/**
 * 定期取引 (21-cashflow §2, §8) and the inputs of the cash-flow forecast. A recurring item is the
 * entry 「口座の科目 ⇄ 科目」 that happens every month or year; it only feeds the forecast
 * (`@niho-finance/reports` `buildCashflowForecast`) and never posts an entry. Every write is
 * validated with the schemas in `schemas.ts`, runs in one transaction and appends to the audit log.
 * Nothing is deleted: items are deactivated instead.
 */
import { addDays, dateParts, type CalendarDate, type Money } from "@niho-finance/ledger";
import {
  recurringCashEffect,
  type CashflowDeadline,
  type CashflowInputs,
  type CashflowInvoice,
  type CashflowRecurringItem,
} from "@niho-finance/reports";
import type { Prisma, RecurrenceFrequency, RecurringItem, Wallet } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, toDbDate } from "./dates";
import { SettingsError } from "./errors";
import { newId } from "./ids";
import { INVOICE_LIST_LIMIT, listInvoices } from "./invoices";
import { listPayrollSchedule } from "./payroll";
import {
  recurringItemCreateSchema,
  recurringItemUpdateSchema,
  type RecurringDirection,
  type RecurringItemCreateInput,
  type RecurringItemUpdateInput,
} from "./schemas";
import type { WriteOptions } from "./settings";
import { runInTransaction, type Tx } from "./transaction";

export interface RecurringItemSettings {
  id: string;
  name: string;
  /** Signed from the wallet's point of view: deposits are positive. */
  amount: Money;
  frequency: RecurrenceFrequency;
  /** 1–31 (31 = 末日). */
  dayOfMonth: number | null;
  /** 1–12 for yearly items, `null` for monthly ones. */
  monthOfYear: number | null;
  startDate: CalendarDate;
  endDate: CalendarDate | null;
  walletId: string | null;
  walletName: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  partnerId: string | null;
  segmentId: string | null;
  taxCategoryCode: string | null;
  note: string | null;
  isActive: boolean;
  /** The change of 現預金 of one occurrence (21 §3.2): 0 for a card payment, `null` without a wallet. */
  cashEffect: Money | null;
}

const recurringInclude = {
  account: { select: { code: true, name: true, isCashLike: true } },
  wallet: { select: { name: true, accountId: true, account: { select: { isCashLike: true } } } },
} satisfies Prisma.RecurringItemInclude;

type RecurringRow = Prisma.RecurringItemGetPayload<{ include: typeof recurringInclude }>;

function toRecurringItemSettings(row: RecurringRow): RecurringItemSettings {
  const wallet = row.wallet;
  const cashEffect = recurringCashEffect(row, {
    accounts: [
      { id: row.accountId, isCashLike: row.account.isCashLike },
      ...(wallet ? [{ id: wallet.accountId, isCashLike: wallet.account.isCashLike }] : []),
    ],
    wallets: wallet && row.walletId ? [{ id: row.walletId, accountId: wallet.accountId }] : [],
  });
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    frequency: row.frequency,
    dayOfMonth: row.dayOfMonth,
    monthOfYear: row.monthOfYear,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDateOrNull(row.endDate),
    walletId: row.walletId,
    walletName: wallet?.name ?? null,
    accountId: row.accountId,
    accountCode: row.account.code,
    accountName: row.account.name,
    partnerId: row.partnerId,
    segmentId: row.segmentId,
    taxCategoryCode: row.taxCategoryCode,
    note: row.note,
    isActive: row.isActive,
    cashEffect,
  };
}

async function loadRecurringItem(db: Db, id: string): Promise<RecurringItemSettings> {
  const row = await db.recurringItem.findUniqueOrThrow({
    where: { id },
    include: recurringInclude,
  });
  return toRecurringItemSettings(row);
}

/** Active ones first, then 毎月 → 毎年, the month, the day and the name (21 §8). */
export async function listRecurringItems(db: Db): Promise<RecurringItemSettings[]> {
  const rows = await db.recurringItem.findMany({
    include: recurringInclude,
    orderBy: [
      { isActive: "desc" },
      { frequency: "asc" },
      { monthOfYear: { sort: "asc", nulls: "first" } },
      { dayOfMonth: { sort: "asc", nulls: "last" } },
      { name: "asc" },
      { id: "asc" },
    ],
  });
  return rows.map(toRecurringItemSettings);
}

/** 設定の索引の「有効 n 件」. */
export async function countActiveRecurringItems(db: Db): Promise<number> {
  return db.recurringItem.count({ where: { isActive: true } });
}

// ---------------------------------------------------------------------------
// Checks (21 §2)
// ---------------------------------------------------------------------------

async function requireActiveWallet(tx: Tx, walletId: string): Promise<Wallet> {
  const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) {
    throw new SettingsError("口座が見つかりません。一覧から選んでください", { field: "walletId" });
  }
  if (!wallet.isActive) {
    throw new SettingsError(`口座「${wallet.name}」は無効です。有効な口座を選んでください`, {
      field: "walletId",
    });
  }
  return wallet;
}

async function requireActiveAccount(tx: Tx, accountId: string): Promise<void> {
  const account = await tx.account.findUnique({ where: { id: accountId } });
  if (!account) {
    throw new SettingsError("科目が見つかりません。一覧から選んでください", { field: "accountId" });
  }
  if (!account.isActive) {
    throw new SettingsError(`勘定科目「${account.name}」は無効です。有効な科目を選んでください`, {
      field: "accountId",
    });
  }
}

/** Debit and credit on the same account would make the entry nothing. */
function assertOtherAccount(wallet: Wallet, accountId: string, field: string): void {
  if (wallet.accountId === accountId) {
    throw new SettingsError("口座の科目と同じ科目は選べません", { field });
  }
}

/** 毎年 needs its month; 毎月 keeps none. */
function monthFor(frequency: RecurrenceFrequency, monthOfYear: number | null): number | null {
  if (frequency === "monthly") return null;
  if (monthOfYear === null) {
    throw new SettingsError("毎年の定期取引は月を選んでください", { field: "monthOfYear" });
  }
  return monthOfYear;
}

function assertPeriod(startDate: CalendarDate, endDate: CalendarDate | null, field: string): void {
  if (endDate !== null && endDate < startDate) {
    throw new SettingsError("終了日は開始日より後にしてください", { field });
  }
}

async function assertOptionalReferences(
  tx: Tx,
  data: {
    partnerId?: string | null | undefined;
    segmentId?: string | null | undefined;
    taxCategoryCode?: string | null | undefined;
  },
): Promise<void> {
  if (data.partnerId) {
    const partner = await tx.partner.findUnique({ where: { id: data.partnerId } });
    if (!partner) {
      throw new SettingsError("取引先が見つかりません。一覧から選んでください", {
        field: "partnerId",
      });
    }
  }
  if (data.segmentId) {
    const segment = await tx.segment.findUnique({ where: { id: data.segmentId } });
    if (!segment) {
      throw new SettingsError("セグメントが見つかりません。一覧から選んでください", {
        field: "segmentId",
      });
    }
  }
  if (data.taxCategoryCode) {
    const category = await tx.taxCategory.findUnique({ where: { code: data.taxCategoryCode } });
    if (!category) {
      throw new SettingsError("税区分が見つかりません。税区分の一覧から選んでください", {
        field: "taxCategoryCode",
      });
    }
  }
}

function signedAmount(direction: RecurringDirection, amount: Money): Money {
  return direction === "deposit" ? amount : -amount;
}

function hasChanges(row: RecurringItem, patch: Prisma.RecurringItemUncheckedUpdateInput): boolean {
  const current = row as unknown as Record<string, unknown>;
  return Object.entries(patch).some(([key, value]) => {
    const before = current[key];
    if (before instanceof Date && value instanceof Date) {
      return before.getTime() !== value.getTime();
    }
    return before !== value;
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createRecurringItem(
  db: Db,
  input: RecurringItemCreateInput,
  options: WriteOptions,
): Promise<RecurringItemSettings> {
  const data = recurringItemCreateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const wallet = await requireActiveWallet(tx, data.walletId);
    await requireActiveAccount(tx, data.accountId);
    assertOtherAccount(wallet, data.accountId, "accountId");
    const monthOfYear = monthFor(data.frequency, data.monthOfYear);
    assertPeriod(data.startDate, data.endDate, "endDate");
    await assertOptionalReferences(tx, data);
    const row = await tx.recurringItem.create({
      data: {
        id: newId(),
        name: data.name,
        accountId: data.accountId,
        amount: signedAmount(data.direction, data.amount),
        frequency: data.frequency,
        dayOfMonth: data.dayOfMonth,
        monthOfYear,
        startDate: toDbDate(data.startDate),
        endDate: data.endDate === null ? null : toDbDate(data.endDate),
        walletId: wallet.id,
        taxCategoryCode: data.taxCategoryCode,
        segmentId: data.segmentId ?? wallet.defaultSegmentId,
        partnerId: data.partnerId,
        note: data.note,
      },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "recurring_item.create",
      entity: "recurring_item",
      entityId: row.id,
      after: row,
    });
    return loadRecurringItem(tx, row.id);
  });
}

/**
 * Changes the given fields (a missing key leaves the column as is). 無効にする / 有効にする is
 * `{ isActive }`. 入出金 or 金額 alone keeps the other half of the signed amount; 毎月 drops the month.
 * The wallet and the account are checked when they change or the item is activated again.
 */
export async function updateRecurringItem(
  db: Db,
  id: string,
  patch: RecurringItemUpdateInput,
  options: WriteOptions,
): Promise<RecurringItemSettings> {
  const data = recurringItemUpdateSchema.parse(patch);
  return runInTransaction(db, async (tx) => {
    const current = id ? await tx.recurringItem.findUnique({ where: { id } }) : null;
    if (!current) {
      throw new SettingsError("定期取引が見つかりません。画面を読み込み直してください");
    }
    const walletId = data.walletId ?? current.walletId;
    const accountId = data.accountId ?? current.accountId;
    const activating = data.isActive === true && !current.isActive;
    if (data.walletId !== undefined || data.accountId !== undefined || activating) {
      const wallet = walletId ? await requireActiveWallet(tx, walletId) : null;
      await requireActiveAccount(tx, accountId);
      if (wallet) {
        assertOtherAccount(
          wallet,
          accountId,
          data.accountId !== undefined ? "accountId" : "walletId",
        );
      }
    }
    const frequency = data.frequency ?? current.frequency;
    const monthOfYear = monthFor(
      frequency,
      data.monthOfYear !== undefined ? data.monthOfYear : current.monthOfYear,
    );
    const startDate = data.startDate ?? fromDbDate(current.startDate);
    const endDate = data.endDate !== undefined ? data.endDate : fromDbDateOrNull(current.endDate);
    assertPeriod(
      startDate,
      endDate,
      data.startDate !== undefined && data.endDate === undefined ? "startDate" : "endDate",
    );
    await assertOptionalReferences(tx, data);

    const update: Prisma.RecurringItemUncheckedUpdateInput = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.amount !== undefined || data.direction !== undefined) {
      const direction: RecurringDirection =
        data.direction ?? (current.amount < 0n ? "withdrawal" : "deposit");
      const magnitude = data.amount ?? (current.amount < 0n ? -current.amount : current.amount);
      update.amount = signedAmount(direction, magnitude);
    }
    if (data.frequency !== undefined || data.monthOfYear !== undefined) {
      update.frequency = frequency;
      update.monthOfYear = monthOfYear;
    }
    if (data.dayOfMonth !== undefined) update.dayOfMonth = data.dayOfMonth;
    if (data.startDate !== undefined) update.startDate = toDbDate(data.startDate);
    if (data.endDate !== undefined) {
      update.endDate = data.endDate === null ? null : toDbDate(data.endDate);
    }
    if (data.walletId !== undefined) update.walletId = data.walletId;
    if (data.accountId !== undefined) update.accountId = data.accountId;
    if (data.partnerId !== undefined) update.partnerId = data.partnerId;
    if (data.segmentId !== undefined) update.segmentId = data.segmentId;
    if (data.taxCategoryCode !== undefined) update.taxCategoryCode = data.taxCategoryCode;
    if (data.note !== undefined) update.note = data.note;
    if (data.isActive !== undefined) update.isActive = data.isActive;

    if (!hasChanges(current, update)) return loadRecurringItem(tx, current.id);
    const row = await tx.recurringItem.update({ where: { id: current.id }, data: update });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "recurring_item.update",
      entity: "recurring_item",
      entityId: row.id,
      before: current,
      after: row,
    });
    return loadRecurringItem(tx, row.id);
  });
}

// ---------------------------------------------------------------------------
// The inputs of the forecast (21 §3)
// ---------------------------------------------------------------------------

/** Rules of S8 whose deadline is a filing and a payment at once (their keys never change). */
export const CASHFLOW_PAYMENT_RULE_KEYS = ["annual.tax-return", "annual.interim-return"] as const;

function toForecastItem(row: RecurringItem): CashflowRecurringItem {
  const startDate = fromDbDate(row.startDate);
  const start = dateParts(startDate);
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    frequency: row.frequency,
    // The screens always set the day (and the month of a yearly item); a row without them
    // happens on the day (month) of its start.
    dayOfMonth: row.dayOfMonth ?? start.day,
    monthOfYear: row.frequency === "yearly" ? (row.monthOfYear ?? start.month) : null,
    startDate,
    endDate: fromDbDateOrNull(row.endDate),
    walletId: row.walletId,
    accountId: row.accountId,
    isActive: row.isActive,
  };
}

/**
 * What the forecast reads besides the book (21 §3.1): every recurring item (the forecast counts
 * the active ones), the open payment deadlines of `start < due ≤ start + days` (`null` while the
 * calendar has no row at all) with the amounts the pay runs give (22-payroll §7.2), and what
 * issued invoices still wait for (18-invoicing). 法人税等 (#14) has no amount yet, and received
 * invoices are not connected yet (`null`).
 */
export async function loadCashflowInputs(
  db: Db,
  options: { start: CalendarDate; days: number },
): Promise<CashflowInputs> {
  const rows = await db.recurringItem.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const recurring = rows.map(toForecastItem);

  let deadlines: CashflowDeadline[] | null = null;
  if ((await db.calendarItem.count()) > 0) {
    const items = await db.calendarItem.findMany({
      where: {
        completedAt: null,
        dueDate: {
          gt: toDbDate(options.start),
          lte: toDbDate(addDays(options.start, options.days)),
        },
        OR: [{ kind: "payment" }, { ruleKey: { in: [...CASHFLOW_PAYMENT_RULE_KEYS] } }],
      },
      orderBy: [{ dueDate: "asc" }, { title: "asc" }, { id: "asc" }],
      select: {
        id: true,
        kind: true,
        title: true,
        dueDate: true,
        ruleKey: true,
        completedAt: true,
      },
    });
    // 源泉所得税・住民税・社会保険料 of the confirmed pay runs carry their derived amount
    // (22-payroll §7.2); a payroll deadline with nothing left to pay is not a payment at all.
    const payroll = new Map((await listPayrollSchedule(db)).map((row) => [row.id, row.amount]));
    deadlines = [];
    for (const item of items) {
      const amount = payroll.get(item.id);
      if (amount !== undefined && amount <= 0n) continue;
      deadlines.push({ date: fromDbDate(item.dueDate), title: item.title, amount: amount ?? null });
    }
  }

  // 未入金の請求: issued and sent invoices (not drafts, paid or void ones) with a balance left.
  const invoices = await listInvoices(db, { type: "invoice", status: "issued" }, 1, {
    today: options.start,
    pageSize: INVOICE_LIST_LIMIT,
  });
  const receivables: CashflowInvoice[] = [];
  for (const row of invoices.rows) {
    if (row.balance === null || row.balance <= 0n) continue;
    receivables.push({
      date: row.dueDate,
      amount: row.balance,
      label: `${row.number} ${row.partnerName}`,
    });
  }

  return { recurring, deadlines, receivables, payables: null };
}
