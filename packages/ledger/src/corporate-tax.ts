import { addDays, dateParts, isCalendarDate, lastDayOfMonth, type CalendarDate } from "./date";
import { countLocalTaxMonths, countMonths, monthPeriodEnd } from "./depreciation";
import type { Money } from "./money";

/**
 * 法人税等の概算 (docs/design/16-year-end.md §9). A guide for the year-end entry, without 申告調整:
 * the owner replaces it with the tax accountant's or the return's figures. Rates are integer basis
 * points (1/10,000); 課税標準 is truncated to 1,000 yen and each tax to 100 yen.
 */

// ---------------------------------------------------------------------------
// 率 (期の開始日で引く。03 §4.1 の【要確認】が確かめられたら表だけ直す)
// ---------------------------------------------------------------------------

export interface CorporateTaxRates {
  /** Fiscal years starting on or after this date use the row (until the next row). */
  from: CalendarDate;
  /** 法人税: the part up to 8,000,000 a year (中小法人の軽減税率). */
  reducedRateBp: number;
  /** 法人税: the part above. */
  standardRateBp: number;
  /** 地方法人税 (× 法人税額). */
  localCorporateTaxBp: number;
  /** 防衛特別法人税 (× (法人税額 − 5,000,000 a year)); `null` before it applies. */
  defenseTaxBp: number | null;
  /** 事業税 所得割: up to 4,000,000 / up to 8,000,000 / above (a year). */
  enterpriseTaxBp: readonly [number, number, number];
  /** 特別法人事業税 (× 事業税 所得割). */
  specialEnterpriseTaxBp: number;
}

/**
 * Sources: 法法66・措法42の3の2 (15% for years starting by 2027-03-31, then 19%), 地方法人税法10
 * (10.3%), 防衛特別法人税 (4%, years starting on or after 2026-04-01), docs/design/03-compliance.md
 * §4.1 and docs/research/jp-requirements.md §2-2. 事業税・特別法人事業税 are 【要確認】.
 */
export const CORPORATE_TAX_RATE_TABLE: readonly CorporateTaxRates[] = [
  {
    from: "2019-10-01",
    reducedRateBp: 1500,
    standardRateBp: 2320,
    localCorporateTaxBp: 1030,
    defenseTaxBp: null,
    enterpriseTaxBp: [350, 530, 700],
    specialEnterpriseTaxBp: 3700,
  },
  {
    from: "2026-04-01",
    reducedRateBp: 1500,
    standardRateBp: 2320,
    localCorporateTaxBp: 1030,
    defenseTaxBp: 400,
    enterpriseTaxBp: [350, 530, 700],
    specialEnterpriseTaxBp: 3700,
  },
  {
    from: "2027-04-01",
    reducedRateBp: 1900,
    standardRateBp: 2320,
    localCorporateTaxBp: 1030,
    defenseTaxBp: 400,
    enterpriseTaxBp: [350, 530, 700],
    specialEnterpriseTaxBp: 3700,
  },
];

/** The rates of a fiscal year starting on `startDate` (the first row for earlier dates). */
export function corporateTaxRates(startDate: CalendarDate): CorporateTaxRates {
  let found: CorporateTaxRates | undefined = CORPORATE_TAX_RATE_TABLE[0];
  for (const row of CORPORATE_TAX_RATE_TABLE) {
    if (row.from <= startDate) found = row;
  }
  if (!found) throw new Error("corporateTaxRates: the rate table is empty");
  return found;
}

/** Yearly amounts the brackets are prorated from (× months ÷ 12, truncated to 1,000 yen). */
const REDUCED_RATE_INCOME_LIMIT: Money = 8_000_000n;
const DEFENSE_TAX_DEDUCTION: Money = 5_000_000n;
const ENTERPRISE_TAX_BRACKETS: readonly [Money, Money] = [4_000_000n, 8_000_000n];

export interface LocalTaxAuthority {
  name: string;
  /** 均等割 (年額). */
  perCapitaAnnual: Money;
  /** 法人税割 (× 法人税額, basis points). */
  corporateTaxRateBp: number;
}

export interface LocalTaxSetting {
  prefecture: LocalTaxAuthority;
  municipality: LocalTaxAuthority;
}

/**
 * Values from docs/design/03-compliance.md §4.1 (均等割) and docs/research/jp-requirements.md §2-2
 * (法人税割). 県の法人税割 1.0% is 【要確認】.
 */
export const DEFAULT_LOCAL_TAX: LocalTaxSetting = {
  prefecture: { name: "神奈川県", perCapitaAnnual: 20_000n, corporateTaxRateBp: 100 },
  municipality: { name: "鎌倉市", perCapitaAnnual: 50_000n, corporateTaxRateBp: 600 },
};

// ---------------------------------------------------------------------------
// 概算
// ---------------------------------------------------------------------------

export const CORPORATE_TAX_LINE_KEYS = [
  "corporate_tax",
  "local_corporate_tax",
  "defense_tax",
  "prefecture_tax",
  "municipal_tax",
  "prefecture_per_capita",
  "municipal_per_capita",
  "enterprise_tax",
  "special_enterprise_tax",
] as const;
export type CorporateTaxLineKey = (typeof CORPORATE_TAX_LINE_KEYS)[number];

/** Labels without the local authority's name (the estimate appends it). */
export const CORPORATE_TAX_LINE_LABELS: Readonly<Record<CorporateTaxLineKey, string>> = {
  corporate_tax: "法人税",
  local_corporate_tax: "地方法人税",
  defense_tax: "防衛特別法人税",
  prefecture_tax: "法人住民税 法人税割（県）",
  municipal_tax: "法人住民税 法人税割（市）",
  prefecture_per_capita: "均等割（県）",
  municipal_per_capita: "均等割（市）",
  enterprise_tax: "事業税（所得割）",
  special_enterprise_tax: "特別法人事業税",
};

export interface CorporateTaxLine {
  key: CorporateTaxLineKey;
  label: string;
  /** 課税標準 (or the yearly amount for 均等割). */
  base: Money;
  amount: Money;
}

export interface CorporateTaxEstimate {
  /** Months as national taxes count them (§4.2). */
  months: number;
  /** Months as 均等割 counts them (地方税法52条③). */
  localMonths: number;
  carryforwardUsed: Money;
  /** 所得の概算 after the carryforward, truncated to 1,000 yen. */
  taxableIncome: Money;
  lines: CorporateTaxLine[];
  total: Money;
}

function floorTo(value: Money, unit: Money): Money {
  if (value <= 0n) return 0n;
  return value - (value % unit);
}

const floor1000 = (value: Money): Money => floorTo(value, 1000n);
const floor100 = (value: Money): Money => floorTo(value, 100n);

/** `annual × months ÷ 12` truncated to 1,000 yen: the brackets of a short year. */
function proratedBracket(annual: Money, months: number): Money {
  return floor1000((annual * BigInt(months)) / 12n);
}

function times(base: Money, bp: number): Money {
  return (base * BigInt(bp)) / 10_000n;
}

function authorityLabel(key: CorporateTaxLineKey, authority: LocalTaxAuthority): string {
  const label = CORPORATE_TAX_LINE_LABELS[key];
  const name = authority.name.trim();
  if (name === "") return label;
  return label.replace(/（[県市]）$/, `（${name}）`);
}

/**
 * The yearly corporate taxes of a fiscal year from its pre-tax income (§9). Losses carried forward are
 * used in full (中小法人). The 均等割 is due even with a loss.
 */
export function estimateCorporateTax(input: {
  period: { startDate: CalendarDate; endDate: CalendarDate };
  pretaxIncome: Money;
  lossCarryforward: Money;
  local?: LocalTaxSetting;
}): CorporateTaxEstimate {
  const { startDate, endDate } = input.period;
  const local = input.local ?? DEFAULT_LOCAL_TAX;
  const rates = corporateTaxRates(startDate);
  const months = countMonths(startDate, endDate);
  const localMonths = countLocalTaxMonths(startDate, endDate);

  const positiveIncome = input.pretaxIncome > 0n ? input.pretaxIncome : 0n;
  const carryforward = input.lossCarryforward > 0n ? input.lossCarryforward : 0n;
  const carryforwardUsed = carryforward < positiveIncome ? carryforward : positiveIncome;
  const taxableIncome = floor1000(positiveIncome - carryforwardUsed);

  // 法人税: the reduced rate up to 8,000,000 × months ÷ 12, the standard rate above.
  const reducedLimit = proratedBracket(REDUCED_RATE_INCOME_LIMIT, months);
  const reducedPart = taxableIncome < reducedLimit ? taxableIncome : reducedLimit;
  const standardPart = taxableIncome - reducedPart;
  const corporateTax = floor100(
    (reducedPart * BigInt(rates.reducedRateBp) + standardPart * BigInt(rates.standardRateBp)) /
      10_000n,
  );
  const corporateTaxBase = floor1000(corporateTax);

  const lines: CorporateTaxLine[] = [
    {
      key: "corporate_tax",
      label: CORPORATE_TAX_LINE_LABELS.corporate_tax,
      base: taxableIncome,
      amount: corporateTax,
    },
    {
      key: "local_corporate_tax",
      label: CORPORATE_TAX_LINE_LABELS.local_corporate_tax,
      base: corporateTaxBase,
      amount: floor100(times(corporateTaxBase, rates.localCorporateTaxBp)),
    },
  ];

  if (rates.defenseTaxBp !== null) {
    const deduction = (DEFENSE_TAX_DEDUCTION * BigInt(months)) / 12n;
    const base = floor1000(corporateTax - deduction);
    lines.push({
      key: "defense_tax",
      label: CORPORATE_TAX_LINE_LABELS.defense_tax,
      base,
      amount: floor100(times(base, rates.defenseTaxBp)),
    });
  }

  lines.push(
    {
      key: "prefecture_tax",
      label: authorityLabel("prefecture_tax", local.prefecture),
      base: corporateTaxBase,
      amount: floor100(times(corporateTaxBase, local.prefecture.corporateTaxRateBp)),
    },
    {
      key: "municipal_tax",
      label: authorityLabel("municipal_tax", local.municipality),
      base: corporateTaxBase,
      amount: floor100(times(corporateTaxBase, local.municipality.corporateTaxRateBp)),
    },
    {
      key: "prefecture_per_capita",
      label: authorityLabel("prefecture_per_capita", local.prefecture),
      base: local.prefecture.perCapitaAnnual,
      amount: floor100((local.prefecture.perCapitaAnnual * BigInt(localMonths)) / 12n),
    },
    {
      key: "municipal_per_capita",
      label: authorityLabel("municipal_per_capita", local.municipality),
      base: local.municipality.perCapitaAnnual,
      amount: floor100((local.municipality.perCapitaAnnual * BigInt(localMonths)) / 12n),
    },
  );

  // 事業税 所得割: 3 brackets of the income, prorated like the 法人税 bracket.
  const lowLimit = proratedBracket(ENTERPRISE_TAX_BRACKETS[0], months);
  const middleLimit = proratedBracket(ENTERPRISE_TAX_BRACKETS[1], months);
  const [lowBp, middleBp, highBp] = rates.enterpriseTaxBp;
  const low = taxableIncome < lowLimit ? taxableIncome : lowLimit;
  const middle = (taxableIncome < middleLimit ? taxableIncome : middleLimit) - low;
  const high = taxableIncome - low - middle;
  const enterpriseTax = floor100(
    (low * BigInt(lowBp) + middle * BigInt(middleBp) + high * BigInt(highBp)) / 10_000n,
  );
  lines.push(
    {
      key: "enterprise_tax",
      label: CORPORATE_TAX_LINE_LABELS.enterprise_tax,
      base: taxableIncome,
      amount: enterpriseTax,
    },
    {
      key: "special_enterprise_tax",
      label: CORPORATE_TAX_LINE_LABELS.special_enterprise_tax,
      base: enterpriseTax,
      amount: floor100(times(enterpriseTax, rates.specialEnterpriseTaxBp)),
    },
  );

  const total = lines.reduce((sum, line) => sum + line.amount, 0n);
  return { months, localMonths, carryforwardUsed, taxableIncome, lines, total };
}

// ---------------------------------------------------------------------------
// 繰越欠損金
// ---------------------------------------------------------------------------

/** Years a loss can be carried forward (法法57①: losses of years started within 10 years before). */
export const LOSS_CARRYFORWARD_YEARS = 10;

/** The same date `years` earlier; 02-29 becomes 02-28 when the year has none. */
function yearsBefore(date: CalendarDate, years: number): CalendarDate {
  const { year, month, day } = dateParts(date);
  const target = year - years;
  const candidate = `${String(target).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isCalendarDate(candidate) ? candidate : lastDayOfMonth(target, month);
}

/**
 * The loss carried forward into the year starting on `currentStartDate` (§9). Walks the earlier years
 * in order: a loss is kept with its year's start date, a profit uses the oldest usable losses first.
 * A loss can be used by a year that starts within 10 years after the loss year started (法法57①:
 * 「各事業年度開始の日前十年以内に開始した事業年度において生じた欠損金額」).
 */
export function lossCarryforward(
  prior: readonly { startDate: CalendarDate; endDate: CalendarDate; pretaxIncome: Money }[],
  currentStartDate: CalendarDate,
): Money {
  const losses: { startDate: CalendarDate; remaining: Money }[] = [];
  const usable = (loss: { startDate: CalendarDate }, yearStart: CalendarDate): boolean =>
    loss.startDate >= yearsBefore(yearStart, LOSS_CARRYFORWARD_YEARS);

  const years = [...prior]
    .filter((year) => year.startDate < currentStartDate)
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  for (const year of years) {
    if (year.pretaxIncome < 0n) {
      losses.push({ startDate: year.startDate, remaining: -year.pretaxIncome });
      continue;
    }
    let income = year.pretaxIncome;
    for (const loss of losses) {
      if (income <= 0n) break;
      if (loss.remaining <= 0n || !usable(loss, year.startDate)) continue;
      const used = loss.remaining < income ? loss.remaining : income;
      loss.remaining -= used;
      income -= used;
    }
  }
  return losses
    .filter((loss) => usable(loss, currentStartDate))
    .reduce((sum, loss) => sum + loss.remaining, 0n);
}

/**
 * The filing and payment deadline of the corporate taxes: 2 months from the day after the year end
 * (法人税法74①, counted like 民法143条). `2027-03-31` → `2027-05-31`.
 */
export function corporateTaxDueDate(endDate: CalendarDate): CalendarDate {
  return monthPeriodEnd(addDays(endDate, 1), 2);
}
