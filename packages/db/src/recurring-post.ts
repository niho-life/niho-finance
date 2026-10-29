/**
 * 定期取引からの登録 (21-cashflow §10): the occurrences due for registration (やること and
 * `/settings/recurring/due`), the 1-click registration of one, the entries registered from an item,
 * the input of the statements' 定期取引 stage and the template of the transaction form.
 *
 * Nothing is stored about a registration besides the entry itself (derive, don't sync, 00 §5): a
 * month is 登録済み when (a) an entry posted from the item for that month (`sourceKind = recurring`,
 * `sourceId = <item>:<YYYY-MM>`) or (b) an entry of the month with the wallet's line and the item's
 * account line of the same amount is posted and not voided (§10.2). Every entry goes through
 * `postJournalEntryInTransaction`; nothing is ever posted automatically.
 */
import {
  addDays,
  allowedSimpleEntryAccount,
  buildSimpleEntry,
  dateParts,
  displayDate,
  LedgerValidationError,
  parseRecurringSourceId,
  recurringDateInMonth,
  recurringEntryDescription,
  recurringMonth,
  recurringMonthLabel,
  recurringMonthRange,
  recurringOccurrences,
  recurringSourceId,
  recurringSourcePrefix,
  walletAccountIdsOf,
  type CalendarDate,
  type JournalEntryInput,
  type Money,
  type RecurringEntryType,
  type RecurringMonth,
  type RecurringSchedule,
  type SimpleEntryInput,
  type SuggestRecurringItem,
} from "@niho-finance/ledger";
import type { Prisma, RecurringItem } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, todayInJapan, toDbDate } from "./dates";
import {
  loadSimpleEntryContext,
  lockFiscalYearOn,
  simpleEntryValidationError,
  type EntryRef,
} from "./entries";
import { SettingsError } from "./errors";
import { postJournalEntryInTransaction, type ActorOptions } from "./journal";
import type { HomeTodoSource } from "./reports-query";
import { recurringPostSchema, type RecurringPostInput } from "./schemas";
import { runInTransaction } from "./transaction";

/** Occurrences of `today − 92 < date ≤ today` are due (§10.2); older ones go through 取引. */
export const RECURRING_DUE_DAYS = 92;

/** At most this many entries in the sheet's 「登録した取引」 (§10.8). */
export const RECURRING_ENTRY_HISTORY_LIMIT = 6;

// ---------------------------------------------------------------------------
// Items and their entry (§10.1)
// ---------------------------------------------------------------------------

/**
 * When a row happens (21 §2.1). The screens always set the day (and the month of a yearly item); a
 * row without them happens on the day (month) of its start.
 */
export function recurringScheduleOf(
  row: Pick<RecurringItem, "frequency" | "dayOfMonth" | "monthOfYear" | "startDate" | "endDate">,
): RecurringSchedule {
  const startDate = fromDbDate(row.startDate);
  const start = dateParts(startDate);
  return {
    frequency: row.frequency,
    dayOfMonth: row.dayOfMonth ?? start.day,
    monthOfYear: row.frequency === "yearly" ? (row.monthOfYear ?? start.month) : null,
    startDate,
    endDate: fromDbDateOrNull(row.endDate),
  };
}

const itemInclude = {
  account: {
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      isCashLike: true,
      isActive: true,
      defaultTaxCategoryCode: true,
      defaultSegmentId: true,
    },
  },
  wallet: {
    select: {
      id: true,
      name: true,
      accountId: true,
      subAccountId: true,
      importer: true,
      isActive: true,
      defaultSegmentId: true,
    },
  },
  transferWallet: {
    select: { id: true, name: true, accountId: true, subAccountId: true, isActive: true },
  },
} satisfies Prisma.RecurringItemInclude;

type ItemRow = Prisma.RecurringItemGetPayload<{ include: typeof itemInclude }>;

interface WalletRef {
  id: string;
  name: string;
  accountId: string;
  subAccountId: string | null;
  isActive: boolean;
}

async function loadWalletRefs(db: Db): Promise<WalletRef[]> {
  return db.wallet.findMany({
    orderBy: { id: "asc" },
    select: { id: true, name: true, accountId: true, subAccountId: true, isActive: true },
  });
}

/** The entry an occurrence registers, or why it cannot (the owner fixes it in 設定 › 定期取引). */
type EntryPlan =
  | { ok: true; type: "transfer"; wallet: NonNullable<ItemRow["wallet"]>; other: WalletRef }
  | {
      ok: true;
      type: "income" | "expense";
      wallet: NonNullable<ItemRow["wallet"]>;
      accountId: string;
      taxCategoryCode: string | null;
      segmentId: string | null;
      partnerId: string | null;
    }
  | { ok: false; message: string; field: string };

const NO_WALLET = "口座を選んでください（設定 › 定期取引）";
const AMBIGUOUS_TRANSFER = "相手の口座を選んでください（設定 › 定期取引）";
const NO_TAX_CATEGORY = "税区分を選んでください（設定 › 定期取引）";

/**
 * The other wallet of a 振替: the item's `transferWalletId`, or for a row of #19 whose 科目 is a
 * wallet's account (未払金 of a card's 引落し) the only active wallet on that account. Several
 * such wallets leave the choice to the owner (`"ambiguous"`).
 */
function transferWalletOf(
  item: ItemRow,
  wallets: readonly WalletRef[],
): WalletRef | "ambiguous" | null {
  if (item.transferWalletId) return item.transferWallet;
  const linked = wallets.filter(
    (wallet) =>
      wallet.isActive && wallet.accountId === item.accountId && wallet.id !== item.walletId,
  );
  const [only] = linked;
  if (linked.length > 1) return "ambiguous";
  return only ?? null;
}

/**
 * 振替 / 支出 / 収入 of an item (§10.1). 税区分 is the item's, else the account's default; セグメント
 * the item's, else the account's, else the wallet's (11 §4).
 */
function planOf(item: ItemRow, wallets: readonly WalletRef[]): EntryPlan {
  const wallet = item.wallet;
  if (!wallet) return { ok: false, message: NO_WALLET, field: "walletId" };
  const other = transferWalletOf(item, wallets);
  if (other === "ambiguous") return { ok: false, message: AMBIGUOUS_TRANSFER, field: "accountId" };
  if (other) return { ok: true, type: "transfer", wallet, other };
  return {
    ok: true,
    type: item.amount < 0n ? "expense" : "income",
    wallet,
    accountId: item.accountId,
    taxCategoryCode: item.taxCategoryCode ?? item.account.defaultTaxCategoryCode,
    segmentId: item.segmentId ?? item.account.defaultSegmentId ?? wallet.defaultSegmentId,
    partnerId: item.partnerId,
  };
}

/** The type and the wallets as `buildSimpleEntry` takes them. */
function entryInputOf(
  item: ItemRow,
  plan: Extract<EntryPlan, { ok: true }>,
  occurrence: { date: CalendarDate; month: RecurringMonth; amount: Money },
): SimpleEntryInput {
  const description = recurringEntryDescription(item.name, occurrence.month);
  if (plan.type === "transfer") {
    // 出金: 口座 → 相手の口座. 入金: 相手の口座 → 口座. No fee.
    const out = item.amount < 0n;
    return {
      type: "transfer",
      entryDate: occurrence.date,
      description,
      fromWalletId: out ? plan.wallet.id : plan.other.id,
      toWalletId: out ? plan.other.id : plan.wallet.id,
      amount: occurrence.amount,
      fee: null,
    };
  }
  if (!plan.taxCategoryCode) {
    throw new SettingsError(NO_TAX_CATEGORY, { field: "taxCategoryCode" });
  }
  return {
    type: plan.type,
    entryDate: occurrence.date,
    description,
    counterpart: { kind: "wallet", walletId: plan.wallet.id },
    accountId: plan.accountId,
    amount: occurrence.amount,
    taxCategoryCode: plan.taxCategoryCode,
    segmentId: plan.segmentId,
    partnerId: plan.partnerId,
  };
}

/** 科目 or 相手の口座 of a row: what the entry is booked against. */
function counterpartLabel(item: ItemRow, plan: EntryPlan): string {
  if (plan.ok && plan.type === "transfer") return plan.other.name;
  if (!plan.ok && plan.field === "accountId") return "相手の口座";
  return item.account.name;
}

function magnitude(amount: Money): Money {
  return amount < 0n ? -amount : amount;
}

const entryNoLabel = (no: number) => `No. ${no}`;

// ---------------------------------------------------------------------------
// 登録済み (§10.2): derived from the posted entries
// ---------------------------------------------------------------------------

/** What makes an entry of the month count as the item's (§10.2 (b)). */
interface BookingTarget {
  itemId: string;
  /** The wallet's account, and its sub-account when the wallet has one. */
  wallet: { accountId: string; subAccountId: string | null };
  /** The item's account; a 振替's other wallet (its sub-account when it has one). */
  other: { accountId: string; subAccountId: string | null };
  /** |金額| of the wallet's line. */
  amount: Money;
}

function bookingTarget(item: ItemRow, plan: EntryPlan): BookingTarget | null {
  if (!item.wallet) return null;
  const other =
    plan.ok && plan.type === "transfer"
      ? { accountId: plan.other.accountId, subAccountId: plan.other.subAccountId }
      : { accountId: item.accountId, subAccountId: null };
  return {
    itemId: item.id,
    wallet: { accountId: item.wallet.accountId, subAccountId: item.wallet.subAccountId },
    other,
    amount: magnitude(item.amount),
  };
}

type BookedMonths = Map<string, Map<RecurringMonth, EntryRef>>;

function markBooked(booked: BookedMonths, itemId: string, month: RecurringMonth, entry: EntryRef) {
  let months = booked.get(itemId);
  if (!months) {
    months = new Map();
    booked.set(itemId, months);
  }
  const known = months.get(month);
  if (!known || entry.no < known.no) months.set(month, entry);
}

function onAccount(
  line: { accountId: string; subAccountId: string | null },
  target: { accountId: string; subAccountId: string | null },
): boolean {
  return (
    line.accountId === target.accountId &&
    (target.subAccountId === null || line.subAccountId === target.subAccountId)
  );
}

/**
 * The entry that stands for a voided one: its correction (`replacedById`, 11 §1), followed to the
 * end of the chain; `null` when the chain ends in a cancelled entry (取消).
 */
async function liveReplacement(db: Db, replacedById: string): Promise<EntryRef | null> {
  let nextId: string | null = replacedById;
  for (let depth = 0; nextId && depth < 50; depth += 1) {
    const next: {
      id: string;
      no: number;
      entryDate: Date;
      status: string;
      replacedById: string | null;
    } | null = await db.journalEntry.findUnique({
      where: { id: nextId },
      select: { id: true, no: true, entryDate: true, status: true, replacedById: true },
    });
    if (!next) return null;
    if (next.status === "posted") return toRef(next);
    nextId = next.replacedById;
  }
  return null;
}

/**
 * The months of `from … through` (whole months) already registered for each target (§10.2): (a) an
 * entry posted from the item for the month (a corrected one counts through its correction: 訂正 is
 * not 取消), (b) an entry of the month holding the wallet's line of |金額| and the item's account
 * line. Cancelled entries and reversals do not count.
 */
async function bookedMonthsOf(
  db: Db,
  targets: readonly BookingTarget[],
  range: { from: CalendarDate; through: CalendarDate },
): Promise<BookedMonths> {
  const booked: BookedMonths = new Map();
  if (targets.length === 0 || range.through < range.from) return booked;
  const from = recurringMonthRange(recurringMonth(range.from)).from;
  const through = recurringMonthRange(recurringMonth(range.through)).through;
  const live = {
    status: "posted",
    kind: { not: "reversal" },
    entryDate: { gte: toDbDate(from), lte: toDbDate(through) },
  } satisfies Prisma.JournalEntryWhereInput;
  const ids = new Set(targets.map((target) => target.itemId));

  // (a) entries posted from an item for the month (or corrected into a posted one).
  const sourced = await db.journalEntry.findMany({
    where: {
      kind: { not: "reversal" },
      entryDate: live.entryDate,
      sourceKind: "recurring",
      OR: [{ status: "posted" }, { replacedById: { not: null } }],
    },
    select: {
      id: true,
      no: true,
      entryDate: true,
      sourceId: true,
      status: true,
      replacedById: true,
    },
  });
  for (const entry of sourced) {
    const parsed = parseRecurringSourceId(entry.sourceId);
    if (!parsed || !ids.has(parsed.itemId)) continue;
    const ref =
      entry.status === "posted"
        ? toRef(entry)
        : entry.replacedById
          ? await liveReplacement(db, entry.replacedById)
          : null;
    if (ref) markBooked(booked, parsed.itemId, parsed.month, ref);
  }

  // (b) entries of the month with the wallet's line and the item's account line (明細・手入力).
  const walletAccounts = [...new Set(targets.map((target) => target.wallet.accountId))];
  const entries = await db.journalEntry.findMany({
    where: { ...live, lines: { some: { accountId: { in: walletAccounts } } } },
    select: {
      id: true,
      no: true,
      entryDate: true,
      lines: { select: { id: true, accountId: true, subAccountId: true, amount: true } },
    },
  });
  for (const entry of entries) {
    const ref = toRef(entry);
    const month = recurringMonth(ref.entryDate);
    for (const target of targets) {
      const walletLines = entry.lines.filter(
        (line) => onAccount(line, target.wallet) && line.amount === target.amount,
      );
      const matches = walletLines.some((walletLine) =>
        entry.lines.some((line) => line.id !== walletLine.id && onAccount(line, target.other)),
      );
      if (matches) markBooked(booked, target.itemId, month, ref);
    }
  }
  return booked;
}

function toRef(entry: { id: string; no: number; entryDate: Date }): EntryRef {
  return { id: entry.id, no: entry.no, entryDate: fromDbDate(entry.entryDate) };
}

// ---------------------------------------------------------------------------
// 予定日の発生 (§10.2–§10.4)
// ---------------------------------------------------------------------------

/** 登録する (no statements to import) / 明細で登録する (the wallet imports statements). */
export type RecurringDueMode = "post" | "statement";

/** A due occurrence: a row of `/settings/recurring/due`. */
export interface RecurringDueOccurrence {
  /** `<item>:<YYYY-MM>` (React keys). */
  key: string;
  recurringItemId: string;
  name: string;
  date: CalendarDate;
  month: RecurringMonth;
  /** 振替 / 支出 / 収入, or `null` while the other wallet is not decided (§10.1). */
  type: RecurringEntryType | null;
  walletId: string;
  walletName: string;
  /** 科目 (収入・支出) or 相手の口座 (振替). */
  counterpartName: string;
  /** The default amount: |金額| of the item (positive). */
  amount: Money;
  mode: RecurringDueMode;
}

interface OpenYear {
  startDate: CalendarDate;
  endDate: CalendarDate;
  lockedThrough: CalendarDate | null;
}

async function loadOpenYears(db: Db): Promise<OpenYear[]> {
  const years = await db.fiscalYear.findMany({
    where: { status: "open" },
    select: { startDate: true, endDate: true, lockedThrough: true },
  });
  return years.map((year) => ({
    startDate: fromDbDate(year.startDate),
    endDate: fromDbDate(year.endDate),
    lockedThrough: year.lockedThrough ? fromDbDate(year.lockedThrough) : null,
  }));
}

/** In an open fiscal year and after its close (§10.2: 開いている期間). */
function isOpenDate(date: CalendarDate, years: readonly OpenYear[]): boolean {
  return years.some(
    (year) =>
      year.startDate <= date &&
      date <= year.endDate &&
      (year.lockedThrough === null || date > year.lockedThrough),
  );
}

async function loadDue(db: Db, today: CalendarDate): Promise<RecurringDueOccurrence[]> {
  const after = addDays(today, -RECURRING_DUE_DAYS);
  const items = await db.recurringItem.findMany({
    where: { isActive: true, walletId: { not: null } },
    include: itemInclude,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  if (items.length === 0) return [];
  const wallets = await loadWalletRefs(db);
  const years = await loadOpenYears(db);
  const planned = items.map((item) => ({ item, plan: planOf(item, wallets) }));
  const booked = await bookedMonthsOf(
    db,
    planned.flatMap(({ item, plan }) => bookingTarget(item, plan) ?? []),
    { from: addDays(after, 1), through: today },
  );
  const rows: RecurringDueOccurrence[] = [];
  for (const { item, plan } of planned) {
    const wallet = item.wallet;
    if (!wallet) continue;
    for (const date of recurringOccurrences(recurringScheduleOf(item), {
      after,
      through: today,
    })) {
      const month = recurringMonth(date);
      if (!isOpenDate(date, years) || booked.get(item.id)?.has(month)) continue;
      rows.push({
        key: recurringSourceId(item.id, month),
        recurringItemId: item.id,
        name: item.name,
        date,
        month,
        type: plan.ok ? plan.type : null,
        walletId: wallet.id,
        walletName: wallet.name,
        counterpartName: counterpartLabel(item, plan),
        amount: magnitude(item.amount),
        mode: wallet.importer ? "statement" : "post",
      });
    }
  }
  rows.sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.recurringItemId < b.recurringItemId ? -1 : a.recurringItemId > b.recurringItemId ? 1 : 0),
  );
  return rows;
}

/**
 * The occurrences to register (§10.2): of the active items with a wallet, dated
 * `today − 92 < date ≤ today` in an open period, whose month is not registered yet. Oldest first,
 * then by name. `mode` tells 登録する from 明細で登録する (the wallet has an importer, §10.4).
 */
export async function listDueRecurringOccurrences(
  db: Db,
  today: CalendarDate,
): Promise<RecurringDueOccurrence[]> {
  return loadDue(db, today);
}

/** 予定日の登録 n 件 (both sections). */
export async function countDueRecurringOccurrences(db: Db, today: CalendarDate): Promise<number> {
  return (await loadDue(db, today)).length;
}

/** 定期取引を登録する n 件 → `/settings/recurring/due` (§10.3); nothing when none is due. */
export const recurringDueTodo: HomeTodoSource = async (db, today) => {
  const count = await countDueRecurringOccurrences(db, today);
  if (count === 0) return [];
  return [
    {
      key: "recurring-due",
      badge: String(count),
      tone: "count",
      label: "定期取引を登録する",
      href: "/settings/recurring/due",
    },
  ];
};

// ---------------------------------------------------------------------------
// 登録 (§10.5)
// ---------------------------------------------------------------------------

export interface RecurringPostResult {
  recurringItemId: string;
  month: RecurringMonth;
  entry: EntryRef;
}

/** Why the month cannot be registered (§10.5 step 2), or `null`. */
function occurrenceProblem(
  item: ItemRow,
  month: RecurringMonth,
  today: CalendarDate,
): { message: string } | { date: CalendarDate } {
  const label = `${item.name}の ${recurringMonthLabel(month)}分`;
  if (!item.isActive) {
    return { message: `${item.name}は無効です。設定 › 定期取引 で有効にしてから登録してください` };
  }
  const schedule = recurringScheduleOf(item);
  const date = recurringDateInMonth(schedule, month);
  if (date === null) {
    return { message: `${item.name}は ${recurringMonthLabel(month)}に予定日がありません` };
  }
  if (date < schedule.startDate) {
    return { message: `${label}は開始日（${displayDate(schedule.startDate)}）より前です` };
  }
  if (schedule.endDate !== null && date > schedule.endDate) {
    return { message: `${label}は終了日（${displayDate(schedule.endDate)}）より後です` };
  }
  if (date > today) {
    return { message: `${label}はまだ予定日が来ていません（${displayDate(date)}）` };
  }
  if (date <= addDays(today, -RECURRING_DUE_DAYS)) {
    return { message: `${label}は 3 か月より前の予定日です。取引の画面で登録してください` };
  }
  return { date };
}

/** The settings field a rejection of the entry belongs to also says where to fix it. */
const ITEM_FIELDS = new Set([
  "accountId",
  "taxCategoryCode",
  "segmentId",
  "partnerId",
  "counterpart",
  "fromWalletId",
  "toWalletId",
]);

function withSettingsHint(error: LedgerValidationError): LedgerValidationError {
  return new LedgerValidationError(
    error.errors.map((item) =>
      item.field && ITEM_FIELDS.has(item.field) && !item.message.includes("設定 ›")
        ? { ...item, message: `${item.message}（設定 › 定期取引）` }
        : item,
    ),
  );
}

/**
 * Registers one occurrence (§10.5) in one transaction: the item's row is locked (`FOR UPDATE`, so
 * two clicks on the same month queue), the month's date is checked (active, started, not ended,
 * due and within 92 days), a registered month (§10.2) is refused, so is a wallet that imports its
 * statements; then the entry of §10.1 is built by `buildSimpleEntry` and posted through
 * `postJournalEntryInTransaction` (`sourceKind = recurring`, `sourceId = <item>:<YYYY-MM>`, dated on
 * the occurrence), and `recurring_item.post` is logged. The ledger's rejections (closed month,
 * outside the year, no tax rule) come back as the transaction screens word them.
 */
export async function postRecurringOccurrence(
  db: Db,
  input: RecurringPostInput,
  options: ActorOptions & { today?: CalendarDate },
): Promise<RecurringPostResult> {
  const data = recurringPostSchema.parse(input);
  const today = options.today ?? todayInJapan();
  return runInTransaction(db, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "recurring_item" WHERE "id" = ${data.recurringItemId} FOR UPDATE`;
    if (locked.length === 0) {
      throw new SettingsError("定期取引が見つかりません。画面を読み込み直してください");
    }
    const item = await tx.recurringItem.findUniqueOrThrow({
      where: { id: data.recurringItemId },
      include: itemInclude,
    });
    const checked = occurrenceProblem(item, data.month, today);
    if ("message" in checked) throw new SettingsError(checked.message, { field: "month" });
    const date = checked.date;

    const wallets = await loadWalletRefs(tx);
    const plan = planOf(item, wallets);
    const target = bookingTarget(item, plan);
    if (target) {
      const booked = await bookedMonthsOf(tx, [target], { from: date, through: date });
      const entry = booked.get(item.id)?.get(data.month);
      if (entry) {
        throw new SettingsError(
          `${item.name}の ${recurringMonthLabel(data.month)}分は登録済みです（${entryNoLabel(entry.no)}）`,
          { field: "month" },
        );
      }
    }
    if (item.wallet?.importer) {
      throw new SettingsError("この口座は明細から登録します。明細を開いてください", {
        field: "walletId",
      });
    }
    if (!plan.ok) throw new SettingsError(plan.message, { field: plan.field });

    const simple = entryInputOf(item, plan, { date, month: data.month, amount: data.amount });
    let entry: JournalEntryInput | undefined;
    try {
      const fiscalYear = await lockFiscalYearOn(tx, date);
      entry = buildSimpleEntry(simple, await loadSimpleEntryContext(tx, fiscalYear));
      const posted = await postJournalEntryInTransaction(
        tx,
        {
          ...entry,
          sourceKind: "recurring",
          sourceId: recurringSourceId(item.id, data.month),
          fiscalYearId: fiscalYear.id,
        },
        { actor: options.actor },
      );
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "recurring_item.post",
        entity: "recurring_item",
        entityId: item.id,
        after: { month: data.month, journalEntryId: posted.id, amount: data.amount },
      });
      return {
        recurringItemId: item.id,
        month: data.month,
        entry: { id: posted.id, no: posted.no, entryDate: posted.entryDate },
      };
    } catch (error) {
      if (error instanceof LedgerValidationError) {
        throw withSettingsHint(simpleEntryValidationError(simple.type, entry, error));
      }
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// 履歴 (§10.8)
// ---------------------------------------------------------------------------

export interface RecurringEntryRow {
  id: string;
  no: number;
  entryDate: CalendarDate;
  month: RecurringMonth | null;
  /** The entry's total (its debit lines). */
  amount: Money;
  /** 取消済み (or 訂正済み: `replacedByNo`). */
  voided: boolean;
  /** 「→ No. 20 に訂正」 */
  replacedByNo: number | null;
}

/** The entries registered from an item (`sourceKind = recurring`), newest first, at most 6. */
export async function listRecurringEntries(
  db: Db,
  recurringItemId: string,
  options: { limit?: number } = {},
): Promise<RecurringEntryRow[]> {
  if (!recurringItemId) return [];
  const rows = await db.journalEntry.findMany({
    where: {
      sourceKind: "recurring",
      kind: { not: "reversal" },
      sourceId: { startsWith: recurringSourcePrefix(recurringItemId) },
    },
    orderBy: [{ entryDate: "desc" }, { no: "desc" }],
    take: options.limit ?? RECURRING_ENTRY_HISTORY_LIMIT,
    select: {
      id: true,
      no: true,
      entryDate: true,
      status: true,
      sourceId: true,
      replacedBy: { select: { no: true } },
      lines: { where: { side: "debit" }, select: { amount: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    no: row.no,
    entryDate: fromDbDate(row.entryDate),
    month: parseRecurringSourceId(row.sourceId)?.month ?? null,
    amount: row.lines.reduce((sum, line) => sum + line.amount, 0n),
    voided: row.status === "voided",
    replacedByNo: row.replacedBy?.no ?? null,
  }));
}

/** 生成元 of an entry posted from an item (§10.8): its name and month, `null` when unknown. */
export async function describeRecurringSource(
  db: Db,
  sourceId: string | null,
): Promise<{ recurringItemId: string; name: string | null; month: RecurringMonth } | null> {
  const parsed = parseRecurringSourceId(sourceId);
  if (!parsed) return null;
  const item = await db.recurringItem.findUnique({
    where: { id: parsed.itemId },
    select: { name: true },
  });
  return { recurringItemId: parsed.itemId, name: item?.name ?? null, month: parsed.month };
}

// ---------------------------------------------------------------------------
// 明細の推定 (§10.6) and the transaction form's template (§10.7)
// ---------------------------------------------------------------------------

/**
 * The 定期取引 stage's input (15 §4): the active items with an active wallet whose entry can be
 * decided, each with the months already registered (§10.2) around `from … through` (the dates of
 * the pending lines; the stage looks 7 days further each way).
 */
export async function loadRecurringSuggestItems(
  db: Db,
  range: { from: CalendarDate; through: CalendarDate },
): Promise<SuggestRecurringItem[]> {
  const items = await db.recurringItem.findMany({
    where: { isActive: true, walletId: { not: null } },
    include: itemInclude,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  if (items.length === 0) return [];
  const wallets = await loadWalletRefs(db);
  const planned = items.map((item) => ({ item, plan: planOf(item, wallets) }));
  const booked = await bookedMonthsOf(
    db,
    planned.flatMap(({ item, plan }) => bookingTarget(item, plan) ?? []),
    { from: addDays(range.from, -7), through: addDays(range.through, 7) },
  );
  const result: SuggestRecurringItem[] = [];
  for (const { item, plan } of planned) {
    if (!plan.ok || !plan.wallet.isActive) continue;
    result.push({
      id: item.id,
      name: item.name,
      walletId: plan.wallet.id,
      amount: item.amount,
      ...recurringScheduleOf(item),
      transferWalletId: plan.type === "transfer" ? plan.other.id : null,
      accountId: plan.type === "transfer" ? null : plan.accountId,
      taxCategoryCode: plan.type === "transfer" ? null : plan.taxCategoryCode,
      partnerId: plan.type === "transfer" ? null : plan.partnerId,
      segmentId: plan.type === "transfer" ? null : plan.segmentId,
      bookedMonths: new Set(booked.get(item.id)?.keys() ?? []),
    });
  }
  return result;
}

/** The initial values of `/entries/new?template=<id>` (§10.7). */
export type RecurringEntryTemplate =
  | {
      recurringItemId: string;
      name: string;
      type: "income" | "expense";
      /** 入金先 / 支払元 */
      walletId: string;
      accountId: string;
      taxCategoryCode: string | null;
      partnerId: string | null;
      segmentId: string | null;
      /** |金額| */
      amount: Money;
      /** 摘要: the item's name. */
      description: string;
    }
  | {
      recurringItemId: string;
      name: string;
      type: "transfer";
      fromWalletId: string;
      toWalletId: string;
      amount: Money;
      description: string;
    };

function templateOf(
  item: ItemRow,
  plan: EntryPlan,
  walletAccountIds: ReadonlySet<string>,
): RecurringEntryTemplate | null {
  if (!item.isActive || !plan.ok || !plan.wallet.isActive) return null;
  const base = {
    recurringItemId: item.id,
    name: item.name,
    amount: magnitude(item.amount),
    description: item.name,
  };
  if (plan.type === "transfer") {
    if (!plan.other.isActive) return null;
    const out = item.amount < 0n;
    return {
      ...base,
      type: "transfer",
      fromWalletId: out ? plan.wallet.id : plan.other.id,
      toWalletId: out ? plan.other.id : plan.wallet.id,
    };
  }
  // A 科目 the form cannot take for the type (収益 for 収入; 費用・資産・負債 for 支出) is no template.
  if (!allowedSimpleEntryAccount(item.account, plan.type, walletAccountIds)) return null;
  return {
    ...base,
    type: plan.type,
    walletId: plan.wallet.id,
    accountId: plan.accountId,
    taxCategoryCode: plan.taxCategoryCode,
    partnerId: plan.partnerId,
    segmentId: plan.segmentId,
  };
}

/**
 * The templates 「テンプレートから」 offers (§10.7): the active items whose entry can be built (the
 * other wallet decided, the 科目 fits the type), by name.
 */
export async function listRecurringEntryTemplates(db: Db): Promise<RecurringEntryTemplate[]> {
  const items = await db.recurringItem.findMany({
    where: { isActive: true, walletId: { not: null } },
    include: itemInclude,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  if (items.length === 0) return [];
  const wallets = await loadWalletRefs(db);
  const walletAccountIds = walletAccountIdsOf(wallets);
  return items.flatMap((item) => templateOf(item, planOf(item, wallets), walletAccountIds) ?? []);
}

/** One template (§10.7), or `null` when the item is unknown, inactive or cannot be built. */
export async function recurringEntryTemplate(
  db: Db,
  recurringItemId: string,
): Promise<RecurringEntryTemplate | null> {
  if (!recurringItemId || recurringItemId.length > 64) return null;
  const item = await db.recurringItem.findUnique({
    where: { id: recurringItemId },
    include: itemInclude,
  });
  if (!item) return null;
  const wallets = await loadWalletRefs(db);
  return templateOf(item, planOf(item, wallets), walletAccountIdsOf(wallets));
}
