import {
  addDays,
  compareDates,
  dateParts,
  daysBetween,
  lastDayOfMonth,
  parseCalendarDate,
  type CalendarDate,
} from "@niho-finance/ledger";
import { paymentCategoryOfRuleKey } from "@niho-finance/payroll";
import type { CalendarItem, CalendarItemKind } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, toDbDate, todayInJapan } from "./dates";
import { SettingsError } from "./errors";
import { newId } from "./ids";
import { DEADLINE_WINDOW_DAYS } from "./reports-query";
import { getCompany, listFiscalYears, type WriteOptions } from "./settings";
import { lockSettings, runInTransaction } from "./transaction";

/*
 * Tax and legal deadlines generated from the fiscal years (07-operations §4), and the reminder
 * mail selection (7 days before, on the due date, overdue). Dates are nominal: nothing is moved
 * for weekends or holidays, so a reminder is early rather than late. The payments of a pay run
 * (withholding tax, monthly or under the special rule; resident tax; social insurance) are not
 * generated here: the payroll adds them when a run is confirmed (22-payroll §7.1).
 */

export interface CalendarRuleInput {
  company: { foundedOn: CalendarDate };
  fiscalYear: { id: string; no: number; startDate: CalendarDate; endDate: CalendarDate };
}

export interface CalendarRule {
  /** Stored as `CalendarItem.ruleKey` (unique per fiscal year). */
  key: string;
  kind: CalendarItemKind;
  title: string;
  note?: string;
  /** The due date in this fiscal year, or `null` when the rule has no item in it. */
  due(input: CalendarRuleInput): CalendarDate | null;
}

export interface BuiltCalendarItem {
  ruleKey: string;
  kind: CalendarItemKind;
  title: string;
  dueDate: CalendarDate;
  note: string | null;
}

function calendarDate(year: number, month: number, day: number): CalendarDate {
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return parseCalendarDate(`${yyyy}-${mm}-${dd}`);
}

/** Adds whole months; a day the target month lacks becomes its last day (11-30 + 3 → 02-28). */
function addMonths(date: CalendarDate, months: number): CalendarDate {
  const { year, month, day } = dateParts(date);
  const monthIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex - targetYear * 12 + 1;
  const monthEnd = lastDayOfMonth(targetYear, targetMonth);
  return day >= dateParts(monthEnd).day ? monthEnd : calendarDate(targetYear, targetMonth, day);
}

function earlier(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a < b ? a : b;
}

/** The day with this month and day inside the fiscal year (a year has at most one), or `null`. */
function dayInFiscalYear(
  fiscalYear: CalendarRuleInput["fiscalYear"],
  month: number,
  day: number,
): CalendarDate | null {
  const first = dateParts(fiscalYear.startDate).year;
  const last = dateParts(fiscalYear.endDate).year;
  for (let year = first; year <= last; year += 1) {
    const date = calendarDate(year, month, day);
    if (date >= fiscalYear.startDate && date <= fiscalYear.endDate) return date;
  }
  return null;
}

/** The last day of the n-th month of the fiscal year (the starting month is the first). */
function endOfFiscalMonth(fiscalYear: CalendarRuleInput["fiscalYear"], n: number): CalendarDate {
  const { year, month } = dateParts(fiscalYear.startDate);
  const target = dateParts(addMonths(calendarDate(year, month, 1), n - 1));
  return lastDayOfMonth(target.year, target.month);
}

/** Founding filings exist in 第 1 期 only; `due` gets the founding date. */
function firstYearOnly(
  due: (foundedOn: CalendarDate, input: CalendarRuleInput) => CalendarDate,
): CalendarRule["due"] {
  return (input) => (input.fiscalYear.no === 1 ? due(input.company.foundedOn, input) : null);
}

/** The rules, in the order of 07-operations §4. Keys never change once released (stored rows). */
export const CALENDAR_RULES: readonly CalendarRule[] = [
  // 第 1 期: counted from the founding date.
  {
    key: "founding.establishment-notice-tax-office",
    kind: "filing",
    title: "法人設立届出書（税務署）",
    due: firstYearOnly((foundedOn) => addMonths(foundedOn, 2)),
  },
  {
    key: "founding.blue-return-application",
    kind: "filing",
    title: "青色申告承認申請書（税務署）",
    note: "少額減価償却資産の特例の前提。最優先",
    // The day before the earlier of "3 months after founding" and the end of 第 1 期.
    due: firstYearOnly((foundedOn, input) =>
      addDays(earlier(addMonths(foundedOn, 3), input.fiscalYear.endDate), -1),
    ),
  },
  {
    key: "founding.salary-office-notice",
    kind: "filing",
    title: "給与支払事務所等の開設届出書（税務署）",
    due: firstYearOnly((foundedOn) => addMonths(foundedOn, 1)),
  },
  {
    key: "founding.withholding-special-application",
    kind: "filing",
    title: "源泉所得税の納期の特例の承認申請（税務署）",
    note: "提出翌月から適用",
    due: firstYearOnly((foundedOn) => addMonths(foundedOn, 1)),
  },
  {
    key: "founding.social-insurance-application",
    kind: "filing",
    title: "健康保険・厚生年金 新規適用届（年金事務所）",
    note: "役員報酬を払う場合",
    due: firstYearOnly((foundedOn) => addDays(foundedOn, 5)),
  },
  {
    key: "founding.local-notice-city",
    kind: "filing",
    title: "法人設立・開設届出書（市役所）",
    due: firstYearOnly((foundedOn) => addDays(foundedOn, 30)),
  },
  {
    key: "founding.local-notice-prefecture",
    kind: "filing",
    title: "法人設立・開設届出書（県税事務所）",
    due: firstYearOnly((foundedOn) => addMonths(foundedOn, 2)),
  },
  {
    key: "founding.prescheduled-salary-notice",
    kind: "filing",
    title: "事前確定届出給与に関する届出書（税務署）",
    note: "役員に賞与を出す場合",
    due: firstYearOnly((foundedOn) => addMonths(foundedOn, 2)),
  },
  {
    key: "founding.invoice-registration",
    kind: "filing",
    title: "適格請求書発行事業者の登録申請（税務署）",
    note: "設立日に遡って登録する場合",
    due: firstYearOnly((_foundedOn, input) => input.fiscalYear.endDate),
  },
  {
    key: "founding.simplified-tax-election",
    kind: "filing",
    title: "簡易課税制度選択届出書（税務署）",
    due: firstYearOnly((_foundedOn, input) => input.fiscalYear.endDate),
  },
  {
    key: "founding.depreciation-method-notice",
    kind: "filing",
    title: "減価償却資産の償却方法の届出書（税務署）",
    note: "定額法にしたい資産がある場合",
    due: firstYearOnly((_foundedOn, input) => addMonths(input.fiscalYear.endDate, 2)),
  },

  // Every fiscal year.
  {
    key: "annual.tax-return",
    kind: "filing",
    title: "法人税・地方法人税・法人住民税・法人事業税の申告と納付（税務署・県税事務所・市役所）",
    note: "消費税は課税事業者の場合",
    due: (input) => addMonths(input.fiscalYear.endDate, 2),
  },
  {
    key: "annual.shareholders-meeting",
    kind: "meeting",
    title: "定時株主総会・決算公告（自社）",
    due: (input) => addMonths(input.fiscalYear.endDate, 3),
  },
  // The withholding tax under the special rule (1/20, and 7/10 before) is the payroll's
  // (22-payroll §7.1): `annual.withholding-special-jan` is gone, and the sync deletes its open items.
  {
    key: "annual.legal-records",
    kind: "filing",
    title: "法定調書合計表・給与支払報告書・償却資産申告書（税務署・市区町村）",
    due: (input) => dayInFiscalYear(input.fiscalYear, 1, 31),
  },
  {
    // The key predates 22-payroll §7.1 (it also carried the withholding tax then): kept, as keys are.
    key: "annual.withholding-special-jul",
    kind: "filing",
    title: "算定基礎届（年金事務所）",
    note: "社会保険の適用事業所の場合",
    due: (input) => dayInFiscalYear(input.fiscalYear, 7, 10),
  },
  {
    key: "annual.interim-return",
    kind: "filing",
    title: "法人税・消費税の中間申告（税務署）",
    note: "前期の税額が一定額を超えた場合",
    // From 第 2 期: the end of the 8th month of the year (11-30 for a year starting on 04-01).
    due: (input) => (input.fiscalYear.no >= 2 ? endOfFiscalMonth(input.fiscalYear, 8) : null),
  },
];

/** The items the rules give for one fiscal year (pure). */
export function buildCalendarItems(input: CalendarRuleInput): BuiltCalendarItem[] {
  const items: BuiltCalendarItem[] = [];
  for (const rule of CALENDAR_RULES) {
    const dueDate = rule.due(input);
    if (dueDate === null) continue;
    items.push({
      ruleKey: rule.key,
      kind: rule.kind,
      title: rule.title,
      dueDate,
      note: rule.note ?? null,
    });
  }
  return items;
}

export interface SyncCalendarItemsResult {
  created: number;
  updated: number;
  /** Open items whose rule no longer gives one, deleted. */
  removed: number;
}

function itemKey(fiscalYearId: string | null, ruleKey: string | null): string {
  return `${fiscalYearId ?? ""}\u0000${ruleKey ?? ""}`;
}

function differs(row: CalendarItem, item: BuiltCalendarItem): boolean {
  return (
    row.kind !== item.kind ||
    row.title !== item.title ||
    row.note !== item.note ||
    fromDbDate(row.dueDate) !== item.dueDate
  );
}

/**
 * Brings the calendar in line with the rules for every fiscal year (idempotent, one transaction):
 * missing items are created; open items follow the rule's date, title, note and kind, and are
 * deleted once their rule gives none (a generated reminder, not a book: the audit log keeps the
 * row). Completed items are left as they are, and so are the items of no fiscal year (payroll).
 */
export async function syncCalendarItems(
  db: Db,
  options: WriteOptions,
): Promise<SyncCalendarItemsResult> {
  return runInTransaction(db, async (tx) => {
    // The same lock as fiscal year creation: the years read here stay put, and two runs queue.
    await lockSettings(tx, "fiscalYears");
    const company = await getCompany(tx);
    if (!company) return { created: 0, updated: 0, removed: 0 };
    const fiscalYears = await listFiscalYears(tx);
    const existing = new Map(
      (
        await tx.calendarItem.findMany({
          where: {
            fiscalYearId: { in: fiscalYears.map((year) => year.id) },
            ruleKey: { not: null },
          },
        })
      ).map((row) => [itemKey(row.fiscalYearId, row.ruleKey), row]),
    );

    let created = 0;
    let updated = 0;
    const given = new Set<string>();
    for (const fiscalYear of fiscalYears) {
      const items = buildCalendarItems({ company: { foundedOn: company.foundedOn }, fiscalYear });
      for (const item of items) {
        given.add(itemKey(fiscalYear.id, item.ruleKey));
        const row = existing.get(itemKey(fiscalYear.id, item.ruleKey));
        if (!row) {
          const inserted = await tx.calendarItem.create({
            data: {
              id: newId(),
              fiscalYearId: fiscalYear.id,
              ruleKey: item.ruleKey,
              kind: item.kind,
              title: item.title,
              dueDate: toDbDate(item.dueDate),
              note: item.note,
            },
          });
          await appendAuditLog(tx, {
            actor: options.actor,
            action: "calendar_item.create",
            entity: "calendar_item",
            entityId: inserted.id,
            after: inserted,
          });
          created += 1;
          continue;
        }
        if (row.completedAt !== null || !differs(row, item)) continue;
        const after = await tx.calendarItem.update({
          where: { id: row.id },
          data: {
            kind: item.kind,
            title: item.title,
            dueDate: toDbDate(item.dueDate),
            note: item.note,
          },
        });
        await appendAuditLog(tx, {
          actor: options.actor,
          action: "calendar_item.update",
          entity: "calendar_item",
          entityId: row.id,
          before: row,
          after,
        });
        updated += 1;
      }
    }

    // A rule taken out (or no longer giving an item in that year): its open items would go on
    // being mailed. Completed ones stay as the record of what was done.
    let removed = 0;
    for (const [key, row] of existing) {
      if (given.has(key) || row.completedAt !== null) continue;
      await tx.calendarItem.delete({ where: { id: row.id } });
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "calendar_item.delete",
        entity: "calendar_item",
        entityId: row.id,
        before: row,
      });
      removed += 1;
    }
    return { created, updated, removed };
  });
}

/** A calendar item as the reminder selection sees it. */
export interface CalendarNoticeItem {
  id: string;
  dueDate: CalendarDate;
  completedAt: Date | null;
  lastNotifiedOn: CalendarDate | null;
  title: string;
  note: string | null;
  kind: CalendarItemKind;
}

export type CalendarNoticeStage = "week" | "today" | "overdue";

export interface CalendarNotice {
  stage: CalendarNoticeStage;
  item: CalendarNoticeItem;
}

function noticeStage(item: CalendarNoticeItem, today: CalendarDate): CalendarNoticeStage | null {
  const weekBefore = addDays(item.dueDate, -7);
  const notifiedSince = (day: CalendarDate) =>
    item.lastNotifiedOn !== null && item.lastNotifiedOn >= day;
  if (today < weekBefore) return null;
  if (today < item.dueDate) return notifiedSince(weekBefore) ? null : "week";
  if (notifiedSince(item.dueDate)) return null;
  return today === item.dueDate ? "today" : "overdue";
}

/**
 * The reminders due on `today` (pure): an open item is mailed once when it comes within 7 days,
 * and once more on its due date, or as overdue when the due-date mail never went out.
 * Sorted by due date (items with the same date keep their order).
 */
export function selectCalendarNotices(
  items: readonly CalendarNoticeItem[],
  today: CalendarDate,
): CalendarNotice[] {
  const notices: CalendarNotice[] = [];
  for (const item of items) {
    if (item.completedAt !== null) continue;
    const stage = noticeStage(item, today);
    if (stage) notices.push({ stage, item });
  }
  return notices.sort((a, b) => compareDates(a.item.dueDate, b.item.dueDate));
}

function toNoticeItem(row: CalendarItem): CalendarNoticeItem {
  return {
    id: row.id,
    dueDate: fromDbDate(row.dueDate),
    completedAt: row.completedAt,
    lastNotifiedOn: fromDbDateOrNull(row.lastNotifiedOn),
    title: row.title,
    note: row.note,
    kind: row.kind,
  };
}

/** Open (not completed) items, by due date. */
export async function loadOpenCalendarItems(db: Db): Promise<CalendarNoticeItem[]> {
  const rows = await db.calendarItem.findMany({
    where: { completedAt: null },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
  });
  return rows.map(toNoticeItem);
}

/** Records that the reminder mail for these items went out `today` (one audit entry). */
export async function markCalendarItemsNotified(
  db: Db,
  ids: readonly string[],
  today: CalendarDate,
  options: WriteOptions,
): Promise<void> {
  if (ids.length === 0) return;
  await runInTransaction(db, async (tx) => {
    await tx.calendarItem.updateMany({
      where: { id: { in: [...ids] } },
      data: { lastNotifiedOn: toDbDate(today) },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "calendar_item.notify",
      entity: "calendar_item",
      entityId: null,
      after: { ids, today },
    });
  });
}

// ---------------------------------------------------------------------------
// The calendar screen (24): the list, 完了にする / 未完了に戻す
// ---------------------------------------------------------------------------

/** A deadline as the calendar screen shows it. */
export interface CalendarListItem {
  id: string;
  kind: CalendarItemKind;
  title: string;
  note: string | null;
  dueDate: CalendarDate;
  completedAt: Date | null;
  completedBy: string | null;
  /**
   * Where the completion is recorded: on the calendar screen, or on the payroll screen for the
   * payments a pay run added (22 §7: 納付を登録 posts the entry and completes the item).
   */
  managedBy: "calendar" | "payroll";
}

/** The deadlines of one fiscal year (`fiscalYear` is `null` for items outside every year). */
export interface CalendarGroup {
  fiscalYear: { id: string; no: number; startDate: CalendarDate; endDate: CalendarDate } | null;
  /** Not completed, by due date (then title). */
  open: CalendarListItem[];
  /** Completed, by due date (then title). */
  completed: CalendarListItem[];
}

/**
 * A payment deadline a pay run added (22 §7.1): no fiscal year, a `payroll.` rule key of a payment.
 * The 賞与支払届 a bonus run adds (`payroll.bonus_report.*`, §10.4) is a filing: completed here.
 */
function isPayrollItem(row: Pick<CalendarItem, "fiscalYearId" | "ruleKey">): boolean {
  return row.fiscalYearId === null && paymentCategoryOfRuleKey(row.ruleKey ?? "") !== null;
}

function toListItem(row: CalendarItem): CalendarListItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    note: row.note,
    dueDate: fromDbDate(row.dueDate),
    completedAt: row.completedAt,
    completedBy: row.completedBy,
    managedBy: isPayrollItem(row) ? "payroll" : "calendar",
  };
}

/**
 * The calendar screen's list (24 §3): one group per fiscal year from 第 1 期, years without items
 * included. An item of no fiscal year (the payroll payments) goes to the year its due date falls
 * in; the ones outside every year come last, in a group of their own.
 */
export async function listCalendarItems(db: Db): Promise<CalendarGroup[]> {
  const fiscalYears = (
    await db.fiscalYear.findMany({
      orderBy: { no: "asc" },
      select: { id: true, no: true, startDate: true, endDate: true },
    })
  ).map((year) => ({
    id: year.id,
    no: year.no,
    startDate: fromDbDate(year.startDate),
    endDate: fromDbDate(year.endDate),
  }));
  const rows = await db.calendarItem.findMany({
    orderBy: [{ dueDate: "asc" }, { title: "asc" }, { id: "asc" }],
  });
  const groups = new Map<string | null, CalendarGroup>(
    fiscalYears.map((year) => [year.id, { fiscalYear: year, open: [], completed: [] }]),
  );
  for (const row of rows) {
    const item = toListItem(row);
    const yearId =
      row.fiscalYearId ??
      fiscalYears.find((year) => year.startDate <= item.dueDate && item.dueDate <= year.endDate)
        ?.id;
    let group = (yearId === undefined ? undefined : groups.get(yearId)) ?? groups.get(null);
    if (!group) {
      group = { fiscalYear: null, open: [], completed: [] };
      groups.set(null, group);
    }
    (item.completedAt === null ? group.open : group.completed).push(item);
  }
  return [...groups.values()];
}

/** How the calendar screen shows an item on a day (24 §1). */
export type CalendarItemStatus =
  | { kind: "completed"; on: CalendarDate }
  | { kind: "overdue" }
  | { kind: "today" }
  | { kind: "soon"; days: number }
  | { kind: "open" };

/**
 * The state of an item on `today` (pure): completed (on the JST day it was recorded), overdue, due
 * today, due within the home's 7 days (`soon`), or later (`open`).
 */
export function calendarItemStatus(
  item: { dueDate: CalendarDate; completedAt: Date | null },
  today: CalendarDate,
): CalendarItemStatus {
  if (item.completedAt !== null) return { kind: "completed", on: todayInJapan(item.completedAt) };
  if (item.dueDate < today) return { kind: "overdue" };
  if (item.dueDate === today) return { kind: "today" };
  const days = daysBetween(today, item.dueDate);
  return days <= DEADLINE_WINDOW_DAYS ? { kind: "soon", days } : { kind: "open" };
}

const CALENDAR_ITEM_NOT_FOUND = "この期限は見つかりません。画面を読み込み直してください";

async function setCalendarItemCompleted(
  db: Db,
  id: string,
  completed: boolean,
  options: WriteOptions,
): Promise<CalendarListItem> {
  return runInTransaction(db, async (tx) => {
    // The sync's lock: a sync that read the item as open cannot overwrite it once completed.
    await lockSettings(tx, "fiscalYears");
    const row = await tx.calendarItem.findUnique({ where: { id } });
    if (!row) throw new SettingsError(CALENDAR_ITEM_NOT_FOUND);
    // A payroll payment is completed by registering it on the payroll screen, which posts the
    // entry (22 §7): completing or reopening it here would put the schedule and the ledger apart.
    if (isPayrollItem(row)) {
      throw new SettingsError(`「${row.title}」は給与の画面で納付を記録します`);
    }
    // Already so (another tab, a second click): nothing to write, nothing to log.
    if ((row.completedAt !== null) === completed) return toListItem(row);
    const after = await tx.calendarItem.update({
      where: { id },
      data: completed
        ? { completedAt: new Date(), completedBy: options.actor }
        : { completedAt: null, completedBy: null },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: completed ? "calendar_item.complete" : "calendar_item.reopen",
      entity: "calendar_item",
      entityId: id,
      before: row,
      after,
    });
    return toListItem(after);
  });
}

/**
 * 完了にする (24 §2): records when and by whom (audit `calendar_item.complete`). The sync and the
 * reminders leave a completed item alone.
 */
export async function completeCalendarItem(
  db: Db,
  id: string,
  options: WriteOptions,
): Promise<CalendarListItem> {
  return setCalendarItemCompleted(db, id, true, options);
}

/**
 * 未完了に戻す (24 §2): clears the record (audit `calendar_item.reopen`). The next sync puts the item
 * back on its rule; reminders already sent are not sent again (`lastNotifiedOn` stays).
 */
export async function reopenCalendarItem(
  db: Db,
  id: string,
  options: WriteOptions,
): Promise<CalendarListItem> {
  return setCalendarItemCompleted(db, id, false, options);
}
