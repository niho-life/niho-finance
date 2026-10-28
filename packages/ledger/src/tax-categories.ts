import type { TaxRateRule } from "./tax";

export const TAX_CATEGORY_CODES = [
  "sales_10",
  "sales_8r",
  "sales_exempt",
  "sales_out",
  "sales_export",
  "purchase_10",
  "purchase_8r",
  "purchase_10_ni",
  "purchase_8r_ni",
  "purchase_exempt",
  "purchase_out",
  "na",
] as const;
/** Fixed codes = the aggregation buckets of the consumption tax return. */
export type TaxCategoryCode = (typeof TAX_CATEGORY_CODES)[number];

export const TAX_DIRECTIONS = ["sales", "purchase", "none"] as const;
export type TaxDirection = (typeof TAX_DIRECTIONS)[number];

export const TAX_KINDS = ["taxable", "exempt", "out_of_scope", "export", "na"] as const;
/** 課税 / 非課税 / 不課税 / 輸出免税 / 対象外 */
export type TaxKind = (typeof TAX_KINDS)[number];

export interface TaxCategoryDefinition {
  code: TaxCategoryCode;
  name: string;
  direction: TaxDirection;
  kind: TaxKind;
  sortOrder: number;
}

export const TAX_CATEGORIES: readonly TaxCategoryDefinition[] = [
  { code: "sales_10", name: "課税売上 10%", direction: "sales", kind: "taxable", sortOrder: 10 },
  {
    code: "sales_8r",
    name: "課税売上 8%（軽減）",
    direction: "sales",
    kind: "taxable",
    sortOrder: 20,
  },
  { code: "sales_exempt", name: "非課税売上", direction: "sales", kind: "exempt", sortOrder: 30 },
  {
    code: "sales_out",
    name: "不課税売上",
    direction: "sales",
    kind: "out_of_scope",
    sortOrder: 40,
  },
  { code: "sales_export", name: "輸出免税売上", direction: "sales", kind: "export", sortOrder: 50 },
  {
    code: "purchase_10",
    name: "課税仕入 10%",
    direction: "purchase",
    kind: "taxable",
    sortOrder: 110,
  },
  {
    code: "purchase_8r",
    name: "課税仕入 8%（軽減）",
    direction: "purchase",
    kind: "taxable",
    sortOrder: 120,
  },
  {
    code: "purchase_10_ni",
    name: "課税仕入 10%（インボイスなし）",
    direction: "purchase",
    kind: "taxable",
    sortOrder: 130,
  },
  {
    code: "purchase_8r_ni",
    name: "課税仕入 8%（軽減・インボイスなし）",
    direction: "purchase",
    kind: "taxable",
    sortOrder: 140,
  },
  {
    code: "purchase_exempt",
    name: "非課税仕入",
    direction: "purchase",
    kind: "exempt",
    sortOrder: 150,
  },
  {
    code: "purchase_out",
    name: "不課税仕入",
    direction: "purchase",
    kind: "out_of_scope",
    sortOrder: 160,
  },
  { code: "na", name: "対象外", direction: "none", kind: "na", sortOrder: 900 },
];

const TAX_CATEGORY_BY_CODE: ReadonlyMap<string, TaxCategoryDefinition> = new Map(
  TAX_CATEGORIES.map((category) => [category.code, category]),
);

export function isTaxCategoryCode(value: unknown): value is TaxCategoryCode {
  return typeof value === "string" && TAX_CATEGORY_BY_CODE.has(value);
}

export function getTaxCategory(code: string): TaxCategoryDefinition | undefined {
  return TAX_CATEGORY_BY_CODE.get(code);
}

/** 10% (and the reduced 8%) took effect on this date. */
const RATE_10_START = "2019-10-01";
/** Qualified invoice system (インボイス制度) start: transitional credit for purchases without an invoice. */
const INVOICE_SYSTEM_START = "2023-10-01";

/** Purchases without a qualified invoice: credit ratio by period (経過措置). */
const NO_INVOICE_SCHEDULE = [
  { from: INVOICE_SYSTEM_START, to: "2026-09-30", deductiblePercent: 80 },
  { from: "2026-10-01", to: "2028-09-30", deductiblePercent: 70 },
  { from: "2028-10-01", to: "2030-09-30", deductiblePercent: 50 },
  { from: "2030-10-01", to: "2031-09-30", deductiblePercent: 30 },
  { from: "2031-10-01", to: null, deductiblePercent: 0 },
] as const;

/** Proposed 1% rate for food and drink (bill submitted, not enacted). Kept disabled until it passes. */
const FOOD_1_PERCENT = { from: "2027-04-01", to: "2029-03-31" } as const;
const FOOD_1_PERCENT_NOTE = "飲食料品の税率 1%（法案。成立したら有効にする）";

export const STANDARD_TAX_RATE_RULES: readonly TaxRateRule[] = [
  {
    taxCategoryCode: "sales_10",
    effectiveFrom: RATE_10_START,
    effectiveTo: null,
    ratePercent: 10,
    deductiblePercent: null,
    enabled: true,
  },
  {
    taxCategoryCode: "sales_8r",
    effectiveFrom: RATE_10_START,
    effectiveTo: null,
    ratePercent: 8,
    deductiblePercent: null,
    enabled: true,
  },
  {
    taxCategoryCode: "sales_8r",
    effectiveFrom: FOOD_1_PERCENT.from,
    effectiveTo: FOOD_1_PERCENT.to,
    ratePercent: 1,
    deductiblePercent: null,
    enabled: false,
    note: FOOD_1_PERCENT_NOTE,
  },
  {
    taxCategoryCode: "sales_exempt",
    effectiveFrom: RATE_10_START,
    effectiveTo: null,
    ratePercent: 0,
    deductiblePercent: null,
    enabled: true,
  },
  {
    taxCategoryCode: "sales_out",
    effectiveFrom: RATE_10_START,
    effectiveTo: null,
    ratePercent: 0,
    deductiblePercent: null,
    enabled: true,
  },
  {
    taxCategoryCode: "sales_export",
    effectiveFrom: RATE_10_START,
    effectiveTo: null,
    ratePercent: 0,
    deductiblePercent: null,
    enabled: true,
  },
  {
    taxCategoryCode: "purchase_10",
    effectiveFrom: RATE_10_START,
    effectiveTo: null,
    ratePercent: 10,
    deductiblePercent: 100,
    enabled: true,
  },
  {
    taxCategoryCode: "purchase_8r",
    effectiveFrom: RATE_10_START,
    effectiveTo: null,
    ratePercent: 8,
    deductiblePercent: 100,
    enabled: true,
  },
  {
    taxCategoryCode: "purchase_8r",
    effectiveFrom: FOOD_1_PERCENT.from,
    effectiveTo: FOOD_1_PERCENT.to,
    ratePercent: 1,
    deductiblePercent: 100,
    enabled: false,
    note: FOOD_1_PERCENT_NOTE,
  },
  ...NO_INVOICE_SCHEDULE.map((period): TaxRateRule => ({
    taxCategoryCode: "purchase_10_ni",
    effectiveFrom: period.from,
    effectiveTo: period.to,
    ratePercent: 10,
    deductiblePercent: period.deductiblePercent,
    enabled: true,
  })),
  ...NO_INVOICE_SCHEDULE.map((period): TaxRateRule => ({
    taxCategoryCode: "purchase_8r_ni",
    effectiveFrom: period.from,
    effectiveTo: period.to,
    ratePercent: 8,
    deductiblePercent: period.deductiblePercent,
    enabled: true,
  })),
  // The 1% food rate without an invoice follows the same credit schedule, so it is split at 2028-10-01.
  {
    taxCategoryCode: "purchase_8r_ni",
    effectiveFrom: FOOD_1_PERCENT.from,
    effectiveTo: "2028-09-30",
    ratePercent: 1,
    deductiblePercent: 70,
    enabled: false,
    note: FOOD_1_PERCENT_NOTE,
  },
  {
    taxCategoryCode: "purchase_8r_ni",
    effectiveFrom: "2028-10-01",
    effectiveTo: FOOD_1_PERCENT.to,
    ratePercent: 1,
    deductiblePercent: 50,
    enabled: false,
    note: FOOD_1_PERCENT_NOTE,
  },
  {
    taxCategoryCode: "purchase_exempt",
    effectiveFrom: RATE_10_START,
    effectiveTo: null,
    ratePercent: 0,
    deductiblePercent: null,
    enabled: true,
  },
  {
    taxCategoryCode: "purchase_out",
    effectiveFrom: RATE_10_START,
    effectiveTo: null,
    ratePercent: 0,
    deductiblePercent: null,
    enabled: true,
  },
  {
    taxCategoryCode: "na",
    effectiveFrom: RATE_10_START,
    effectiveTo: null,
    ratePercent: 0,
    deductiblePercent: null,
    enabled: true,
  },
];
