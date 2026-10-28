/**
 * 締め (11-transactions §1, §7): `FiscalYear.lockedThrough` moves forward to a month end (or the
 * year's last day), or back — to an earlier month end or to 「締めない」 — with a reason. Entries on
 * or before it can no longer be posted, voided or corrected (the ledger rejects them with
 * PERIOD_LOCKED); voids and corrections of such entries are dated on the first open day instead.
 *
 * 決算 (16-year-end §1): the year's status moves open → closing (決算整理を始める) → closed (締める,
 * with the closing entry), and back with a reason (決算整理をやめる / 締めを戻す).
 */
import {
  addDays,
  buildClosingEntry,
  CORPORATE_SEGMENT_CODE,
  dateParts,
  displayDate,
  findTemplateAccount,
  firstOpenDate,
  isLastDayOfMonth,
  isLocked,
  lastDayOfMonth,
  LedgerValidationError,
  RETAINED_EARNINGS_CODE,
  type AccountGroup,
  type AccountKind,
  type CalendarDate,
  type ClosingRow,
  type FiscalYearContext,
  type FiscalYearStatus,
  type Money,
} from "@niho-finance/ledger";
import type { FiscalYear } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, todayInJapan, toDbDate } from "./dates";
import { SettingsError } from "./errors";
import {
  JournalEntryNotFoundError,
  postJournalEntryInTransaction,
  voidJournalEntryInTransaction,
  type ActorOptions,
  type VoidJournalEntryResult,
} from "./journal";
import { toFiscalYearContext } from "./queries";
import {
  closeFiscalYearSchema,
  yearEndTransitionSchema,
  type CloseFiscalYearInput,
  type YearEndTransitionInput,
} from "./schemas";
import { runInTransaction, type Tx } from "./transaction";

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

/** The monthly close of a year in its year-end adjustments or closed cannot change (16 §1.1). */
function assertCloseChangeable(row: Pick<FiscalYear, "no" | "status">): void {
  if (row.status === "closed") {
    throw new SettingsError(`第 ${row.no} 期は決算済みのため、締めは変えられません`);
  }
  if (row.status === "closing") {
    throw new SettingsError(
      `第 ${row.no} 期は決算整理中のため、締め日は変えられません。決算 の画面で決算整理をやめると変えられます`,
    );
  }
}

/** What a change of the close would affect (the sheet shows it before the confirmation). Read only. */
export async function previewFiscalYearClose(
  db: Db,
  fiscalYearId: string,
  lockedThrough: CalendarDate | null,
): Promise<ClosePreview> {
  const row = await db.fiscalYear.findUnique({ where: { id: fiscalYearId } });
  if (!row) throw notFound();
  assertCloseChangeable(row);
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
    assertCloseChangeable(current);
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

// ---------------------------------------------------------------------------
// 決算: shared helpers of the year-end writes (16-year-end §1, §11)
// ---------------------------------------------------------------------------

/** An account a year-end entry posts to. */
export interface YearEndAccount {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  group: AccountGroup;
  defaultSegmentId: string | null;
}

/**
 * The account with a standard code (02 §2). A missing or inactive one is an owner-facing error: the
 * year-end entries cannot be posted without it.
 */
export async function requireAccountByCode(db: Db, code: string): Promise<YearEndAccount> {
  const row = await db.account.findUnique({
    where: { code },
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      group: true,
      defaultSegmentId: true,
      isActive: true,
    },
  });
  const name = row?.name ?? findTemplateAccount(code)?.name ?? "";
  if (!row) {
    throw new SettingsError(
      `勘定科目 ${code} ${name} がありません。設定 › 勘定科目 で確かめてください`,
    );
  }
  if (!row.isActive) {
    throw new SettingsError(
      `勘定科目 ${code} ${name} は無効です。設定 › 勘定科目 で確かめてください`,
    );
  }
  const { isActive: _isActive, ...account } = row;
  return account;
}

/** The segment of the company as a whole (共通), the default of the year-end lines. */
export async function corporateSegmentId(db: Db): Promise<string> {
  const row = await db.segment.findUnique({
    where: { code: CORPORATE_SEGMENT_CODE },
    select: { id: true },
  });
  if (!row) {
    throw new SettingsError("セグメント「共通」がありません。設定 › セグメント で確かめてください");
  }
  return row.id;
}

/** 第 n−1 期 and 第 n+1 期 of the same company, when they exist. */
export async function neighborYears(
  db: Db,
  year: Pick<FiscalYear, "companyId" | "no">,
): Promise<{ previous: FiscalYear | null; next: FiscalYear | null }> {
  const rows = await db.fiscalYear.findMany({
    where: { companyId: year.companyId, no: { in: [year.no - 1, year.no + 1] } },
  });
  return {
    previous: rows.find((row) => row.no === year.no - 1) ?? null,
    next: rows.find((row) => row.no === year.no + 1) ?? null,
  };
}

/**
 * Locks fiscal year rows until the transaction ends, in ascending `no` (the order every year-end
 * write takes them, so two writes never wait on each other crosswise). Locks taken before are kept.
 */
export async function lockFiscalYears(
  tx: Tx,
  ids: readonly (string | null | undefined)[],
): Promise<void> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const rows = await tx.fiscalYear.findMany({
    where: { id: { in: wanted } },
    select: { id: true },
    orderBy: { no: "asc" },
  });
  for (const row of rows) {
    await tx.$queryRaw`SELECT "id" FROM "fiscal_year" WHERE "id" = ${row.id} FOR UPDATE`;
  }
}

/**
 * The closing entries of a fiscal year and the reversals that voided them (ids, never null, so that
 * `notIn` filters stay exact; a `NOT` over a nullable column would drop rows holding NULL).
 */
export async function closingEntryIds(db: Db, fiscalYearId: string): Promise<string[]> {
  const closing = await db.journalEntry.findMany({
    where: { fiscalYearId, kind: "closing" },
    select: { id: true },
  });
  if (closing.length === 0) return [];
  const ids = closing.map((entry) => entry.id);
  const reversals = await db.journalEntry.findMany({
    where: { reversalOfId: { in: ids } },
    select: { id: true },
  });
  return [...ids, ...reversals.map((entry) => entry.id)];
}

export interface ProfitAndLossRow extends ClosingRow {
  code: string;
  name: string;
  group: AccountGroup;
  isActive: boolean;
}

/**
 * debit − credit of each revenue, expense and internal account × segment over the entries of the
 * fiscal year, voided ones and reversals included (they cancel out). `excludeClosing` leaves out the
 * closing entries and their reversals: the year's P&L before 決算振替.
 */
export async function profitAndLossRows(
  db: Db,
  fiscalYearId: string,
  options: { excludeClosing?: boolean } = {},
): Promise<ProfitAndLossRow[]> {
  const accounts = await db.account.findMany({
    where: { kind: { in: ["revenue", "expense", "internal"] } },
    select: { id: true, code: true, name: true, kind: true, group: true, isActive: true },
  });
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const excluded = options.excludeClosing ? await closingEntryIds(db, fiscalYearId) : [];
  const groups = await db.journalLine.groupBy({
    by: ["accountId", "segmentId", "side"],
    where: {
      accountId: { in: [...byId.keys()] },
      journalEntry: {
        fiscalYearId,
        ...(excluded.length > 0 ? { id: { notIn: excluded } } : {}),
      },
    },
    _sum: { amount: true },
  });
  const rows = new Map<string, ProfitAndLossRow>();
  for (const group of groups) {
    const account = byId.get(group.accountId);
    if (!account) continue;
    const key = `${group.accountId}\u0000${group.segmentId ?? ""}`;
    const row = rows.get(key) ?? {
      accountId: account.id,
      kind: account.kind,
      segmentId: group.segmentId,
      net: 0n,
      code: account.code,
      name: account.name,
      group: account.group,
      isActive: account.isActive,
    };
    const amount = group._sum.amount ?? 0n;
    row.net += group.side === "debit" ? amount : -amount;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) =>
    a.code === b.code
      ? (a.segmentId ?? "").localeCompare(b.segmentId ?? "")
      : a.code.localeCompare(b.code),
  );
}

/** revenue − expenses of P&L rows (internal rows net to 0 and are left out). */
export function netIncomeOf(rows: readonly ClosingRow[]): Money {
  let net = 0n;
  for (const row of rows) if (row.kind === "revenue" || row.kind === "expense") net -= row.net;
  return net;
}

// ---------------------------------------------------------------------------
// 決算: 期の状態の遷移 (16-year-end §1.1)
// ---------------------------------------------------------------------------

export interface YearEndTransitionResult {
  fiscalYearId: string;
  /** 第 n 期 */
  no: number;
  status: FiscalYearStatus;
  lockedThrough: CalendarDate | null;
  /** `closeYear`: the closing entry posted (`null` when the year had no P&L). */
  closingEntry: { id: string; no: number } | null;
  /** `closeYear`: 当期純利益 carried to 繰越利益剰余金. */
  netIncome: Money | null;
}

export type YearEndTransitionOptions = ActorOptions & {
  /** Today in Japan; defaults to `todayInJapan()`. */
  today?: CalendarDate;
};

/**
 * Where the monthly close goes when the year-end adjustments start (§1.1, the decision record
 * 2026-10-28-year-end-closing-flow): a close on the last day moves back to the latest month end
 * before it inside the year (or 締めない), so that the adjusting entries dated on the last day fit.
 */
export function lockedThroughAfterStart(period: ClosePeriod): CalendarDate | null {
  if (period.lockedThrough !== period.endDate) return period.lockedThrough;
  const { year, month } = dateParts(period.endDate);
  const previous = month === 1 ? lastDayOfMonth(year - 1, 12) : lastDayOfMonth(year, month - 1);
  return previous >= period.startDate ? previous : null;
}

export interface YearEndStartCheck {
  canStart: boolean;
  /** Why it cannot start (owner-facing), `null` when it can. */
  reason: string | null;
  /** The monthly close after the start. */
  lockedThroughAfterStart: CalendarDate | null;
}

/** 決算整理を始める: the year is open, today is after its last day, and the previous year is closed. */
export function checkYearEndStart(
  year: Pick<FiscalYear, "no" | "status"> & ClosePeriod,
  previous: Pick<FiscalYear, "no" | "status"> | null,
  today: CalendarDate,
): YearEndStartCheck {
  const after = lockedThroughAfterStart(year);
  const blocked = (reason: string): YearEndStartCheck => ({
    canStart: false,
    reason,
    lockedThroughAfterStart: after,
  });
  if (year.status === "closing") return blocked(`第 ${year.no} 期は決算整理中です`);
  if (year.status === "closed") return blocked(`第 ${year.no} 期は締め済みです`);
  if (today <= year.endDate) {
    return blocked(
      `期末は ${displayDate(year.endDate)} です。決算整理は ${displayDate(addDays(year.endDate, 1))} から始められます`,
    );
  }
  if (previous && previous.status !== "closed") {
    return blocked(`第 ${previous.no} 期を締めてから始めます`);
  }
  return { canStart: true, reason: null, lockedThroughAfterStart: after };
}

async function findYear(db: Db, fiscalYearId: string): Promise<FiscalYear> {
  const row = await db.fiscalYear.findUnique({ where: { id: fiscalYearId } });
  if (!row) throw notFound();
  return row;
}

async function reloadYear(db: Db, year: FiscalYear | null): Promise<FiscalYear | null> {
  return year ? db.fiscalYear.findUniqueOrThrow({ where: { id: year.id } }) : null;
}

function requireReason(reason: string | null, message: string): string {
  if (!reason) throw new SettingsError(message, { field: "reason" });
  return reason;
}

function transitionResult(
  year: FiscalYear,
  status: FiscalYearStatus,
  lockedThrough: CalendarDate | null,
  closing: { entry: { id: string; no: number } | null; netIncome: Money | null } = {
    entry: null,
    netIncome: null,
  },
): YearEndTransitionResult {
  return {
    fiscalYearId: year.id,
    no: year.no,
    status,
    lockedThrough,
    closingEntry: closing.entry,
    netIncome: closing.netIncome,
  };
}

/**
 * 決算整理を始める (open → closing, §1.1). From then on the year takes only adjusting and closing
 * entries. A monthly close on the last day moves back (`lockedThroughAfterStart`). The reason is
 * optional. Audit: `fiscal_year.start_adjusting` with `status` and `lockedThrough`.
 */
export async function startYearEnd(
  db: Db,
  fiscalYearId: string,
  input: YearEndTransitionInput,
  options: YearEndTransitionOptions,
): Promise<YearEndTransitionResult> {
  const data = yearEndTransitionSchema.parse(input);
  const today = options.today ?? todayInJapan();
  return runInTransaction(db, async (tx) => {
    const found = await findYear(tx, fiscalYearId);
    const neighbors = await neighborYears(tx, found);
    await lockFiscalYears(tx, [neighbors.previous?.id, found.id]);
    const year = await tx.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } });
    const previous = await reloadYear(tx, neighbors.previous);
    const period = toFiscalYearContext(year);
    const check = checkYearEndStart(
      { ...period, no: year.no, status: year.status },
      previous,
      today,
    );
    if (!check.canStart) throw new SettingsError(check.reason ?? "決算整理を始められません");
    const lockedThrough = check.lockedThroughAfterStart;
    await tx.fiscalYear.update({
      where: { id: year.id },
      data: { status: "closing", lockedThrough: lockedThrough ? toDbDate(lockedThrough) : null },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "fiscal_year.start_adjusting",
      entity: "fiscal_year",
      entityId: year.id,
      before: { status: year.status, lockedThrough: period.lockedThrough },
      after: { status: "closing", lockedThrough },
      reason: data.reason,
    });
    return transitionResult(year, "closing", lockedThrough);
  });
}

/**
 * 決算整理をやめる (closing → open, §1.1). The adjusting entries stay; the monthly close is not
 * moved forward again. The reason is required. Audit: `fiscal_year.cancel_adjusting`.
 */
export async function cancelYearEnd(
  db: Db,
  fiscalYearId: string,
  input: YearEndTransitionInput,
  options: ActorOptions,
): Promise<YearEndTransitionResult> {
  const data = yearEndTransitionSchema.parse(input);
  const reason = requireReason(data.reason, "決算整理をやめる理由を入力してください");
  return runInTransaction(db, async (tx) => {
    await findYear(tx, fiscalYearId);
    await lockFiscalYears(tx, [fiscalYearId]);
    const year = await tx.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } });
    if (year.status !== "closing") {
      throw new SettingsError(`第 ${year.no} 期は決算整理中ではありません`);
    }
    const lockedThrough = fromDbDateOrNull(year.lockedThrough);
    await tx.fiscalYear.update({ where: { id: year.id }, data: { status: "open" } });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "fiscal_year.cancel_adjusting",
      entity: "fiscal_year",
      entityId: year.id,
      before: { status: "closing", lockedThrough },
      after: { status: "open", lockedThrough },
      reason,
    });
    return transitionResult(year, "open", lockedThrough);
  });
}

/**
 * 締める (closing → closed, §1.1, §10): posts the closing entry (`buildClosingEntry` over the year's
 * P&L and internal accounts × segments, every entry of the year included) and closes the year. The
 * previous year must be closed. Audit: `fiscal_year.close_year` with `closingEntryId` and `netIncome`.
 */
export async function closeYear(
  db: Db,
  fiscalYearId: string,
  input: YearEndTransitionInput,
  options: ActorOptions,
): Promise<YearEndTransitionResult> {
  const data = yearEndTransitionSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const found = await findYear(tx, fiscalYearId);
    const neighbors = await neighborYears(tx, found);
    await lockFiscalYears(tx, [neighbors.previous?.id, found.id]);
    const year = await tx.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } });
    const previous = await reloadYear(tx, neighbors.previous);
    if (year.status === "open") {
      throw new SettingsError(`第 ${year.no} 期は決算整理を始めてから締めます`);
    }
    if (year.status === "closed") throw new SettingsError(`第 ${year.no} 期は締め済みです`);
    if (previous && previous.status !== "closed") {
      throw new SettingsError(`第 ${previous.no} 期を締めてから締めます`);
    }
    const existing = await tx.journalEntry.count({
      where: { fiscalYearId: year.id, kind: "closing", status: "posted" },
    });
    if (existing > 0) {
      throw new SettingsError(
        `第 ${year.no} 期の決算振替は登録済みです。取り消してから締め直してください`,
      );
    }

    const rows = await profitAndLossRows(tx, year.id);
    const inactive = rows.find((row) => row.net !== 0n && !row.isActive);
    if (inactive) {
      throw new SettingsError(
        `勘定科目 ${inactive.code} ${inactive.name} は無効ですが、第 ${year.no} 期に残高があります。決算振替のために 設定 › 勘定科目 で有効にしてください`,
      );
    }
    const retained = await requireAccountByCode(tx, RETAINED_EARNINGS_CODE);
    const period = toFiscalYearContext(year);
    const { entry, netIncome } = buildClosingEntry({
      date: period.endDate,
      fiscalYearId: year.id,
      fiscalYearNo: year.no,
      rows,
      retainedEarningsAccountId: retained.id,
    });
    const posted = entry
      ? await postJournalEntryInTransaction(
          tx,
          { ...entry, fiscalYearId: year.id },
          { actor: options.actor },
        )
      : null;
    await tx.fiscalYear.update({ where: { id: year.id }, data: { status: "closed" } });
    const closingEntry = posted ? { id: posted.id, no: posted.no } : null;
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "fiscal_year.close_year",
      entity: "fiscal_year",
      entityId: year.id,
      before: { status: "closing", lockedThrough: period.lockedThrough },
      after: {
        status: "closed",
        lockedThrough: period.lockedThrough,
        closingEntryId: closingEntry?.id ?? null,
        netIncome,
      },
      reason: data.reason,
    });
    return transitionResult(year, "closed", period.lockedThrough, {
      entry: closingEntry,
      netIncome,
    });
  });
}

/**
 * 締めを戻す (closed → closing, §1.1): voids the closing entry (a reversal, `voidEntryInYearEnd`)
 * and puts the year back in its year-end adjustments. The reason is required and the next year must
 * not be closed. Audit: `fiscal_year.reopen_year` with `voidedClosingEntryId`.
 */
export async function reopenYear(
  db: Db,
  fiscalYearId: string,
  input: YearEndTransitionInput,
  options: ActorOptions,
): Promise<YearEndTransitionResult> {
  const data = yearEndTransitionSchema.parse(input);
  const reason = requireReason(data.reason, "締めを戻す理由を入力してください");
  return runInTransaction(db, async (tx) => {
    const found = await findYear(tx, fiscalYearId);
    const closingEntries = await tx.journalEntry.findMany({
      where: { fiscalYearId, kind: "closing", status: "posted" },
      select: { id: true, no: true },
      orderBy: { no: "asc" },
    });
    // Entry rows first, then the years in ascending `no` (the order of every void).
    for (const entry of closingEntries) {
      await tx.$queryRaw`SELECT "id" FROM "journal_entry" WHERE "id" = ${entry.id} FOR UPDATE`;
    }
    const neighbors = await neighborYears(tx, found);
    await lockFiscalYears(tx, [found.id, neighbors.next?.id]);
    const year = await tx.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } });
    const next = await reloadYear(tx, neighbors.next);
    if (year.status !== "closed")
      throw new SettingsError(`第 ${year.no} 期は締め済みではありません`);
    if (next && next.status === "closed") {
      throw new SettingsError(
        `第 ${next.no} 期が締め済みのため、第 ${year.no} 期の締めは戻せません。先に第 ${next.no} 期の締めを戻してください`,
      );
    }
    let voided: { id: string; no: number } | null = null;
    for (const entry of closingEntries) {
      const current = await tx.journalEntry.findUniqueOrThrow({
        where: { id: entry.id },
        select: { status: true },
      });
      if (current.status !== "posted") continue;
      await voidEntryInYearEnd(tx, entry.id, { reason, actor: options.actor });
      voided = entry;
    }
    const lockedThrough = fromDbDateOrNull(year.lockedThrough);
    await tx.fiscalYear.update({ where: { id: year.id }, data: { status: "closing" } });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "fiscal_year.reopen_year",
      entity: "fiscal_year",
      entityId: year.id,
      before: { status: "closed", lockedThrough },
      after: { status: "closing", lockedThrough, voidedClosingEntryId: voided?.id ?? null },
      reason,
    });
    return transitionResult(year, "closing", lockedThrough, { entry: voided, netIncome: null });
  });
}

/**
 * Voids an adjusting or closing entry of a year in its year-end adjustments or closed (§1.2).
 *
 * The ledger (`validateEntry`) takes only adjusting and closing entries in a `closing` year and
 * nothing in a `closed` one, so a reversal there is rejected. Until the ledger allows the reversal of
 * adjusting and closing entries in such a year (Issue #4), the year is treated as open inside this
 * transaction: the entry row and then the year row are locked, the status is set to `open`, the
 * reversal is posted by `voidJournalEntryInTransaction` (dated on the entry's date, or the first open
 * date when the monthly close covers it) and the status is restored before returning. Other
 * transactions never see the open state (the row stays locked; an error rolls everything back).
 * See docs/decisions/2026-10-28-year-end-closing-flow.md. The caller decides which entries and years
 * qualify (`voidYearEndEntry`: adjusting entries of a closing year; `reopenYear`: the closing entry).
 */
export async function voidEntryInYearEnd(
  tx: Tx,
  entryId: string,
  options: { reason: string; actor: string },
): Promise<VoidJournalEntryResult> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "journal_entry" WHERE "id" = ${entryId} FOR UPDATE`;
  if (locked.length === 0) throw new JournalEntryNotFoundError(entryId);
  const entry = await tx.journalEntry.findUniqueOrThrow({
    where: { id: entryId },
    select: { fiscalYearId: true, entryDate: true },
  });
  await tx.$queryRaw`SELECT "id" FROM "fiscal_year" WHERE "id" = ${entry.fiscalYearId} FOR UPDATE`;
  const year = await tx.fiscalYear.findUniqueOrThrow({ where: { id: entry.fiscalYearId } });
  if (year.status === "open") {
    throw new Error(
      `voidEntryInYearEnd: 第 ${year.no} 期 is open; void with voidJournalEntryWithOpenDate`,
    );
  }
  const period: FiscalYearContext = { ...toFiscalYearContext(year), status: "open" };
  const entryDate = fromDbDate(entry.entryDate);
  const date = isLocked(entryDate, period) ? firstOpenDate(period) : entryDate;
  if (!date) {
    throw new LedgerValidationError([
      {
        code: "PERIOD_LOCKED",
        message: `第 ${year.no} 期は ${displayDate(period.lockedThrough ?? period.endDate)} まですべて締めているため、取り消せません`,
      },
    ]);
  }
  await tx.fiscalYear.update({ where: { id: year.id }, data: { status: "open" } });
  const result = await voidJournalEntryInTransaction(tx, entryId, {
    reason: options.reason,
    actor: options.actor,
    date,
  });
  await tx.fiscalYear.update({ where: { id: year.id }, data: { status: year.status } });
  return result;
}
