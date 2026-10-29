import { dateParts, lastDayOfMonth, type CalendarDate } from "./date";
import type { RecurringMonth } from "./recurring";

/**
 * 定期請求 (docs/design/18-invoicing.md §14): the due dates of a recurring invoice, its 支払期限, the
 * 対象月 written into the title and the line names, and the sentences the screens show. Pure: the
 * repository (`@niho-finance/db`) and the form (in the browser) share these rules.
 */

export const RECURRING_INVOICE_FREQUENCIES = ["monthly", "bimonthly", "yearly"] as const;
export type RecurringInvoiceFrequency = (typeof RECURRING_INVOICE_FREQUENCIES)[number];

/** 毎月 / 隔月 / 毎年 (18 §14.1). */
export const RECURRING_INVOICE_FREQUENCY_LABELS: Readonly<
  Record<RecurringInvoiceFrequency, string>
> = {
  monthly: "毎月",
  bimonthly: "隔月",
  yearly: "毎年",
};

export function isRecurringInvoiceFrequency(value: unknown): value is RecurringInvoiceFrequency {
  return (
    typeof value === "string" &&
    (RECURRING_INVOICE_FREQUENCIES as readonly string[]).includes(value)
  );
}

/** 対象月のずれ: the month of the due date + this. */
export type RecurringInvoiceTargetOffset = -1 | 0 | 1;

/** The choices of 対象月 (当月分 is the default), in the order of the select. */
export const RECURRING_INVOICE_TARGET_OFFSETS: readonly {
  value: RecurringInvoiceTargetOffset;
  label: string;
}[] = [
  { value: -1, label: "前月分" },
  { value: 0, label: "当月分" },
  { value: 1, label: "翌月分" },
];

export function recurringInvoiceTargetOffsetLabel(offset: number): string {
  return RECURRING_INVOICE_TARGET_OFFSETS.find((item) => item.value === offset)?.label ?? "当月分";
}

/** 支払期限の「何か月後」: 0–3 (18 §14.1). */
export const RECURRING_INVOICE_DUE_MONTHS = [0, 1, 2, 3] as const;

const DUE_MONTH_LABELS: readonly string[] = ["当月", "翌月", "翌々月", "3 か月後"];

/** 1–31 for the days of the rules; 31 is 末日. */
export const RECURRING_INVOICE_LAST_DAY = 31;

/** What decides the due dates (予定日) of a recurring invoice. */
export interface RecurringInvoiceSchedule {
  frequency: RecurringInvoiceFrequency;
  /** 1–31; 31 is 末日, and a day the month does not have is its last day (2/30 → 2/28). */
  issueDay: number;
  /** 隔月 counts from this month, 毎年 happens in it. */
  startDate: CalendarDate;
  /** Inclusive; `null` = no end. */
  endDate: CalendarDate | null;
}

/** 支払期限: `dueMonths` months after the issue date, on `dueDay` (31 = 末日). */
export interface RecurringInvoiceDueRule {
  dueMonths: number;
  dueDay: number;
}

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

/** Months counted from year 0: month arithmetic without dates. */
function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function fromMonthIndex(index: number): { year: number; month: number } {
  // Indexes are positive (years 1+), so the remainder is the month and the rest divides evenly.
  const month = index % 12;
  return { year: (index - month) / 12, month: month + 1 };
}

function monthKey(index: number): RecurringMonth {
  const { year, month } = fromMonthIndex(index);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}` as RecurringMonth;
}

function indexOfMonth(month: RecurringMonth): number {
  const text: string = month;
  return monthIndex(Number(text.slice(0, 4)), Number(text.slice(5, 7)));
}

/** The `day` of a month, or its last day when the month is shorter (31 = 末日). */
function dayOfMonth(index: number, day: number): CalendarDate {
  const { year, month } = fromMonthIndex(index);
  const last = dateParts(lastDayOfMonth(year, month)).day;
  const clamped = Math.min(Math.max(Math.trunc(day), 1), last);
  return `${monthKey(index)}-${String(clamped).padStart(2, "0")}` as CalendarDate;
}

// ---------------------------------------------------------------------------
// 予定日 (18 §14.1, §14.2)
// ---------------------------------------------------------------------------

/**
 * The nominal date of the schedule in a month, without its start and end: the `issueDay` day (the
 * last day when the month is shorter) of every month, of every other month counted from the start
 * month (隔月), or of the start month only (毎年). `null` when the schedule skips that month.
 */
export function recurringInvoiceDateInMonth(
  schedule: Pick<RecurringInvoiceSchedule, "frequency" | "issueDay" | "startDate">,
  month: RecurringMonth,
): CalendarDate | null {
  const index = indexOfMonth(month);
  const start = dateParts(schedule.startDate);
  const startIndex = monthIndex(start.year, start.month);
  switch (schedule.frequency) {
    case "monthly":
      break;
    case "bimonthly":
      if ((((index - startIndex) % 2) + 2) % 2 !== 0) return null;
      break;
    case "yearly":
      if (fromMonthIndex(index).month !== start.month) return null;
      break;
  }
  return dayOfMonth(index, schedule.issueDay);
}

/** The dates in force: on or after the start date, on or before the end date. */
function inForce(schedule: RecurringInvoiceSchedule, date: CalendarDate): boolean {
  return date >= schedule.startDate && (schedule.endDate === null || date <= schedule.endDate);
}

/**
 * The due dates with `after < d ≤ through` within `startDate ≤ d ≤ endDate` (18 §14.2), oldest
 * first. At most one per month. `isActive` is not looked at here.
 */
export function recurringInvoiceDates(
  schedule: RecurringInvoiceSchedule,
  range: { after: CalendarDate; through: CalendarDate },
): CalendarDate[] {
  const { after, through } = range;
  if (through <= after) return [];
  const first = dateParts(after);
  const last = dateParts(through);
  const dates: CalendarDate[] = [];
  for (
    let index = monthIndex(first.year, first.month);
    index <= monthIndex(last.year, last.month);
    index += 1
  ) {
    const date = recurringInvoiceDateInMonth(schedule, monthKey(index));
    if (date !== null && date > after && date <= through && inForce(schedule, date)) {
      dates.push(date);
    }
  }
  return dates;
}

/** How far ahead `nextRecurringInvoiceDates` looks (a yearly schedule needs 12 months a date). */
const LOOKAHEAD_MONTHS = 12 * 50;

/**
 * The next `count` due dates after `after` (次回の予定日, 「次回 3 回の予定日」), oldest first; fewer
 * when the schedule ends before.
 */
export function nextRecurringInvoiceDates(
  schedule: RecurringInvoiceSchedule,
  options: { after: CalendarDate; count: number },
): CalendarDate[] {
  const dates: CalendarDate[] = [];
  if (options.count <= 0) return dates;
  const from = dateParts(options.after > schedule.startDate ? options.after : schedule.startDate);
  const start = monthIndex(from.year, from.month);
  for (let index = start; index < start + LOOKAHEAD_MONTHS; index += 1) {
    const date = recurringInvoiceDateInMonth(schedule, monthKey(index));
    if (date === null || date <= options.after || date < schedule.startDate) continue;
    if (schedule.endDate !== null && date > schedule.endDate) break;
    dates.push(date);
    if (dates.length >= options.count) break;
  }
  return dates;
}

// ---------------------------------------------------------------------------
// 支払期限 (18 §14.1)
// ---------------------------------------------------------------------------

/** 支払期限 of a draft issued on `issueDate`: `dueMonths` months later, on `dueDay` (31 = 末日). */
export function recurringInvoiceDueDate(
  issueDate: CalendarDate,
  rule: RecurringInvoiceDueRule,
): CalendarDate {
  const { year, month } = dateParts(issueDate);
  return dayOfMonth(monthIndex(year, month) + rule.dueMonths, rule.dueDay);
}

/**
 * Why the rule could put the due date before the issue date, or `null`: in the month of the issue
 * (`dueMonths = 0`) the day must be the issue day or later.
 */
export function recurringInvoiceDueRuleProblem(
  issueDay: number,
  rule: RecurringInvoiceDueRule,
): string | null {
  if (rule.dueMonths > 0 || rule.dueDay >= issueDay) return null;
  return "支払期限が発行日より前になります。当月にするときは、発行日の日以後の日にしてください";
}

function dayLabel(day: number): string {
  return day >= RECURRING_INVOICE_LAST_DAY ? "末日" : `${day} 日`;
}

/** 「翌月末」「翌月 10 日」「当月末」「3 か月後の 5 日」. */
export function describeRecurringInvoiceDueRule(rule: RecurringInvoiceDueRule): string {
  const months = DUE_MONTH_LABELS[rule.dueMonths] ?? `${rule.dueMonths} か月後`;
  if (rule.dueMonths >= 3) return `${months}の${dayLabel(rule.dueDay)}`;
  return rule.dueDay >= RECURRING_INVOICE_LAST_DAY ? `${months}末` : `${months} ${rule.dueDay} 日`;
}

// ---------------------------------------------------------------------------
// 対象月 (18 §14.1)
// ---------------------------------------------------------------------------

/** What the title and the line names write for the target month. Full-width braces work too. */
export const TARGET_MONTH_PLACEHOLDER = "{対象月}";

const TARGET_MONTH_PATTERN = /[{｛]\s*対象月\s*[}｝]/g;

/** The month a draft issued on `issueDate` is for: the issue month + the offset. */
export function recurringInvoiceTargetMonth(
  issueDate: CalendarDate,
  offset: number,
): RecurringMonth {
  const { year, month } = dateParts(issueDate);
  return monthKey(monthIndex(year, month) + offset);
}

/** 「2026年11月」: the month as the documents write it (18 §11). */
export function invoiceMonthLabel(month: RecurringMonth): string {
  const text: string = month;
  return `${Number(text.slice(0, 4))}年${Number(text.slice(5, 7))}月`;
}

export function hasTargetMonthPlaceholder(text: string | null | undefined): boolean {
  return typeof text === "string" && new RegExp(TARGET_MONTH_PATTERN.source).test(text);
}

/**
 * `{対象月}` replaced by the target month (「顧問料（{対象月}分）」 → 「顧問料（2026年11月分）」).
 * The text without it is returned as is.
 */
export function expandTargetMonth(text: string, issueDate: CalendarDate, offset: number): string {
  const label = invoiceMonthLabel(recurringInvoiceTargetMonth(issueDate, offset));
  return text.replace(TARGET_MONTH_PATTERN, label);
}

// ---------------------------------------------------------------------------
// 周期の文 (18 §14.5)
// ---------------------------------------------------------------------------

/** The longest a month gets (2 月 = 29 in a leap year). */
const MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 「毎月 25 日」「隔月 末日」「毎年 3 月 31 日」「毎年 2 月 末日」. */
export function describeRecurringInvoiceSchedule(
  schedule: Pick<RecurringInvoiceSchedule, "frequency" | "issueDay" | "startDate">,
): string {
  const label = RECURRING_INVOICE_FREQUENCY_LABELS[schedule.frequency];
  if (schedule.frequency !== "yearly") return `${label} ${dayLabel(schedule.issueDay)}`;
  const { month } = dateParts(schedule.startDate);
  const max = MAX_DAYS[month - 1] ?? 31;
  const day = schedule.issueDay > max ? "末日" : `${schedule.issueDay} 日`;
  return `${label} ${month} 月 ${day}`;
}
