import { isCalendarDate, type CalendarDate, type Money } from "@niho-finance/ledger";
import { PayrollTableFormatError } from "./errors";
import { isYearMonth, type YearMonth } from "./month";
import { add, compare, fromDecimalString, ratio, type Rational } from "./rational";

/**
 * Typed tables parsed from `data/<年>/*.json` (22-payroll §3.1). Amounts become `bigint` yen and
 * rates exact rationals (percent or per-mille strings divided out), so no calculation ever sees a
 * floating-point number. Every parser rejects unknown or missing fields, gaps, overlaps, broken
 * monotonicity and malformed rates with `PayrollTableFormatError`.
 */

export const PAYROLL_TABLE_KINDS = [
  "withholding-monthly",
  "kyokai-kenpo",
  "pension",
  "employment-insurance",
  "withholding-bonus",
  "year-end",
] as const;
export type PayrollTableKind = (typeof PAYROLL_TABLE_KINDS)[number];

export interface TableSource {
  url: string;
  fetchedAt: CalendarDate;
  /** SHA-256 of the downloaded original; `null` when the source is a web page that was read. */
  sha256: string | null;
  note: string;
}

interface TableHeader<Kind extends PayrollTableKind, Period extends string> {
  kind: Kind;
  id: string;
  /** Name of the publication. */
  title: string;
  effectiveFrom: Period;
  /** Inclusive. `null` means "until the next version" (the registry ends it there). */
  effectiveTo: Period | null;
  legalBasis: string;
  source: TableSource;
}

/** What a payroll result records about each table it used (22-payroll §4). */
export interface TableRef {
  id: string;
  title: string;
  source: { url: string; fetchedAt: CalendarDate };
}

/** Number of 甲欄 columns: 0〜7 dependents. */
export const KOU_COLUMNS = 8;

/** A row of the monthly table: `from` 以上 `to` 未満. `kou[n]` is the tax for n dependents. */
export interface WithholdingBand {
  from: Money;
  to: Money;
  kou: readonly Money[];
  otsu: Money;
}

/** The tax at exactly `at` (基準額), e.g. 740,000 円. */
export interface WithholdingKouPoint {
  at: Money;
  kou: readonly Money[];
}

export interface WithholdingOtsuPoint {
  at: Money;
  otsu: Money;
}

/** Above `over` (and below `under`; `null` = no upper bound): tax(over) + (amount − over) × rate. */
export interface WithholdingSegment {
  over: Money;
  under: Money | null;
  rate: Rational;
}

/** 源泉徴収税額表 月額表 (甲欄 0〜7 人・乙欄), one version per calendar year of payment. */
export interface WithholdingTable extends TableHeader<"withholding-monthly", CalendarDate> {
  /** Below `below`: 甲欄 0 円, 乙欄 amount × `otsuRate`. */
  lowBand: { below: Money; otsuRate: Rational };
  bands: readonly WithholdingBand[];
  kouPoints: readonly WithholdingKouPoint[];
  kouSegments: readonly WithholdingSegment[];
  otsuPoints: readonly WithholdingOtsuPoint[];
  otsuSegments: readonly WithholdingSegment[];
  /** Per dependent beyond 7 (甲欄) or per secondary dependent (乙欄). */
  extraDependentDeduction: Money;
}

/** A grade of standard monthly remuneration: remuneration `from` 以上 `to` 未満 (`null` = open). */
export interface Grade {
  grade: number;
  smr: Money;
  from: Money | null;
  to: Money | null;
}

/** 協会けんぽ (one prefecture branch): health, care and child-support rates and health grades. */
export interface KenpoTable extends TableHeader<"kyokai-kenpo", YearMonth> {
  rates: { health: Rational; care: Rational; childSupport: Rational };
  /** First premium month of 子ども・子育て支援金; earlier months (or `null`) have none. */
  childSupportFrom: YearMonth | null;
  grades: readonly Grade[];
}

/** 厚生年金: premium rate, 子ども・子育て拠出金 rate (employer only) and pension grades. */
export interface PensionTable extends TableHeader<"pension", YearMonth> {
  rate: Rational;
  childContributionRate: Rational;
  grades: readonly Grade[];
}

/** 雇用保険 rates of 一般の事業. */
export interface EmploymentInsuranceTable extends TableHeader<"employment-insurance", YearMonth> {
  businessType: "general";
  rates: { employee: Rational; employer: Rational; total: Rational };
}

/**
 * A row's range of 前月の社会保険料等控除後の給与等の金額: `from` 以上 `to` 未満; `null` is open (the
 * first row has only 「未満」, the last only 「以上」).
 */
export interface BonusWithholdingRange {
  from: Money | null;
  to: Money | null;
}

/** A row of the bonus table: the rate, and the range for 甲欄 0〜7 人以上 and 乙欄 (when it has one). */
export interface BonusWithholdingRow {
  /** The rate as published, e.g. `"2.042"` (percent). */
  ratePercent: string;
  rate: Rational;
  /** 8 columns: 0〜6 人 and 7 人以上. */
  kou: readonly BonusWithholdingRange[];
  /** `null`: this rate is not one of 乙欄's. */
  otsu: BonusWithholdingRange | null;
}

/** 賞与に対する源泉徴収税額の算出率の表 (22-payroll §10.1), one version per calendar year of payment. */
export interface BonusWithholdingTable extends TableHeader<"withholding-bonus", CalendarDate> {
  rows: readonly BonusWithholdingRow[];
}

/**
 * A segment of 年末調整等のための給与所得控除後の給与等の金額の表 (所得税法別表第五): income `from` 以上
 * `to` 未満 (`null` = no upper end). `rate`: (income, or the lower end of its `step`-yen row) × rate −
 * deduction, 1 円未満切り捨て.
 */
export type SalaryIncomeSegment =
  | { from: Money; to: Money | null; kind: "zero" }
  | { from: Money; to: Money | null; kind: "fixed"; amount: Money }
  | {
      from: Money;
      to: Money | null;
      kind: "rate";
      /** The row width of the table (4,000 円), `null` = the income itself. */
      step: Money | null;
      ratePercent: string;
      rate: Rational;
      deduction: Money;
    };

/**
 * One bracket of a deduction formula (生命保険料・旧長期損害保険料): an amount ≤ `upTo` (`null` = above
 * every bound) gives amount × rate + add, 1 円未満切り上げ.
 */
export interface YearEndFormulaBracket {
  upTo: Money | null;
  ratePercent: string;
  rate: Rational;
  add: Money;
}

/** An amount for incomes ≤ `upTo` (以下). */
export interface YearEndAmountBracket {
  upTo: Money;
  amount: Money;
}

/** 速算表: 課税給与所得金額 ≤ `upTo` → amount × rate − deduction. */
export interface YearEndTaxBracket {
  upTo: Money;
  ratePercent: string;
  rate: Rational;
  deduction: Money;
}

/** The yearly data of 年末調整 (22-payroll §11.3), one version per 年分. */
export interface YearEndTable extends TableHeader<"year-end", CalendarDate> {
  /** The 年分 (effectiveFrom is its 1 January, effectiveTo its 31 December). */
  year: number;
  /** 対象: 給与等の収入 ≤ incomeLimit; 課税給与所得金額 ≤ taxableIncomeLimit. */
  eligibility: { incomeLimit: Money; taxableIncomeLimit: Money };
  /** From 0, without gaps, the last one open. */
  salaryIncome: readonly SalaryIncomeSegment[];
  /** 所得金額調整控除: (min(収入, incomeCap) − threshold) × rate, 1 円未満切り上げ. */
  incomeAdjustment: { threshold: Money; incomeCap: Money; ratePercent: string; rate: Rational };
  /** 基礎控除 by 合計所得金額 (以下); above the last bound 0. */
  basicDeduction: readonly YearEndAmountBracket[];
  spouse: {
    /** 所得者の合計所得金額 900 / 950 / 1,000 万円以下: the 3 columns; above the last 0. */
    earnerIncomeLimits: readonly Money[];
    /** 配偶者控除: 配偶者の合計所得金額 ≤ this. */
    deductionIncomeLimit: Money;
    general: readonly Money[];
    /** 老人控除対象配偶者 (70 歳以上). */
    elderly: readonly Money[];
    /** 配偶者特別控除: above `deductionIncomeLimit`, by 配偶者の合計所得金額 (以下). */
    special: readonly { upTo: Money; amounts: readonly Money[] }[];
  };
  /** 特定親族特別控除: 特定親族の合計所得金額 > incomeOver, by bracket (以下). */
  specificRelative: { incomeOver: Money; brackets: readonly YearEndAmountBracket[] };
  /** 扶養控除 (扶養親族・同一生計配偶者の所得要件 incomeLimit 以下). */
  dependents: {
    incomeLimit: Money;
    general: Money;
    specific: Money;
    elderly: Money;
    elderlyCohabiting: Money;
  };
  /** 障害者控除. */
  disability: { general: Money; special: Money; specialCohabiting: Money };
  /** 寡婦・ひとり親・勤労学生 and their 合計所得金額 requirements (以下). */
  personal: {
    widow: Money;
    singleParent: Money;
    workingStudent: Money;
    widowIncomeLimit: Money;
    singleParentIncomeLimit: Money;
    workingStudentIncomeLimit: Money;
  };
  lifeInsurance: {
    /** 計算式Ⅰ: 新生命保険料・介護医療保険料・新個人年金保険料. */
    newFormula: readonly YearEndFormulaBracket[];
    /** 計算式Ⅱ: 新生命保険料 when there is a 23 歳未満の扶養親族. */
    newUnder23Formula: readonly YearEndFormulaBracket[];
    /** 計算式Ⅲ: 旧生命保険料・旧個人年金保険料. */
    oldFormula: readonly YearEndFormulaBracket[];
    /** 一般: 新旧の合計の上限 (23 歳未満の扶養親族がいる場合は generalUnder23Limit). */
    generalLimit: Money;
    generalUnder23Limit: Money;
    /** 個人年金: 新旧の合計の上限. */
    pensionLimit: Money;
    totalLimit: Money;
  };
  earthquake: {
    earthquakeLimit: Money;
    oldLongTermFormula: readonly YearEndFormulaBracket[];
    totalLimit: Money;
  };
  /** 課税給与所得金額 is rounded down to this (1,000 円). */
  taxableIncomeUnit: Money;
  taxBrackets: readonly YearEndTaxBracket[];
  /** 年調年税額 = 年調所得税額 × rate, rounded down to `unit` (102.1%, 100 円). */
  surtax: { ratePercent: string; rate: Rational; unit: Money };
  /** The birth-date ranges of the year (12 月 31 日 の年齢): for the screens. */
  birthDates: {
    /** 特定扶養親族 (19〜22 歳). */
    specificFrom: CalendarDate;
    specificTo: CalendarDate;
    /** 老人扶養親族・老人控除対象配偶者 (70 歳以上): born on or before. */
    elderlyTo: CalendarDate;
    /** 控除対象扶養親族 (16 歳以上): born on or before. */
    age16To: CalendarDate;
    /** 23 歳未満: born on or after. */
    under23From: CalendarDate;
  };
}

export type PayrollTable =
  | WithholdingTable
  | KenpoTable
  | PensionTable
  | EmploymentInsuranceTable
  | BonusWithholdingTable
  | YearEndTable;

export function tableRef(table: PayrollTable): TableRef {
  return {
    id: table.id,
    title: table.title,
    source: { url: table.source.url, fetchedAt: table.source.fetchedAt },
  };
}

/**
 * Whether `at` (the payment date for the withholding table, the premium month otherwise) falls in
 * the table's own period. An `effectiveTo` of `null` counts as open-ended here.
 */
export function isTableEffective(table: PayrollTable, when: string): boolean {
  const valid =
    table.kind === "withholding-monthly" ||
    table.kind === "withholding-bonus" ||
    table.kind === "year-end"
      ? isCalendarDate(when)
      : isYearMonth(when);
  if (!valid) throw new RangeError(`isTableEffective: "${when}" is not a period of ${table.kind}`);
  return table.effectiveFrom <= when && (table.effectiveTo === null || when <= table.effectiveTo);
}

// ---------------------------------------------------------------------------------------------
// JSON readers

type JsonObject = Record<string, unknown>;

interface Context {
  table: string;
}

function fail(context: Context, path: string, problem: string): never {
  throw new PayrollTableFormatError(context.table, path, problem);
}

function pathOf(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path === "" ? key : `${path}.${key}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(
  context: Context,
  value: unknown,
  path: string,
  keys: readonly string[],
): JsonObject {
  if (!isJsonObject(value)) fail(context, path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(context, pathOf(path, key), "is not a known field");
  }
  for (const key of keys) {
    if (!(key in value)) fail(context, pathOf(path, key), "is missing");
  }
  return value;
}

function readArray(context: Context, value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(context, path, "must be an array");
  return value as readonly unknown[];
}

function readText(context: Context, value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(context, path, "must be a non-empty string");
  }
  return value;
}

function readYen(context: Context, value: unknown, path: string): Money {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(context, path, "must be a whole number of yen (0 or more)");
  }
  return BigInt(value);
}

function readPositiveYen(context: Context, value: unknown, path: string): Money {
  const yen = readYen(context, value, path);
  if (yen === 0n) fail(context, path, "must be 1 yen or more");
  return yen;
}

function readNullableYen(context: Context, value: unknown, path: string): Money | null {
  return value === null ? null : readYen(context, value, path);
}

const RATE_PATTERN = /^\d+(?:\.\d+)?$/;

/** A non-negative decimal string such as `"9.92"`, divided by `divisor` (100 for percent). */
function readRate(context: Context, value: unknown, path: string, divisor: bigint): Rational {
  if (typeof value !== "string" || !RATE_PATTERN.test(value)) {
    fail(context, path, 'must be a decimal string such as "9.92"');
  }
  const rate = fromDecimalString(value);
  return ratio(rate.num, rate.den * divisor);
}

function readDate(context: Context, value: unknown, path: string): CalendarDate {
  if (!isCalendarDate(value)) fail(context, path, "must be a date (YYYY-MM-DD)");
  return value;
}

function readYearMonth(context: Context, value: unknown, path: string): YearMonth {
  if (!isYearMonth(value)) fail(context, path, "must be a month (YYYY-MM)");
  return value;
}

const HEADER_KEYS = [
  "kind",
  "id",
  "title",
  "effectiveFrom",
  "effectiveTo",
  "legalBasis",
  "source",
] as const;

function readHeader<Kind extends PayrollTableKind, Period extends string>(
  json: unknown,
  kind: Kind,
  bodyKeys: readonly string[],
  readPeriod: (context: Context, value: unknown, path: string) => Period,
): { context: Context; object: JsonObject; header: TableHeader<Kind, Period> } {
  const context: Context = {
    table: isJsonObject(json) && typeof json.id === "string" ? json.id : kind,
  };
  const object = readObject(context, json, "", [...HEADER_KEYS, ...bodyKeys]);
  if (object.kind !== kind) fail(context, "kind", `must be "${kind}"`);
  const id = readText(context, object.id, "id");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail(context, "id", "must be kebab-case");
  const effectiveFrom = readPeriod(context, object.effectiveFrom, "effectiveFrom");
  const effectiveTo =
    object.effectiveTo === null ? null : readPeriod(context, object.effectiveTo, "effectiveTo");
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    fail(context, "effectiveTo", "must not be before effectiveFrom");
  }
  const source = readObject(context, object.source, "source", [
    "url",
    "fetchedAt",
    "sha256",
    "note",
  ]);
  const url = readText(context, source.url, "source.url");
  if (!/^https:\/\/\S+$/.test(url)) fail(context, "source.url", "must be an https URL");
  const sha256 = source.sha256 === null ? null : readText(context, source.sha256, "source.sha256");
  if (sha256 !== null && !/^[0-9a-f]{64}$/.test(sha256)) {
    fail(context, "source.sha256", "must be 64 lowercase hex digits or null");
  }
  return {
    context,
    object,
    header: {
      kind,
      id,
      title: readText(context, object.title, "title"),
      effectiveFrom,
      effectiveTo,
      legalBasis: readText(context, object.legalBasis, "legalBasis"),
      source: {
        url,
        fetchedAt: readDate(context, source.fetchedAt, "source.fetchedAt"),
        sha256,
        note: readText(context, source.note, "source.note"),
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 源泉徴収税額表 月額表

function readKou(context: Context, value: unknown, path: string): readonly Money[] {
  const cells = readArray(context, value, path);
  if (cells.length !== KOU_COLUMNS)
    fail(context, path, `must have ${KOU_COLUMNS} columns (0〜7 人)`);
  const kou = cells.map((cell, index) => readYen(context, cell, pathOf(path, index)));
  for (let index = 1; index < kou.length; index++) {
    if (kou[index]! > kou[index - 1]!) {
      fail(context, path, "must not increase with the number of dependents");
    }
  }
  return kou;
}

function checkNotDecreasing(
  context: Context,
  previous: readonly Money[],
  current: readonly Money[],
  path: string,
): void {
  current.forEach((value, index) => {
    const before = previous[index];
    if (before !== undefined && value < before) {
      fail(context, path, "must not be less than the tax of the previous row");
    }
  });
}

function readSegments(
  context: Context,
  value: unknown,
  path: string,
  points: readonly Money[],
): readonly WithholdingSegment[] {
  const segments = readArray(context, value, path).map((item, index) => {
    const itemPath = pathOf(path, index);
    const segment = readObject(context, item, itemPath, ["over", "under", "ratePercent"]);
    const rate = readRate(context, segment.ratePercent, pathOf(itemPath, "ratePercent"), 100n);
    if (rate.num === 0n) fail(context, pathOf(itemPath, "ratePercent"), "must be more than 0");
    return {
      over: readYen(context, segment.over, pathOf(itemPath, "over")),
      under: readNullableYen(context, segment.under, pathOf(itemPath, "under")),
      rate,
    };
  });
  if (segments.length !== points.length) {
    fail(context, path, "must have one segment from each point");
  }
  segments.forEach((segment, index) => {
    const itemPath = pathOf(path, index);
    if (segment.over !== points[index])
      fail(context, pathOf(itemPath, "over"), "must equal a point");
    const next = points[index + 1] ?? null;
    if (segment.under !== next) {
      fail(
        context,
        pathOf(itemPath, "under"),
        next === null ? "must be null (open-ended)" : "must equal the next point",
      );
    }
  });
  return segments;
}

function checkPointsIncrease(context: Context, points: readonly Money[], path: string): void {
  if (points.length === 0) fail(context, path, "must not be empty");
  for (let index = 1; index < points.length; index++) {
    if (points[index]! <= points[index - 1]!) {
      fail(context, pathOf(pathOf(path, index), "at"), "must be greater than the previous point");
    }
  }
}

export function parseWithholdingTable(json: unknown): WithholdingTable {
  const { context, object, header } = readHeader(
    json,
    "withholding-monthly",
    [
      "lowBand",
      "bands",
      "kouPoints",
      "kouSegments",
      "otsuPoints",
      "otsuSegments",
      "extraDependentDeduction",
    ],
    readDate,
  );

  const low = readObject(context, object.lowBand, "lowBand", ["below", "otsuRatePercent"]);
  const lowBand = {
    below: readPositiveYen(context, low.below, "lowBand.below"),
    otsuRate: readRate(context, low.otsuRatePercent, "lowBand.otsuRatePercent", 100n),
  };

  const bands = readArray(context, object.bands, "bands").map((item, index): WithholdingBand => {
    const path = pathOf("bands", index);
    const band = readObject(context, item, path, ["from", "to", "kou", "otsu"]);
    return {
      from: readYen(context, band.from, pathOf(path, "from")),
      to: readYen(context, band.to, pathOf(path, "to")),
      kou: readKou(context, band.kou, pathOf(path, "kou")),
      otsu: readYen(context, band.otsu, pathOf(path, "otsu")),
    };
  });
  if (bands.length === 0) fail(context, "bands", "must not be empty");
  bands.forEach((band, index) => {
    const path = pathOf("bands", index);
    const expectedFrom = index === 0 ? lowBand.below : bands[index - 1]!.to;
    if (band.from !== expectedFrom) {
      fail(
        context,
        pathOf(path, "from"),
        "must continue the previous row without a gap or overlap",
      );
    }
    if (band.to <= band.from) fail(context, pathOf(path, "to"), "must be greater than from");
    if (band.otsu < band.kou[0]!)
      fail(context, pathOf(path, "otsu"), "must not be less than 甲欄 0 人");
    const previous = bands[index - 1];
    if (previous) {
      checkNotDecreasing(context, previous.kou, band.kou, pathOf(path, "kou"));
      checkNotDecreasing(context, [previous.otsu], [band.otsu], pathOf(path, "otsu"));
    }
  });
  const lastBand = bands[bands.length - 1]!;

  const kouPoints = readArray(context, object.kouPoints, "kouPoints").map(
    (item, index): WithholdingKouPoint => {
      const path = pathOf("kouPoints", index);
      const point = readObject(context, item, path, ["at", "kou"]);
      return {
        at: readYen(context, point.at, pathOf(path, "at")),
        kou: readKou(context, point.kou, pathOf(path, "kou")),
      };
    },
  );
  checkPointsIncrease(
    context,
    kouPoints.map((point) => point.at),
    "kouPoints",
  );
  if (kouPoints[0]!.at !== lastBand.to) {
    fail(context, "kouPoints[0].at", "must equal the upper end of the last row");
  }
  kouPoints.forEach((point, index) => {
    const previous = index === 0 ? lastBand.kou : kouPoints[index - 1]!.kou;
    checkNotDecreasing(context, previous, point.kou, pathOf(pathOf("kouPoints", index), "kou"));
  });
  const kouSegments = readSegments(
    context,
    object.kouSegments,
    "kouSegments",
    kouPoints.map((point) => point.at),
  );

  const otsuPoints = readArray(context, object.otsuPoints, "otsuPoints").map(
    (item, index): WithholdingOtsuPoint => {
      const path = pathOf("otsuPoints", index);
      const point = readObject(context, item, path, ["at", "otsu"]);
      return {
        at: readYen(context, point.at, pathOf(path, "at")),
        otsu: readYen(context, point.otsu, pathOf(path, "otsu")),
      };
    },
  );
  checkPointsIncrease(
    context,
    otsuPoints.map((point) => point.at),
    "otsuPoints",
  );
  if (otsuPoints[0]!.at !== kouPoints[0]!.at) {
    fail(context, "otsuPoints[0].at", "must equal the first 甲欄 point");
  }
  otsuPoints.forEach((point, index) => {
    const path = pathOf("otsuPoints", index);
    const previous = index === 0 ? lastBand.otsu : otsuPoints[index - 1]!.otsu;
    if (point.otsu < previous) fail(context, pathOf(path, "otsu"), "must not be less than before");
    const kou = kouPoints.find((candidate) => candidate.at === point.at);
    if (kou && point.otsu < kou.kou[0]!) {
      fail(context, pathOf(path, "otsu"), "must not be less than 甲欄 0 人");
    }
  });
  const otsuSegments = readSegments(
    context,
    object.otsuSegments,
    "otsuSegments",
    otsuPoints.map((point) => point.at),
  );

  return {
    ...header,
    lowBand,
    bands,
    kouPoints,
    kouSegments,
    otsuPoints,
    otsuSegments,
    extraDependentDeduction: readPositiveYen(
      context,
      object.extraDependentDeduction,
      "extraDependentDeduction",
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// 等級表・料率表

function readGrades(context: Context, value: unknown, path: string): readonly Grade[] {
  const grades = readArray(context, value, path).map((item, index): Grade => {
    const itemPath = pathOf(path, index);
    const grade = readObject(context, item, itemPath, ["grade", "smr", "from", "to"]);
    if (grade.grade !== index + 1) fail(context, pathOf(itemPath, "grade"), `must be ${index + 1}`);
    return {
      grade: index + 1,
      smr: readPositiveYen(context, grade.smr, pathOf(itemPath, "smr")),
      from: readNullableYen(context, grade.from, pathOf(itemPath, "from")),
      to: readNullableYen(context, grade.to, pathOf(itemPath, "to")),
    };
  });
  if (grades.length < 2) fail(context, path, "must have at least 2 grades");
  grades.forEach((grade, index) => {
    const itemPath = pathOf(path, index);
    const first = index === 0;
    const last = index === grades.length - 1;
    if (first !== (grade.from === null)) {
      fail(context, pathOf(itemPath, "from"), first ? "must be null" : "must not be null");
    }
    if (last !== (grade.to === null)) {
      fail(context, pathOf(itemPath, "to"), last ? "must be null" : "must not be null");
    }
    const previous = grades[index - 1];
    if (previous) {
      if (grade.from !== previous.to) {
        fail(context, pathOf(itemPath, "from"), "must continue the previous grade without a gap");
      }
      if (grade.smr <= previous.smr) {
        fail(context, pathOf(itemPath, "smr"), "must be greater than the previous grade");
      }
    }
    if (grade.from !== null && grade.to !== null && grade.to <= grade.from) {
      fail(context, pathOf(itemPath, "to"), "must be greater than from");
    }
    if (
      (grade.from !== null && grade.smr < grade.from) ||
      (grade.to !== null && grade.smr >= grade.to)
    ) {
      fail(context, pathOf(itemPath, "smr"), "must lie in its own remuneration range");
    }
  });
  return grades;
}

export function parseKenpoTable(json: unknown): KenpoTable {
  const { context, object, header } = readHeader(
    json,
    "kyokai-kenpo",
    ["ratesPercent", "childSupportFrom", "grades"],
    readYearMonth,
  );
  const rates = readObject(context, object.ratesPercent, "ratesPercent", [
    "health",
    "care",
    "childSupport",
  ]);
  return {
    ...header,
    rates: {
      health: readRate(context, rates.health, "ratesPercent.health", 100n),
      care: readRate(context, rates.care, "ratesPercent.care", 100n),
      childSupport: readRate(context, rates.childSupport, "ratesPercent.childSupport", 100n),
    },
    childSupportFrom:
      object.childSupportFrom === null
        ? null
        : readYearMonth(context, object.childSupportFrom, "childSupportFrom"),
    grades: readGrades(context, object.grades, "grades"),
  };
}

export function parsePensionTable(json: unknown): PensionTable {
  const { context, object, header } = readHeader(
    json,
    "pension",
    ["ratePercent", "childContributionPercent", "grades"],
    readYearMonth,
  );
  return {
    ...header,
    rate: readRate(context, object.ratePercent, "ratePercent", 100n),
    childContributionRate: readRate(
      context,
      object.childContributionPercent,
      "childContributionPercent",
      100n,
    ),
    grades: readGrades(context, object.grades, "grades"),
  };
}

export function parseEmploymentInsuranceTable(json: unknown): EmploymentInsuranceTable {
  const { context, object, header } = readHeader(
    json,
    "employment-insurance",
    ["businessType", "ratesPerMille"],
    readYearMonth,
  );
  if (object.businessType !== "general") fail(context, "businessType", 'must be "general"');
  const rates = readObject(context, object.ratesPerMille, "ratesPerMille", [
    "employee",
    "employer",
    "total",
  ]);
  const employee = readRate(context, rates.employee, "ratesPerMille.employee", 1000n);
  const employer = readRate(context, rates.employer, "ratesPerMille.employer", 1000n);
  const total = readRate(context, rates.total, "ratesPerMille.total", 1000n);
  if (compare(add(employee, employer), total) !== 0) {
    fail(context, "ratesPerMille.total", "must equal employee + employer");
  }
  return { ...header, businessType: "general", rates: { employee, employer, total } };
}

// ---------------------------------------------------------------------------------------------
// 賞与に対する源泉徴収税額の算出率の表

function readNullableRangeEnd(context: Context, value: unknown, path: string): Money | null {
  return value === null ? null : readPositiveYen(context, value, path);
}

function readBonusRange(context: Context, value: unknown, path: string): BonusWithholdingRange {
  const range = readObject(context, value, path, ["from", "to"]);
  const from = readNullableRangeEnd(context, range.from, pathOf(path, "from"));
  const to = readNullableRangeEnd(context, range.to, pathOf(path, "to"));
  if (from !== null && to !== null && to <= from) {
    fail(context, pathOf(path, "to"), "must be greater than from");
  }
  return { from, to };
}

/**
 * The ranges of one column down the rows must start open (「未満」), continue each other without a
 * gap or overlap, and end open (「以上」).
 */
function checkBonusColumn(
  context: Context,
  ranges: readonly { range: BonusWithholdingRange; path: string }[],
  label: string,
): void {
  if (ranges.length < 2) fail(context, "rows", `${label} must have at least 2 rows`);
  ranges.forEach(({ range, path }, index) => {
    const first = index === 0;
    const last = index === ranges.length - 1;
    if (first !== (range.from === null)) {
      fail(context, pathOf(path, "from"), first ? "must be null (未満 only)" : "must not be null");
    }
    if (last !== (range.to === null)) {
      fail(context, pathOf(path, "to"), last ? "must be null (以上 only)" : "must not be null");
    }
    const previous = ranges[index - 1];
    if (previous && range.from !== previous.range.to) {
      fail(context, pathOf(path, "from"), `${label}: must continue the previous row without a gap`);
    }
  });
}

export function parseBonusWithholdingTable(json: unknown): BonusWithholdingTable {
  const { context, object, header } = readHeader(json, "withholding-bonus", ["rows"], readDate);
  const rows = readArray(context, object.rows, "rows").map((item, index): BonusWithholdingRow => {
    const path = pathOf("rows", index);
    const row = readObject(context, item, path, ["ratePercent", "kou", "otsu"]);
    const ratePercent = row.ratePercent;
    const rate = readRate(context, ratePercent, pathOf(path, "ratePercent"), 100n);
    const cells = readArray(context, row.kou, pathOf(path, "kou"));
    if (cells.length !== KOU_COLUMNS) {
      fail(context, pathOf(path, "kou"), `must have ${KOU_COLUMNS} columns (0〜6 人・7 人以上)`);
    }
    return {
      ratePercent: ratePercent as string,
      rate,
      kou: cells.map((cell, column) =>
        readBonusRange(context, cell, pathOf(pathOf(path, "kou"), column)),
      ),
      otsu: row.otsu === null ? null : readBonusRange(context, row.otsu, pathOf(path, "otsu")),
    };
  });
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (previous && compare(row.rate, previous.rate) <= 0) {
      fail(context, pathOf(pathOf("rows", index), "ratePercent"), "must be greater than before");
    }
  });
  for (let column = 0; column < KOU_COLUMNS; column++) {
    checkBonusColumn(
      context,
      rows.map((row, index) => ({
        range: row.kou[column]!,
        path: pathOf(pathOf(pathOf("rows", index), "kou"), column),
      })),
      `甲欄 ${column} 人`,
    );
  }
  checkBonusColumn(
    context,
    rows.flatMap((row, index) =>
      row.otsu ? [{ range: row.otsu, path: pathOf(pathOf("rows", index), "otsu") }] : [],
    ),
    "乙欄",
  );
  return { ...header, rows };
}

// ---------------------------------------------------------------------------------------------
// 年末調整 (22-payroll §11.3)

function readYenList(
  context: Context,
  value: unknown,
  path: string,
  length: number,
): readonly Money[] {
  const cells = readArray(context, value, path);
  if (cells.length !== length) fail(context, path, `must have ${length} amounts`);
  return cells.map((cell, index) => readYen(context, cell, pathOf(path, index)));
}

function checkNotIncreasingList(context: Context, values: readonly Money[], path: string): void {
  for (let index = 1; index < values.length; index++) {
    if (values[index]! > values[index - 1]!) {
      fail(context, pathOf(path, index), "must not be more than the column before");
    }
  }
}

/** Value of a salary segment at `income` (no range check). */
function salarySegmentValue(segment: SalaryIncomeSegment, income: Money): Money {
  switch (segment.kind) {
    case "zero":
      return 0n;
    case "fixed":
      return segment.amount;
    case "rate": {
      const base = segment.step === null ? income : (income / segment.step) * segment.step;
      const value = (base * segment.rate.num) / segment.rate.den - segment.deduction;
      return value < 0n ? 0n : value;
    }
  }
}

function readSalarySegments(
  context: Context,
  value: unknown,
  path: string,
): readonly SalaryIncomeSegment[] {
  const segments = readArray(context, value, path).map((item, index): SalaryIncomeSegment => {
    const itemPath = pathOf(path, index);
    const kind = isJsonObject(item) ? item.kind : undefined;
    switch (kind) {
      case "zero": {
        const segment = readObject(context, item, itemPath, ["from", "to", "kind"]);
        return {
          from: readYen(context, segment.from, pathOf(itemPath, "from")),
          to: readNullableYen(context, segment.to, pathOf(itemPath, "to")),
          kind: "zero",
        };
      }
      case "fixed": {
        const segment = readObject(context, item, itemPath, ["from", "to", "kind", "amount"]);
        return {
          from: readYen(context, segment.from, pathOf(itemPath, "from")),
          to: readNullableYen(context, segment.to, pathOf(itemPath, "to")),
          kind: "fixed",
          amount: readYen(context, segment.amount, pathOf(itemPath, "amount")),
        };
      }
      case "rate": {
        const segment = readObject(context, item, itemPath, [
          "from",
          "to",
          "kind",
          "step",
          "ratePercent",
          "deduction",
        ]);
        const step =
          segment.step === null
            ? null
            : readPositiveYen(context, segment.step, pathOf(itemPath, "step"));
        const rate = readRate(context, segment.ratePercent, pathOf(itemPath, "ratePercent"), 100n);
        if (rate.num === 0n) fail(context, pathOf(itemPath, "ratePercent"), "must be more than 0");
        return {
          from: readYen(context, segment.from, pathOf(itemPath, "from")),
          to: readNullableYen(context, segment.to, pathOf(itemPath, "to")),
          kind: "rate",
          step,
          ratePercent: segment.ratePercent as string,
          rate,
          deduction: readYen(context, segment.deduction, pathOf(itemPath, "deduction")),
        };
      }
      default:
        return fail(context, pathOf(itemPath, "kind"), 'must be "zero", "fixed" or "rate"');
    }
  });
  if (segments.length === 0) fail(context, path, "must not be empty");
  segments.forEach((segment, index) => {
    const itemPath = pathOf(path, index);
    const previous = segments[index - 1];
    const expectedFrom = previous ? previous.to : 0n;
    if (segment.from !== expectedFrom) {
      fail(context, pathOf(itemPath, "from"), "must continue the previous segment from 0");
    }
    const last = index === segments.length - 1;
    if (last !== (segment.to === null)) {
      fail(
        context,
        pathOf(itemPath, "to"),
        last ? "must be null (open-ended)" : "must not be null",
      );
    }
    if (segment.to !== null && segment.to <= segment.from) {
      fail(context, pathOf(itemPath, "to"), "must be greater than from");
    }
    if (segment.kind === "rate" && segment.step !== null) {
      if (segment.from % segment.step !== 0n || (segment.to ?? 0n) % segment.step !== 0n) {
        fail(context, pathOf(itemPath, "step"), "must divide from and to");
      }
    }
    // The amount never goes down from one segment to the next, nor inside a segment.
    if (previous && previous.to !== null) {
      const before = salarySegmentValue(previous, previous.to - 1n);
      if (salarySegmentValue(segment, segment.from) < before) {
        fail(context, pathOf(itemPath, "from"), "must not give less than the previous segment");
      }
    }
    if (salarySegmentValue(segment, segment.from) > segment.from) {
      fail(context, itemPath, "must not give more than the income");
    }
  });
  return segments;
}

function readFormula(
  context: Context,
  value: unknown,
  path: string,
): readonly YearEndFormulaBracket[] {
  const brackets = readArray(context, value, path).map((item, index): YearEndFormulaBracket => {
    const itemPath = pathOf(path, index);
    const bracket = readObject(context, item, itemPath, ["upTo", "ratePercent", "add"]);
    return {
      upTo: readNullableYen(context, bracket.upTo, pathOf(itemPath, "upTo")),
      ratePercent: bracket.ratePercent as string,
      rate: readRate(context, bracket.ratePercent, pathOf(itemPath, "ratePercent"), 100n),
      add: readYen(context, bracket.add, pathOf(itemPath, "add")),
    };
  });
  if (brackets.length < 2) fail(context, path, "must have at least 2 brackets");
  brackets.forEach((bracket, index) => {
    const itemPath = pathOf(path, index);
    const last = index === brackets.length - 1;
    if (last !== (bracket.upTo === null)) {
      fail(context, pathOf(itemPath, "upTo"), last ? "must be null (above)" : "must not be null");
    }
    const previous = brackets[index - 1];
    if (previous && bracket.upTo !== null && previous.upTo !== null) {
      if (bracket.upTo <= previous.upTo) {
        fail(context, pathOf(itemPath, "upTo"), "must be greater than before");
      }
    }
    // Continuous: the value at the previous bound is the same with this bracket's formula.
    if (previous && previous.upTo !== null) {
      const at = (b: YearEndFormulaBracket) =>
        add(ratio(previous.upTo! * b.rate.num, b.rate.den), ratio(b.add));
      if (compare(at(previous), at(bracket)) !== 0) {
        fail(context, itemPath, "must continue the previous bracket without a jump");
      }
    }
  });
  return brackets;
}

function readAmountBrackets(
  context: Context,
  value: unknown,
  path: string,
): readonly YearEndAmountBracket[] {
  const brackets = readArray(context, value, path).map((item, index): YearEndAmountBracket => {
    const itemPath = pathOf(path, index);
    const bracket = readObject(context, item, itemPath, ["upTo", "amount"]);
    return {
      upTo: readPositiveYen(context, bracket.upTo, pathOf(itemPath, "upTo")),
      amount: readPositiveYen(context, bracket.amount, pathOf(itemPath, "amount")),
    };
  });
  if (brackets.length === 0) fail(context, path, "must not be empty");
  brackets.forEach((bracket, index) => {
    const previous = brackets[index - 1];
    if (!previous) return;
    const itemPath = pathOf(path, index);
    if (bracket.upTo <= previous.upTo) {
      fail(context, pathOf(itemPath, "upTo"), "must be greater than before");
    }
    if (bracket.amount >= previous.amount) {
      fail(context, pathOf(itemPath, "amount"), "must be less than before");
    }
  });
  return brackets;
}

function readTaxBrackets(
  context: Context,
  value: unknown,
  path: string,
): readonly YearEndTaxBracket[] {
  const brackets = readArray(context, value, path).map((item, index): YearEndTaxBracket => {
    const itemPath = pathOf(path, index);
    const bracket = readObject(context, item, itemPath, ["upTo", "ratePercent", "deduction"]);
    const rate = readRate(context, bracket.ratePercent, pathOf(itemPath, "ratePercent"), 100n);
    if (rate.num === 0n) fail(context, pathOf(itemPath, "ratePercent"), "must be more than 0");
    return {
      upTo: readPositiveYen(context, bracket.upTo, pathOf(itemPath, "upTo")),
      ratePercent: bracket.ratePercent as string,
      rate,
      deduction: readYen(context, bracket.deduction, pathOf(itemPath, "deduction")),
    };
  });
  if (brackets.length === 0) fail(context, path, "must not be empty");
  brackets.forEach((bracket, index) => {
    const previous = brackets[index - 1];
    if (!previous) return;
    const itemPath = pathOf(path, index);
    if (bracket.upTo <= previous.upTo) {
      fail(context, pathOf(itemPath, "upTo"), "must be greater than before");
    }
    if (compare(bracket.rate, previous.rate) <= 0) {
      fail(context, pathOf(itemPath, "ratePercent"), "must be greater than before");
    }
    // 速算表: both formulas give the same tax at the previous bound.
    const tax = (b: YearEndTaxBracket) => (previous.upTo * b.rate.num) / b.rate.den - b.deduction;
    if (tax(previous) !== tax(bracket)) {
      fail(context, pathOf(itemPath, "deduction"), "must continue the previous bracket");
    }
  });
  return brackets;
}

export function parseYearEndTable(json: unknown): YearEndTable {
  const { context, object, header } = readHeader(
    json,
    "year-end",
    [
      "year",
      "eligibility",
      "salaryIncome",
      "incomeAdjustment",
      "basicDeduction",
      "spouse",
      "specificRelative",
      "dependents",
      "disability",
      "personal",
      "lifeInsurance",
      "earthquake",
      "taxableIncomeUnit",
      "taxBrackets",
      "surtax",
      "birthDates",
    ],
    readDate,
  );
  const year = object.year;
  if (typeof year !== "number" || !Number.isSafeInteger(year) || year < 2000 || year > 2100) {
    fail(context, "year", "must be a year (2000〜2100)");
  }
  if (header.effectiveFrom !== `${year}-01-01`) {
    fail(context, "effectiveFrom", `must be ${year}-01-01 (the 年分)`);
  }
  if (header.effectiveTo !== `${year}-12-31`) {
    fail(context, "effectiveTo", `must be ${year}-12-31 (the 年分)`);
  }

  const eligibility = readObject(context, object.eligibility, "eligibility", [
    "incomeLimit",
    "taxableIncomeLimit",
  ]);
  const adjustment = readObject(context, object.incomeAdjustment, "incomeAdjustment", [
    "threshold",
    "incomeCap",
    "ratePercent",
  ]);
  const incomeAdjustment = {
    threshold: readPositiveYen(context, adjustment.threshold, "incomeAdjustment.threshold"),
    incomeCap: readPositiveYen(context, adjustment.incomeCap, "incomeAdjustment.incomeCap"),
    ratePercent: adjustment.ratePercent as string,
    rate: readRate(context, adjustment.ratePercent, "incomeAdjustment.ratePercent", 100n),
  };
  if (incomeAdjustment.incomeCap <= incomeAdjustment.threshold) {
    fail(context, "incomeAdjustment.incomeCap", "must be greater than the threshold");
  }

  const spouseJson = readObject(context, object.spouse, "spouse", [
    "earnerIncomeLimits",
    "deductionIncomeLimit",
    "general",
    "elderly",
    "special",
  ]);
  const earnerIncomeLimits = readYenList(
    context,
    spouseJson.earnerIncomeLimits,
    "spouse.earnerIncomeLimits",
    3,
  );
  earnerIncomeLimits.forEach((limit, index) => {
    if (index > 0 && limit <= earnerIncomeLimits[index - 1]!) {
      fail(context, pathOf("spouse.earnerIncomeLimits", index), "must be greater than before");
    }
  });
  const general = readYenList(context, spouseJson.general, "spouse.general", 3);
  const elderly = readYenList(context, spouseJson.elderly, "spouse.elderly", 3);
  checkNotIncreasingList(context, general, "spouse.general");
  checkNotIncreasingList(context, elderly, "spouse.elderly");
  elderly.forEach((amount, index) => {
    if (amount < general[index]!) {
      fail(context, pathOf("spouse.elderly", index), "must not be less than spouse.general");
    }
  });
  const deductionIncomeLimit = readPositiveYen(
    context,
    spouseJson.deductionIncomeLimit,
    "spouse.deductionIncomeLimit",
  );
  const special = readArray(context, spouseJson.special, "spouse.special").map((item, index) => {
    const itemPath = pathOf("spouse.special", index);
    const row = readObject(context, item, itemPath, ["upTo", "amounts"]);
    const amounts = readYenList(context, row.amounts, pathOf(itemPath, "amounts"), 3);
    checkNotIncreasingList(context, amounts, pathOf(itemPath, "amounts"));
    return { upTo: readPositiveYen(context, row.upTo, pathOf(itemPath, "upTo")), amounts };
  });
  if (special.length === 0) fail(context, "spouse.special", "must not be empty");
  special.forEach((row, index) => {
    const previousUpTo = index === 0 ? deductionIncomeLimit : special[index - 1]!.upTo;
    if (row.upTo <= previousUpTo) {
      fail(context, pathOf(pathOf("spouse.special", index), "upTo"), "must be greater than before");
    }
    const previous = special[index - 1];
    row.amounts.forEach((amount, column) => {
      const before = previous ? previous.amounts[column]! : general[column]!;
      if (amount > before) {
        fail(
          context,
          pathOf(pathOf(pathOf("spouse.special", index), "amounts"), column),
          "must not be more than the row before",
        );
      }
    });
  });

  const specificJson = readObject(context, object.specificRelative, "specificRelative", [
    "incomeOver",
    "brackets",
  ]);
  const specificRelative = {
    incomeOver: readPositiveYen(context, specificJson.incomeOver, "specificRelative.incomeOver"),
    brackets: readAmountBrackets(context, specificJson.brackets, "specificRelative.brackets"),
  };
  if (specificRelative.brackets[0]!.upTo <= specificRelative.incomeOver) {
    fail(context, "specificRelative.brackets[0].upTo", "must be greater than incomeOver");
  }

  const dependentsJson = readObject(context, object.dependents, "dependents", [
    "incomeLimit",
    "general",
    "specific",
    "elderly",
    "elderlyCohabiting",
  ]);
  const disabilityJson = readObject(context, object.disability, "disability", [
    "general",
    "special",
    "specialCohabiting",
  ]);
  const personalJson = readObject(context, object.personal, "personal", [
    "widow",
    "singleParent",
    "workingStudent",
    "widowIncomeLimit",
    "singleParentIncomeLimit",
    "workingStudentIncomeLimit",
  ]);
  const lifeJson = readObject(context, object.lifeInsurance, "lifeInsurance", [
    "newFormula",
    "newUnder23Formula",
    "oldFormula",
    "generalLimit",
    "generalUnder23Limit",
    "pensionLimit",
    "totalLimit",
  ]);
  const earthquakeJson = readObject(context, object.earthquake, "earthquake", [
    "earthquakeLimit",
    "oldLongTermFormula",
    "totalLimit",
  ]);
  const surtaxJson = readObject(context, object.surtax, "surtax", ["ratePercent", "unit"]);
  const datesJson = readObject(context, object.birthDates, "birthDates", [
    "specificFrom",
    "specificTo",
    "elderlyTo",
    "age16To",
    "under23From",
  ]);
  const birthDates = {
    specificFrom: readDate(context, datesJson.specificFrom, "birthDates.specificFrom"),
    specificTo: readDate(context, datesJson.specificTo, "birthDates.specificTo"),
    elderlyTo: readDate(context, datesJson.elderlyTo, "birthDates.elderlyTo"),
    age16To: readDate(context, datesJson.age16To, "birthDates.age16To"),
    under23From: readDate(context, datesJson.under23From, "birthDates.under23From"),
  };
  if (
    birthDates.specificTo <= birthDates.specificFrom ||
    birthDates.age16To <= birthDates.specificTo ||
    birthDates.elderlyTo >= birthDates.specificFrom
  ) {
    fail(context, "birthDates", "must be in the order 老人 < 特定 < 16 歳");
  }

  const basicDeduction = readAmountBrackets(context, object.basicDeduction, "basicDeduction");
  const taxBrackets = readTaxBrackets(context, object.taxBrackets, "taxBrackets");
  const taxableIncomeLimit = readPositiveYen(
    context,
    eligibility.taxableIncomeLimit,
    "eligibility.taxableIncomeLimit",
  );
  if (taxBrackets[taxBrackets.length - 1]!.upTo !== taxableIncomeLimit) {
    fail(context, "taxBrackets", "must end at eligibility.taxableIncomeLimit");
  }
  const surtax = {
    ratePercent: surtaxJson.ratePercent as string,
    rate: readRate(context, surtaxJson.ratePercent, "surtax.ratePercent", 100n),
    unit: readPositiveYen(context, surtaxJson.unit, "surtax.unit"),
  };
  if (compare(surtax.rate, ratio(1n)) < 0)
    fail(context, "surtax.ratePercent", "must be 100 or more");

  return {
    ...header,
    year,
    eligibility: {
      incomeLimit: readPositiveYen(context, eligibility.incomeLimit, "eligibility.incomeLimit"),
      taxableIncomeLimit,
    },
    salaryIncome: readSalarySegments(context, object.salaryIncome, "salaryIncome"),
    incomeAdjustment,
    basicDeduction,
    spouse: { earnerIncomeLimits, deductionIncomeLimit, general, elderly, special },
    specificRelative,
    dependents: {
      incomeLimit: readPositiveYen(context, dependentsJson.incomeLimit, "dependents.incomeLimit"),
      general: readPositiveYen(context, dependentsJson.general, "dependents.general"),
      specific: readPositiveYen(context, dependentsJson.specific, "dependents.specific"),
      elderly: readPositiveYen(context, dependentsJson.elderly, "dependents.elderly"),
      elderlyCohabiting: readPositiveYen(
        context,
        dependentsJson.elderlyCohabiting,
        "dependents.elderlyCohabiting",
      ),
    },
    disability: {
      general: readPositiveYen(context, disabilityJson.general, "disability.general"),
      special: readPositiveYen(context, disabilityJson.special, "disability.special"),
      specialCohabiting: readPositiveYen(
        context,
        disabilityJson.specialCohabiting,
        "disability.specialCohabiting",
      ),
    },
    personal: {
      widow: readPositiveYen(context, personalJson.widow, "personal.widow"),
      singleParent: readPositiveYen(context, personalJson.singleParent, "personal.singleParent"),
      workingStudent: readPositiveYen(
        context,
        personalJson.workingStudent,
        "personal.workingStudent",
      ),
      widowIncomeLimit: readPositiveYen(
        context,
        personalJson.widowIncomeLimit,
        "personal.widowIncomeLimit",
      ),
      singleParentIncomeLimit: readPositiveYen(
        context,
        personalJson.singleParentIncomeLimit,
        "personal.singleParentIncomeLimit",
      ),
      workingStudentIncomeLimit: readPositiveYen(
        context,
        personalJson.workingStudentIncomeLimit,
        "personal.workingStudentIncomeLimit",
      ),
    },
    lifeInsurance: {
      newFormula: readFormula(context, lifeJson.newFormula, "lifeInsurance.newFormula"),
      newUnder23Formula: readFormula(
        context,
        lifeJson.newUnder23Formula,
        "lifeInsurance.newUnder23Formula",
      ),
      oldFormula: readFormula(context, lifeJson.oldFormula, "lifeInsurance.oldFormula"),
      generalLimit: readPositiveYen(context, lifeJson.generalLimit, "lifeInsurance.generalLimit"),
      generalUnder23Limit: readPositiveYen(
        context,
        lifeJson.generalUnder23Limit,
        "lifeInsurance.generalUnder23Limit",
      ),
      pensionLimit: readPositiveYen(context, lifeJson.pensionLimit, "lifeInsurance.pensionLimit"),
      totalLimit: readPositiveYen(context, lifeJson.totalLimit, "lifeInsurance.totalLimit"),
    },
    earthquake: {
      earthquakeLimit: readPositiveYen(
        context,
        earthquakeJson.earthquakeLimit,
        "earthquake.earthquakeLimit",
      ),
      oldLongTermFormula: readFormula(
        context,
        earthquakeJson.oldLongTermFormula,
        "earthquake.oldLongTermFormula",
      ),
      totalLimit: readPositiveYen(context, earthquakeJson.totalLimit, "earthquake.totalLimit"),
    },
    taxableIncomeUnit: readPositiveYen(context, object.taxableIncomeUnit, "taxableIncomeUnit"),
    taxBrackets,
    surtax,
    birthDates,
  };
}

/** Parses any table JSON by its `kind`. */
export function parsePayrollTable(json: unknown): PayrollTable {
  const kind = isJsonObject(json) ? json.kind : undefined;
  switch (kind) {
    case "withholding-monthly":
      return parseWithholdingTable(json);
    case "kyokai-kenpo":
      return parseKenpoTable(json);
    case "pension":
      return parsePensionTable(json);
    case "employment-insurance":
      return parseEmploymentInsuranceTable(json);
    case "withholding-bonus":
      return parseBonusWithholdingTable(json);
    case "year-end":
      return parseYearEndTable(json);
    default:
      throw new PayrollTableFormatError(
        "(unknown)",
        "kind",
        `must be one of ${PAYROLL_TABLE_KINDS.join(", ")}`,
      );
  }
}
