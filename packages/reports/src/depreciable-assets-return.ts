/**
 * 償却資産申告の元データ (docs/design/16-year-end.md §14): the assets of the fixed asset register
 * (#14) held on 1 January of the return year Y, split as the 種類別明細書 of 第二十六号様式 needs them
 * (全資産 / 増加資産 / 減少資産), with the excluded ones and their reasons. The return itself is made on
 * eLTAX or on paper; this is its source data (CSV and PDF). Pure: the repository passes the assets in.
 */
import {
  INTANGIBLE_ASSET_ACCOUNT_CODES,
  SMALL_ASSET_LIMIT,
  type CalendarDate,
  type DepreciationMethod,
  type Money,
} from "@niho-finance/ledger";
import type { CsvCell } from "./csv";
import { slashDate } from "./format";

// ---------------------------------------------------------------------------
// 資産の種類 (§14.2)
// ---------------------------------------------------------------------------

/** 資産の種類 of the 種類別明細書 (1 構築物 … 6 工具、器具及び備品). */
export const PROPERTY_TAX_ASSET_TYPES = [1, 2, 3, 4, 5, 6] as const;
export type PropertyTaxAssetType = (typeof PROPERTY_TAX_ASSET_TYPES)[number];

export const PROPERTY_TAX_ASSET_TYPE_LABELS: Readonly<Record<PropertyTaxAssetType, string>> = {
  1: "構築物",
  2: "機械及び装置",
  3: "船舶",
  4: "航空機",
  5: "車両及び運搬具",
  6: "工具、器具及び備品",
};

export function isPropertyTaxAssetType(value: unknown): value is PropertyTaxAssetType {
  return (
    typeof value === "number" && (PROPERTY_TAX_ASSET_TYPES as readonly number[]).includes(value)
  );
}

/** `6` → `6 工具、器具及び備品` (the number and the name, as the form lists them). */
export function propertyTaxAssetTypeText(type: PropertyTaxAssetType): string {
  return `${type} ${PROPERTY_TAX_ASSET_TYPE_LABELS[type]}`;
}

/** 建物附属設備 (1500) → 1 構築物, 工具器具備品 (1510) → 6; other accounts have no default. */
const DEFAULT_ASSET_TYPES: Readonly<Record<string, PropertyTaxAssetType>> = {
  "1500": 1,
  "1510": 6,
};

export function defaultPropertyTaxAssetType(accountCode: string): PropertyTaxAssetType | null {
  return DEFAULT_ASSET_TYPES[accountCode] ?? null;
}

/** The asset's own type, else the account's default; `null` = 未選択. */
export function effectivePropertyTaxAssetType(asset: {
  accountCode: string;
  propertyTaxAssetType: number | null;
}): PropertyTaxAssetType | null {
  return isPropertyTaxAssetType(asset.propertyTaxAssetType)
    ? asset.propertyTaxAssetType
    : defaultPropertyTaxAssetType(asset.accountCode);
}

// ---------------------------------------------------------------------------
// 対象と対象外 (§14.1)
// ---------------------------------------------------------------------------

export interface DepreciableAssetClassification {
  taxable: boolean;
  /** Why it is not reported (owner-facing), `null` when it is. */
  reason: string | null;
}

/**
 * The rule of §14.1: tangible assets on 定額・定率 and the 中小企業者等の特例 (`immediate` from 100,000)
 * are reported; 少額 (`immediate` under 100,000, 令133), 一括 (令133の2) and intangible assets
 * (ソフトウェア) are not (地方税法 341 条 4 号, 施行令 49 条). An asset excluded by hand (a vehicle under
 * 自動車税) is not either; the rules come first, so an explicit reason never makes an asset taxable.
 */
export function classifyDepreciableAsset(asset: {
  accountCode: string;
  method: DepreciationMethod;
  cost: Money;
  propertyTaxExcludedReason: string | null;
}): DepreciableAssetClassification {
  if (INTANGIBLE_ASSET_ACCOUNT_CODES.includes(asset.accountCode)) {
    return { taxable: false, reason: "無形固定資産（ソフトウェア）" };
  }
  if (asset.method === "lump_sum_3y") {
    return { taxable: false, reason: "一括償却資産（3 年）" };
  }
  if (asset.method === "immediate" && asset.cost < SMALL_ASSET_LIMIT) {
    return { taxable: false, reason: "少額減価償却資産（10 万円未満）" };
  }
  const explicit = asset.propertyTaxExcludedReason?.trim() ?? "";
  if (explicit !== "") return { taxable: false, reason: explicit };
  return { taxable: true, reason: null };
}

// ---------------------------------------------------------------------------
// 和暦 (§14.2)
// ---------------------------------------------------------------------------

const ERAS: readonly { name: string; start: string; offset: number }[] = [
  { name: "令和", start: "2019-05-01", offset: 2018 },
  { name: "平成", start: "1989-01-08", offset: 1988 },
  { name: "昭和", start: "1926-12-25", offset: 1925 },
];

function eraOf(value: string): { name: string; year: number; month: number; day: number | null } {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = match?.[3] === undefined ? null : Number(match[3]);
  if (!match || month < 1 || month > 12 || (day !== null && (day < 1 || day > 31))) {
    throw new RangeError(`wareki: "${value}" is not a year-month (YYYY-MM) or a date`);
  }
  const key = `${match[1]}-${match[2]}-${match[3] ?? "01"}`;
  const era = ERAS.find((candidate) => key >= candidate.start);
  if (!era) throw new RangeError(`wareki: "${value}" is before 昭和`);
  return { name: era.name, year: year - era.offset, month, day };
}

/** `2026-12` (or `2026-12-10`) → `令和 8 年 12 月`; 平成 before 2019-05-01. */
export function wareki(yearMonth: string): string {
  const era = eraOf(yearMonth);
  return `${era.name} ${era.year} 年 ${era.month} 月`;
}

/** `2027-01-01` → `令和 9 年 1 月 1 日`. */
export function warekiDate(date: CalendarDate): string {
  const era = eraOf(date);
  return `${era.name} ${era.year} 年 ${era.month} 月 ${era.day ?? 1} 日`;
}

/** The era year of 1 January of `year` (the return year): `2027` → `令和 9 年`. */
export function warekiYear(year: number): string {
  const era = eraOf(`${String(year).padStart(4, "0")}-01-01`);
  return `${era.name} ${era.year} 年`;
}

// ---------------------------------------------------------------------------
// 全資産・増加・減少 (§14.3)
// ---------------------------------------------------------------------------

/** One asset of the register as the return reads it. */
export interface DepreciableAssetsReturnAsset {
  id: string;
  name: string;
  accountCode: string;
  accountName: string;
  /** 取得日 (事業供用日). */
  acquisitionDate: CalendarDate;
  /** 台帳の取得価額 (税込 in exempt / tax-inclusive years, 税抜 in tax-exclusive ones). */
  cost: Money;
  method: DepreciationMethod;
  usefulLifeYears: number | null;
  /** The disposal in force (a voided disposal entry puts the asset back in use); `null` while held. */
  disposedAt: CalendarDate | null;
  /** The disposal was a sale (its entry has the proceeds); otherwise a 除却. */
  sold: boolean;
  /** 登録の取消: never counted. */
  voided: boolean;
  /** 1–6, `null` = from the account. */
  propertyTaxAssetType: number | null;
  /** 申告の対象外 by hand, `null` = by the rules. */
  propertyTaxExcludedReason: string | null;
}

export const INCREASE_REASON = "新品取得";
export type DecreaseReason = "売却" | "滅失";

/** One line of the 種類別明細書. */
export interface DepreciableAssetsReturnRow {
  assetId: string;
  name: string;
  accountName: string;
  method: DepreciationMethod;
  /** 資産の種類 (the asset's own, else the account's); `null` = 未選択. */
  assetType: PropertyTaxAssetType | null;
  /** 数量 (one asset per line). */
  quantity: number;
  acquisitionDate: CalendarDate;
  /** `2026-12` */
  acquisitionYearMonth: string;
  /** `令和 8 年 12 月` */
  acquisitionWareki: string;
  cost: Money;
  usefulLifeYears: number | null;
  /** 増加事由: 「新品取得」 for an asset acquired in the window, `null` otherwise. */
  increaseReason: string | null;
  /** 減少の事由と区分 (減少資産 only): 売却, or 滅失 for a 除却; always 全部. */
  decrease: { reason: DecreaseReason; scope: "全部"; date: CalendarDate } | null;
  /** 摘要 */
  note: string | null;
}

/** An asset held on the assessment date that is not reported, with the reason. */
export interface DepreciableAssetsReturnExcludedRow {
  assetId: string;
  name: string;
  accountName: string;
  method: DepreciationMethod;
  acquisitionDate: CalendarDate;
  cost: Money;
  reason: string;
}

export type DepreciableAssetsReturnWarningKind = "asset_type" | "useful_life";

/** A reported asset the return cannot be filled for yet (fixed on the asset's detail). */
export interface DepreciableAssetsReturnWarning {
  assetId: string;
  name: string;
  kind: DepreciableAssetsReturnWarningKind;
  message: string;
}

export interface DepreciableAssetsReturnTotal {
  count: number;
  cost: Money;
}

export interface DepreciableAssetsReturn {
  /** 申告年 Y. */
  year: number;
  /** 判定の日: Y-01-01. */
  assessmentDate: CalendarDate;
  /** The previous return's assessment date: (Y−1)-01-01. */
  previousAssessmentDate: CalendarDate;
  /** Acquisitions and disposals counted in this return: (Y−1)-01-02 … Y-01-01. */
  window: { from: CalendarDate; to: CalendarDate };
  /** 全資産: reported assets held on the assessment date. */
  all: DepreciableAssetsReturnRow[];
  /** 増加資産: of 全資産, those acquired in the window. */
  increased: DepreciableAssetsReturnRow[];
  /** 減少資産: disposed or sold in the window, reported in the previous return (held on (Y−1)-01-01). */
  decreased: DepreciableAssetsReturnRow[];
  /** Held on the assessment date but not reported. */
  excluded: DepreciableAssetsReturnExcludedRow[];
  warnings: DepreciableAssetsReturnWarning[];
  totals: Record<"all" | "increased" | "decreased" | "excluded", DepreciableAssetsReturnTotal>;
  /** Nothing was reported on (Y−1)-01-01: 全資産 are all 増加資産. */
  firstReturn: boolean;
}

/** 1 月なら今年、それ以外は翌年 (§14.4). */
export function defaultDepreciableAssetsReturnYear(today: CalendarDate): number {
  const year = Number(today.slice(0, 4));
  return today.slice(5, 7) === "01" ? year : year + 1;
}

function isoYear(year: number): string {
  return String(year).padStart(4, "0");
}

/** Held on `date`: acquired by then and not disposed by then (a disposal on `date` is not held). */
function heldOn(asset: DepreciableAssetsReturnAsset, date: CalendarDate): boolean {
  return asset.acquisitionDate <= date && (asset.disposedAt === null || asset.disposedAt > date);
}

function inWindow(date: CalendarDate | null, window: { from: CalendarDate; to: CalendarDate }) {
  return date !== null && date >= window.from && date <= window.to;
}

function total(rows: readonly { cost: Money }[]): DepreciableAssetsReturnTotal {
  return { count: rows.length, cost: rows.reduce((sum, row) => sum + row.cost, 0n) };
}

function byTypeThenDate(a: DepreciableAssetsReturnRow, b: DepreciableAssetsReturnRow): number {
  return (
    (a.assetType ?? 99) - (b.assetType ?? 99) ||
    a.acquisitionDate.localeCompare(b.acquisitionDate) ||
    a.name.localeCompare(b.name, "ja") ||
    a.assetId.localeCompare(b.assetId)
  );
}

const SPECIAL_NOTE = "中小企業者の特例（措法 67 条の 5）";

function toRow(
  asset: DepreciableAssetsReturnAsset,
  window: { from: CalendarDate; to: CalendarDate },
  decreased: boolean,
): DepreciableAssetsReturnRow {
  const reason: DecreaseReason = asset.sold ? "売却" : "滅失";
  const decrease: DepreciableAssetsReturnRow["decrease"] =
    decreased && asset.disposedAt ? { reason, scope: "全部", date: asset.disposedAt } : null;
  const notes: string[] = [];
  if (asset.method === "immediate") notes.push(SPECIAL_NOTE);
  if (decrease) notes.push(`${asset.sold ? "売却" : "除却"} ${slashDate(decrease.date)}`);
  return {
    assetId: asset.id,
    name: asset.name,
    accountName: asset.accountName,
    method: asset.method,
    assetType: effectivePropertyTaxAssetType(asset),
    quantity: 1,
    acquisitionDate: asset.acquisitionDate,
    acquisitionYearMonth: asset.acquisitionDate.slice(0, 7),
    acquisitionWareki: wareki(asset.acquisitionDate),
    cost: asset.cost,
    usefulLifeYears: asset.usefulLifeYears,
    increaseReason: !decreased && inWindow(asset.acquisitionDate, window) ? INCREASE_REASON : null,
    decrease,
    note: notes.length > 0 ? notes.join(" / ") : null,
  };
}

function warningsOf(rows: readonly DepreciableAssetsReturnRow[]): DepreciableAssetsReturnWarning[] {
  const warnings: DepreciableAssetsReturnWarning[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.assetId)) continue;
    seen.add(row.assetId);
    if (row.assetType === null) {
      warnings.push({
        assetId: row.assetId,
        name: row.name,
        kind: "asset_type",
        message: "資産の種類が未選択です",
      });
    }
    if (row.usefulLifeYears === null) {
      warnings.push({
        assetId: row.assetId,
        name: row.name,
        kind: "useful_life",
        message: "耐用年数が未入力です",
      });
    }
  }
  return warnings;
}

/**
 * The return of year `year` (§14.3): 全資産 are the reported assets held on Y-01-01; 増加資産 those of
 * them acquired from (Y−1)-01-02 through Y-01-01; 減少資産 the assets disposed or sold in the same
 * window that were reported on (Y−1)-01-01. Voided registrations are never counted.
 */
export function buildDepreciableAssetsReturn(
  assets: readonly DepreciableAssetsReturnAsset[],
  options: { year: number },
): DepreciableAssetsReturn {
  const { year } = options;
  if (!Number.isSafeInteger(year) || year < 1927 || year > 9999) {
    throw new RangeError(`buildDepreciableAssetsReturn: ${year} is not a return year`);
  }
  const assessmentDate = `${isoYear(year)}-01-01` as CalendarDate;
  const previousAssessmentDate = `${isoYear(year - 1)}-01-01` as CalendarDate;
  const window = { from: `${isoYear(year - 1)}-01-02` as CalendarDate, to: assessmentDate };

  const all: DepreciableAssetsReturnRow[] = [];
  const decreased: DepreciableAssetsReturnRow[] = [];
  const excluded: DepreciableAssetsReturnExcludedRow[] = [];
  let reportedBefore = false;
  for (const asset of assets) {
    if (asset.voided) continue;
    const classification = classifyDepreciableAsset(asset);
    if (!classification.taxable) {
      if (heldOn(asset, assessmentDate)) {
        excluded.push({
          assetId: asset.id,
          name: asset.name,
          accountName: asset.accountName,
          method: asset.method,
          acquisitionDate: asset.acquisitionDate,
          cost: asset.cost,
          reason: classification.reason ?? "",
        });
      }
      continue;
    }
    const heldBefore = heldOn(asset, previousAssessmentDate);
    if (heldBefore) reportedBefore = true;
    if (heldOn(asset, assessmentDate)) all.push(toRow(asset, window, false));
    if (heldBefore && inWindow(asset.disposedAt, window))
      decreased.push(toRow(asset, window, true));
  }
  all.sort(byTypeThenDate);
  decreased.sort(byTypeThenDate);
  excluded.sort(
    (a, b) =>
      a.acquisitionDate.localeCompare(b.acquisitionDate) ||
      a.name.localeCompare(b.name, "ja") ||
      a.assetId.localeCompare(b.assetId),
  );
  const increased = all.filter((row) => row.increaseReason !== null);
  return {
    year,
    assessmentDate,
    previousAssessmentDate,
    window,
    all,
    increased,
    decreased,
    excluded,
    warnings: warningsOf([...all, ...decreased]),
    totals: {
      all: total(all),
      increased: total(increased),
      decreased: total(decreased),
      excluded: total(excluded),
    },
    firstReturn: !reportedBefore,
  };
}

// ---------------------------------------------------------------------------
// CSV (§14.4)
// ---------------------------------------------------------------------------

/**
 * The columns of the CSV: 区分 (全資産 / 増加資産 / 減少資産), then the items of the 種類別明細書 in the
 * form's order. 減価残存率・価額・課税標準額 are the municipality's (一般方式) and stay empty.
 */
export const DEPRECIABLE_ASSETS_RETURN_CSV_HEADER = [
  "区分",
  "資産の種類",
  "資産の名称等",
  "数量",
  "取得年月（和暦）",
  "取得年月（西暦）",
  "取得価額",
  "耐用年数",
  "減価残存率",
  "価額",
  "課税標準額",
  "増加事由",
  "減少の事由",
  "減少の区分",
  "摘要",
] as const;

export type DepreciableAssetsReturnSection = "all" | "increased" | "decreased";

export const DEPRECIABLE_ASSETS_RETURN_SECTION_LABELS: Readonly<
  Record<DepreciableAssetsReturnSection, string>
> = {
  all: "全資産",
  increased: "増加資産",
  decreased: "減少資産",
};

function csvRow(section: DepreciableAssetsReturnSection, row: DepreciableAssetsReturnRow) {
  return [
    DEPRECIABLE_ASSETS_RETURN_SECTION_LABELS[section],
    row.assetType === null ? "" : propertyTaxAssetTypeText(row.assetType),
    row.name,
    row.quantity,
    row.acquisitionWareki,
    row.acquisitionYearMonth,
    row.cost,
    row.usefulLifeYears,
    null,
    null,
    null,
    row.increaseReason,
    row.decrease?.reason,
    row.decrease?.scope,
    row.note,
  ] satisfies CsvCell[];
}

/** The rows of the CSV (header first): 全資産, 増加資産 and 減少資産 in one file. */
export function depreciableAssetsReturnCsv(result: DepreciableAssetsReturn): CsvCell[][] {
  return [
    [...DEPRECIABLE_ASSETS_RETURN_CSV_HEADER],
    ...result.all.map((row) => csvRow("all", row)),
    ...result.increased.map((row) => csvRow("increased", row)),
    ...result.decreased.map((row) => csvRow("decreased", row)),
  ];
}

/** `depreciable-assets-return_2027.csv` */
export function depreciableAssetsReturnFileName(year: number, extension: "csv" | "pdf"): string {
  return `depreciable-assets-return_${year}.${extension}`;
}
