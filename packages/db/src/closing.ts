/**
 * 締め (11-transactions §1, §7): `FiscalYear.lockedThrough` moves forward to a month end (or the
 * year's last day), or back — to an earlier month end or to 「締めない」 — with a reason. Entries on
 * or before it can no longer be posted, voided or corrected (the ledger rejects them with
 * PERIOD_LOCKED); voids and corrections of such entries are dated on the first open day instead.
 */
import {
  addDays,
  dateParts,
  displayDate,
  isLastDayOfMonth,
  lastDayOfMonth,
  type CalendarDate,
  type FiscalYearContext,
} from "@niho-finance/ledger";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDateOrNull, toDbDate } from "./dates";
import { SettingsError } from "./errors";
import type { ActorOptions } from "./journal";
import { toFiscalYearContext } from "./queries";
import { closeFiscalYearSchema, type CloseFiscalYearInput } from "./schemas";
import { runInTransaction } from "./transaction";

type ClosePeriod = Pick<FiscalYearContext, "startDate" | "endDate" | "lockedThrough">;

/** A month end inside the year, or the year's last day (a year may end mid-month). */
export function isCloseDate(date: CalendarDate, period: ClosePeriod): boolean {
  if (date < period.startDate || date > period.endDate) return false;
  return date === period.endDate || isLastDayOfMonth(date);
}

/**
 * The dates the close can be set to (11 §7): the month ends from the year's first month up to the
 * earlier of the year's last day and the end of today's month. The current close is always offered.
 */
export function listCloseOptions(period: ClosePeriod, today: CalendarDate): CalendarDate[] {
  const now = dateParts(today);
  const endOfThisMonth = lastDayOfMonth(now.year, now.month);
  const limit = endOfThisMonth < period.endDate ? endOfThisMonth : period.endDate;
  const options: CalendarDate[] = [];
  let { year, month } = dateParts(period.startDate);
  for (;;) {
    const monthEnd = lastDayOfMonth(year, month);
    const candidate = monthEnd < period.endDate ? monthEnd : period.endDate;
    if (candidate > limit) break;
    options.push(candidate);
    if (candidate >= period.endDate) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  if (period.lockedThrough !== null && !options.includes(period.lockedThrough)) {
    options.push(period.lockedThrough);
    options.sort();
  }
  return options;
}

export type CloseDirection = "close" | "reopen";

export interface CloseRange {
  /** `close` makes the range read-only; `reopen` opens it again. */
  direction: CloseDirection;
  from: CalendarDate;
  to: CalendarDate;
}

/** The dates a change of the close affects: between the old and the new `lockedThrough`. */
export function closeRange(period: ClosePeriod, next: CalendarDate | null): CloseRange | null {
  const current = period.lockedThrough;
  if (current === next) return null;
  if (next !== null && (current === null || next > current)) {
    return { direction: "close", from: current ? addDays(current, 1) : period.startDate, to: next };
  }
  if (current === null) return null;
  return { direction: "reopen", from: next ? addDays(next, 1) : period.startDate, to: current };
}

/** Entries of the fiscal year dated `from`–`to` (both inclusive), whatever their status. */
export async function countEntriesBetween(
  db: Db,
  fiscalYearId: string,
  from: CalendarDate,
  to: CalendarDate,
): Promise<number> {
  return db.journalEntry.count({
    where: { fiscalYearId, entryDate: { gte: toDbDate(from), lte: toDbDate(to) } },
  });
}

export interface ClosePreview {
  /** `null` when the close would not change. */
  range: CloseRange | null;
  /** Entries in the range. */
  count: number;
}

function invalidDate(no: number, period: ClosePeriod): SettingsError {
  return new SettingsError(
    `締め日は第 ${no} 期（${displayDate(period.startDate)}〜${displayDate(period.endDate)}）の月末日にしてください`,
    { field: "lockedThrough" },
  );
}

function notFound(): SettingsError {
  return new SettingsError("会計期間が見つかりません。画面を読み込み直してください");
}

/** What a change of the close would affect (the sheet shows it before the confirmation). Read only. */
export async function previewFiscalYearClose(
  db: Db,
  fiscalYearId: string,
  lockedThrough: CalendarDate | null,
): Promise<ClosePreview> {
  const row = await db.fiscalYear.findUnique({ where: { id: fiscalYearId } });
  if (!row) throw notFound();
  const period = toFiscalYearContext(row);
  if (lockedThrough !== null && !isCloseDate(lockedThrough, period)) {
    throw invalidDate(row.no, period);
  }
  const range = closeRange(period, lockedThrough);
  return {
    range,
    count: range ? await countEntriesBetween(db, row.id, range.from, range.to) : 0,
  };
}

export interface CloseFiscalYearResult {
  fiscalYearId: string;
  /** 第 n 期 */
  no: number;
  lockedThrough: CalendarDate | null;
  /** `null` when nothing changed (e.g. a second submit). */
  range: CloseRange | null;
  /** Entries in the range: now read-only (close) or open again (reopen). */
  affectedCount: number;
}

/**
 * Sets the close of a fiscal year (11 §1): a month end inside the year (or its last day), or `null`
 * (締めない). Moving it back needs a reason. The year is locked like a posting, so a close and a
 * posting never cross. A closed year (決算済み) cannot change. Audit: `fiscal_year.close` / `.reopen`.
 */
export async function closeFiscalYearThrough(
  db: Db,
  fiscalYearId: string,
  input: CloseFiscalYearInput,
  options: ActorOptions,
): Promise<CloseFiscalYearResult> {
  const data = closeFiscalYearSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "fiscal_year" WHERE "id" = ${fiscalYearId} FOR UPDATE`;
    if (locked.length === 0) throw notFound();
    const current = await tx.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } });
    if (current.status === "closed") {
      throw new SettingsError(`第 ${current.no} 期は決算済みのため、締めは変えられません`);
    }
    const period = toFiscalYearContext(current);
    const next = data.lockedThrough;
    if (next !== null && !isCloseDate(next, period)) throw invalidDate(current.no, period);
    const range = closeRange(period, next);
    const result = { fiscalYearId: current.id, no: current.no, lockedThrough: next, range };
    if (!range) return { ...result, lockedThrough: period.lockedThrough, affectedCount: 0 };
    if (range.direction === "reopen" && !data.reason) {
      throw new SettingsError("締めを戻す理由を入力してください", { field: "reason" });
    }
    const affectedCount = await countEntriesBetween(tx, current.id, range.from, range.to);
    const row = await tx.fiscalYear.update({
      where: { id: current.id },
      data: { lockedThrough: next ? toDbDate(next) : null },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: range.direction === "close" ? "fiscal_year.close" : "fiscal_year.reopen",
      entity: "fiscal_year",
      entityId: current.id,
      before: { lockedThrough: period.lockedThrough },
      after: { lockedThrough: fromDbDateOrNull(row.lockedThrough) },
      reason: data.reason,
    });
    return { ...result, affectedCount };
  });
}
