/**
 * 固定資産台帳 (docs/design/16-year-end.md §5, §12): registration (from an acquisition entry, or
 * together with a 支出), editing while nothing is posted, the logical delete, disposal and sale, the
 * schedule and the ledger for the statements (#15). The schedule is always computed
 * (`planDepreciation` over the fiscal years and what was posted); `FixedAsset.schedule` keeps a copy.
 */
import {
  addDays,
  buildDisposalEntry,
  checkDepreciationChoice,
  DEPRECIATION_EXPENSE_CODE,
  ACCUMULATED_DEPRECIATION_CODE,
  displayDate,
  formatYen,
  isDepreciableAccount,
  isDepreciableAssetTaxed,
  isLocked,
  isSpecialSmallAsset,
  MAX_USEFUL_LIFE,
  MIN_USEFUL_LIFE,
  MISC_INCOME_CODE,
  MISC_LOSS_CODE,
  OUTPUT_TAX_ACCOUNT_CODE,
  planDepreciation,
  SMALL_ASSET_LIMIT,
  specialSmallAssetCap,
  splitTaxInclusive,
  type AccountingMethod,
  type CalendarDate,
  type DepreciationMethod,
  type DepreciationPeriodInput,
  type DepreciationProblem,
  type DepreciationRow,
  type EntryKind,
  type EntryStatus,
  type FiscalYearStatus,
  type Money,
  type TaxRateRule,
} from "@niho-finance/ledger";
import {
  buildDepreciableAssetsReturn,
  classifyDepreciableAsset,
  defaultDepreciableAssetsReturnYear,
  effectivePropertyTaxAssetType,
  type DepreciableAssetClassification,
  type DepreciableAssetsReturn,
  type PropertyTaxAssetType,
} from "@niho-finance/reports";
import type { FixedAsset, Prisma } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import {
  corporateSegmentId,
  lockFiscalYears,
  requireAccountByCode,
  type YearEndAccount,
} from "./closing";
import { fromDbDate, fromDbDateOrNull, todayInJapan, toDbDate } from "./dates";
import { postSimpleEntry, type EntryRef } from "./entries";
import { SettingsError } from "./errors";
import { newId } from "./ids";
import { postJournalEntryInTransaction, type ActorOptions } from "./journal";
import { loadCurrentFiscalYear } from "./queries";
import {
  fixedAssetDisposeSchema,
  fixedAssetRegisterSchema,
  fixedAssetUpdateSchema,
  fixedAssetVoidSchema,
  propertyTaxMunicipalitySchema,
  type FixedAssetDisposeInput,
  type FixedAssetRegisterInput,
  type FixedAssetUpdateInput,
  type FixedAssetVoidInput,
  type PropertyTaxMunicipalityInput,
} from "./schemas";
import { requireCompanyRow } from "./settings";
import { lockSettings, runInTransaction, type Tx } from "./transaction";

// ---------------------------------------------------------------------------
// Fiscal years and what was posted
// ---------------------------------------------------------------------------

/** A fiscal year as the schedule needs it. */
export interface ScheduleYear {
  id: string;
  no: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
  status: FiscalYearStatus;
  lockedThrough: CalendarDate | null;
  accountingMethod: AccountingMethod;
}

/** Every fiscal year, in date order. */
export async function loadScheduleYears(db: Db): Promise<ScheduleYear[]> {
  const rows = await db.fiscalYear.findMany({ orderBy: [{ startDate: "asc" }, { no: "asc" }] });
  return rows.map((row) => ({
    id: row.id,
    no: row.no,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
    status: row.status,
    lockedThrough: fromDbDateOrNull(row.lockedThrough),
    accountingMethod: row.accountingMethod,
  }));
}

function yearContaining<T extends { startDate: CalendarDate; endDate: CalendarDate }>(
  years: readonly T[],
  date: CalendarDate,
): T | undefined {
  return years.find((year) => year.startDate <= date && date <= year.endDate);
}

/**
 * The fiscal years an asset's schedule runs over: from the one containing the acquisition, as long as
 * the next one follows on the next day (the test books and a gap in the years stop the chain; the
 * schedule then projects 12-month years).
 */
function scheduleChain(years: readonly ScheduleYear[], acquisitionDate: CalendarDate) {
  const chain: ScheduleYear[] = [];
  const first = yearContaining(years, acquisitionDate);
  if (!first) return chain;
  chain.push(first);
  for (;;) {
    const last = chain[chain.length - 1];
    if (!last) break;
    const next = years.find((year) => year.startDate === addDays(last.endDate, 1));
    if (!next) break;
    chain.push(next);
  }
  return chain;
}

/** The depreciation of one asset in one fiscal year. */
export interface YearPostings {
  /** Σ(debit − credit) on 減価償却費 over the asset's entries of the year (reversals included). */
  net: Money;
  /** The depreciation entries in force (posted, not voided). */
  live: EntryRef[];
}

/** assetId → fiscalYearId → postings. */
export type DepreciationPostings = Map<string, Map<string, YearPostings>>;

/**
 * The depreciation posted for assets (§4.2: 台帳の実績): the lines on 減価償却費 (5460) of the entries
 * with `sourceKind = fixed_asset` and `sourceId` = the asset, grouped by fiscal year.
 */
export async function loadDepreciationPostings(
  db: Db,
  assetIds?: readonly string[],
): Promise<DepreciationPostings> {
  const result: DepreciationPostings = new Map();
  const expense = await db.account.findUnique({
    where: { code: DEPRECIATION_EXPENSE_CODE },
    select: { id: true },
  });
  if (!expense) return result;
  const lines = await db.journalLine.findMany({
    where: {
      accountId: expense.id,
      journalEntry: {
        sourceKind: "fixed_asset",
        ...(assetIds ? { sourceId: { in: [...assetIds] } } : { sourceId: { not: null } }),
      },
    },
    select: {
      side: true,
      amount: true,
      journalEntry: {
        select: {
          id: true,
          no: true,
          entryDate: true,
          fiscalYearId: true,
          sourceId: true,
          kind: true,
          status: true,
        },
      },
    },
  });
  for (const line of lines) {
    const entry = line.journalEntry;
    if (!entry.sourceId) continue;
    const byYear = result.get(entry.sourceId) ?? new Map<string, YearPostings>();
    const year = byYear.get(entry.fiscalYearId) ?? { net: 0n, live: [] };
    year.net += line.side === "debit" ? line.amount : -line.amount;
    if (
      entry.kind === "adjusting" &&
      entry.status === "posted" &&
      !year.live.some((ref) => ref.id === entry.id)
    ) {
      year.live.push({ id: entry.id, no: entry.no, entryDate: fromDbDate(entry.entryDate) });
    }
    byYear.set(entry.fiscalYearId, year);
    result.set(entry.sourceId, byYear);
  }
  return result;
}

export type ScheduleRowState = "posted" | "unposted" | "none" | "projected";

export interface FixedAssetScheduleRow extends DepreciationRow {
  /** `null` for a projected 12-month year. */
  fiscalYearId: string | null;
  fiscalYearNo: number | null;
  fiscalYearStatus: FiscalYearStatus | null;
  /** The depreciation entries in force of the year. */
  entries: EntryRef[];
  /** 計上済み / 未計上 / なし (0, or a closed year without an entry) / 予定 (projected). */
  state: ScheduleRowState;
}

export interface SchedulableAsset {
  id: string;
  method: DepreciationMethod;
  cost: Money;
  acquisitionDate: CalendarDate;
  usefulLifeYears: number | null;
  /** The disposal in force (`null` when not disposed or when the disposal entry was voided). */
  disposedOn: CalendarDate | null;
}

/**
 * The schedule of an asset over the fiscal years: the amount of each year from what was actually
 * posted (a closed year without an entry counts as 0; a year in progress without an entry is planned)
 * and, with `project`, 12-month years until the book value reaches its floor.
 */
export function assetSchedule(
  asset: SchedulableAsset,
  years: readonly ScheduleYear[],
  postings: DepreciationPostings,
  options: { project?: boolean } = {},
): FixedAssetScheduleRow[] {
  const chain = scheduleChain(years, asset.acquisitionDate);
  if (chain.length === 0) return [];
  const byYear = postings.get(asset.id) ?? new Map<string, YearPostings>();
  const periods: DepreciationPeriodInput[] = chain.map((year) => {
    const posted = byYear.get(year.id);
    const actual =
      posted && (posted.live.length > 0 || year.status === "closed")
        ? posted.net
        : year.status === "closed"
          ? 0n
          : null;
    return { startDate: year.startDate, endDate: year.endDate, posted: actual };
  });
  const rows = planDepreciation(
    {
      method: asset.method,
      cost: asset.cost,
      acquisitionDate: asset.acquisitionDate,
      usefulLifeYears: asset.usefulLifeYears,
      disposedOn: asset.disposedOn,
    },
    periods,
    { project: options.project === true },
  );
  return rows.map((row) => {
    const year = row.projected
      ? undefined
      : chain.find((candidate) => candidate.startDate === row.startDate);
    const entries = year ? (byYear.get(year.id)?.live ?? []) : [];
    let state: ScheduleRowState;
    if (row.projected) state = "projected";
    else if (entries.length > 0) state = "posted";
    else if (row.amount === 0n || year?.status === "closed") state = "none";
    else state = "unposted";
    return {
      ...row,
      fiscalYearId: year?.id ?? null,
      fiscalYearNo: year?.no ?? null,
      fiscalYearStatus: year?.status ?? null,
      entries,
      state,
    };
  });
}

/** The copy kept on `FixedAsset.schedule` (#15 reads it; the computed schedule is the truth). */
function scheduleSnapshot(rows: readonly DepreciationRow[]): Prisma.InputJsonValue {
  return rows.map((row) => ({
    startDate: row.startDate,
    endDate: row.endDate,
    opening: row.opening.toString(),
    amount: row.amount.toString(),
    closing: row.closing.toString(),
  }));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type FixedAssetStatus = "active" | "disposed" | "sold" | "voided";

export const FIXED_ASSET_STATUS_LABELS: Readonly<Record<FixedAssetStatus, string>> = {
  active: "使用中",
  disposed: "除却済み",
  sold: "売却済み",
  voided: "取消",
};

const assetInclude = {
  account: { select: { code: true, name: true } },
  segment: { select: { name: true } },
  acquisitionEntry: { select: { id: true, no: true, entryDate: true, status: true } },
  disposalEntry: {
    select: {
      id: true,
      no: true,
      entryDate: true,
      status: true,
      lines: { where: { taxCategoryCode: "sales_10" }, select: { id: true } },
    },
  },
} as const;

type AssetWithRelations = Prisma.FixedAssetGetPayload<{ include: typeof assetInclude }>;

/** A disposal is in force unless its entry was voided (then the asset is in use again). */
function disposalInForce(asset: AssetWithRelations): CalendarDate | null {
  if (!asset.disposedAt) return null;
  if (asset.disposalEntry && asset.disposalEntry.status !== "posted") return null;
  return fromDbDate(asset.disposedAt);
}

function statusOf(asset: AssetWithRelations): FixedAssetStatus {
  if (asset.voidedAt) return "voided";
  if (!disposalInForce(asset)) return "active";
  return asset.disposalEntry && asset.disposalEntry.lines.length > 0 ? "sold" : "disposed";
}

function schedulable(asset: AssetWithRelations | FixedAsset, disposedOn: CalendarDate | null) {
  return {
    id: asset.id,
    method: asset.method,
    cost: asset.cost,
    acquisitionDate: fromDbDate(asset.acquisitionDate),
    usefulLifeYears: asset.usefulLifeYears,
    disposedOn,
  } satisfies SchedulableAsset;
}

function refOf(row: { id: string; no: number; entryDate: Date }): EntryRef {
  return { id: row.id, no: row.no, entryDate: fromDbDate(row.entryDate) };
}

export interface FixedAssetListRow {
  id: string;
  name: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  acquisitionDate: CalendarDate;
  cost: Money;
  method: DepreciationMethod;
  usefulLifeYears: number | null;
  segmentId: string | null;
  segmentName: string | null;
  status: FixedAssetStatus;
  disposedAt: CalendarDate | null;
  /** 当期末の帳簿価額 (the fiscal year containing today); `null` for a voided registration. */
  bookValue: Money | null;
  voidedAt: Date | null;
  voidReason: string | null;
}

/** The book value at the end of the fiscal year ending on `endDate`, from the schedule. */
function bookValueAt(
  asset: SchedulableAsset,
  rows: readonly DepreciationRow[],
  endDate: CalendarDate | null,
): Money {
  if (endDate === null) return rows.at(-1)?.closing ?? asset.cost;
  if (asset.acquisitionDate > endDate) return asset.cost;
  if (asset.method !== "lump_sum_3y" && asset.disposedOn && asset.disposedOn <= endDate) return 0n;
  let value = asset.cost;
  for (const row of rows) if (row.endDate <= endDate) value = row.closing;
  return value;
}

function toListRow(
  asset: AssetWithRelations,
  years: readonly ScheduleYear[],
  postings: DepreciationPostings,
  asOfEnd: CalendarDate | null,
): FixedAssetListRow {
  const status = statusOf(asset);
  const disposedOn = disposalInForce(asset);
  const base = schedulable(asset, disposedOn);
  const rows = status === "voided" ? [] : assetSchedule(base, years, postings, { project: true });
  return {
    id: asset.id,
    name: asset.name,
    accountId: asset.accountId,
    accountCode: asset.account.code,
    accountName: asset.account.name,
    acquisitionDate: base.acquisitionDate,
    cost: asset.cost,
    method: asset.method,
    usefulLifeYears: asset.usefulLifeYears,
    segmentId: asset.segmentId,
    segmentName: asset.segment?.name ?? null,
    status,
    disposedAt: disposedOn,
    bookValue: status === "voided" ? null : bookValueAt(base, rows, asOfEnd),
    voidedAt: asset.voidedAt,
    voidReason: asset.voidReason,
  };
}

export interface FixedAssetList {
  rows: FixedAssetListRow[];
  /** Registrations voided (shown folded: 「取消 n 件を表示」). */
  voidedCount: number;
  /** The fiscal year whose end the book values are at. */
  fiscalYear: { id: string; no: number; endDate: CalendarDate } | null;
}

/** 固定資産台帳 (§5): newest acquisition first; voided registrations only with `includeVoided`. */
export async function listFixedAssets(
  db: Db,
  options: { includeVoided?: boolean; today?: CalendarDate } = {},
): Promise<FixedAssetList> {
  const today = options.today ?? todayInJapan();
  const assets = await db.fixedAsset.findMany({
    where: options.includeVoided ? {} : { voidedAt: null },
    include: assetInclude,
    orderBy: [{ acquisitionDate: "desc" }, { id: "desc" }],
  });
  const voidedCount = await db.fixedAsset.count({ where: { voidedAt: { not: null } } });
  const years = await loadScheduleYears(db);
  const postings = await loadDepreciationPostings(
    db,
    assets.map((asset) => asset.id),
  );
  const current = await loadCurrentFiscalYear(db, today);
  return {
    rows: assets.map((asset) => toListRow(asset, years, postings, current?.endDate ?? null)),
    voidedCount,
    fiscalYear: current ? { id: current.id, no: current.no, endDate: current.endDate } : null,
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface FixedAssetEntryRow extends EntryRef {
  kind: EntryKind;
  status: EntryStatus;
  description: string;
}

export interface FixedAssetHistoryRow {
  id: string;
  at: Date;
  actor: string;
  action: string;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string | null;
}

export interface FixedAssetDetail extends FixedAssetListRow {
  note: string | null;
  residualValue: Money;
  isDepreciableAssetTaxed: boolean;
  /** 中小企業者等の特例 (別表十六(七)). */
  isSpecialSmallAsset: boolean;
  acquisitionEntry: (EntryRef & { status: EntryStatus }) | null;
  disposalEntry: (EntryRef & { status: EntryStatus }) | null;
  schedule: FixedAssetScheduleRow[];
  /** 取得価額・取得日・科目・償却方法・耐用年数 can change (no depreciation or disposal in force). */
  canEditParameters: boolean;
  /** Why they cannot (owner-facing), `null` when they can. */
  editBlockedReason: string | null;
  canVoid: boolean;
  /** Why it cannot be disposed or sold, `null` when it can. */
  disposeBlockedReason: string | null;
  /** The depreciation and disposal entries (voided ones and reversals included), oldest first. */
  entries: FixedAssetEntryRow[];
  /** The audit log of the asset (`entity = fixed_asset`), oldest first. */
  history: FixedAssetHistoryRow[];
  /** 償却資産申告の資産の種類 as stored (1–6), `null` = from the account (16 §14.2). */
  propertyTaxAssetType: number | null;
  /** 申告の対象外の理由 as stored, `null` = by the rules (§14.1). */
  propertyTaxExcludedReason: string | null;
  /** 償却資産申告: reported or not (with the reason) and the kind used (§14.1–§14.2). */
  propertyTax: DepreciableAssetClassification & { assetType: PropertyTaxAssetType | null };
}

/** The locked parameters as words: the life of an 即時・一括 asset stays free (§14.5). */
function lockedParameters(method: DepreciationMethod): string {
  return isLifeBased(method)
    ? "取得価額・取得日・科目・償却方法・耐用年数"
    : "取得価額・取得日・科目・償却方法";
}

/** Why the parameters cannot change and the registration cannot be voided, or `null`. */
function parameterLock(
  asset: AssetWithRelations,
  liveDepreciation: number,
): { edit: string | null } {
  if (asset.voidedAt) return { edit: "登録を取り消した固定資産です" };
  const what = lockedParameters(asset.method);
  if (disposalInForce(asset)) {
    return { edit: `除却・売却済みのため、${what}は変えられません` };
  }
  if (liveDepreciation > 0) {
    return {
      edit: `償却の仕訳があるため、${what}は変えられません。償却の仕訳を取り消すと変えられます`,
    };
  }
  return { edit: null };
}

/** One asset with its schedule, its entries and its history; `null` when not found. */
export async function getFixedAssetDetail(
  db: Db,
  id: string,
  options: { today?: CalendarDate } = {},
): Promise<FixedAssetDetail | null> {
  const asset = await db.fixedAsset.findUnique({ where: { id }, include: assetInclude });
  if (!asset) return null;
  const today = options.today ?? todayInJapan();
  const years = await loadScheduleYears(db);
  const postings = await loadDepreciationPostings(db, [asset.id]);
  const current = await loadCurrentFiscalYear(db, today);
  const row = toListRow(asset, years, postings, current?.endDate ?? null);
  const schedule =
    row.status === "voided"
      ? []
      : assetSchedule(schedulable(asset, row.disposedAt), years, postings, { project: true });
  const liveDepreciation = [...(postings.get(asset.id)?.values() ?? [])].reduce(
    (count, year) => count + year.live.length,
    0,
  );
  const lock = parameterLock(asset, liveDepreciation);
  const entries = await db.journalEntry.findMany({
    where: { sourceKind: "fixed_asset", sourceId: asset.id },
    select: { id: true, no: true, entryDate: true, kind: true, status: true, description: true },
    orderBy: [{ entryDate: "asc" }, { postedAt: "asc" }],
  });
  const history = await db.auditLog.findMany({
    where: { entity: "fixed_asset", entityId: asset.id },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  return {
    ...row,
    note: asset.note,
    residualValue: asset.residualValue,
    isDepreciableAssetTaxed: asset.isDepreciableAssetTaxed,
    isSpecialSmallAsset: isSpecialSmallAsset(asset),
    acquisitionEntry: asset.acquisitionEntry
      ? { ...refOf(asset.acquisitionEntry), status: asset.acquisitionEntry.status }
      : null,
    disposalEntry: asset.disposalEntry
      ? { ...refOf(asset.disposalEntry), status: asset.disposalEntry.status }
      : null,
    schedule,
    canEditParameters: lock.edit === null,
    editBlockedReason: lock.edit,
    canVoid: lock.edit === null,
    disposeBlockedReason: asset.voidedAt
      ? "登録を取り消した固定資産は除却・売却できません"
      : row.disposedAt
        ? "除却・売却済みです"
        : null,
    entries: entries.map((entry) => ({
      ...refOf(entry),
      kind: entry.kind,
      status: entry.status,
      description: entry.description,
    })),
    history: history.map((item) => ({
      id: item.id,
      at: item.at,
      actor: item.actor,
      action: item.action,
      before: item.before,
      after: item.after,
      reason: item.reason,
    })),
    propertyTaxAssetType: asset.propertyTaxAssetType,
    propertyTaxExcludedReason: asset.propertyTaxExcludedReason,
    propertyTax: {
      ...classifyDepreciableAsset({ ...asset, accountCode: asset.account.code }),
      assetType: effectivePropertyTaxAssetType({ ...asset, accountCode: asset.account.code }),
    },
  };
}

// ---------------------------------------------------------------------------
// 取得の仕訳の候補 (§5.1)
// ---------------------------------------------------------------------------

export interface AcquisitionCandidate {
  entryId: string;
  entryNo: number;
  entryDate: CalendarDate;
  description: string;
  fiscalYearNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  /** The debit lines on the account in the entry. */
  amount: Money;
  /** Cost of the registrations (not voided) from this entry and account. */
  registered: Money;
  remaining: Money;
}

export const ACQUISITION_CANDIDATE_LIMIT = 200;

async function depreciableAccountIds(db: Db): Promise<Map<string, { code: string; name: string }>> {
  const accounts = await db.account.findMany({
    where: { group: "fixed_assets" },
    select: { id: true, code: true, name: true, group: true },
  });
  return new Map(
    accounts
      .filter((account) => isDepreciableAccount(account))
      .map((account) => [account.id, { code: account.code, name: account.name }]),
  );
}

/** What is registered from an entry on an account (not voided), optionally without one asset. */
async function registeredFrom(
  db: Db,
  entryId: string,
  accountId: string,
  excludeAssetId?: string,
): Promise<Money> {
  const sum = await db.fixedAsset.aggregate({
    where: {
      acquisitionEntryId: entryId,
      accountId,
      voidedAt: null,
      ...(excludeAssetId ? { id: { not: excludeAssetId } } : {}),
    },
    _sum: { cost: true },
  });
  return sum._sum.cost ?? 0n;
}

/**
 * The debit lines on depreciable accounts of posted entries (not voided, not reversals) that still
 * have an amount not registered in the ledger, per entry × account, newest first (at most 200).
 */
export async function listAcquisitionCandidates(db: Db): Promise<AcquisitionCandidate[]> {
  const accounts = await depreciableAccountIds(db);
  if (accounts.size === 0) return [];
  const lines = await db.journalLine.findMany({
    where: {
      side: "debit",
      accountId: { in: [...accounts.keys()] },
      journalEntry: { status: "posted", kind: { not: "reversal" } },
    },
    select: {
      accountId: true,
      amount: true,
      journalEntry: {
        select: {
          id: true,
          no: true,
          entryDate: true,
          description: true,
          postedAt: true,
          fiscalYear: { select: { no: true } },
        },
      },
    },
  });
  const groups = new Map<string, AcquisitionCandidate & { postedAt: Date }>();
  for (const line of lines) {
    const entry = line.journalEntry;
    const account = accounts.get(line.accountId);
    if (!account) continue;
    const key = `${entry.id}\u0000${line.accountId}`;
    const group = groups.get(key) ?? {
      entryId: entry.id,
      entryNo: entry.no,
      entryDate: fromDbDate(entry.entryDate),
      description: entry.description,
      fiscalYearNo: entry.fiscalYear.no,
      accountId: line.accountId,
      accountCode: account.code,
      accountName: account.name,
      amount: 0n,
      registered: 0n,
      remaining: 0n,
      postedAt: entry.postedAt,
    };
    group.amount += line.amount;
    groups.set(key, group);
  }
  const registered = await db.fixedAsset.groupBy({
    by: ["acquisitionEntryId", "accountId"],
    where: { voidedAt: null, acquisitionEntryId: { not: null } },
    _sum: { cost: true },
  });
  for (const row of registered) {
    const group = groups.get(`${row.acquisitionEntryId ?? ""}\u0000${row.accountId}`);
    if (group) group.registered = row._sum.cost ?? 0n;
  }
  return [...groups.values()]
    .map((group) => ({ ...group, remaining: group.amount - group.registered }))
    .filter((group) => group.remaining > 0n)
    .sort((a, b) =>
      a.entryDate === b.entryDate
        ? b.postedAt.getTime() - a.postedAt.getTime() || b.entryNo - a.entryNo
        : a.entryDate < b.entryDate
          ? 1
          : -1,
    )
    .slice(0, ACQUISITION_CANDIDATE_LIMIT)
    .map(({ postedAt: _postedAt, ...candidate }) => candidate);
}

// ---------------------------------------------------------------------------
// Checks of the registration and the edit (§5.1)
// ---------------------------------------------------------------------------

interface AssetAccount {
  id: string;
  code: string;
  name: string;
}

/** The account must be an active depreciable account (§5.4). */
async function requireDepreciableAccount(db: Db, accountId: string): Promise<AssetAccount> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { id: true, code: true, name: true, group: true, isActive: true },
  });
  if (!account) {
    throw new SettingsError("勘定科目が見つかりません。一覧から選んでください", {
      field: "accountId",
    });
  }
  if (!isDepreciableAccount(account)) {
    throw new SettingsError(
      `勘定科目「${account.code} ${account.name}」には固定資産を登録できません。工具器具備品などの固定資産の科目を選んでください`,
      { field: "accountId" },
    );
  }
  if (!account.isActive) {
    throw new SettingsError(
      `勘定科目「${account.code} ${account.name}」は無効です。設定 › 勘定科目 で有効にするか、別の科目を選んでください`,
      { field: "accountId" },
    );
  }
  return { id: account.id, code: account.code, name: account.name };
}

/** Locks and returns the fiscal year containing `date` (the acquisition or the disposal). */
async function lockYearContaining(
  tx: Tx,
  date: CalendarDate,
  field: string,
): Promise<ScheduleYear> {
  const years = await loadScheduleYears(tx);
  const year = yearContaining(years, date);
  if (!year) {
    throw new SettingsError(
      `${displayDate(date)} を含む会計期間がありません。会計期間の中の日付にするか、設定 › 会計期間 で期を作ってください`,
      { field },
    );
  }
  await lockFiscalYears(tx, [year.id]);
  const reloaded = (await loadScheduleYears(tx)).find((candidate) => candidate.id === year.id);
  if (!reloaded) throw new Error(`fiscal year ${year.id} disappeared`);
  return reloaded;
}

function throwFirstProblem(problems: readonly DepreciationProblem[], costField: string): void {
  const [first] = problems;
  if (!first) return;
  throw new SettingsError(first.message, {
    field: first.field === "cost" ? costField : first.field,
  });
}

/** 中小企業者等の特例: the year's total (not voided) must stay within 3,000,000 × months ÷ 12. */
async function assertSpecialCap(
  tx: Tx,
  asset: { method: DepreciationMethod; cost: Money; acquisitionDate: CalendarDate },
  year: ScheduleYear,
  excludeAssetId?: string,
): Promise<void> {
  if (!isSpecialSmallAsset(asset)) return;
  const cap = specialSmallAssetCap(year);
  const sum = await tx.fixedAsset.aggregate({
    where: {
      voidedAt: null,
      method: "immediate",
      cost: { gte: SMALL_ASSET_LIMIT },
      acquisitionDate: { gte: toDbDate(year.startDate), lte: toDbDate(year.endDate) },
      ...(excludeAssetId ? { id: { not: excludeAssetId } } : {}),
    },
    _sum: { cost: true },
  });
  const registered = sum._sum.cost ?? 0n;
  if (registered + asset.cost > cap) {
    throw new SettingsError(
      `第 ${year.no} 期の特例の上限 ${formatYen(cap)} 円を超えます（登録済み ${formatYen(registered)} 円）`,
      { field: "method" },
    );
  }
}

function isLifeBased(method: DepreciationMethod): boolean {
  return method === "straight_line" || method === "declining_balance";
}

/**
 * The 1 yen memorandum value is kept only for 定額・定率. The life is required for them; 即時・一括 may
 * keep one for 償却資産申告 (16 §14.2), which the depreciation never reads.
 */
function derivedColumns(asset: {
  method: DepreciationMethod;
  cost: Money;
  usefulLifeYears: number | null;
  accountCode: string;
}) {
  return {
    usefulLifeYears: asset.usefulLifeYears,
    residualValue: isLifeBased(asset.method) ? 1n : 0n,
    isDepreciableAssetTaxed: isDepreciableAssetTaxed(asset),
  };
}

function assetSnapshot(asset: FixedAsset) {
  return {
    name: asset.name,
    accountId: asset.accountId,
    acquisitionDate: fromDbDate(asset.acquisitionDate),
    cost: asset.cost,
    method: asset.method,
    usefulLifeYears: asset.usefulLifeYears,
    residualValue: asset.residualValue,
    isDepreciableAssetTaxed: asset.isDepreciableAssetTaxed,
    segmentId: asset.segmentId,
    note: asset.note,
    acquisitionEntryId: asset.acquisitionEntryId,
    disposedAt: fromDbDateOrNull(asset.disposedAt),
    disposalEntryId: asset.disposalEntryId,
    voidedAt: asset.voidedAt,
    voidReason: asset.voidReason,
    propertyTaxAssetType: asset.propertyTaxAssetType,
    propertyTaxExcludedReason: asset.propertyTaxExcludedReason,
  };
}

async function snapshotOf(tx: Tx, asset: FixedAsset): Promise<Prisma.InputJsonValue> {
  const years = await loadScheduleYears(tx);
  const postings = await loadDepreciationPostings(tx, [asset.id]);
  const disposal = asset.disposalEntryId
    ? await tx.journalEntry.findUnique({
        where: { id: asset.disposalEntryId },
        select: { status: true },
      })
    : null;
  const disposedOn =
    asset.disposedAt && (!disposal || disposal.status === "posted")
      ? fromDbDate(asset.disposedAt)
      : null;
  return scheduleSnapshot(
    assetSchedule(schedulable(asset, disposedOn), years, postings, { project: true }),
  );
}

async function lockAsset(tx: Tx, id: string): Promise<FixedAsset> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "fixed_asset" WHERE "id" = ${id} FOR UPDATE`;
  if (locked.length === 0) {
    throw new SettingsError("固定資産が見つかりません。画面を読み込み直してください");
  }
  return tx.fixedAsset.findUniqueOrThrow({ where: { id } });
}

/** Depreciation entries in force of an asset. */
async function countLiveDepreciation(db: Db, assetId: string): Promise<number> {
  return db.journalEntry.count({
    where: { sourceKind: "fixed_asset", sourceId: assetId, kind: "adjusting", status: "posted" },
  });
}

async function disposalInForceOf(db: Db, asset: FixedAsset): Promise<boolean> {
  if (!asset.disposedAt) return false;
  if (!asset.disposalEntryId) return true;
  const entry = await db.journalEntry.findUnique({
    where: { id: asset.disposalEntryId },
    select: { status: true },
  });
  return entry?.status === "posted";
}

async function assertParametersChangeable(tx: Tx, asset: FixedAsset, what: string): Promise<void> {
  if (await disposalInForceOf(tx, asset)) {
    throw new SettingsError(`除却・売却済みのため、${what}`);
  }
  if ((await countLiveDepreciation(tx, asset.id)) > 0) {
    throw new SettingsError(`償却の仕訳があるため、${what}。償却の仕訳を取り消すと変えられます`);
  }
}

/** Debit total on an account in an entry, and what remains to register from it. */
async function remainingOfEntry(
  tx: Tx,
  entryId: string,
  account: AssetAccount,
  excludeAssetId?: string,
): Promise<Money> {
  const sum = await tx.journalLine.aggregate({
    where: { journalEntryId: entryId, accountId: account.id, side: "debit" },
    _sum: { amount: true },
  });
  const amount = sum._sum.amount ?? 0n;
  if (amount === 0n) {
    throw new SettingsError(
      `取得の仕訳に「${account.code} ${account.name}」の借方の行がありません。仕訳の科目を選んでください`,
      { field: "accountId" },
    );
  }
  return amount - (await registeredFrom(tx, entryId, account.id, excludeAssetId));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface RegisteredFixedAsset {
  id: string;
  name: string;
  /** The acquisition entry: the chosen one, or the 支出 posted with the registration. */
  acquisitionEntry: EntryRef | null;
}

/**
 * 固定資産の登録 (§5.1). `source = entry`: from a debit line of a posted entry, up to what is not
 * registered yet. `source = purchase`: posts the 支出 (S3 `postSimpleEntry`) in the same transaction
 * and takes the cost from the asset line (without the tax in tax-exclusive years). The method is
 * checked against the cost, the date and the account; the special measure against the year's cap.
 * Audit: `fixed_asset.create`.
 */
export async function registerFixedAsset(
  db: Db,
  input: FixedAssetRegisterInput,
  options: ActorOptions,
): Promise<RegisteredFixedAsset> {
  const data = fixedAssetRegisterSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const account = await requireDepreciableAccount(tx, data.accountId);
    const segmentId = data.segmentId ?? (await corporateSegmentId(tx));
    let acquisitionDate: CalendarDate;
    let cost: Money;
    let acquisitionEntry: EntryRef;
    let year: ScheduleYear;
    if (data.source === "entry") {
      const entry = await tx.journalEntry.findUnique({
        where: { id: data.entryId },
        select: { id: true, no: true, entryDate: true, status: true, kind: true },
      });
      if (!entry || entry.status !== "posted" || entry.kind === "reversal") {
        throw new SettingsError(
          "取得の仕訳が見つかりません。取消済みでない仕訳を一覧から選んでください",
          { field: "entryId" },
        );
      }
      acquisitionDate = fromDbDate(entry.entryDate);
      year = await lockYearContaining(tx, acquisitionDate, "entryId");
      const remaining = await remainingOfEntry(tx, entry.id, account);
      if (data.cost > remaining) {
        throw new SettingsError(
          `取得価額は仕訳の残りの額 ${formatYen(remaining)} 円までにしてください`,
          { field: "cost" },
        );
      }
      cost = data.cost;
      acquisitionEntry = refOf(entry);
    } else {
      acquisitionDate = data.entryDate;
      year = await lockYearContaining(tx, acquisitionDate, "entryDate");
      const counterpart =
        data.counterpart.kind === "wallet"
          ? `wallet:${data.counterpart.walletId}`
          : `account:${data.counterpart.accountId}`;
      const posted = await postSimpleEntry(
        tx,
        {
          type: "expense",
          entryDate: data.entryDate,
          description: data.name,
          counterpart,
          accountId: account.id,
          amount: data.amount,
          taxCategoryCode: data.taxCategoryCode,
          segmentId,
          partnerId: data.partnerId ?? "",
          memoTagIds: [],
        },
        options,
      );
      cost = posted.lines
        .filter((line) => line.side === "debit" && line.accountId === account.id)
        .reduce((sum, line) => sum + line.amount, 0n);
      acquisitionEntry = { id: posted.id, no: posted.no, entryDate: posted.entryDate };
    }

    const choice = {
      method: data.method,
      cost,
      acquisitionDate,
      accountCode: account.code,
      usefulLifeYears: data.usefulLifeYears,
    };
    throwFirstProblem(checkDepreciationChoice(choice), data.source === "entry" ? "cost" : "amount");
    await assertSpecialCap(tx, choice, year);

    const created = await tx.fixedAsset.create({
      data: {
        id: newId(),
        name: data.name,
        accountId: account.id,
        acquisitionDate: toDbDate(acquisitionDate),
        cost,
        method: data.method,
        ...derivedColumns(choice),
        segmentId,
        note: data.note,
        acquisitionEntryId: acquisitionEntry.id,
      },
    });
    const asset = await tx.fixedAsset.update({
      where: { id: created.id },
      data: { schedule: await snapshotOf(tx, created) },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "fixed_asset.create",
      entity: "fixed_asset",
      entityId: asset.id,
      after: assetSnapshot(asset),
    });
    return { id: asset.id, name: asset.name, acquisitionEntry };
  });
}

/**
 * 編集 (§5.2): 名称・セグメント・メモ at any time; 取得価額・取得日・科目・償却方法・耐用年数 only while
 * the asset has no depreciation or disposal in force. 償却資産申告 (§14.5): 資産の種類 and 申告の対象外の
 * 理由 at any time, and so is the life of an 即時・一括 asset (the depreciation does not read it).
 * Audit: `fixed_asset.update` (before / after).
 */
export async function updateFixedAsset(
  db: Db,
  id: string,
  input: FixedAssetUpdateInput,
  options: ActorOptions,
): Promise<FixedAsset> {
  const data = fixedAssetUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const found = await tx.fixedAsset.findUnique({ where: { id } });
    if (!found) throw new SettingsError("固定資産が見つかりません。画面を読み込み直してください");
    const oldDate = fromDbDate(found.acquisitionDate);
    const newDate = data.acquisitionDate ?? oldDate;
    const years = await loadScheduleYears(tx);
    await lockFiscalYears(tx, [
      yearContaining(years, oldDate)?.id,
      yearContaining(years, newDate)?.id,
    ]);
    const current = await lockAsset(tx, id);
    if (current.voidedAt) {
      throw new SettingsError("登録を取り消した固定資産は変更できません");
    }

    const next = {
      accountId: data.accountId ?? current.accountId,
      acquisitionDate: newDate,
      cost: data.cost ?? current.cost,
      method: data.method ?? current.method,
      usefulLifeYears:
        data.usefulLifeYears === undefined ? current.usefulLifeYears : data.usefulLifeYears,
    };
    const parametersChanged =
      next.accountId !== current.accountId ||
      next.acquisitionDate !== oldDate ||
      next.cost !== current.cost ||
      next.method !== current.method ||
      (isLifeBased(next.method) ? next.usefulLifeYears !== current.usefulLifeYears : false);
    // Only the life of an 即時・一括 asset: kept for 償却資産申告, whatever was posted (§14.5).
    const lifeOnly =
      !parametersChanged &&
      !isLifeBased(next.method) &&
      next.usefulLifeYears !== current.usefulLifeYears;
    if (
      lifeOnly &&
      next.usefulLifeYears !== null &&
      (next.usefulLifeYears < MIN_USEFUL_LIFE || next.usefulLifeYears > MAX_USEFUL_LIFE)
    ) {
      throw new SettingsError(
        `耐用年数は ${MIN_USEFUL_LIFE}〜${MAX_USEFUL_LIFE} 年で入力してください`,
        { field: "usefulLifeYears" },
      );
    }

    let derived = {};
    if (parametersChanged) {
      await assertParametersChangeable(
        tx,
        current,
        `${lockedParameters(current.method)}は変えられません`,
      );
      const account = await requireDepreciableAccount(tx, next.accountId);
      const year = await lockYearContaining(tx, next.acquisitionDate, "acquisitionDate");
      if (current.acquisitionEntryId) {
        const remaining = await remainingOfEntry(tx, current.acquisitionEntryId, account, id);
        if (next.cost > remaining) {
          throw new SettingsError(
            `取得価額は仕訳の残りの額 ${formatYen(remaining)} 円までにしてください`,
            { field: "cost" },
          );
        }
      }
      const choice = { ...next, accountCode: account.code };
      throwFirstProblem(checkDepreciationChoice(choice), "cost");
      await assertSpecialCap(tx, choice, year, id);
      derived = {
        accountId: next.accountId,
        acquisitionDate: toDbDate(next.acquisitionDate),
        cost: next.cost,
        method: next.method,
        ...derivedColumns(choice),
      };
    }

    const updated = await tx.fixedAsset.update({
      where: { id },
      data: {
        ...(data.name === undefined ? {} : { name: data.name }),
        ...(data.segmentId === undefined
          ? {}
          : { segmentId: data.segmentId ?? (await corporateSegmentId(tx)) }),
        ...(data.note === undefined ? {} : { note: data.note }),
        ...(lifeOnly ? { usefulLifeYears: next.usefulLifeYears } : {}),
        ...(data.propertyTaxAssetType === undefined
          ? {}
          : { propertyTaxAssetType: data.propertyTaxAssetType }),
        ...(data.propertyTaxExcludedReason === undefined
          ? {}
          : { propertyTaxExcludedReason: data.propertyTaxExcludedReason }),
        ...derived,
      },
    });
    const asset = await tx.fixedAsset.update({
      where: { id },
      data: { schedule: await snapshotOf(tx, updated) },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "fixed_asset.update",
      entity: "fixed_asset",
      entityId: id,
      before: assetSnapshot(current),
      after: assetSnapshot(asset),
    });
    return asset;
  });
}

/**
 * 登録の取消 (§5.2): a logical delete (`voidedAt`, `voidReason`) while the asset has no depreciation
 * or disposal in force. The acquisition entry stays. Audit: `fixed_asset.void` with the reason.
 */
export async function voidFixedAsset(
  db: Db,
  id: string,
  input: FixedAssetVoidInput,
  options: ActorOptions,
): Promise<FixedAsset> {
  const data = fixedAssetVoidSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await lockAsset(tx, id);
    if (current.voidedAt) throw new SettingsError("この固定資産の登録は取消済みです");
    await assertParametersChangeable(tx, current, "登録は取り消せません");
    const asset = await tx.fixedAsset.update({
      where: { id },
      data: { voidedAt: new Date(), voidReason: data.reason },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "fixed_asset.void",
      entity: "fixed_asset",
      entityId: id,
      before: assetSnapshot(current),
      after: assetSnapshot(asset),
      reason: data.reason,
    });
    return asset;
  });
}

async function loadTaxRules(db: Db): Promise<TaxRateRule[]> {
  const rows = await db.taxRateRule.findMany({
    orderBy: [{ taxCategoryCode: "asc" }, { effectiveFrom: "asc" }, { ratePercent: "desc" }],
  });
  return rows.map((rule) => ({
    taxCategoryCode: rule.taxCategoryCode,
    effectiveFrom: fromDbDate(rule.effectiveFrom),
    effectiveTo: fromDbDateOrNull(rule.effectiveTo),
    ratePercent: rule.ratePercent,
    deductiblePercent: rule.deductiblePercent,
    enabled: rule.enabled,
    ...(rule.note ? { note: rule.note } : {}),
  }));
}

/** Σ(debit − credit) on an account through a date (all segments and sub-accounts). */
async function accountBalanceThrough(db: Db, accountId: string, date: CalendarDate) {
  const groups = await db.journalLine.groupBy({
    by: ["side"],
    where: { accountId, journalEntry: { entryDate: { lte: toDbDate(date) } } },
    _sum: { amount: true },
  });
  let net = 0n;
  for (const group of groups) {
    const amount = group._sum.amount ?? 0n;
    net += group.side === "debit" ? amount : -amount;
  }
  return net;
}

export interface DisposedFixedAsset {
  assetId: string;
  disposedAt: CalendarDate;
  /** `null` when nothing had to be posted (即時 already expensed, no proceeds). */
  entry: EntryRef | null;
  /** The book value removed (除却損 or the cost of the sale). */
  bookValue: Money;
}

/**
 * 除却・売却 (§5.3): no depreciation for the year of the disposal; the book value (cost − the
 * depreciation posted) becomes a 除却損 or the cost of the sale (`buildDisposalEntry`). The proceeds
 * are split like a 収入 (`sales_10`). The date must be open (a year in progress, after the monthly
 * close). Audit: `fixed_asset.dispose`.
 */
export async function disposeFixedAsset(
  db: Db,
  id: string,
  input: FixedAssetDisposeInput,
  options: ActorOptions,
): Promise<DisposedFixedAsset> {
  const data = fixedAssetDisposeSchema.parse(input);
  const proceeds = data.proceeds ?? 0n;
  return runInTransaction(db, async (tx) => {
    const year = await lockYearContaining(tx, data.date, "date");
    const current = await lockAsset(tx, id);
    if (current.voidedAt) {
      throw new SettingsError("登録を取り消した固定資産は除却・売却できません");
    }
    if (await disposalInForceOf(tx, current)) throw new SettingsError("除却・売却済みです");
    if (year.status === "closing") {
      throw new SettingsError(
        `第 ${year.no} 期は決算整理中のため、除却・売却は登録できません。決算整理をやめるか、翌期の日付にしてください`,
        { field: "date" },
      );
    }
    if (year.status === "closed") {
      throw new SettingsError(`第 ${year.no} 期は締め済みです。翌期の日付にしてください`, {
        field: "date",
      });
    }
    if (isLocked(data.date, year)) {
      throw new SettingsError(
        `${displayDate(year.lockedThrough ?? year.endDate)} までは締めています。それより後の日付にしてください`,
        { field: "date" },
      );
    }
    const acquisitionDate = fromDbDate(current.acquisitionDate);
    if (data.date < acquisitionDate) {
      throw new SettingsError(
        `除却・売却の日付は取得日（${displayDate(acquisitionDate)}）以後にしてください`,
        { field: "date" },
      );
    }

    const postings = await loadDepreciationPostings(tx, [id]);
    const accumulated = [...(postings.get(id)?.values() ?? [])].reduce(
      (sum, item) => sum + item.net,
      0n,
    );
    const wallet = proceeds > 0n ? await requireWallet(tx, data.walletId) : null;
    const account = await tx.account.findUniqueOrThrow({
      where: { id: current.accountId },
      select: { code: true, name: true },
    });
    const accumulatedAccount =
      current.method === "straight_line" || current.method === "declining_balance"
        ? await requireAccountByCode(tx, ACCUMULATED_DEPRECIATION_CODE)
        : null;
    let split: { amount: Money; taxAmount: Money; taxLineAmount: Money } | null = null;
    if (proceeds > 0n) {
      split = splitTaxInclusive(proceeds, "sales_10", data.date, {
        accountingMethod: year.accountingMethod,
        taxRules: await loadTaxRules(tx),
        field: "proceeds",
      });
    }
    const optional = async (code: string, needed: boolean): Promise<YearEndAccount | null> =>
      needed ? requireAccountByCode(tx, code) : null;
    const bookValue = current.method === "lump_sum_3y" ? 0n : current.cost - accumulated;
    const gain = split !== null && split.amount >= bookValue;
    const miscIncome = await optional(MISC_INCOME_CODE, proceeds > 0n && gain);
    const miscLoss = await optional(MISC_LOSS_CODE, proceeds > 0n ? !gain : bookValue > 0n);
    const outputTax = await optional(OUTPUT_TAX_ACCOUNT_CODE, (split?.taxLineAmount ?? 0n) > 0n);
    const segmentId = current.segmentId ?? (await corporateSegmentId(tx));

    // The asset's account must still hold what the disposal takes off (its acquisition entry may
    // have been voided since the registration).
    const assetAccountBalance = await accountBalanceThrough(tx, current.accountId, data.date);
    const removing = accumulatedAccount
      ? current.cost
      : current.method === "immediate"
        ? bookValue
        : 0n;
    if (removing > assetAccountBalance) {
      throw new SettingsError(
        `勘定科目 ${account.code} ${account.name} の残高（${formatYen(assetAccountBalance)} 円）が外す額（${formatYen(removing)} 円）より少ないため、除却・売却できません。取得の仕訳を確かめてください`,
      );
    }
    const built = buildDisposalEntry({
      date: data.date,
      assetId: id,
      assetName: current.name,
      method: current.method,
      cost: current.cost,
      accumulated,
      assetAccountBalance,
      assetAccountId: current.accountId,
      accumulatedAccountId: accumulatedAccount?.id ?? "",
      proceeds,
      proceedsCounterpart: wallet
        ? { accountId: wallet.accountId, subAccountId: wallet.subAccountId }
        : null,
      proceedsSplit: split,
      outputTaxAccountId: outputTax?.id ?? null,
      miscIncomeAccountId: miscIncome?.id ?? "",
      miscLossAccountId: miscLoss?.id ?? "",
      segmentId,
      description: data.description ?? "",
    });
    const posted = built.entry
      ? await postJournalEntryInTransaction(tx, { ...built.entry, fiscalYearId: year.id }, options)
      : null;
    const disposed = await tx.fixedAsset.update({
      where: { id },
      data: { disposedAt: toDbDate(data.date), disposalEntryId: posted?.id ?? null },
    });
    const asset = await tx.fixedAsset.update({
      where: { id },
      data: { schedule: await snapshotOf(tx, disposed) },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "fixed_asset.dispose",
      entity: "fixed_asset",
      entityId: id,
      before: assetSnapshot(current),
      after: { ...assetSnapshot(asset), proceeds, bookValue: built.bookValue },
    });
    return {
      assetId: id,
      disposedAt: data.date,
      entry: posted ? { id: posted.id, no: posted.no, entryDate: posted.entryDate } : null,
      bookValue: built.bookValue,
    };
  });
}

async function requireWallet(db: Db, walletId: string | null) {
  if (!walletId) {
    throw new SettingsError("入金先の口座を選んでください", { field: "walletId" });
  }
  const wallet = await db.wallet.findUnique({
    where: { id: walletId },
    select: { id: true, name: true, accountId: true, subAccountId: true, isActive: true },
  });
  if (!wallet) {
    throw new SettingsError("口座が見つかりません。一覧から選んでください", { field: "walletId" });
  }
  if (!wallet.isActive) {
    throw new SettingsError(`口座「${wallet.name}」は無効です。別の口座を選んでください`, {
      field: "walletId",
    });
  }
  return wallet;
}

// ---------------------------------------------------------------------------
// 固定資産の明細 for the statements (#15, §12)
// ---------------------------------------------------------------------------

export interface FixedAssetLedgerRow {
  assetId: string;
  name: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  acquisitionDate: CalendarDate;
  cost: Money;
  method: DepreciationMethod;
  usefulLifeYears: number | null;
  /** 期首帳簿価額 (0 for an asset acquired in the year). */
  openingBookValue: Money;
  /** 当期増加: the cost of an asset acquired in the year. */
  increase: Money;
  /** 当期減少: the book value removed by a disposal in the year. */
  decrease: Money;
  /** 当期償却額: the depreciation posted in the year. */
  depreciation: Money;
  /** The year's amount of the schedule (posted or not). */
  plannedDepreciation: Money;
  /** 期末帳簿価額 = opening + increase − decrease − depreciation. */
  closingBookValue: Money;
  /** The depreciation posted through the year end (0 once the asset is removed). */
  accumulated: Money;
  disposedAt: CalendarDate | null;
  isDepreciableAssetTaxed: boolean;
  /** 中小企業者等の特例 (別表十六(七)). */
  isSpecialSmallAsset: boolean;
}

export interface FixedAssetLedger {
  fiscalYear: { id: string; no: number; startDate: CalendarDate; endDate: CalendarDate };
  rows: FixedAssetLedgerRow[];
  totals: {
    openingBookValue: Money;
    increase: Money;
    decrease: Money;
    depreciation: Money;
    closingBookValue: Money;
  };
}

/**
 * The fixed assets of a fiscal year for the statements (#15): the registrations in force acquired by
 * its end and not removed before it, with the movements of the year from the entries posted.
 */
export async function loadFixedAssetLedger(
  db: Db,
  fiscalYearId: string,
): Promise<FixedAssetLedger> {
  const years = await loadScheduleYears(db);
  const year = years.find((candidate) => candidate.id === fiscalYearId);
  if (!year) throw new SettingsError("会計期間が見つかりません。画面を読み込み直してください");
  const assets = await db.fixedAsset.findMany({
    where: { voidedAt: null, acquisitionDate: { lte: toDbDate(year.endDate) } },
    include: assetInclude,
    orderBy: [{ account: { code: "asc" } }, { acquisitionDate: "asc" }, { id: "asc" }],
  });
  const postings = await loadDepreciationPostings(
    db,
    assets.map((asset) => asset.id),
  );
  const startOf = new Map(years.map((candidate) => [candidate.id, candidate.startDate]));
  const rows: FixedAssetLedgerRow[] = [];
  for (const asset of assets) {
    const disposedOn = disposalInForce(asset);
    const removes = asset.method !== "lump_sum_3y";
    if (removes && disposedOn && disposedOn < year.startDate) continue;
    const acquisitionDate = fromDbDate(asset.acquisitionDate);
    let before = 0n;
    let depreciation = 0n;
    for (const [yearId, item] of postings.get(asset.id) ?? []) {
      const start = startOf.get(yearId);
      if (start === undefined) continue;
      if (start < year.startDate) before += item.net;
      else if (yearId === year.id) depreciation += item.net;
    }
    const acquiredInYear = acquisitionDate >= year.startDate;
    const openingBookValue = acquiredInYear ? 0n : asset.cost - before;
    const increase = acquiredInYear ? asset.cost : 0n;
    const removed = removes && disposedOn !== null && disposedOn <= year.endDate;
    const decrease = removed ? openingBookValue + increase - depreciation : 0n;
    const schedule = assetSchedule(schedulable(asset, disposedOn), years, postings);
    const planned = schedule.find((row) => row.fiscalYearId === year.id)?.amount ?? 0n;
    const row: FixedAssetLedgerRow = {
      assetId: asset.id,
      name: asset.name,
      accountId: asset.accountId,
      accountCode: asset.account.code,
      accountName: asset.account.name,
      acquisitionDate,
      cost: asset.cost,
      method: asset.method,
      usefulLifeYears: asset.usefulLifeYears,
      openingBookValue,
      increase,
      decrease,
      depreciation,
      plannedDepreciation: planned,
      closingBookValue: openingBookValue + increase - decrease - depreciation,
      accumulated: removed ? 0n : before + depreciation,
      disposedAt: disposedOn,
      isDepreciableAssetTaxed: asset.isDepreciableAssetTaxed,
      isSpecialSmallAsset: isSpecialSmallAsset(asset),
    };
    const moves =
      row.openingBookValue !== 0n ||
      row.increase !== 0n ||
      row.decrease !== 0n ||
      row.depreciation !== 0n;
    if (moves) rows.push(row);
  }
  const totals = {
    openingBookValue: 0n,
    increase: 0n,
    decrease: 0n,
    depreciation: 0n,
    closingBookValue: 0n,
  };
  for (const row of rows) {
    totals.openingBookValue += row.openingBookValue;
    totals.increase += row.increase;
    totals.decrease += row.decrease;
    totals.depreciation += row.depreciation;
    totals.closingBookValue += row.closingBookValue;
  }
  return {
    fiscalYear: { id: year.id, no: year.no, startDate: year.startDate, endDate: year.endDate },
    rows,
    totals,
  };
}

// ---------------------------------------------------------------------------
// 償却資産申告の元データ (16 §14)
// ---------------------------------------------------------------------------

/** The S8 calendar rule whose 1/31 item is the return's deadline (24 §1). */
const LEGAL_RECORDS_RULE_KEY = "annual.legal-records";

/** The calendar item of 1/31 (法定調書合計表・給与支払報告書・償却資産申告書); completed on `/calendar`. */
export interface DepreciableAssetsReturnDeadline {
  id: string;
  title: string;
  dueDate: CalendarDate;
  completedAt: Date | null;
}

export interface DepreciableAssetsReturnData extends DepreciableAssetsReturn {
  companyName: string | null;
  /** 申告先 (本店所在地の市町村), `null` until saved. */
  municipality: string | null;
  /** `null` when the calendar has no item for Y-01-31 (no fiscal year holds that day yet). */
  deadline: DepreciableAssetsReturnDeadline | null;
  /** The return years to choose from, newest first: next year back to the year after the earliest acquisition. */
  years: number[];
}

function returnYears(
  earliest: CalendarDate | null,
  today: CalendarDate,
  requested: number,
): number[] {
  const last = Number(today.slice(0, 4)) + 1;
  const first = earliest
    ? Math.min(Number(earliest.slice(0, 4)) + 1, last)
    : defaultDepreciableAssetsReturnYear(today);
  const years: number[] = [];
  for (let year = last; year >= first; year -= 1) years.push(year);
  if (!years.includes(requested)) years.push(requested);
  return years.sort((a, b) => b - a);
}

/**
 * 償却資産申告の元データ of return year `year` (§14): the register's assets (voided registrations
 * left out, a voided disposal entry puts the asset back in use) through `buildDepreciableAssetsReturn`,
 * the 申告先 of the company, the deadline from the calendar and the years to choose from.
 */
export async function loadDepreciableAssetsReturn(
  db: Db,
  options: { year: number; today?: CalendarDate },
): Promise<DepreciableAssetsReturnData> {
  const today = options.today ?? todayInJapan();
  const assessmentDate = `${String(options.year).padStart(4, "0")}-01-01` as CalendarDate;
  const assets = await db.fixedAsset.findMany({
    where: { voidedAt: null, acquisitionDate: { lte: toDbDate(assessmentDate) } },
    include: assetInclude,
    orderBy: [{ acquisitionDate: "asc" }, { id: "asc" }],
  });
  const result = buildDepreciableAssetsReturn(
    assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      accountCode: asset.account.code,
      accountName: asset.account.name,
      acquisitionDate: fromDbDate(asset.acquisitionDate),
      cost: asset.cost,
      method: asset.method,
      usefulLifeYears: asset.usefulLifeYears,
      disposedAt: disposalInForce(asset),
      sold: statusOf(asset) === "sold",
      voided: asset.voidedAt !== null,
      propertyTaxAssetType: asset.propertyTaxAssetType,
      propertyTaxExcludedReason: asset.propertyTaxExcludedReason,
    })),
    { year: options.year },
  );
  const company = await db.company.findFirst({
    orderBy: { createdAt: "asc" },
    select: { name: true, propertyTaxMunicipality: true },
  });
  const deadline = await db.calendarItem.findFirst({
    where: {
      ruleKey: LEGAL_RECORDS_RULE_KEY,
      dueDate: toDbDate(`${String(options.year).padStart(4, "0")}-01-31` as CalendarDate),
    },
    orderBy: { createdAt: "asc" },
  });
  const earliest = await db.fixedAsset.aggregate({
    where: { voidedAt: null },
    _min: { acquisitionDate: true },
  });
  return {
    ...result,
    companyName: company?.name ?? null,
    municipality: company?.propertyTaxMunicipality ?? null,
    deadline: deadline
      ? {
          id: deadline.id,
          title: deadline.title,
          dueDate: fromDbDate(deadline.dueDate),
          completedAt: deadline.completedAt,
        }
      : null,
    years: returnYears(fromDbDateOrNull(earliest._min.acquisitionDate), today, options.year),
  };
}

/**
 * 申告先 (§14.4): the municipality of the head office, saved on the company (empty clears it).
 * Audit: `company.update` with the field before and after; nothing is written when it is unchanged.
 */
export async function setPropertyTaxMunicipality(
  db: Db,
  input: PropertyTaxMunicipalityInput,
  options: ActorOptions,
): Promise<{ municipality: string | null }> {
  const data = propertyTaxMunicipalitySchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "company");
    const company = await requireCompanyRow(tx);
    if (company.propertyTaxMunicipality === data.municipality) {
      return { municipality: company.propertyTaxMunicipality };
    }
    const row = await tx.company.update({
      where: { id: company.id },
      data: { propertyTaxMunicipality: data.municipality },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "company.update",
      entity: "company",
      entityId: row.id,
      before: { propertyTaxMunicipality: company.propertyTaxMunicipality },
      after: { propertyTaxMunicipality: row.propertyTaxMunicipality },
    });
    return { municipality: row.propertyTaxMunicipality };
  });
}
