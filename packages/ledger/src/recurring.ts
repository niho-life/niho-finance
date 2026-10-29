import { dateParts, lastDayOfMonth, type CalendarDate } from "./date";
import type { Money } from "./money";

/**
 * 定期取引 (21-cashflow §2.1, §10): when an item happens, the month key of an occurrence and the
 * `sourceId` of the entry registered from it. Pure: the forecast (`@niho-finance/reports`), the
 * registration and the statement suggestions (`@niho-finance/db`) share these rules.
 */

export type RecurringFrequency = "monthly" | "yearly";

/** What decides the dates of a recurring item. */
export interface RecurringSchedule {
  frequency: RecurringFrequency;
  /** 1–31; 31 is 末日, and a day the month does not have is its last day (2/30 → 2/28). */
  dayOfMonth: number;
  /** 1–12 for yearly items; `null` for monthly ones. */
  monthOfYear: number | null;
  startDate: CalendarDate;
  /** Inclusive; `null` = no end. */
  endDate: CalendarDate | null;
}

/** 月のキー of an occurrence: `YYYY-MM` (§10.2). */
export type RecurringMonth = `${number}-${number}`;

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

export function isRecurringMonth(value: unknown): value is RecurringMonth {
  if (typeof value !== "string") return false;
  const match = MONTH_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 1 && month >= 1 && month <= 12;
}

/** The month key of a date: `2026-12-31` → `2026-12`. */
export function recurringMonth(date: CalendarDate): RecurringMonth {
  return date.slice(0, 7) as RecurringMonth;
}

function monthParts(month: RecurringMonth): { year: number; month: number } {
  const text: string = month;
  if (!isRecurringMonth(text)) throw new RangeError(`"${text}" is not a month (YYYY-MM)`);
  return { year: Number(text.slice(0, 4)), month: Number(text.slice(5, 7)) };
}

/** 「2026 年 12 月」. */
export function recurringMonthLabel(month: RecurringMonth): string {
  const parts = monthParts(month);
  return `${parts.year} 年 ${parts.month} 月`;
}

/** The 摘要 of an entry registered from an item (§10.1): 「家賃（2026 年 12 月分）」. */
export function recurringEntryDescription(name: string, month: RecurringMonth): string {
  return `${name}（${recurringMonthLabel(month)}分）`;
}

/** The first and the last day of a month. */
export function recurringMonthRange(month: RecurringMonth): {
  from: CalendarDate;
  through: CalendarDate;
} {
  const parts = monthParts(month);
  return { from: `${month}-01` as CalendarDate, through: lastDayOfMonth(parts.year, parts.month) };
}

/**
 * The nominal date of the item in a month, without its start and end: the `dayOfMonth` day (the
 * last day when the month is shorter) of every month, or of `monthOfYear` only for a yearly item.
 * `null` when a yearly item does not happen in that month.
 */
export function recurringDateInMonth(
  item: Pick<RecurringSchedule, "frequency" | "dayOfMonth" | "monthOfYear">,
  month: RecurringMonth,
): CalendarDate | null {
  const parts = monthParts(month);
  if (item.frequency === "yearly" && item.monthOfYear !== parts.month) return null;
  const monthEnd = lastDayOfMonth(parts.year, parts.month);
  const day = Math.min(Math.max(item.dayOfMonth, 1), dateParts(monthEnd).day);
  return `${month}-${String(day).padStart(2, "0")}` as CalendarDate;
}

/**
 * The dates of an item with `after < d ≤ through`, `startDate ≤ d` and `d ≤ endDate` (§2.1). A day
 * the month does not have is the month's last day (末日 = 31). `isActive` is not looked at here.
 */
export function recurringOccurrences(
  item: RecurringSchedule,
  range: { after: CalendarDate; through: CalendarDate },
): CalendarDate[] {
  const { after, through } = range;
  if (through <= after) return [];
  if (item.frequency === "yearly" && item.monthOfYear === null) return [];
  const dates: CalendarDate[] = [];
  let { year, month } = dateParts(after);
  const last = dateParts(through);
  while (year < last.year || (year === last.year && month <= last.month)) {
    const key =
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}` as RecurringMonth;
    const date = recurringDateInMonth(item, key);
    if (
      date !== null &&
      date > after &&
      date <= through &&
      date >= item.startDate &&
      (item.endDate === null || date <= item.endDate)
    ) {
      dates.push(date);
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return dates;
}

// ---------------------------------------------------------------------------
// The entry of an occurrence (§10.1, §10.5)
// ---------------------------------------------------------------------------

/** 振替 / 支出 / 収入 (§10.1): derived from the columns, never stored. */
export type RecurringEntryType = "transfer" | "expense" | "income";

/** 振替 when the item has the other wallet, else 支出 (money out) or 収入 (money in). */
export function recurringEntryType(item: {
  amount: Money;
  transferWalletId: string | null;
}): RecurringEntryType {
  if (item.transferWalletId !== null) return "transfer";
  return item.amount < 0n ? "expense" : "income";
}

const SOURCE_SEPARATOR = ":";

/** `<定期取引の id>:<YYYY-MM>`: the `sourceId` of the entry registered for one month (§10.5). */
export function recurringSourceId(itemId: string, month: RecurringMonth): string {
  if (itemId === "" || itemId.includes(SOURCE_SEPARATOR)) {
    throw new RangeError(`recurringSourceId: "${itemId}" is not an item id`);
  }
  const text: string = month;
  if (!isRecurringMonth(text)) throw new RangeError(`"${text}" is not a month (YYYY-MM)`);
  return `${itemId}${SOURCE_SEPARATOR}${text}`;
}

/** The prefix every `sourceId` of one item starts with (its history, §10.8). */
export function recurringSourcePrefix(itemId: string): string {
  return `${itemId}${SOURCE_SEPARATOR}`;
}

/** Reads a `sourceId` made by `recurringSourceId`; `null` for anything else. */
export function parseRecurringSourceId(
  sourceId: string | null | undefined,
): { itemId: string; month: RecurringMonth } | null {
  if (typeof sourceId !== "string") return null;
  const parts = sourceId.split(SOURCE_SEPARATOR);
  if (parts.length !== 2) return null;
  const [itemId, month] = parts;
  if (!itemId || !isRecurringMonth(month)) return null;
  return { itemId, month };
}
