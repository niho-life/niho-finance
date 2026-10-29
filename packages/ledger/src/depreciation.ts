import {
  addDays,
  dateParts,
  displayDate,
  isCalendarDate,
  lastDayOfMonth,
  type CalendarDate,
} from "./date";
import { deriveNextFiscalYear } from "./fiscal-year";
import { formatYen, type Money } from "./money";
import type { AccountGroup } from "./types";

/**
 * 減価償却・繰延資産の償却 (docs/design/16-year-end.md §4–§6). Pure functions on integers only:
 * rates are per mille (償却率) or per 100,000 (保証率), and every product is bigint math that is
 * truncated once at the end (1 円未満切り捨て, 別表十六(二) の記載要領).
 */

// ---------------------------------------------------------------------------
// 償却率 (別表第八・別表第十)
// ---------------------------------------------------------------------------

// Generated from e-Gov 減価償却資産の耐用年数等に関する省令（昭和四十年大蔵省令第十五号）別表第八・別表第十
// [usefulLife, straightLine‰, decliningRate‰, revisedRate‰ | null, guaranteeRate (per 100,000) | null]
const RATE_ROWS = [
  [2, 500, 1000, null, null],
  [3, 334, 667, 1000, 11089],
  [4, 250, 500, 1000, 12499],
  [5, 200, 400, 500, 10800],
  [6, 167, 333, 334, 9911],
  [7, 143, 286, 334, 8680],
  [8, 125, 250, 334, 7909],
  [9, 112, 222, 250, 7126],
  [10, 100, 200, 250, 6552],
  [11, 91, 182, 200, 5992],
  [12, 84, 167, 200, 5566],
  [13, 77, 154, 167, 5180],
  [14, 72, 143, 167, 4854],
  [15, 67, 133, 143, 4565],
  [16, 63, 125, 143, 4294],
  [17, 59, 118, 125, 4038],
  [18, 56, 111, 112, 3884],
  [19, 53, 105, 112, 3693],
  [20, 50, 100, 112, 3486],
  [21, 48, 95, 100, 3335],
  [22, 46, 91, 100, 3182],
  [23, 44, 87, 91, 3052],
  [24, 42, 83, 84, 2969],
  [25, 40, 80, 84, 2841],
  [26, 39, 77, 84, 2716],
  [27, 38, 74, 77, 2624],
  [28, 36, 71, 72, 2568],
  [29, 35, 69, 72, 2463],
  [30, 34, 67, 72, 2366],
  [31, 33, 65, 67, 2286],
  [32, 32, 63, 67, 2216],
  [33, 31, 61, 63, 2161],
  [34, 30, 59, 63, 2097],
  [35, 29, 57, 59, 2051],
  [36, 28, 56, 59, 1974],
  [37, 28, 54, 56, 1950],
  [38, 27, 53, 56, 1882],
  [39, 26, 51, 53, 1860],
  [40, 25, 50, 53, 1791],
  [41, 25, 49, 50, 1741],
  [42, 24, 48, 50, 1694],
  [43, 24, 47, 48, 1664],
  [44, 23, 45, 46, 1664],
  [45, 23, 44, 46, 1634],
  [46, 22, 43, 44, 1601],
  [47, 22, 43, 44, 1532],
  [48, 21, 42, 44, 1499],
  [49, 21, 41, 42, 1475],
  [50, 20, 40, 42, 1440],
] as const;

export const DEPRECIATION_METHODS = [
  "straight_line",
  "declining_balance",
  "immediate",
  "lump_sum_3y",
] as const;
/**
 * `straight_line` 定額法, `declining_balance` 200% 定率法, `immediate` 即時償却 (少額 under 100,000 or
 * the 中小企業者の特例 from 100,000), `lump_sum_3y` 一括償却資産 (3 年).
 */
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export function isDepreciationMethod(value: unknown): value is DepreciationMethod {
  return typeof value === "string" && (DEPRECIATION_METHODS as readonly string[]).includes(value);
}

export const MIN_USEFUL_LIFE = 2;
export const MAX_USEFUL_LIFE = 50;

/** The rates of a useful life (平成 24 年 4 月 1 日以後に取得した資産). */
export interface DepreciationRates {
  usefulLife: number;
  /** 定額法の償却率 (per mille). */
  straightLineMille: number;
  /** 定率法の償却率 (per mille). */
  decliningMille: number;
  /** 改定償却率 (per mille). `null` for 2 years (the rate is already 1.000). */
  revisedMille: number | null;
  /** 保証率 (per 100,000). `null` for 2 years. */
  guaranteePer100k: number | null;
}

/** The rates of a useful life of 2–50 years, or `null` outside the table. */
export function depreciationRates(usefulLife: number): DepreciationRates | null {
  if (!Number.isInteger(usefulLife)) return null;
  const row = RATE_ROWS.find(([life]) => life === usefulLife);
  if (!row) return null;
  const [life, straightLineMille, decliningMille, revisedMille, guaranteePer100k] = row;
  return { usefulLife: life, straightLineMille, decliningMille, revisedMille, guaranteePer100k };
}

function isUsefulLife(value: number | null | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_USEFUL_LIFE &&
    value <= MAX_USEFUL_LIFE
  );
}

// ---------------------------------------------------------------------------
// 月数 (民法143条, 令59②, 省令5条⑤, 地方税法52条③)
// ---------------------------------------------------------------------------

function formatDate(year: number, month: number, day: number): CalendarDate {
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}` as CalendarDate;
}

/**
 * The last day of a period of `months` months that starts on `start` (民法143条): the day before the
 * corresponding day (応当日) `months` months later, or the last day of that month when it has no
 * corresponding day (`2027-01-31` + 1 → `2027-02-28`). `0` months ends the day before `start`.
 */
export function monthPeriodEnd(start: CalendarDate, months: number): CalendarDate {
  if (!Number.isSafeInteger(months) || months < 0) {
    throw new RangeError(`monthPeriodEnd: ${months} is not a whole number of months`);
  }
  const { year, month, day } = dateParts(start);
  const index = year * 12 + (month - 1) + months;
  const targetMonth = (index % 12) + 1;
  const targetYear = (index - (index % 12)) / 12;
  const monthEnd = lastDayOfMonth(targetYear, targetMonth);
  if (day > dateParts(monthEnd).day) return monthEnd;
  return addDays(formatDate(targetYear, targetMonth, day), -1);
}

/** Whole months from `from` to `to` (both inclusive), counted like 民法143条. Assumes from ≤ to. */
function fullMonths(from: CalendarDate, to: CalendarDate): number {
  const a = dateParts(from);
  const b = dateParts(to);
  // Two months past the calendar difference always ends after `to`; step back to the last fit.
  let months = (b.year - a.year) * 12 + (b.month - a.month) + 2;
  while (months > 0 && monthPeriodEnd(from, months) > to) months -= 1;
  return months;
}

/**
 * Months from `from` to `to`, both inclusive, as national taxes count them (令59②, 省令5条⑤):
 * whole months by 民法143条, and any remaining day is one more month (1 か月未満は 1 か月).
 * `2026-11-02`〜`2027-03-31` (4 か月と 30 日) → 5. Returns 0 when `to` is before `from`.
 */
export function countMonths(from: CalendarDate, to: CalendarDate): number {
  if (to < from) return 0;
  const full = fullMonths(from, to);
  return monthPeriodEnd(from, full) < to ? full + 1 : full;
}

/**
 * Months as 均等割 counts them (地方税法52条③・312条④): whole months by 民法143条, the remainder is
 * dropped, and a period shorter than a month counts as 1. `2026-11-02`〜`2027-03-31` → 4.
 * Returns 0 when `to` is before `from`.
 */
export function countLocalTaxMonths(from: CalendarDate, to: CalendarDate): number {
  if (to < from) return 0;
  const full = fullMonths(from, to);
  return full === 0 ? 1 : full;
}

// ---------------------------------------------------------------------------
// 少額・一括・特例の判定 (§4.1, §5.1)
// ---------------------------------------------------------------------------

/** 少額減価償却資産: cost below this is expensed when acquired (令133). */
export const SMALL_ASSET_LIMIT: Money = 100_000n;
/** 一括償却資産: cost below this may be written off over 3 years (令133の2). */
export const LUMP_SUM_LIMIT: Money = 200_000n;
/** 中小企業者等の特例: at most this much a year (× months ÷ 12 for a short year, 措法67条の5). */
export const SPECIAL_SMALL_ASSET_ANNUAL_CAP: Money = 3_000_000n;
/** Acquisitions on or after this date use the raised limit of 400,000 (令和 8 年度改正). */
export const SPECIAL_SMALL_ASSET_RAISED_FROM: CalendarDate = "2026-04-01";
/** The last acquisition date the special measure applies to. */
export const SPECIAL_SMALL_ASSET_LAST_DATE: CalendarDate = "2029-03-31";

/**
 * The upper limit (exclusive) of the 中小企業者等の特例 for an asset acquired on `acquisitionDate`:
 * 400,000 from 2026-04-01, 300,000 before, `null` after 2029-03-31 (the measure has ended).
 * An asset qualifies when `SMALL_ASSET_LIMIT ≤ cost < limit`.
 */
export function specialSmallAssetLimit(acquisitionDate: CalendarDate): Money | null {
  if (acquisitionDate > SPECIAL_SMALL_ASSET_LAST_DATE) return null;
  return acquisitionDate >= SPECIAL_SMALL_ASSET_RAISED_FROM ? 400_000n : 300_000n;
}

/** The yearly cap of the special measure for a fiscal year: 3,000,000 × months ÷ 12, truncated. */
export function specialSmallAssetCap(period: {
  startDate: CalendarDate;
  endDate: CalendarDate;
}): Money {
  const months = BigInt(countMonths(period.startDate, period.endDate));
  return (SPECIAL_SMALL_ASSET_ANNUAL_CAP * months) / 12n;
}

/** `immediate` from 100,000 is the 中小企業者等の特例 (below that it is 少額). */
export function isSpecialSmallAsset(asset: { method: DepreciationMethod; cost: Money }): boolean {
  return asset.method === "immediate" && asset.cost >= SMALL_ASSET_LIMIT;
}

// ---------------------------------------------------------------------------
// 償却できる科目 (§5.4)
// ---------------------------------------------------------------------------

/** 固定資産 accounts that are not depreciated: 減価償却累計額・敷金・保証金・長期前払費用. */
export const NON_DEPRECIABLE_FIXED_ASSET_CODES: readonly string[] = ["1590", "1600", "1800"];
/** 建物附属設備 and ソフトウェア can only use the straight-line method. */
export const STRAIGHT_LINE_ONLY_ACCOUNT_CODES: readonly string[] = ["1500", "1520"];
/** Intangible assets: not subject to 償却資産税. */
export const INTANGIBLE_ASSET_ACCOUNT_CODES: readonly string[] = ["1520"];

/** An account fixed assets can be registered on: 固定資産 except the non-depreciable ones. */
export function isDepreciableAccount(account: { code: string; group: AccountGroup }): boolean {
  return (
    account.group === "fixed_assets" && !NON_DEPRECIABLE_FIXED_ASSET_CODES.includes(account.code)
  );
}

/** Methods an asset on the account may use (no 定率法 for 建物附属設備・ソフトウェア). */
export function allowedDepreciationMethods(accountCode: string): DepreciationMethod[] {
  const straightLineOnly = STRAIGHT_LINE_ONLY_ACCOUNT_CODES.includes(accountCode);
  return DEPRECIATION_METHODS.filter(
    (method) => !(straightLineOnly && method === "declining_balance"),
  );
}

/**
 * The method the registration form proposes (§5.1): under 100,000 → 即時 (少額), under 200,000 →
 * 一括, under the special limit while the measure applies → 即時 (特例), otherwise 定率法
 * (定額法 for 建物附属設備・ソフトウェア).
 */
export function suggestDepreciationMethod(input: {
  cost: Money;
  acquisitionDate: CalendarDate;
  accountCode: string;
}): DepreciationMethod {
  if (input.cost < SMALL_ASSET_LIMIT) return "immediate";
  if (input.cost < LUMP_SUM_LIMIT) return "lump_sum_3y";
  const limit = specialSmallAssetLimit(input.acquisitionDate);
  if (limit !== null && input.cost < limit) return "immediate";
  return STRAIGHT_LINE_ONLY_ACCOUNT_CODES.includes(input.accountCode)
    ? "straight_line"
    : "declining_balance";
}

/**
 * Whether the asset is reported for 償却資産税 (§5.1): tangible assets on 定額・定率 and the special
 * measure are; 少額・一括 and intangible assets (ソフトウェア) are not.
 */
export function isDepreciableAssetTaxed(asset: {
  method: DepreciationMethod;
  cost: Money;
  accountCode: string;
}): boolean {
  if (INTANGIBLE_ASSET_ACCOUNT_CODES.includes(asset.accountCode)) return false;
  switch (asset.method) {
    case "straight_line":
    case "declining_balance":
      return true;
    case "immediate":
      return isSpecialSmallAsset(asset);
    case "lump_sum_3y":
      return false;
  }
}

// ---------------------------------------------------------------------------
// 登録時の検査と注意 (§5.1)
// ---------------------------------------------------------------------------

export interface DepreciationChoice {
  method: DepreciationMethod;
  cost: Money;
  acquisitionDate: CalendarDate;
  accountCode: string;
  usefulLifeYears: number | null;
}

export type DepreciationProblemCode =
  | "INVALID_COST"
  | "INVALID_METHOD"
  | "INVALID_USEFUL_LIFE"
  | "STRAIGHT_LINE_ONLY"
  | "SPECIAL_SMALL_ASSET_ENDED"
  | "IMMEDIATE_LIMIT"
  | "LUMP_SUM_LIMIT";

/** A problem of the registration form. `message` is owner-facing Japanese, shown under `field`. */
export interface DepreciationProblem {
  code: DepreciationProblemCode;
  field: "method" | "usefulLifeYears" | "cost";
  message: string;
}

/**
 * Checks the method against the cost, the date and the account (§5.1). The yearly cap of the special
 * measure needs the other assets of the year: the repository checks it with `specialSmallAssetCap`.
 */
export function checkDepreciationChoice(choice: DepreciationChoice): DepreciationProblem[] {
  const problems: DepreciationProblem[] = [];
  if (choice.cost <= 0n) {
    problems.push({
      code: "INVALID_COST",
      field: "cost",
      message: "取得価額は 1 円以上にしてください",
    });
  }
  if (!isDepreciationMethod(choice.method)) {
    problems.push({ code: "INVALID_METHOD", field: "method", message: "償却方法を選んでください" });
    return problems;
  }
  // 即時・一括 do not use the life; it may still be kept for 償却資産申告 (§14.2), within the table.
  if (
    (choice.method === "immediate" || choice.method === "lump_sum_3y") &&
    choice.usefulLifeYears !== null &&
    !isUsefulLife(choice.usefulLifeYears)
  ) {
    problems.push({
      code: "INVALID_USEFUL_LIFE",
      field: "usefulLifeYears",
      message: `耐用年数は ${MIN_USEFUL_LIFE}〜${MAX_USEFUL_LIFE} 年で入力してください`,
    });
  }
  switch (choice.method) {
    case "straight_line":
    case "declining_balance":
      if (!isUsefulLife(choice.usefulLifeYears)) {
        problems.push({
          code: "INVALID_USEFUL_LIFE",
          field: "usefulLifeYears",
          message: `耐用年数は ${MIN_USEFUL_LIFE}〜${MAX_USEFUL_LIFE} 年で入力してください`,
        });
      }
      if (
        choice.method === "declining_balance" &&
        STRAIGHT_LINE_ONLY_ACCOUNT_CODES.includes(choice.accountCode)
      ) {
        problems.push({
          code: "STRAIGHT_LINE_ONLY",
          field: "method",
          message: "建物附属設備とソフトウェアは定額法だけです",
        });
      }
      break;
    case "immediate": {
      if (choice.cost < SMALL_ASSET_LIMIT) break;
      const limit = specialSmallAssetLimit(choice.acquisitionDate);
      if (limit === null) {
        problems.push({
          code: "SPECIAL_SMALL_ASSET_ENDED",
          field: "method",
          message: `10 万円以上の即時償却（中小企業者の特例）は ${displayDate(SPECIAL_SMALL_ASSET_LAST_DATE)} までの取得だけです`,
        });
      } else if (choice.cost >= limit) {
        problems.push({
          code: "IMMEDIATE_LIMIT",
          field: "method",
          message: `即時償却は ${formatYen(limit)} 円未満の資産だけです`,
        });
      }
      break;
    }
    case "lump_sum_3y":
      if (choice.cost >= LUMP_SUM_LIMIT) {
        problems.push({
          code: "LUMP_SUM_LIMIT",
          field: "method",
          message: `一括償却（3 年）は ${formatYen(LUMP_SUM_LIMIT)} 円未満の資産だけです`,
        });
      }
      break;
  }
  return problems;
}

export type DepreciationNoteCode = "STRAIGHT_LINE_FILING" | "SPECIAL_SMALL_ASSET";

/** A help text of the registration form (not an error). */
export interface DepreciationNote {
  code: DepreciationNoteCode;
  field: "method";
  message: string;
}

/**
 * Help texts for the chosen method (§5.1): 定額法 on an account whose statutory method is 定率法
 * needs a filing (by the return deadline of the year of acquisition), and the special measure
 * presumes 青色申告 and is reported on 別表十六(七) and for 償却資産税.
 */
export function depreciationWarnings(input: {
  method: DepreciationMethod;
  cost: Money;
  accountCode: string;
  /** The fiscal year of the acquisition, for the filing deadline. */
  fiscalYear?: { no: number; endDate: CalendarDate } | null;
}): DepreciationNote[] {
  const notes: DepreciationNote[] = [];
  if (
    input.method === "straight_line" &&
    !STRAIGHT_LINE_ONLY_ACCOUNT_CODES.includes(input.accountCode)
  ) {
    // 令51②: by the return deadline of the year (法人税法74: 2 months after the year end).
    const deadline = input.fiscalYear
      ? `第 ${input.fiscalYear.no} 期は申告期限の ${displayDate(monthPeriodEnd(addDays(input.fiscalYear.endDate, 1), 2))} まで`
      : "取得した期の申告期限まで";
    notes.push({
      code: "STRAIGHT_LINE_FILING",
      field: "method",
      message: `定額法は償却方法の届出が要ります（${deadline}）`,
    });
  }
  if (isSpecialSmallAsset(input)) {
    notes.push({
      code: "SPECIAL_SMALL_ASSET",
      field: "method",
      message: "青色申告の承認が前提です。別表十六(七) に載せ、償却資産税の申告の対象です",
    });
  }
  return notes;
}

// ---------------------------------------------------------------------------
// 予定表と当期の額 (§4.1–§4.2)
// ---------------------------------------------------------------------------

export interface DepreciableAsset {
  method: DepreciationMethod;
  cost: Money;
  acquisitionDate: CalendarDate;
  /** Required for 定額・定率 (2–50); ignored otherwise. */
  usefulLifeYears: number | null;
  disposedOn?: CalendarDate | null;
}

export interface DepreciationPeriodInput {
  startDate: CalendarDate;
  endDate: CalendarDate;
  /** Actual depreciation posted for this asset in the period; null/undefined when nothing is posted. */
  posted?: Money | null;
}

export interface DepreciationRow {
  startDate: CalendarDate;
  endDate: CalendarDate;
  /** A 12-month period placed after the known fiscal years (`project: true`). */
  projected: boolean;
  /** Months the amount is computed for: months in use (定額・定率), the period's months (一括). */
  months: number;
  /** 期首帳簿価額: cost − the actual depreciation of the earlier rows. */
  opening: Money;
  /** 償却限度額 of the period, computed from the actual history. */
  amount: Money;
  /** 期末帳簿価額: opening − (posted ?? amount). */
  closing: Money;
  posted: Money | null;
  /** 定率法: computed from 改定取得価額 × 改定償却率. */
  revised: boolean;
}

/** Rows a schedule may have: a 50-year life with a short first year fits. */
export const MAX_DEPRECIATION_ROWS = 60;
/** Synthetic periods skipped before an acquisition beyond the known years. */
const MAX_SKIPPED_PERIODS = 120;

function maxMoney(a: Money, b: Money): Money {
  return a > b ? a : b;
}

function minMoney(a: Money, b: Money): Money {
  return a < b ? a : b;
}

/** 定額・定率 keep 1 yen (備忘価額); the others go down to 0. */
function bookValueFloor(method: DepreciationMethod): Money {
  return method === "straight_line" || method === "declining_balance" ? 1n : 0n;
}

function within(
  date: CalendarDate,
  period: { startDate: CalendarDate; endDate: CalendarDate },
): boolean {
  return period.startDate <= date && date <= period.endDate;
}

function assertSchedulable(
  asset: DepreciableAsset,
  periods: readonly DepreciationPeriodInput[],
): void {
  if (!isDepreciationMethod(asset.method)) {
    throw new RangeError(`planDepreciation: unknown method "${String(asset.method)}"`);
  }
  if (typeof asset.cost !== "bigint" || asset.cost <= 0n) {
    throw new RangeError("planDepreciation: the cost must be a positive bigint");
  }
  if (!isCalendarDate(asset.acquisitionDate)) {
    throw new RangeError(
      `planDepreciation: invalid acquisition date "${String(asset.acquisitionDate)}"`,
    );
  }
  if (
    (asset.method === "straight_line" || asset.method === "declining_balance") &&
    !isUsefulLife(asset.usefulLifeYears)
  ) {
    throw new RangeError(
      `planDepreciation: ${asset.method} needs a useful life of ${MIN_USEFUL_LIFE}–${MAX_USEFUL_LIFE} years`,
    );
  }
  periods.forEach((period, index) => {
    if (
      !isCalendarDate(period.startDate) ||
      !isCalendarDate(period.endDate) ||
      period.endDate < period.startDate
    ) {
      throw new RangeError(`planDepreciation: period ${index} has invalid dates`);
    }
    const previous = index > 0 ? periods[index - 1] : undefined;
    if (previous && addDays(previous.endDate, 1) !== period.startDate) {
      throw new RangeError("planDepreciation: periods must be sorted and contiguous");
    }
  });
  const first = periods[0];
  if (first && asset.acquisitionDate < first.startDate) {
    throw new RangeError("planDepreciation: the periods must start on or before the acquisition");
  }
}

/**
 * The depreciation schedule of an asset over fiscal years (§4.1–§4.2). `periods` are the fiscal years
 * (sorted, contiguous) with what was actually posted for the asset; rows start at the year containing
 * the acquisition. Each row's `amount` is the limit computed from the actual history: the opening book
 * value is the cost less the earlier rows' `posted` (or their `amount` when nothing is posted, so
 * future years assume full depreciation). A disposal stops 定額・定率・即時 (the year of the disposal
 * has 0 and is the last row) but not 一括 (令133の2). With `project`, 12-month years are added after
 * the last period until the book value reaches its floor (1 yen for 定額・定率, 0 otherwise).
 */
export function planDepreciation(
  asset: DepreciableAsset,
  periods: readonly DepreciationPeriodInput[],
  options: { project?: boolean } = {},
): DepreciationRow[] {
  assertSchedulable(asset, periods);
  const first = periods[0];
  if (!first) return [];
  const { method, cost, acquisitionDate } = asset;
  const rates =
    method === "straight_line" || method === "declining_balance"
      ? depreciationRates(asset.usefulLifeYears ?? 0)
      : null;
  const floor = bookValueFloor(method);
  const disposedOn = method === "lump_sum_3y" ? null : (asset.disposedOn ?? null);

  const rows: DepreciationRow[] = [];
  let opening = cost;
  let revisedBase: Money | null = null;
  let lumpSumMonths = 0;
  let previousEnd = first.endDate;
  let skipped = 0;

  for (let index = 0; rows.length < MAX_DEPRECIATION_ROWS; index += 1) {
    const given = periods[index];
    const projected = given === undefined;
    if (projected && options.project !== true) break;
    const period: DepreciationPeriodInput = given ?? deriveNextFiscalYear(previousEnd);
    previousEnd = period.endDate;

    if (period.endDate < acquisitionDate) {
      skipped += 1;
      if (projected && skipped > MAX_SKIPPED_PERIODS) break;
      continue;
    }
    if (disposedOn !== null && disposedOn < period.startDate) break;
    if (projected && opening <= floor) break;

    const usedFrom = acquisitionDate > period.startDate ? acquisitionDate : period.startDate;
    let months = countMonths(usedFrom, period.endDate);
    let amount = 0n;
    let revised = false;
    switch (method) {
      case "straight_line": {
        const mille = BigInt(rates?.straightLineMille ?? 0);
        amount = (cost * mille * BigInt(months)) / 12_000n;
        break;
      }
      case "declining_balance": {
        if (!rates) break;
        // Compare the annual values before the proration by months (令48の2⑤, §4.2).
        const unadjusted = (opening * BigInt(rates.decliningMille)) / 1000n;
        const guarantee =
          rates.guaranteePer100k === null ? 0n : (cost * BigInt(rates.guaranteePer100k)) / 100_000n;
        if (revisedBase === null && rates.revisedMille !== null && unadjusted < guarantee) {
          revisedBase = opening;
        }
        if (revisedBase !== null && rates.revisedMille !== null) {
          revised = true;
          amount = (revisedBase * BigInt(rates.revisedMille) * BigInt(months)) / 12_000n;
        } else {
          amount = (opening * BigInt(rates.decliningMille) * BigInt(months)) / 12_000n;
        }
        break;
      }
      case "immediate":
        amount = within(acquisitionDate, period) ? opening : 0n;
        break;
      case "lump_sum_3y": {
        // 一括: the period's own months whatever the acquisition date (令133の2⑥). Each period's
        // limit is its own slice of cost × months ÷ 36 (令133の2①), so a year left out is not caught
        // up beyond the next year's slice; the remainder is used after the 36 months, again at
        // cost × months ÷ 36 a period. Within the 36 months the slices are truncated cumulatively,
        // so the three years add up to the cost (180,000 → 25,000 / 60,000 / 60,000 / 35,000).
        months = countMonths(period.startDate, period.endDate);
        const before = lumpSumMonths;
        lumpSumMonths += months;
        const scheduled = (count: number) => (cost * BigInt(Math.min(36, count))) / 36n;
        const beyond = lumpSumMonths - Math.max(before, 36);
        amount =
          scheduled(lumpSumMonths) -
          scheduled(before) +
          (beyond > 0 ? (cost * BigInt(beyond)) / 36n : 0n);
        break;
      }
    }
    amount = minMoney(maxMoney(amount, 0n), maxMoney(opening - floor, 0n));
    const disposedHere = disposedOn !== null && within(disposedOn, period);
    if (disposedHere) amount = 0n;
    if (projected && amount === 0n) break;

    const posted = projected ? null : (period.posted ?? null);
    const closing = opening - (posted ?? amount);
    rows.push({
      startDate: period.startDate,
      endDate: period.endDate,
      projected,
      months,
      opening,
      amount,
      closing,
      posted,
      revised,
    });
    opening = closing;
    if (disposedHere) break;
  }
  return rows;
}

/**
 * The depreciation limit of `target` (one of `periods`), from the actual history of the earlier
 * periods. 0 when the asset has no depreciation in it (acquired later, disposed, fully depreciated).
 */
export function depreciationForPeriod(
  asset: DepreciableAsset,
  periods: readonly DepreciationPeriodInput[],
  target: { startDate: CalendarDate; endDate: CalendarDate },
): Money {
  const included = periods.some(
    (period) => period.startDate === target.startDate && period.endDate === target.endDate,
  );
  if (!included) {
    throw new RangeError("depreciationForPeriod: the target must be one of the periods");
  }
  const row = planDepreciation(asset, periods).find(
    (candidate) => candidate.startDate === target.startDate,
  );
  return row?.amount ?? 0n;
}

// ---------------------------------------------------------------------------
// 繰延資産 (§6)
// ---------------------------------------------------------------------------

export const DEFERRED_AMORTIZATION_MODES = ["five_years", "full"] as const;
/** `five_years`: evenly over 60 months from the first posting. `full`: the whole balance. */
export type DeferredAmortizationMode = (typeof DEFERRED_AMORTIZATION_MODES)[number];

export const DEFERRED_AMORTIZATION_MODE_LABELS: Readonly<Record<DeferredAmortizationMode, string>> =
  {
    five_years: "5 年",
    full: "全額",
  };

/** 繰延資産 → its amortization expense: 創立費 → 創立費償却, 開業費 → 開業費償却. */
export const DEFERRED_ASSET_EXPENSE_CODES: Readonly<Record<string, string>> = {
  "1700": "5470",
  "1710": "5480",
};

const DEFERRED_AMORTIZATION_MONTHS = 60;

/**
 * The amortization of a 繰延資産 for the year ending on `period.endDate` (§6). `five_years`: cost ×
 * months from `startDate` to the year end (at most 60) ÷ 60 − what is already amortized, truncated;
 * `full`: the remaining balance. Never below 0 nor above the remaining balance.
 */
export function planDeferredAmortization(
  state: { cost: Money; startDate: CalendarDate; amortizedBefore: Money },
  period: { endDate: CalendarDate },
  mode: DeferredAmortizationMode,
): Money {
  const remaining = maxMoney(state.cost - state.amortizedBefore, 0n);
  if (mode === "full") return remaining;
  const months = Math.min(
    DEFERRED_AMORTIZATION_MONTHS,
    countMonths(state.startDate, period.endDate),
  );
  const target = (state.cost * BigInt(months)) / BigInt(DEFERRED_AMORTIZATION_MONTHS);
  return minMoney(maxMoney(target - state.amortizedBefore, 0n), remaining);
}
