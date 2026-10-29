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

export type PayrollTable =
  WithholdingTable | KenpoTable | PensionTable | EmploymentInsuranceTable | BonusWithholdingTable;

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
    table.kind === "withholding-monthly" || table.kind === "withholding-bonus"
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
    default:
      throw new PayrollTableFormatError(
        "(unknown)",
        "kind",
        `must be one of ${PAYROLL_TABLE_KINDS.join(", ")}`,
      );
  }
}
