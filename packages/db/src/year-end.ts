/**
 * 決算 (docs/design/16-year-end.md §3, §4.3, §6–§10, §12): the checklist of a fiscal year, the
 * postings of the year-end adjustments (depreciation, 繰延資産, accruals, consumption tax, corporate
 * taxes), their void, the confirmations, the balances before and after closing, and the corporate
 * tax estimate (#19). Every posting locks the fiscal year, needs it in its year-end adjustments
 * (`closing`), refuses a second posting and is dated on the year's last day.
 */
import {
  accrualReversalSourceId,
  ACCRUAL_BALANCE_ACCOUNT_CODES,
  ACCRUAL_PL_ACCOUNT_KINDS,
  ACCRUAL_TYPE_LABELS,
  ACCUMULATED_DEPRECIATION_CODE,
  buildAccrualEntry,
  buildAccrualReversal,
  buildConsumptionTaxSettlement,
  buildCorporateTaxEntry,
  buildDeferredAmortizationEntry,
  buildDepreciationEntry,
  CONSUMPTION_TAX_PAYABLE_CODE,
  CORPORATE_TAX_EXPENSE_CODE,
  CORPORATE_TAX_PAYABLE_CODE,
  corporateTaxDueDate,
  DEFERRED_ASSET_EXPENSE_CODES,
  DEPRECIATION_EXPENSE_CODE,
  displayDate,
  estimateCorporateTax,
  formatYen,
  INPUT_TAX_ACCOUNT_CODE,
  isLocked,
  lossCarryforward,
  MISC_INCOME_CODE,
  MISC_LOSS_CODE,
  OTHER_RECEIVABLE_CODE,
  OUTPUT_TAX_ACCOUNT_CODE,
  parseYearEndSourceId,
  planDeferredAmortization,
  SUPPLIES_ACCOUNT_NAME,
  TAXES_AND_DUES_CODE,
  yearEndSourceId,
  type AccountGroup,
  type AccountingMethod,
  type AccountKind,
  type AccrualType,
  type CalendarDate,
  type ConsumptionTaxMethod,
  type CorporateTaxEstimate,
  type DepreciationMethod,
  type FiscalYearStatus,
  type Money,
  type SourceKind,
  type WalletKind,
} from "@niho-finance/ledger";
import type { FiscalYear, Prisma } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import {
  checkYearEndStart,
  closingEntryIds,
  corporateSegmentId,
  lockFiscalYears,
  neighborYears,
  netIncomeOf,
  profitAndLossRows,
  requireAccountByCode,
  voidEntryInYearEnd,
  type YearEndAccount,
} from "./closing";
import { fromDbDate, todayInJapan, toDbDate } from "./dates";
import { countInboxDocuments } from "./documents";
import { voidJournalEntryWithOpenDate, type EntryRef } from "./entries";
import { SettingsError } from "./errors";
import {
  assetSchedule,
  loadDepreciationPostings,
  loadScheduleYears,
  type FixedAssetScheduleRow,
} from "./fixed-assets";
import { postJournalEntryInTransaction, type ActorOptions } from "./journal";
import { toFiscalYearContext } from "./queries";
import {
  accrualEntrySchema,
  consumptionTaxSettlementSchema,
  corporateTaxEntrySchema,
  deferredAmortizationSchema,
  postDepreciationSchema,
  yearEndCheckSchema,
  yearEndVoidSchema,
  type AccrualEntryInput,
  type ConsumptionTaxSettlementInput,
  type CorporateTaxEntryInput,
  type DeferredAmortizationInput,
  type PostDepreciationInput,
  type YearEndCheckInput,
  type YearEndCheckKey,
  type YearEndVoidInput,
} from "./schemas";
import { runInTransaction, type Tx } from "./transaction";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const ALREADY_POSTED = "計上済みです。取り消してから計上し直してください";

function notFound(): SettingsError {
  return new SettingsError("会計期間が見つかりません。画面を読み込み直してください");
}

async function findYear(db: Db, fiscalYearId: string): Promise<FiscalYear> {
  const row = await db.fiscalYear.findUnique({ where: { id: fiscalYearId } });
  if (!row) throw notFound();
  return row;
}

/** Locks the year (and the other given years, ascending `no`) and requires it to be `closing`. */
async function lockClosingYear(
  tx: Tx,
  fiscalYearId: string,
  alsoLock: readonly (string | null | undefined)[] = [],
): Promise<FiscalYear> {
  await findYear(tx, fiscalYearId);
  await lockFiscalYears(tx, [fiscalYearId, ...alsoLock]);
  const year = await tx.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } });
  if (year.status !== "closing") throw new SettingsError("決算整理を始めてから計上してください");
  return year;
}

function refOf(row: { id: string; no: number; entryDate: Date }): EntryRef {
  return { id: row.id, no: row.no, entryDate: fromDbDate(row.entryDate) };
}

const refSelect = { id: true, no: true, entryDate: true } as const;

/** The posted (not voided) adjusting entry of the year with this sourceId. */
async function liveEntry(db: Db, fiscalYearId: string, sourceId: string): Promise<EntryRef | null> {
  const row = await db.journalEntry.findFirst({
    where: { fiscalYearId, sourceId, kind: "adjusting", status: "posted" },
    select: refSelect,
    orderBy: { no: "asc" },
  });
  return row ? refOf(row) : null;
}

/** debit − credit per account over the lines matching `where`. */
async function netByAccount(
  db: Db,
  where: Prisma.JournalLineWhereInput,
): Promise<Map<string, Money>> {
  const groups = await db.journalLine.groupBy({
    by: ["accountId", "side"],
    where,
    _sum: { amount: true },
  });
  const result = new Map<string, Money>();
  for (const group of groups) {
    const amount = group._sum.amount ?? 0n;
    result.set(
      group.accountId,
      (result.get(group.accountId) ?? 0n) + (group.side === "debit" ? amount : -amount),
    );
  }
  return result;
}

async function accountIdOf(db: Db, code: string): Promise<string | null> {
  return (await db.account.findUnique({ where: { code }, select: { id: true } }))?.id ?? null;
}

/** The segment of a year-end line: the account's default, else 共通. */
async function segmentFor(db: Db, account: { defaultSegmentId: string | null }): Promise<string> {
  return account.defaultSegmentId ?? (await corporateSegmentId(db));
}

function floorTo100TowardZero(value: Money): Money {
  return value - (value % 100n);
}

// ---------------------------------------------------------------------------
// The year chosen on /closing
// ---------------------------------------------------------------------------

export interface ClosingYearOption {
  id: string;
  no: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
  status: FiscalYearStatus;
}

/**
 * The years of the select on /closing and the one shown (§2): 第 `no` 期 when it exists, else the first
 * year not closed, else the last one. `null` without years.
 */
export async function findClosingYear(
  db: Db,
  no: number | null,
): Promise<{ selected: ClosingYearOption; years: ClosingYearOption[] } | null> {
  const rows = await db.fiscalYear.findMany({ orderBy: { no: "asc" } });
  const years = rows.map((row) => ({
    id: row.id,
    no: row.no,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
    status: row.status,
  }));
  const selected =
    (no !== null ? years.find((year) => year.no === no) : undefined) ??
    years.find((year) => year.status !== "closed") ??
    years.at(-1);
  return selected ? { selected, years } : null;
}

// ---------------------------------------------------------------------------
// Pieces of the checklist
// ---------------------------------------------------------------------------

export interface YearEndWalletRow {
  walletId: string;
  name: string;
  kind: WalletKind;
  /** The wallet's lines through the year end, on the account's normal side. */
  ledgerBalance: Money;
  /** `balanceAfter` of the last statement line dated on or before the year end (after S4). */
  statementBalance: Money | null;
  statementDate: CalendarDate | null;
  /** statement − ledger; `null` without a statement balance. */
  difference: Money | null;
}

async function loadWalletRows(db: Db, endDate: CalendarDate): Promise<YearEndWalletRow[]> {
  const wallets = await db.wallet.findMany({
    where: { isActive: true },
    include: { account: { select: { kind: true } } },
    orderBy: [{ kind: "asc" }, { name: "asc" }, { id: "asc" }],
  });
  if (wallets.length === 0) return [];
  const groups = await db.journalLine.groupBy({
    by: ["accountId", "subAccountId", "side"],
    where: {
      accountId: { in: [...new Set(wallets.map((wallet) => wallet.accountId))] },
      journalEntry: { entryDate: { lte: toDbDate(endDate) } },
    },
    _sum: { amount: true },
  });
  const rows: YearEndWalletRow[] = [];
  for (const wallet of wallets) {
    let net = 0n;
    for (const group of groups) {
      if (group.accountId !== wallet.accountId) continue;
      if (wallet.subAccountId !== null && group.subAccountId !== wallet.subAccountId) continue;
      const amount = group._sum.amount ?? 0n;
      net += group.side === "debit" ? amount : -amount;
    }
    const debitNormal = ["asset", "expense", "internal"].includes(wallet.account.kind);
    const ledgerBalance = debitNormal ? net : -net;
    const statement = await db.walletTransaction.findFirst({
      where: {
        walletId: wallet.id,
        txnDate: { lte: toDbDate(endDate) },
        balanceAfter: { not: null },
      },
      orderBy: [{ txnDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { balanceAfter: true, txnDate: true },
    });
    const statementBalance = statement?.balanceAfter ?? null;
    rows.push({
      walletId: wallet.id,
      name: wallet.name,
      kind: wallet.kind,
      ledgerBalance,
      statementBalance,
      statementDate: statement ? fromDbDate(statement.txnDate) : null,
      difference: statementBalance === null ? null : statementBalance - ledgerBalance,
    });
  }
  return rows;
}

export interface YearEndDepreciationRow {
  assetId: string;
  name: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  method: DepreciationMethod;
  /** The amount of the year (from what was actually posted before). */
  amount: Money;
  /** The depreciation entries in force of the year. */
  entries: EntryRef[];
  /** 減価償却累計額 (定額・定率, 間接法) or the asset's account (即時・一括, 直接法). */
  creditAccountCode: string;
  state: FixedAssetScheduleRow["state"];
}

async function loadDepreciationRows(db: Db, year: FiscalYear): Promise<YearEndDepreciationRow[]> {
  const assets = await db.fixedAsset.findMany({
    where: { voidedAt: null, acquisitionDate: { lte: year.endDate } },
    include: {
      account: { select: { code: true, name: true } },
      disposalEntry: { select: { status: true } },
    },
    orderBy: [{ acquisitionDate: "asc" }, { id: "asc" }],
  });
  if (assets.length === 0) return [];
  const years = await loadScheduleYears(db);
  const postings = await loadDepreciationPostings(
    db,
    assets.map((asset) => asset.id),
  );
  const rows: YearEndDepreciationRow[] = [];
  for (const asset of assets) {
    const disposedOn =
      asset.disposedAt && (!asset.disposalEntry || asset.disposalEntry.status === "posted")
        ? fromDbDate(asset.disposedAt)
        : null;
    const schedule = assetSchedule(
      {
        id: asset.id,
        method: asset.method,
        cost: asset.cost,
        acquisitionDate: fromDbDate(asset.acquisitionDate),
        usefulLifeYears: asset.usefulLifeYears,
        disposedOn,
      },
      years,
      postings,
    );
    const row = schedule.find((candidate) => candidate.fiscalYearId === year.id);
    if (!row || (row.amount === 0n && row.entries.length === 0)) continue;
    const indirect = asset.method === "straight_line" || asset.method === "declining_balance";
    rows.push({
      assetId: asset.id,
      name: asset.name,
      accountId: asset.accountId,
      accountCode: asset.account.code,
      accountName: asset.account.name,
      method: asset.method,
      amount: row.amount,
      entries: row.entries,
      creditAccountCode: indirect ? ACCUMULATED_DEPRECIATION_CODE : asset.account.code,
      state: row.state,
    });
  }
  return rows;
}

export interface YearEndDeferredRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  expenseAccountCode: string;
  /** 取得価額: the account's entries other than the amortization (voids cancel out). */
  cost: Money;
  /** 起算日: the first posting on the account. */
  startDate: CalendarDate;
  /** Amortized in the earlier years. */
  amortizedBefore: Money;
  /** Amortized in this year (the entry in force). */
  amortizedThisYear: Money;
  /** cost − all amortization through the year end. */
  balance: Money;
  /** The amount for each choice (§6). */
  fiveYears: Money;
  full: Money;
  posted: EntryRef | null;
}

function isDeferredAmortization(entry: { sourceKind: SourceKind; sourceId: string | null }) {
  return (
    entry.sourceKind === "year_end" && parseYearEndSourceId(entry.sourceId)?.purpose === "deferred"
  );
}

async function loadDeferredRows(db: Db, year: FiscalYear): Promise<YearEndDeferredRow[]> {
  const codes = Object.keys(DEFERRED_ASSET_EXPENSE_CODES);
  const accounts = await db.account.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  const period = toFiscalYearContext(year);
  const rows: YearEndDeferredRow[] = [];
  for (const account of accounts) {
    const lines = await db.journalLine.findMany({
      where: { accountId: account.id, journalEntry: { entryDate: { lte: year.endDate } } },
      select: {
        side: true,
        amount: true,
        journalEntry: { select: { entryDate: true, sourceKind: true, sourceId: true } },
      },
    });
    let cost = 0n;
    let startDate: CalendarDate | null = null;
    let amortizedBefore = 0n;
    let amortizedThisYear = 0n;
    for (const line of lines) {
      const signed = line.side === "debit" ? line.amount : -line.amount;
      const date = fromDbDate(line.journalEntry.entryDate);
      if (isDeferredAmortization(line.journalEntry)) {
        if (date < period.startDate) amortizedBefore -= signed;
        else amortizedThisYear -= signed;
        continue;
      }
      cost += signed;
      if (startDate === null || date < startDate) startDate = date;
    }
    if (cost <= 0n || startDate === null) continue;
    const state = { cost, startDate, amortizedBefore };
    rows.push({
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      expenseAccountCode: DEFERRED_ASSET_EXPENSE_CODES[account.code] ?? "",
      cost,
      startDate,
      amortizedBefore,
      amortizedThisYear,
      balance: cost - amortizedBefore - amortizedThisYear,
      fiveYears: planDeferredAmortization(state, period, "five_years"),
      full: planDeferredAmortization(state, period, "full"),
      posted: await liveEntry(db, year.id, yearEndSourceId("deferred", year.id, account.id)),
    });
  }
  return rows;
}

export interface YearEndAccrualRow {
  entry: EntryRef;
  description: string;
  type: AccrualType | null;
  amount: Money;
  /** The reversal in force in the next year. */
  reversal: EntryRef | null;
}

export interface YearEndAccruals {
  entries: YearEndAccrualRow[];
  /** 翌期首に振り戻す can be chosen (the next year exists, is open and its first day is not closed). */
  reversalAvailable: boolean;
  reversalBlockedReason: string | null;
  /** The 貯蔵品 account (an active 流動資産 account with that name), or `null`. */
  suppliesAccount: { id: string; code: string; name: string } | null;
}

function reversalAvailability(
  year: FiscalYear,
  next: FiscalYear | null,
): { available: boolean; reason: string | null } {
  if (!next) {
    return { available: false, reason: `第 ${year.no + 1} 期を作ると振り戻しも登録できます` };
  }
  if (next.status !== "open") {
    return {
      available: false,
      reason: `第 ${next.no} 期が進行中でないため、振り戻しは登録できません`,
    };
  }
  const context = toFiscalYearContext(next);
  if (isLocked(context.startDate, context)) {
    return {
      available: false,
      reason: `第 ${next.no} 期の ${displayDate(context.startDate)} を締めているため、振り戻しは登録できません`,
    };
  }
  return { available: true, reason: null };
}

async function findSuppliesAccount(db: Db) {
  return db.account.findFirst({
    where: { name: SUPPLIES_ACCOUNT_NAME, kind: "asset", group: "current_assets", isActive: true },
    select: { id: true, code: true, name: true, defaultSegmentId: true },
    orderBy: { code: "asc" },
  });
}

async function loadAccruals(db: Db, year: FiscalYear, next: FiscalYear | null) {
  const entries = await db.journalEntry.findMany({
    where: {
      fiscalYearId: year.id,
      kind: "adjusting",
      status: "posted",
      sourceId: yearEndSourceId("accrual", year.id),
    },
    select: {
      ...refSelect,
      description: true,
      lines: {
        select: { side: true, amount: true, account: { select: { code: true, name: true } } },
      },
    },
    orderBy: { no: "asc" },
  });
  const typeByCode = new Map<string, AccrualType>();
  for (const [type, code] of Object.entries(ACCRUAL_BALANCE_ACCOUNT_CODES)) {
    if (code) typeByCode.set(code, type as AccrualType);
  }
  const rows: YearEndAccrualRow[] = [];
  for (const entry of entries) {
    let type: AccrualType | null = null;
    for (const line of entry.lines) {
      type ??=
        typeByCode.get(line.account.code) ??
        (line.account.name === SUPPLIES_ACCOUNT_NAME ? "supplies" : null);
    }
    const reversal = await db.journalEntry.findFirst({
      where: { sourceId: accrualReversalSourceId(entry.id), kind: "adjusting", status: "posted" },
      select: refSelect,
    });
    rows.push({
      entry: refOf(entry),
      description: entry.description,
      type,
      amount: entry.lines
        .filter((line) => line.side === "debit")
        .reduce((sum, line) => sum + line.amount, 0n),
      reversal: reversal ? refOf(reversal) : null,
    });
  }
  const availability = reversalAvailability(year, next);
  const supplies = await findSuppliesAccount(db);
  return {
    entries: rows,
    reversalAvailable: availability.available,
    reversalBlockedReason: availability.reason,
    suppliesAccount: supplies
      ? { id: supplies.id, code: supplies.code, name: supplies.name }
      : null,
  } satisfies YearEndAccruals;
}

export interface YearEndConsumptionTax {
  /** `false` for an exempt year (対象外). */
  applicable: boolean;
  consumptionTax: ConsumptionTaxMethod;
  accountingMethod: AccountingMethod;
  /** 仮受消費税 (2310) through the year end, before the settlement (credit positive). */
  outputTaxBalance: Money;
  /** 仮払消費税 (1400) through the year end, before the settlement (debit positive). */
  inputTaxBalance: Money;
  /** 仮受 − 仮払, truncated to 100 yen toward 0 (the form's default). */
  suggestedPayable: Money;
  posted: EntryRef | null;
}

async function loadConsumptionTax(db: Db, year: FiscalYear): Promise<YearEndConsumptionTax> {
  const sourceId = yearEndSourceId("consumption_tax", year.id);
  const ids = [
    await accountIdOf(db, OUTPUT_TAX_ACCOUNT_CODE),
    await accountIdOf(db, INPUT_TAX_ACCOUNT_CODE),
  ];
  const nets = await netByAccount(db, {
    accountId: { in: ids.filter((id): id is string => id !== null) },
    journalEntry: {
      entryDate: { lte: year.endDate },
      OR: [{ sourceId: null }, { sourceId: { not: sourceId } }],
    },
  });
  const outputTaxBalance = -(ids[0] ? (nets.get(ids[0]) ?? 0n) : 0n);
  const inputTaxBalance = ids[1] ? (nets.get(ids[1]) ?? 0n) : 0n;
  return {
    applicable: year.consumptionTax !== "exempt",
    consumptionTax: year.consumptionTax,
    accountingMethod: year.accountingMethod,
    outputTaxBalance,
    inputTaxBalance,
    suggestedPayable: floorTo100TowardZero(outputTaxBalance - inputTaxBalance),
    posted: await liveEntry(db, year.id, sourceId),
  };
}

/** 所得の概算 of a year (§9): revenue − expenses without 法人税等 and without the closing entry. */
async function pretaxIncomeOf(db: Db, fiscalYearId: string): Promise<Money> {
  const rows = await profitAndLossRows(db, fiscalYearId, { excludeClosing: true });
  return netIncomeOf(rows.filter((row) => row.group !== "income_taxes"));
}

export interface CorporateTaxSummary {
  fiscalYear: { id: string; no: number; startDate: CalendarDate; endDate: CalendarDate };
  /** 所得の概算 before the carryforward. */
  pretaxIncome: Money;
  /** 繰越欠損金 from the earlier years. */
  lossCarryforward: Money;
  estimate: CorporateTaxEstimate;
  /** 法人税等 (income_taxes accounts) booked in the year, closing entry excluded. */
  booked: Money;
  /** max(0, estimate − booked): the default of the entry. */
  suggested: Money;
  posted: EntryRef | null;
  /** 申告・納付の期限. */
  dueDate: CalendarDate;
}

async function corporateTaxSummary(db: Db, year: FiscalYear): Promise<CorporateTaxSummary> {
  const period = toFiscalYearContext(year);
  const rows = await profitAndLossRows(db, year.id, { excludeClosing: true });
  const pretaxIncome = netIncomeOf(rows.filter((row) => row.group !== "income_taxes"));
  const booked = rows
    .filter((row) => row.group === "income_taxes")
    .reduce((sum, row) => sum + row.net, 0n);
  const earlier = await db.fiscalYear.findMany({
    where: { companyId: year.companyId, startDate: { lt: year.startDate } },
    orderBy: { startDate: "asc" },
  });
  const prior = [];
  for (const other of earlier) {
    prior.push({
      startDate: fromDbDate(other.startDate),
      endDate: fromDbDate(other.endDate),
      pretaxIncome: await pretaxIncomeOf(db, other.id),
    });
  }
  const carryforward = lossCarryforward(prior, period.startDate);
  const estimate = estimateCorporateTax({
    period,
    pretaxIncome,
    lossCarryforward: carryforward,
  });
  const suggested = estimate.total - booked;
  return {
    fiscalYear: { id: year.id, no: year.no, startDate: period.startDate, endDate: period.endDate },
    pretaxIncome,
    lossCarryforward: carryforward,
    estimate,
    booked,
    suggested: suggested > 0n ? suggested : 0n,
    posted: await liveEntry(db, year.id, yearEndSourceId("corporate_tax", year.id)),
    dueDate: corporateTaxDueDate(period.endDate),
  };
}

/** 法人税等の概算 of a fiscal year (#19, §12). */
export async function loadCorporateTaxEstimate(
  db: Db,
  fiscalYearId: string,
): Promise<CorporateTaxSummary> {
  return corporateTaxSummary(db, await findYear(db, fiscalYearId));
}

export type YearEndPurpose =
  | "depreciation"
  | "deferred"
  | "accrual"
  | "accrual_reversal"
  | "consumption_tax"
  | "corporate_tax"
  | "voucher";

export const YEAR_END_PURPOSE_LABELS: Readonly<Record<YearEndPurpose, string>> = {
  depreciation: "減価償却",
  deferred: "繰延資産の償却",
  accrual: "前払・未払",
  accrual_reversal: "振り戻し",
  consumption_tax: "消費税",
  corporate_tax: "法人税等",
  voucher: "伝票",
};

export interface YearEndAdjustingEntry extends EntryRef {
  description: string;
  sourceKind: SourceKind;
  purpose: YearEndPurpose;
  /** 「減価償却 ノート PC」, 「法人税等」… */
  purposeLabel: string;
  amount: Money;
}

async function loadAdjustingEntries(db: Db, year: FiscalYear): Promise<YearEndAdjustingEntry[]> {
  const entries = await db.journalEntry.findMany({
    where: { fiscalYearId: year.id, kind: "adjusting", status: "posted" },
    select: {
      ...refSelect,
      description: true,
      sourceKind: true,
      sourceId: true,
      lines: { where: { side: "debit" }, select: { amount: true } },
    },
    orderBy: { no: "asc" },
  });
  const assetIds = entries
    .filter((entry) => entry.sourceKind === "fixed_asset" && entry.sourceId)
    .map((entry) => entry.sourceId ?? "");
  const assets = new Map(
    (
      await db.fixedAsset.findMany({
        where: { id: { in: assetIds } },
        select: { id: true, name: true },
      })
    ).map((asset) => [asset.id, asset.name]),
  );
  return entries.map((entry) => {
    let purpose: YearEndPurpose = "voucher";
    if (entry.sourceKind === "fixed_asset") purpose = "depreciation";
    else if (entry.sourceKind === "year_end") {
      const parsed = parseYearEndSourceId(entry.sourceId);
      if (parsed && parsed.purpose !== "closing") purpose = parsed.purpose;
    }
    const label = YEAR_END_PURPOSE_LABELS[purpose];
    const assetName = purpose === "depreciation" ? assets.get(entry.sourceId ?? "") : undefined;
    return {
      ...refOf(entry),
      description: entry.description,
      sourceKind: entry.sourceKind,
      purpose,
      purposeLabel: assetName ? `${label} ${assetName}` : label,
      amount: entry.lines.reduce((sum, line) => sum + line.amount, 0n),
    };
  });
}

interface YearEndCheckRecord {
  at: string;
  actor: string;
}

export type YearEndChecks = Record<YearEndCheckKey, YearEndCheckRecord | null>;

function readChecks(value: Prisma.JsonValue | null): YearEndChecks {
  const result: YearEndChecks = { balances: null, accruals: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const key of ["balances", "accruals"] as const) {
    const item = (value as Record<string, unknown>)[key];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const { at, actor } = item as Record<string, unknown>;
      if (typeof at === "string" && typeof actor === "string") result[key] = { at, actor };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The checklist (§3)
// ---------------------------------------------------------------------------

export type YearEndStepKey =
  | "statements"
  | "documents"
  | "balances"
  | "depreciation"
  | "accruals"
  | "consumption_tax"
  | "corporate_tax"
  | "closing"
  | "statements_report"
  | "export";

/** 完了 / 未完了 / 準備中 / 対象外. */
export type YearEndStepState = "done" | "todo" | "pending" | "na";

export interface YearEndStep {
  key: YearEndStepKey;
  no: number;
  label: string;
  state: YearEndStepState;
  summary: string;
}

export interface YearEndYearRef {
  id: string;
  no: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
  status: FiscalYearStatus;
  lockedThrough: CalendarDate | null;
}

export interface YearEndChecklist {
  fiscalYear: YearEndYearRef & {
    consumptionTax: ConsumptionTaxMethod;
    accountingMethod: AccountingMethod;
  };
  previous: YearEndYearRef | null;
  next: YearEndYearRef | null;
  today: CalendarDate;
  canStart: boolean;
  startBlockedReason: string | null;
  /** The monthly close after 決算整理を始める (moved back from the last day). */
  lockedThroughAfterStart: CalendarDate | null;
  /** 通常の仕訳 (normal, transfer, opening; posted) that the start makes read-only. */
  normalEntryCount: number;
  /** 計上 is possible (the year is in its year-end adjustments). */
  canPost: boolean;
  steps: YearEndStep[];
  wallets: YearEndWalletRow[];
  depreciation: YearEndDepreciationRow[];
  deferred: YearEndDeferredRow[];
  accruals: YearEndAccruals;
  consumptionTax: YearEndConsumptionTax;
  corporateTax: CorporateTaxSummary;
  closing: {
    /** 当期純利益 before 決算振替. */
    netIncome: Money;
    closingEntry: EntryRef | null;
    /** Steps 4–7 not done (shown in the confirmation of 締める; it does not stop). */
    warnings: string[];
  };
  /** The year's adjusting entries in force, with what they are for. */
  adjustingEntries: YearEndAdjustingEntry[];
  checks: YearEndChecks;
}

function yearRef(row: FiscalYear): YearEndYearRef {
  const period = toFiscalYearContext(row);
  return {
    id: row.id,
    no: row.no,
    startDate: period.startDate,
    endDate: period.endDate,
    status: row.status,
    lockedThrough: period.lockedThrough,
  };
}

/** The read model of /closing for one fiscal year (§3–§10). Read only. */
export async function loadYearEndChecklist(
  db: Db,
  fiscalYearId: string,
  options: { today?: CalendarDate } = {},
): Promise<YearEndChecklist> {
  const today = options.today ?? todayInJapan();
  const year = await findYear(db, fiscalYearId);
  const { previous, next } = await neighborYears(db, year);
  const period = toFiscalYearContext(year);
  const start = checkYearEndStart({ ...period, no: year.no, status: year.status }, previous, today);
  const normalEntryCount = await db.journalEntry.count({
    where: {
      fiscalYearId: year.id,
      status: "posted",
      kind: { in: ["normal", "transfer", "opening"] },
    },
  });
  const wallets = await loadWalletRows(db, period.endDate);
  const depreciation = await loadDepreciationRows(db, year);
  const deferred = await loadDeferredRows(db, year);
  const accruals = await loadAccruals(db, year, next);
  const consumptionTax = await loadConsumptionTax(db, year);
  const corporateTax = await corporateTaxSummary(db, year);
  const plRows = await profitAndLossRows(db, year.id, { excludeClosing: true });
  const closingRow = await db.journalEntry.findFirst({
    where: { fiscalYearId: year.id, kind: "closing", status: "posted" },
    select: refSelect,
  });
  const adjustingEntries = await loadAdjustingEntries(db, year);
  const inboxDocuments = await countInboxDocuments(db);
  const checks = readChecks(year.yearEndChecks);

  const depreciationTargets = depreciation.filter((row) => row.amount > 0n);
  const deferredTargets = deferred.filter((row) => row.cost - row.amortizedBefore > 0n);
  const targetCount = depreciationTargets.length + deferredTargets.length;
  const postedCount =
    depreciationTargets.filter((row) => row.entries.length > 0).length +
    deferredTargets.filter((row) => row.posted !== null).length;

  const steps: YearEndStep[] = [
    {
      key: "statements",
      no: 1,
      label: "未処理の明細",
      state: "pending",
      summary: "明細の片付けの画面ができると、期末日までの未処理の件数を確かめられます",
    },
    {
      // 受信箱 of S6 (13-documents §3.2): not linked yet, or linked without a date, an amount or a
      // partner. The same count the monthly close and the home use.
      key: "documents",
      no: 2,
      label: "未紐づけの証憑",
      state: inboxDocuments === 0 ? "done" : "todo",
      summary:
        inboxDocuments === 0
          ? "受信箱の証憑はありません"
          : `受信箱の証憑 ${inboxDocuments} 件（未紐づけか未整理）を片付けます`,
    },
    {
      key: "balances",
      no: 3,
      label: "残高の照合",
      state: checks.balances ? "done" : "todo",
      summary: checks.balances
        ? `照合しました（口座 ${wallets.length} 件）`
        : `口座 ${wallets.length} 件の期末の残高を確かめます`,
    },
    {
      key: "depreciation",
      no: 4,
      label: "減価償却・繰延資産",
      state: postedCount === targetCount ? "done" : "todo",
      summary:
        targetCount === 0
          ? "当期に償却する資産はありません"
          : `${targetCount} 件のうち ${postedCount} 件を計上済み`,
    },
    {
      key: "accruals",
      no: 5,
      label: "前払・未払",
      state: checks.accruals ? "done" : "todo",
      summary: checks.accruals
        ? `確認しました（登録 ${accruals.entries.length} 件）`
        : `登録 ${accruals.entries.length} 件。該当がなくても確かめて「確認した」を押します`,
    },
    {
      key: "consumption_tax",
      no: 6,
      label: "消費税",
      state: !consumptionTax.applicable ? "na" : consumptionTax.posted ? "done" : "todo",
      summary: !consumptionTax.applicable
        ? "免税の期のため不要"
        : consumptionTax.posted
          ? `精算を計上済み（No. ${consumptionTax.posted.no}）`
          : `仮受 ${formatYen(consumptionTax.outputTaxBalance)} 円・仮払 ${formatYen(consumptionTax.inputTaxBalance)} 円を精算します`,
    },
    {
      key: "corporate_tax",
      no: 7,
      label: "法人税等",
      state: corporateTax.booked !== 0n ? "done" : "todo",
      summary:
        corporateTax.booked !== 0n
          ? `${formatYen(corporateTax.booked)} 円を計上済み`
          : `概算 ${formatYen(corporateTax.estimate.total)} 円（納付期限 ${displayDate(corporateTax.dueDate)}）`,
    },
    {
      key: "closing",
      no: 8,
      label: "締め",
      state: year.status === "closed" ? "done" : "todo",
      summary:
        year.status === "closed"
          ? closingRow
            ? `締め済み（決算振替 No. ${closingRow.no}）`
            : "締め済み"
          : "決算振替を登録して締めます",
    },
    { key: "statements_report", no: 9, label: "決算書", state: "pending", summary: "準備中" },
    { key: "export", no: 10, label: "書き出し", state: "pending", summary: "準備中" },
  ];
  const warnings = steps
    .filter((step) => step.no >= 4 && step.no <= 7 && step.state === "todo")
    .map((step) => `${step.label}が未完了です（${step.summary}）`);

  return {
    fiscalYear: {
      ...yearRef(year),
      consumptionTax: year.consumptionTax,
      accountingMethod: year.accountingMethod,
    },
    previous: previous ? yearRef(previous) : null,
    next: next ? yearRef(next) : null,
    today,
    canStart: start.canStart,
    startBlockedReason: start.reason,
    lockedThroughAfterStart: start.lockedThroughAfterStart,
    normalEntryCount,
    canPost: year.status === "closing",
    steps,
    wallets,
    depreciation,
    deferred,
    accruals,
    consumptionTax,
    corporateTax,
    closing: {
      netIncome: netIncomeOf(plRows),
      closingEntry: closingRow ? refOf(closingRow) : null,
      warnings,
    },
    adjustingEntries,
    checks,
  };
}

// ---------------------------------------------------------------------------
// 計上 (§4.3, §6–§9)
// ---------------------------------------------------------------------------

export interface PostedDepreciation {
  assetId: string;
  amount: Money;
  entry: EntryRef;
}

/**
 * 減価償却の計上 (§4.3): one entry per asset for the year's amount. Without `assetIds`, every asset
 * with an amount and no entry yet; with them, exactly those (an asset already posted is refused).
 */
export async function postDepreciation(
  db: Db,
  fiscalYearId: string,
  input: PostDepreciationInput,
  options: ActorOptions,
): Promise<PostedDepreciation[]> {
  const data = postDepreciationSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const year = await lockClosingYear(tx, fiscalYearId);
    if (data.assetIds) {
      for (const id of data.assetIds) {
        await tx.$queryRaw`SELECT "id" FROM "fixed_asset" WHERE "id" = ${id} FOR UPDATE`;
      }
    }
    const rows = await loadDepreciationRows(tx, year);
    const wanted = data.assetIds ? new Set(data.assetIds) : null;
    if (wanted) {
      for (const id of wanted) {
        const row = rows.find((candidate) => candidate.assetId === id);
        if (!row) {
          throw new SettingsError(`第 ${year.no} 期に償却する額がない固定資産です`, {
            field: "assetIds",
          });
        }
        if (row.entries.length > 0) throw new SettingsError(ALREADY_POSTED, { field: "assetIds" });
      }
    }
    const targets = rows.filter(
      (row) => row.amount > 0n && row.entries.length === 0 && (!wanted || wanted.has(row.assetId)),
    );
    if (targets.length === 0) return [];
    const expense = await requireAccountByCode(tx, DEPRECIATION_EXPENSE_CODE);
    const accumulated = targets.some(
      (row) => row.creditAccountCode === ACCUMULATED_DEPRECIATION_CODE,
    )
      ? await requireAccountByCode(tx, ACCUMULATED_DEPRECIATION_CODE)
      : null;
    const endDate = fromDbDate(year.endDate);
    const posted: PostedDepreciation[] = [];
    for (const row of targets) {
      const asset = await tx.fixedAsset.findUniqueOrThrow({
        where: { id: row.assetId },
        select: { segmentId: true },
      });
      const creditAccountId =
        row.creditAccountCode === ACCUMULATED_DEPRECIATION_CODE && accumulated
          ? accumulated.id
          : row.accountId;
      const entry = buildDepreciationEntry({
        date: endDate,
        assetId: row.assetId,
        assetName: row.name,
        amount: row.amount,
        expenseAccountId: expense.id,
        creditAccountId,
        segmentId: asset.segmentId ?? (await segmentFor(tx, expense)),
      });
      const stored = await postJournalEntryInTransaction(
        tx,
        { ...entry, fiscalYearId: year.id },
        options,
      );
      posted.push({
        assetId: row.assetId,
        amount: row.amount,
        entry: { id: stored.id, no: stored.no, entryDate: stored.entryDate },
      });
    }
    return posted;
  });
}

/** 繰延資産の償却 (§6): 5 年 or 全額 of 創立費 / 開業費, once a year per account. */
export async function postDeferredAmortization(
  db: Db,
  fiscalYearId: string,
  input: DeferredAmortizationInput,
  options: ActorOptions,
): Promise<EntryRef> {
  const data = deferredAmortizationSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const year = await lockClosingYear(tx, fiscalYearId);
    const account = await tx.account.findUnique({
      where: { id: data.accountId },
      select: { id: true, code: true, name: true, isActive: true },
    });
    const expenseCode = account ? DEFERRED_ASSET_EXPENSE_CODES[account.code] : undefined;
    if (!account || !expenseCode) {
      throw new SettingsError("創立費か開業費を選んでください", { field: "accountId" });
    }
    if (await liveEntry(tx, year.id, yearEndSourceId("deferred", year.id, account.id))) {
      throw new SettingsError(ALREADY_POSTED);
    }
    const row = (await loadDeferredRows(tx, year)).find(
      (candidate) => candidate.accountId === account.id,
    );
    const amount = row ? (data.mode === "full" ? row.full : row.fiveYears) : 0n;
    if (!row || amount <= 0n) {
      throw new SettingsError(`${account.name}に償却する残高がありません`, { field: "accountId" });
    }
    const expense = await requireAccountByCode(tx, expenseCode);
    const entry = buildDeferredAmortizationEntry({
      date: fromDbDate(year.endDate),
      fiscalYearId: year.id,
      deferredAccountId: account.id,
      deferredAccountName: account.name,
      expenseAccountId: expense.id,
      amount,
      segmentId: await segmentFor(tx, expense),
    });
    const stored = await postJournalEntryInTransaction(
      tx,
      { ...entry, fiscalYearId: year.id },
      options,
    );
    return { id: stored.id, no: stored.no, entryDate: stored.entryDate };
  });
}

export interface PostedAccrual {
  entry: EntryRef;
  /** The reversal on the next year's first day, when chosen. */
  reversal: EntryRef | null;
}

async function accrualBalanceAccount(tx: Tx, type: AccrualType): Promise<YearEndAccount> {
  const code = ACCRUAL_BALANCE_ACCOUNT_CODES[type];
  if (code) return requireAccountByCode(tx, code);
  const supplies = await findSuppliesAccount(tx);
  if (!supplies) {
    throw new SettingsError(
      `${SUPPLIES_ACCOUNT_NAME}の科目がありません。設定 › 勘定科目 で ${SUPPLIES_ACCOUNT_NAME} を足してください（流動資産）`,
      { field: "type" },
    );
  }
  return { ...supplies, kind: "asset", group: "current_assets" as AccountGroup };
}

/**
 * 前払・未払・前受・貯蔵品 (§7) with, by default, the reversal on the next year's first day in the same
 * transaction (the next year must exist, be open and have its first day not closed).
 */
export async function postAccrual(
  db: Db,
  fiscalYearId: string,
  input: AccrualEntryInput,
  options: ActorOptions,
): Promise<PostedAccrual> {
  const data = accrualEntrySchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const found = await findYear(tx, fiscalYearId);
    const { next: nextFound } = await neighborYears(tx, found);
    const year = await lockClosingYear(tx, fiscalYearId, data.reverse ? [nextFound?.id] : []);
    const next = nextFound
      ? await tx.fiscalYear.findUniqueOrThrow({ where: { id: nextFound.id } })
      : null;
    if (data.reverse) {
      const availability = reversalAvailability(year, next);
      if (!availability.available) {
        throw new SettingsError(availability.reason ?? "振り戻しは登録できません", {
          field: "reverse",
        });
      }
    }
    const balance = await accrualBalanceAccount(tx, data.type);
    const pl = await tx.account.findUnique({
      where: { id: data.plAccountId },
      select: {
        id: true,
        code: true,
        name: true,
        kind: true,
        isActive: true,
        defaultSegmentId: true,
      },
    });
    const wantedKind: AccountKind = ACCRUAL_PL_ACCOUNT_KINDS[data.type];
    if (!pl || pl.kind !== wantedKind || !pl.isActive) {
      throw new SettingsError(
        `${ACCRUAL_TYPE_LABELS[data.type]}の科目は、有効な${wantedKind === "revenue" ? "収益" : "費用"}の科目から選んでください`,
        { field: "plAccountId" },
      );
    }
    const entry = buildAccrualEntry({
      date: fromDbDate(year.endDate),
      fiscalYearId: year.id,
      type: data.type,
      balanceAccountId: balance.id,
      plAccountId: pl.id,
      amount: data.amount,
      segmentId: data.segmentId ?? (await segmentFor(tx, pl)),
      description: data.description ?? "",
    });
    const stored = await postJournalEntryInTransaction(
      tx,
      { ...entry, fiscalYearId: year.id },
      options,
    );
    let reversal: EntryRef | null = null;
    if (data.reverse && next) {
      const reversed = buildAccrualReversal(entry, {
        date: fromDbDate(next.startDate),
        originalEntryId: stored.id,
      });
      const storedReversal = await postJournalEntryInTransaction(
        tx,
        { ...reversed, fiscalYearId: next.id },
        options,
      );
      reversal = {
        id: storedReversal.id,
        no: storedReversal.no,
        entryDate: storedReversal.entryDate,
      };
    }
    return { entry: { id: stored.id, no: stored.no, entryDate: stored.entryDate }, reversal };
  });
}

/** 消費税の精算 (§8): taxable years only, once a year. */
export async function postConsumptionTaxSettlement(
  db: Db,
  fiscalYearId: string,
  input: ConsumptionTaxSettlementInput,
  options: ActorOptions,
): Promise<EntryRef> {
  const data = consumptionTaxSettlementSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const year = await lockClosingYear(tx, fiscalYearId);
    if (year.consumptionTax === "exempt") {
      throw new SettingsError("免税の期のため、消費税の精算は要りません");
    }
    const tax = await loadConsumptionTax(tx, year);
    if (tax.posted) throw new SettingsError(ALREADY_POSTED);
    const payable = data.payable;
    const exclusive = year.accountingMethod === "tax_exclusive";
    const difference = tax.outputTaxBalance - tax.inputTaxBalance - payable;
    const need = async (code: string, needed: boolean) =>
      needed ? (await requireAccountByCode(tx, code)).id : "";
    const corporate = await corporateSegmentId(tx);
    const entry = buildConsumptionTaxSettlement({
      date: fromDbDate(year.endDate),
      fiscalYearId: year.id,
      accountingMethod: year.accountingMethod,
      outputTaxBalance: exclusive ? tax.outputTaxBalance : 0n,
      inputTaxBalance: exclusive ? tax.inputTaxBalance : 0n,
      payable,
      accounts: {
        outputTax: await need(OUTPUT_TAX_ACCOUNT_CODE, exclusive && tax.outputTaxBalance !== 0n),
        inputTax: await need(INPUT_TAX_ACCOUNT_CODE, exclusive && tax.inputTaxBalance !== 0n),
        payable: await need(CONSUMPTION_TAX_PAYABLE_CODE, payable > 0n),
        receivable: await need(OTHER_RECEIVABLE_CODE, payable < 0n),
        miscIncome: await need(MISC_INCOME_CODE, exclusive ? difference > 0n : payable < 0n),
        miscLoss: await need(MISC_LOSS_CODE, exclusive && difference < 0n),
        taxesAndDues: await need(TAXES_AND_DUES_CODE, !exclusive && payable > 0n),
      },
      segmentId: corporate,
    });
    if (!entry) throw new SettingsError("精算する額がありません", { field: "payable" });
    const stored = await postJournalEntryInTransaction(
      tx,
      { ...entry, fiscalYearId: year.id },
      options,
    );
    return { id: stored.id, no: stored.no, entryDate: stored.entryDate };
  });
}

/** 法人税等の計上 (§9): 借方 法人税、住民税及び事業税 / 貸方 未払法人税等, once a year. */
export async function postCorporateTax(
  db: Db,
  fiscalYearId: string,
  input: CorporateTaxEntryInput,
  options: ActorOptions,
): Promise<EntryRef> {
  const data = corporateTaxEntrySchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const year = await lockClosingYear(tx, fiscalYearId);
    if (await liveEntry(tx, year.id, yearEndSourceId("corporate_tax", year.id))) {
      throw new SettingsError(ALREADY_POSTED);
    }
    const expense = await requireAccountByCode(tx, CORPORATE_TAX_EXPENSE_CODE);
    const payable = await requireAccountByCode(tx, CORPORATE_TAX_PAYABLE_CODE);
    const entry = buildCorporateTaxEntry({
      date: fromDbDate(year.endDate),
      fiscalYearId: year.id,
      amount: data.amount,
      expenseAccountId: expense.id,
      payableAccountId: payable.id,
      segmentId: await segmentFor(tx, expense),
    });
    const stored = await postJournalEntryInTransaction(
      tx,
      { ...entry, fiscalYearId: year.id },
      options,
    );
    return { id: stored.id, no: stored.no, entryDate: stored.entryDate };
  });
}

// ---------------------------------------------------------------------------
// 取消 (§1.2, §7)
// ---------------------------------------------------------------------------

export interface VoidedYearEndEntry {
  voided: EntryRef;
  reversal: EntryRef;
  /** The next year's accrual reversal voided with it. */
  accrualReversal: { voided: EntryRef; reversal: EntryRef } | null;
}

/**
 * 取り消す on /closing (§1.2): an adjusting entry of a year in progress (S3's void) or in its year-end
 * adjustments (`voidEntryInYearEnd`). A closed year is refused. An accrual's reversal in the next year
 * is voided with it (refused when that year is not open).
 */
export async function voidYearEndEntry(
  db: Db,
  entryId: string,
  input: YearEndVoidInput,
  options: ActorOptions,
): Promise<VoidedYearEndEntry> {
  const data = yearEndVoidSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const original = await tx.journalEntry.findUnique({
      where: { id: entryId },
      select: { id: true, kind: true, fiscalYearId: true, sourceKind: true, sourceId: true },
    });
    if (!original) throw new SettingsError("仕訳が見つかりません。画面を読み込み直してください");
    const isAccrual =
      original.sourceKind === "year_end" &&
      parseYearEndSourceId(original.sourceId)?.purpose === "accrual";
    const reversalOfAccrual = isAccrual
      ? await tx.journalEntry.findFirst({
          where: {
            sourceId: accrualReversalSourceId(entryId),
            kind: "adjusting",
            status: "posted",
          },
          select: { id: true, fiscalYearId: true },
        })
      : null;
    // Entry rows first, then the fiscal years in ascending `no`.
    await tx.$queryRaw`SELECT "id" FROM "journal_entry" WHERE "id" = ${entryId} FOR UPDATE`;
    if (reversalOfAccrual) {
      await tx.$queryRaw`SELECT "id" FROM "journal_entry" WHERE "id" = ${reversalOfAccrual.id} FOR UPDATE`;
    }
    await lockFiscalYears(tx, [original.fiscalYearId, reversalOfAccrual?.fiscalYearId]);
    const entry = await tx.journalEntry.findUniqueOrThrow({
      where: { id: entryId },
      select: { status: true, kind: true },
    });
    if (entry.kind !== "adjusting") {
      throw new SettingsError("ここで取り消せるのは決算整理仕訳だけです");
    }
    if (entry.status !== "posted") throw new SettingsError("取消済みです");
    const year = await tx.fiscalYear.findUniqueOrThrow({ where: { id: original.fiscalYearId } });
    if (year.status === "closed") {
      throw new SettingsError(
        `第 ${year.no} 期は締め済みのため、取り消せません。締めを戻してから取り消してください`,
      );
    }
    let accrualReversal: VoidedYearEndEntry["accrualReversal"] = null;
    if (reversalOfAccrual) {
      const nextYear = await tx.fiscalYear.findUniqueOrThrow({
        where: { id: reversalOfAccrual.fiscalYearId },
      });
      if (nextYear.status !== "open") {
        throw new SettingsError(
          `第 ${nextYear.no} 期が進行中でないため、振り戻しを取り消せません。振り戻しと一緒に取り消すには第 ${nextYear.no} 期を進行中に戻してください`,
        );
      }
      const result = await voidJournalEntryWithOpenDate(
        tx,
        reversalOfAccrual.id,
        { reason: data.reason },
        options,
      );
      accrualReversal = {
        voided: { id: result.voided.id, no: result.voided.no, entryDate: result.voided.entryDate },
        reversal: {
          id: result.reversal.id,
          no: result.reversal.no,
          entryDate: result.reversal.entryDate,
        },
      };
    }
    const result =
      year.status === "open"
        ? await voidJournalEntryWithOpenDate(tx, entryId, { reason: data.reason }, options)
        : await voidEntryInYearEnd(tx, entryId, { reason: data.reason, actor: options.actor });
    return {
      voided: { id: result.voided.id, no: result.voided.no, entryDate: result.voided.entryDate },
      reversal: {
        id: result.reversal.id,
        no: result.reversal.no,
        entryDate: result.reversal.entryDate,
      },
      accrualReversal,
    };
  });
}

// ---------------------------------------------------------------------------
// 確認 (§3)
// ---------------------------------------------------------------------------

/** 「照合した」「確認した」 and 「確認を外す」 (§3). Audit: `fiscal_year.check`. */
export async function setYearEndCheck(
  db: Db,
  fiscalYearId: string,
  input: YearEndCheckInput,
  options: ActorOptions,
): Promise<YearEndChecks> {
  const data = yearEndCheckSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await findYear(tx, fiscalYearId);
    await lockFiscalYears(tx, [fiscalYearId]);
    const year = await tx.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } });
    if (year.status === "closed") {
      throw new SettingsError(`第 ${year.no} 期は締め済みのため、確認は変えられません`);
    }
    const checks = readChecks(year.yearEndChecks);
    const before = checks[data.key];
    const after = data.checked ? { at: new Date().toISOString(), actor: options.actor } : null;
    const next: YearEndChecks = { ...checks, [data.key]: after };
    const stored: Record<string, Prisma.InputJsonObject> = {};
    for (const key of ["balances", "accruals"] as const) {
      const item = next[key];
      if (item) stored[key] = { at: item.at, actor: item.actor };
    }
    await tx.fiscalYear.update({ where: { id: year.id }, data: { yearEndChecks: stored } });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "fiscal_year.check",
      entity: "fiscal_year",
      entityId: year.id,
      before: { [data.key]: before },
      after: { [data.key]: after },
    });
    return next;
  });
}

// ---------------------------------------------------------------------------
// 期末と翌期首の残高 (§10)
// ---------------------------------------------------------------------------

export interface YearEndBalanceRow {
  accountId: string;
  code: string;
  name: string;
  kind: AccountKind;
  group: AccountGroup;
  /** 期末残高 before 決算振替 (normal side). */
  beforeClosing: Money;
  /** What the closing entry (and its voids) did (normal side). */
  closing: Money;
  /** 翌期首の残高 = beforeClosing + closing. */
  opening: Money;
}

export interface BalanceTotals {
  assets: Money;
  liabilities: Money;
  equity: Money;
}

export interface YearEndBalances {
  fiscalYear: YearEndYearRef;
  closingEntry: EntryRef | null;
  rows: YearEndBalanceRow[];
  totals: { beforeClosing: BalanceTotals; opening: BalanceTotals };
  /** 当期純利益 before 決算振替. */
  netIncome: Money;
  /** P&L of the earlier years not closed into 繰越利益剰余金 (0 when they are all closed). */
  priorPeriodsProfit: Money;
  /** 資産 = 負債 + 純資産 (+ the P&L not closed yet), before and after the closing entry. */
  balanced: boolean;
}

/**
 * The balance-sheet accounts at the year end before and after the closing entry, i.e. the next
 * year's opening balances (§10; they are never stored). Read only.
 */
export async function loadYearEndBalances(db: Db, fiscalYearId: string): Promise<YearEndBalances> {
  const year = await findYear(db, fiscalYearId);
  const accounts = await db.account.findMany({
    select: { id: true, code: true, name: true, kind: true, group: true },
    orderBy: { code: "asc" },
  });
  const closingIds = await closingEntryIds(db, year.id);
  const before = await netByAccount(db, {
    journalEntry: {
      entryDate: { lte: year.endDate },
      ...(closingIds.length > 0 ? { id: { notIn: closingIds } } : {}),
    },
  });
  const effect =
    closingIds.length > 0
      ? await netByAccount(db, { journalEntry: { id: { in: closingIds } } })
      : new Map<string, Money>();
  const priorNet = await netByAccount(db, { journalEntry: { entryDate: { lt: year.startDate } } });
  const plRows = await profitAndLossRows(db, year.id, { excludeClosing: true });
  const plAfter = await profitAndLossRows(db, year.id);

  const rows: YearEndBalanceRow[] = [];
  const totals = {
    beforeClosing: { assets: 0n, liabilities: 0n, equity: 0n },
    opening: { assets: 0n, liabilities: 0n, equity: 0n },
  };
  let priorPeriodsProfit = 0n;
  for (const account of accounts) {
    if (account.kind === "revenue" || account.kind === "expense") {
      priorPeriodsProfit -= priorNet.get(account.id) ?? 0n;
      continue;
    }
    if (account.kind === "internal") continue;
    const sign = account.kind === "asset" ? 1n : -1n;
    const beforeClosing = sign * (before.get(account.id) ?? 0n);
    const closing = sign * (effect.get(account.id) ?? 0n);
    if (beforeClosing === 0n && closing === 0n) continue;
    const opening = beforeClosing + closing;
    rows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      kind: account.kind,
      group: account.group,
      beforeClosing,
      closing,
      opening,
    });
    const key =
      account.kind === "asset" ? "assets" : account.kind === "liability" ? "liabilities" : "equity";
    totals.beforeClosing[key] += beforeClosing;
    totals.opening[key] += opening;
  }
  const netIncome = netIncomeOf(plRows);
  const remaining = netIncomeOf(plAfter);
  const balanced =
    totals.beforeClosing.assets ===
      totals.beforeClosing.liabilities +
        totals.beforeClosing.equity +
        priorPeriodsProfit +
        netIncome &&
    totals.opening.assets ===
      totals.opening.liabilities + totals.opening.equity + priorPeriodsProfit + remaining;
  const closingEntry = await db.journalEntry.findFirst({
    where: { fiscalYearId: year.id, kind: "closing", status: "posted" },
    select: refSelect,
  });
  return {
    fiscalYear: yearRef(year),
    closingEntry: closingEntry ? refOf(closingEntry) : null,
    rows,
    totals,
    netIncome,
    priorPeriodsProfit,
    balanced,
  };
}
