import {
  addDays,
  dateParts,
  displayDate,
  formatYen,
  isCalendarDate,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";
import {
  employmentInsurancePremium,
  type EmploymentInsurancePremium,
} from "./employment-insurance";
import { PayrollInputError, PayrollSnapshotError, type PayrollInputIssue } from "./errors";
import { yearMonthOf, type YearMonth } from "./month";
import { checkPinnedTable, type PayrollCoverage, type WorkerKind } from "./payroll";
import { floorToYen, mul, ratio, type Rational } from "./rational";
import {
  findBonusWithholdingTable,
  findEmploymentInsuranceTable,
  findKenpoTable,
  findPensionTable,
  findTableById,
  findWithholdingTable,
} from "./registry";
import {
  PAYROLL_ACCOUNT_CODES,
  PAYROLL_RULE_KEY_PREFIX,
  PAYROLL_SUB_ACCOUNTS,
  yearMonthLabel,
  type PayrollEntries,
  type PayrollEntryLine,
  type PayrollLineTarget,
  type PayrollRunSummary,
  type PayrollSubAccountKey,
} from "./run";
import {
  child,
  count,
  fail,
  money,
  nonNegativeMoney,
  rational,
  readCoverage,
  readEmploymentInsurance,
  readSocialInsurance,
  readTableRef,
  readTaxColumn,
  record,
  text,
  toSnapshotJson,
  type SnapshotJson,
} from "./snapshot";
import {
  aggregateSocialInsurance,
  premiumsOn,
  type SocialInsuranceCoverage,
  type SocialInsurancePremiums,
} from "./social-insurance";
import {
  KOU_COLUMNS,
  tableRef,
  type BonusWithholdingRow,
  type BonusWithholdingTable,
  type EmploymentInsuranceTable,
  type KenpoTable,
  type PayrollTable,
  type PensionTable,
  type TableRef,
  type WithholdingTable,
} from "./tables";
import { checkTaxColumn, withholdingTax, type TaxColumn } from "./withholding";

/*
 * 賞与 (22-payroll §10): 標準賞与額 and its caps, the premiums, the withholding tax of the bonus table
 * (算出率の表) with the two exceptions of its note 4 (月額表), the 事前確定届出給与 check of an
 * officer, the 2 entries, what a bonus run adds to the payment schedule, and the snapshot. Pure.
 */

// ---------------------------------------------------------------------------------------------
// 標準賞与額 (§10.2)
// ---------------------------------------------------------------------------------------------

/** 標準賞与額 is the bonus truncated to the thousand yen. */
export const STANDARD_BONUS_UNIT = 1_000n;
/** 健康保険（介護・支援金を含む）: the 標準賞与額 of one 年度 (4 月〜翌年 3 月) count up to this. */
export const HEALTH_STANDARD_BONUS_ANNUAL_CAP = 5_730_000n;
/** 厚生年金・子ども・子育て拠出金: the 標準賞与額 of one month count up to this. */
export const PENSION_STANDARD_BONUS_MONTHLY_CAP = 1_500_000n;

function invalidAmount(field: string, label: string): PayrollInputError {
  return new PayrollInputError([
    { code: "INVALID_AMOUNT", field, message: `${label}は 0 円以上の整数（円）にしてください` },
  ]);
}

/** 標準賞与額: 賞与の額の 1,000 円未満切り捨て. */
export function standardBonusAmount(bonus: Money): Money {
  if (typeof bonus !== "bigint" || bonus < 0n) throw invalidAmount("bonus", "賞与の額");
  return (bonus / STANDARD_BONUS_UNIT) * STANDARD_BONUS_UNIT;
}

/** The 年度 (4 月 1 日〜翌年 3 月 31 日) of a date, as the calendar year of its April. */
export function insuranceYearOf(date: CalendarDate): number {
  const { year, month } = dateParts(date);
  return month >= 4 ? year : year - 1;
}

export interface StandardBonus {
  /** 標準賞与額: the bonus truncated to the thousand yen. */
  amount: Money;
  /**
   * The amount 健康保険（介護・支援金）is charged on: the 標準賞与額 within what the year's cap
   * (573 万円) leaves after the earlier bonuses of the 年度; 0 when not covered.
   */
  health: Money;
  /** The amount 厚生年金・拠出金 are charged on: at most 150 万円; 0 when not covered. */
  pension: Money;
}

function min(a: Money, b: Money): Money {
  return a < b ? a : b;
}

/**
 * 標準賞与額 and the caps of §10.2. `priorHealth` is the sum of `StandardBonus.health` of the
 * person's earlier bonuses in the same 年度 (already capped, so at most 573 万円).
 */
export function cappedStandardBonus(
  bonus: Money,
  priorHealth: Money,
  coverage: { health: boolean; pension: boolean },
): StandardBonus {
  const amount = standardBonusAmount(bonus);
  if (typeof priorHealth !== "bigint" || priorHealth < 0n) {
    throw invalidAmount("priorHealthStandardBonus", "同じ年度の先の標準賞与額");
  }
  const left = HEALTH_STANDARD_BONUS_ANNUAL_CAP - priorHealth;
  return {
    amount,
    health: coverage.health ? min(amount, left < 0n ? 0n : left) : 0n,
    pension: coverage.pension ? min(amount, PENSION_STANDARD_BONUS_MONTHLY_CAP) : 0n,
  };
}

/**
 * The premiums of a bonus (§10.2): the monthly rates of the payment month on the capped 標準賞与額,
 * rounded as the monthly premiums are (the combined health rate halved and rounded once, 50 銭以下
 * 切り捨て; employer shares = full − employee).
 */
export function bonusSocialInsurance(
  kenpo: KenpoTable,
  pension: PensionTable,
  premiumMonth: YearMonth,
  standard: StandardBonus,
  coverage: SocialInsuranceCoverage,
): SocialInsurancePremiums {
  if (coverage.care && !coverage.health) {
    throw new PayrollInputError([
      {
        code: "CARE_WITHOUT_HEALTH",
        field: "coverage.care",
        message:
          "介護保険料は健康保険の被保険者だけにかかります。健康保険を「あり」にするか、介護保険を「なし」にしてください",
      },
    ]);
  }
  return premiumsOn(
    kenpo,
    pension,
    premiumMonth,
    { health: standard.health, pension: standard.pension },
    coverage,
  );
}

/** 雇用保険料 of a bonus: 賞与の額 × 労働者負担率 (50 銭以下切り捨て・50 銭超切り上げ). */
export function bonusEmploymentInsurance(
  table: EmploymentInsuranceTable,
  bonus: Money,
): EmploymentInsurancePremium {
  return employmentInsurancePremium(table, bonus);
}

// ---------------------------------------------------------------------------------------------
// 源泉所得税 (§10.1)
// ---------------------------------------------------------------------------------------------

export const BONUS_WITHHOLDING_METHODS = ["rate", "monthly_10x", "monthly_no_prev"] as const;
/**
 * `rate`: 算出率の表. `monthly_10x`: the bonus is more than 10 times the previous month's pay.
 * `monthly_no_prev`: there was no pay (after 社会保険料等) in the previous month.
 */
export type BonusWithholdingMethod = (typeof BONUS_WITHHOLDING_METHODS)[number];

export const BONUS_WITHHOLDING_METHOD_LABELS: Readonly<Record<BonusWithholdingMethod, string>> = {
  rate: "算出率の表",
  monthly_10x: "月額表（前月の給与の 10 倍を超える賞与）",
  monthly_no_prev: "月額表（前月の給与なし）",
};

/** The previous month's pay (§5's run of the month before the bonus, bonuses excluded). */
export interface BonusPreviousMonth {
  /**
   * 前月の社会保険料等控除後の給与等の金額 = 課税支給 − 社会保険料等. 0 or less (pay ≤ 社会保険料等)
   * counts as no pay.
   */
  pay: Money;
  /** The tax of that pay on the monthly table (the 10-times exception deducts it). */
  incomeTax: Money;
}

/** How the tax of a bonus was found, with every amount it took. */
export interface BonusWithholding {
  method: BonusWithholdingMethod;
  /** `rate`: the rate of the row (percent, as published), otherwise `null`. */
  ratePercent: string | null;
  rate: Rational | null;
  /** The monthly methods: 6, or 12 for a calculation period over 6 months. */
  divisor: number | null;
  /** The monthly methods: what is applied to the monthly table (対象額 ÷ divisor [+ 前月の給与]). */
  monthlyAmount: Money | null;
  /** Its tax on the monthly table. */
  monthlyTax: Money | null;
  /** `monthly_10x`: the previous month's tax deducted from `monthlyTax`. */
  previousMonthTax: Money | null;
}

/**
 * The row of the bonus table for 前月の社会保険料等控除後の給与等の金額 `previousPay`: the 甲欄 column of
 * the dependents (7 and more share the last column), or 乙欄.
 */
export function bonusRateRow(
  table: BonusWithholdingTable,
  column: TaxColumn,
  previousPay: Money,
): BonusWithholdingRow {
  const dependents = checkTaxColumn(column);
  const index = dependents < KOU_COLUMNS ? dependents : KOU_COLUMNS - 1;
  const row = table.rows.find((candidate) => {
    const range = column.column === "kou" ? candidate.kou[index] : candidate.otsu;
    return (
      range !== null &&
      range !== undefined &&
      (range.from === null || range.from <= previousPay) &&
      (range.to === null || previousPay < range.to)
    );
  });
  // Validated tables cover every amount in every column.
  if (!row) throw new RangeError(`${table.id}: no row for ${previousPay} yen`);
  return row;
}

export interface BonusWithholdingInput {
  bonusTable: BonusWithholdingTable;
  /** 月額表 of the bonus's payment year (the exceptions use it). */
  monthlyTable: WithholdingTable;
  taxColumn: TaxColumn;
  /** 対象額 = 賞与の額 − 賞与から控除する社会保険料等. */
  base: Money;
  previousMonth: BonusPreviousMonth | null;
  calcPeriodOver6Months: boolean;
}

/**
 * 源泉所得税 of a bonus (§10.1, No.2523):
 * - no pay in the previous month (none, or pay ≤ its 社会保険料等): the monthly table's tax of
 *   (対象額 ÷ 6) × 6 — ÷ 12 and × 12 when the calculation period is over 6 months;
 * - 対象額 more than 10 times the previous month's pay: (the monthly tax of 対象額 ÷ 6 + 前月の給与
 *   − the previous month's tax) × 6 (12);
 * - otherwise 対象額 × the rate of the previous month's pay's row (1 円未満切り捨て).
 * The divided amount is truncated to the yen. A 対象額 of 0 or less has no tax.
 */
export function bonusWithholdingTax(
  input: BonusWithholdingInput,
): BonusWithholding & { tax: Money } {
  const base = input.base < 0n ? 0n : input.base;
  const divisor = input.calcPeriodOver6Months ? 12 : 6;
  const times = BigInt(divisor);
  const previous = input.previousMonth;
  if (previous === null || previous.pay <= 0n) {
    const monthlyAmount = base / times;
    const monthlyTax = withholdingTax(input.monthlyTable, input.taxColumn, monthlyAmount);
    return {
      method: "monthly_no_prev",
      ratePercent: null,
      rate: null,
      divisor,
      monthlyAmount,
      monthlyTax,
      previousMonthTax: null,
      tax: monthlyTax * times,
    };
  }
  if (base > previous.pay * 10n) {
    const monthlyAmount = base / times + previous.pay;
    const monthlyTax = withholdingTax(input.monthlyTable, input.taxColumn, monthlyAmount);
    const difference = monthlyTax - previous.incomeTax;
    return {
      method: "monthly_10x",
      ratePercent: null,
      rate: null,
      divisor,
      monthlyAmount,
      monthlyTax,
      previousMonthTax: previous.incomeTax,
      tax: (difference < 0n ? 0n : difference) * times,
    };
  }
  const row = bonusRateRow(input.bonusTable, input.taxColumn, previous.pay);
  return {
    method: "rate",
    ratePercent: row.ratePercent,
    rate: row.rate,
    divisor: null,
    monthlyAmount: null,
    monthlyTax: null,
    previousMonthTax: null,
    tax: floorToYen(mul(ratio(base), row.rate)),
  };
}

// ---------------------------------------------------------------------------------------------
// 事前確定届出給与 (§10.3)
// ---------------------------------------------------------------------------------------------

/** What an officer's 事前確定届出給与に関する届出書 says (entered by the owner; both optional). */
export interface PredeterminedFiling {
  date: CalendarDate | null;
  amount: Money | null;
}

export const BONUS_WARNING_CODES = [
  "FILING_MISSING",
  "FILING_DATE_MISMATCH",
  "FILING_AMOUNT_MISMATCH",
] as const;
export type BonusWarningCode = (typeof BONUS_WARNING_CODES)[number];

/** A warning about an officer's bonus (保存は止めない). */
export interface BonusWarning {
  code: BonusWarningCode;
  message: string;
}

/**
 * An officer's bonus is deductible only as filed (事前確定届出給与): warns when the filing is not
 * entered, or the payment date or the amount differs from it. Nothing for an employee, nor for an
 * officer without a bonus and without a filing.
 */
export function predeterminedFilingWarnings(
  item: { kind: WorkerKind; bonus: Money; filing: PredeterminedFiling | null },
  paymentDate: CalendarDate,
): BonusWarning[] {
  if (item.kind !== "officer") return [];
  const filing = item.filing ?? { date: null, amount: null };
  if (item.bonus === 0n && filing.date === null && filing.amount === null) return [];
  const warnings: BonusWarning[] = [];
  if (filing.date === null || filing.amount === null) {
    warnings.push({
      code: "FILING_MISSING",
      message:
        "事前確定届出給与の届出（届け出た支給日と金額）が入っていません。届出のない役員の賞与は損金に算入されません",
    });
  }
  if (filing.date !== null && filing.date !== paymentDate) {
    warnings.push({
      code: "FILING_DATE_MISMATCH",
      message: `支払日 ${displayDate(paymentDate)} が届け出た支給日 ${displayDate(filing.date)} と違います。届出どおりに支給しないと損金に算入されない恐れがあります`,
    });
  }
  if (filing.amount !== null && filing.amount !== item.bonus) {
    warnings.push({
      code: "FILING_AMOUNT_MISMATCH",
      message: `賞与の額 ${formatYen(item.bonus)} 円が届け出た金額 ${formatYen(filing.amount)} 円と違います。届出どおりに支給しないと損金に算入されない恐れがあります`,
    });
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// 1 人の賞与 (§10.1・§10.2)
// ---------------------------------------------------------------------------------------------

export interface BonusTables {
  bonusWithholding: BonusWithholdingTable;
  withholding: WithholdingTable;
  kenpo: KenpoTable;
  pension: PensionTable;
  employment: EmploymentInsuranceTable;
}

export interface BonusInput {
  /** 支払日: selects the bonus and monthly tables (年分); its month is the premium month. */
  paymentDate: CalendarDate;
  worker: WorkerKind;
  /** 賞与の額 (課税). */
  bonus: Money;
  /** Coverage in the payment month (§2.9 judged on the payment month). */
  coverage: PayrollCoverage;
  taxColumn: TaxColumn;
  /** `null`: no pay in the previous month. */
  previousMonth: BonusPreviousMonth | null;
  /** 賞与の計算期間が 6 か月を超える (the exceptions then divide and multiply by 12). */
  calcPeriodOver6Months: boolean;
  /** `StandardBonus.health` of the person's earlier bonuses in the same 年度 (4 月〜翌年 3 月). */
  priorHealthStandardBonus: Money;
  /** Pins table versions (e.g. the ones a past run used); the rest come from the registry. */
  tables?: Partial<BonusTables>;
}

export interface BonusResult {
  /** 賞与の額 (総支給). */
  bonus: Money;
  standardBonus: StandardBonus;
  socialInsurance: SocialInsurancePremiums;
  /** `null` when not insured. */
  employmentInsurance: EmploymentInsurancePremium | null;
  /** 対象額 = 賞与 − 社会保険料（健保・厚年）− 雇用保険料. */
  withholdingBase: Money;
  withholding: BonusWithholding;
  incomeTax: Money;
  /** 社会保険料 + 雇用保険料 + 源泉所得税 (住民税 is not deducted from a bonus). */
  totalDeductions: Money;
  /** 差引支給額 = bonus − totalDeductions. */
  netPay: Money;
  tables: {
    bonusWithholding: TableRef;
    withholding: TableRef;
    kenpo: TableRef;
    pension: TableRef;
    employment: TableRef | null;
  };
}

const COVERAGES = [
  { key: "health", label: "健康保険" },
  { key: "care", label: "介護保険" },
  { key: "pension", label: "厚生年金" },
  { key: "employment", label: "雇用保険" },
] as const;

function isAmount(value: unknown): value is Money {
  return typeof value === "bigint" && value >= 0n;
}

function validateBonusInput(input: BonusInput): void {
  const issues: PayrollInputIssue[] = [];
  if (!isCalendarDate(input.paymentDate)) {
    issues.push({
      code: "INVALID_DATE",
      field: "paymentDate",
      message: `支払日「${String(input.paymentDate)}」が正しくありません（YYYY-MM-DD）`,
    });
  }
  const worker: unknown = input.worker;
  if (worker !== "officer" && worker !== "employee") {
    issues.push({
      code: "INVALID_WORKER",
      field: "worker",
      message: "役員か従業員かを選んでください",
    });
  }
  if (!isAmount(input.bonus)) {
    issues.push({
      code: "INVALID_AMOUNT",
      field: "bonus",
      message: "賞与の額は 0 円以上の整数（円）にしてください",
    });
  }
  if (!isAmount(input.priorHealthStandardBonus)) {
    issues.push({
      code: "INVALID_AMOUNT",
      field: "priorHealthStandardBonus",
      message: "同じ年度の先の標準賞与額は 0 円以上の整数（円）にしてください",
    });
  }
  const coverage: unknown = input.coverage;
  const flags = typeof coverage === "object" && coverage !== null ? coverage : {};
  for (const { key, label } of COVERAGES) {
    if (typeof (flags as Record<string, unknown>)[key] !== "boolean") {
      issues.push({
        code: "INVALID_COVERAGE",
        field: `coverage.${key}`,
        message: `${label}の適用を「あり」か「なし」で指定してください`,
      });
    }
  }
  if (typeof input.calcPeriodOver6Months !== "boolean") {
    issues.push({
      code: "INVALID_COVERAGE",
      field: "calcPeriodOver6Months",
      message: "賞与の計算期間を「6 か月以下」か「6 か月超」で指定してください",
    });
  }
  try {
    checkTaxColumn(input.taxColumn);
  } catch (error) {
    if (!(error instanceof PayrollInputError)) throw error;
    issues.push(...error.issues);
  }
  const previous: unknown = input.previousMonth;
  if (previous !== null) {
    const values =
      typeof previous === "object" && previous !== null
        ? (previous as Record<string, unknown>)
        : {};
    if (typeof values.pay !== "bigint") {
      issues.push({
        code: "INVALID_AMOUNT",
        field: "previousMonth.pay",
        message: "前月の給与（社会保険料等控除後）は円の整数にしてください",
      });
    }
    if (!isAmount(values.incomeTax)) {
      issues.push({
        code: "INVALID_AMOUNT",
        field: "previousMonth.incomeTax",
        message: "前月の税額は 0 円以上の整数（円）にしてください",
      });
    }
  }
  if (worker === "officer" && input.coverage?.employment === true) {
    issues.push({
      code: "OFFICER_EMPLOYMENT_INSURANCE",
      field: "coverage.employment",
      message: "役員は雇用保険の被保険者になりません。雇用保険を「なし」にしてください",
    });
  }
  if (input.coverage?.care === true && input.coverage.health !== true) {
    issues.push({
      code: "CARE_WITHOUT_HEALTH",
      field: "coverage.care",
      message:
        "介護保険料は健康保険の被保険者だけにかかります。健康保険を「あり」にするか、介護保険を「なし」にしてください",
    });
  }
  if (issues.length > 0) throw new PayrollInputError(issues);
}

function resolveBonusTables(input: BonusInput, premiumMonth: YearMonth) {
  const pinned = input.tables ?? {};
  const checks: [PayrollTable | undefined, PayrollTable["kind"], string, string][] = [
    [pinned.bonusWithholding, "withholding-bonus", "bonusWithholding", input.paymentDate],
    [pinned.withholding, "withholding-monthly", "withholding", input.paymentDate],
    [pinned.kenpo, "kyokai-kenpo", "kenpo", premiumMonth],
    [pinned.pension, "pension", "pension", premiumMonth],
    [
      input.coverage.employment ? pinned.employment : undefined,
      "employment-insurance",
      "employment",
      premiumMonth,
    ],
  ];
  const issues = checks
    .map(([table, kind, field, when]) =>
      table ? checkPinnedTable(table, kind, field, when) : null,
    )
    .filter((issue): issue is PayrollInputIssue => issue !== null);
  if (issues.length > 0) throw new PayrollInputError(issues);
  return {
    bonusWithholding: pinned.bonusWithholding ?? findBonusWithholdingTable(input.paymentDate),
    withholding: pinned.withholding ?? findWithholdingTable(input.paymentDate),
    kenpo: pinned.kenpo ?? findKenpoTable(premiumMonth),
    pension: pinned.pension ?? findPensionTable(premiumMonth),
    employment: input.coverage.employment
      ? (pinned.employment ?? findEmploymentInsuranceTable(premiumMonth))
      : null,
  };
}

/**
 * One person's bonus (22-payroll §10.1・§10.2): 標準賞与額 with the year's health cap and the month's
 * pension cap, the premiums on the payment month's rates, 雇用保険, the 対象額 and its tax by the
 * bonus table or the monthly table, and the net pay. Tables come from the registry by the payment
 * date (and its month) unless pinned; the result names every table it used.
 *
 * Throws `PayrollInputError` for invalid input and `PayrollTableMissingError` when no table covers
 * the date or month.
 */
export function calculateBonus(input: BonusInput): BonusResult {
  validateBonusInput(input);
  const premiumMonth = yearMonthOf(input.paymentDate);
  const tables = resolveBonusTables(input, premiumMonth);
  const standardBonus = cappedStandardBonus(
    input.bonus,
    input.priorHealthStandardBonus,
    input.coverage,
  );
  const socialInsurance = bonusSocialInsurance(
    tables.kenpo,
    tables.pension,
    premiumMonth,
    standardBonus,
    input.coverage,
  );
  const employmentInsurance = tables.employment
    ? bonusEmploymentInsurance(tables.employment, input.bonus)
    : null;
  const insurance = socialInsurance.employeeTotal + (employmentInsurance?.employee ?? 0n);
  const withholdingBase = input.bonus - insurance;
  const { tax, ...withholding } = bonusWithholdingTax({
    bonusTable: tables.bonusWithholding,
    monthlyTable: tables.withholding,
    taxColumn: input.taxColumn,
    base: withholdingBase,
    previousMonth: input.previousMonth,
    calcPeriodOver6Months: input.calcPeriodOver6Months,
  });
  const totalDeductions = insurance + tax;
  return {
    bonus: input.bonus,
    standardBonus,
    socialInsurance,
    employmentInsurance,
    withholdingBase,
    withholding,
    incomeTax: tax,
    totalDeductions,
    netPay: input.bonus - totalDeductions,
    tables: {
      bonusWithholding: tableRef(tables.bonusWithholding),
      withholding: tableRef(tables.withholding),
      kenpo: tableRef(tables.kenpo),
      pension: tableRef(tables.pension),
      employment: tables.employment ? tableRef(tables.employment) : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 仕訳と暦 (§10.4)
// ---------------------------------------------------------------------------------------------

/** The sub-accounts 「賞与」 the first bonus run makes (22-payroll §10.4). */
export const PAYROLL_BONUS_SUB_ACCOUNTS = {
  officerBonus: { accountCode: PAYROLL_ACCOUNT_CODES.officerPay, name: "賞与" },
  salaryBonus: { accountCode: PAYROLL_ACCOUNT_CODES.salaries, name: "賞与" },
} as const;

function sub(key: PayrollSubAccountKey): PayrollLineTarget {
  const { accountCode, name } = PAYROLL_SUB_ACCOUNTS[key];
  return { kind: "account", accountCode, subAccountName: name };
}

function bonusSub(key: keyof typeof PAYROLL_BONUS_SUB_ACCOUNTS): PayrollLineTarget {
  const { accountCode, name } = PAYROLL_BONUS_SUB_ACCOUNTS[key];
  return { kind: "account", accountCode, subAccountName: name };
}

/** Adds a line: 0 is left out, a negative total goes to the other side (as the monthly entries). */
function place(
  lines: PayrollEntryLine[],
  side: "debit" | "credit",
  target: PayrollLineTarget,
  amount: Money,
): void {
  if (amount === 0n) return;
  const flipped = amount < 0n;
  lines.push({
    side: flipped ? (side === "debit" ? "credit" : "debit") : side,
    target,
    amount: flipped ? -amount : amount,
    taxCategoryCode: "na",
  });
}

export interface BuildBonusEntriesInput {
  payMonth: YearMonth;
  /** 題名 (夏季賞与 など). */
  title: string;
  items: readonly { kind: WorkerKind; result: BonusResult }[];
  /** `wallet`: paid from the run's wallet on the payment date; `accrued`: 未払金〔給与〕. */
  payFrom: "wallet" | "accrued";
}

/**
 * The two entries of a confirmed bonus run (22-payroll §10.4). 本人分: 役員報酬〔賞与〕/ 給料手当〔賞与〕
 * against 預り金〔源泉所得税・社会保険料・雇用保険料〕 and 未払金〔給与〕 (or the wallet). 会社分:
 * 法定福利費 / 未払費用〔社会保険料〕 for the employer share and 拠出金 of the bonus premiums.
 */
export function buildBonusEntries(input: BuildBonusEntriesInput): PayrollEntries {
  let officerBonus = 0n;
  let salaryBonus = 0n;
  let incomeTax = 0n;
  let socialInsurance = 0n;
  let employmentInsurance = 0n;
  let netPay = 0n;
  for (const { kind, result } of input.items) {
    if (kind === "officer") officerBonus += result.bonus;
    else salaryBonus += result.bonus;
    incomeTax += result.incomeTax;
    socialInsurance += result.socialInsurance.employeeTotal;
    employmentInsurance += result.employmentInsurance?.employee ?? 0n;
    netPay += result.netPay;
  }
  const pay: PayrollEntryLine[] = [];
  place(pay, "debit", bonusSub("officerBonus"), officerBonus);
  place(pay, "debit", bonusSub("salaryBonus"), salaryBonus);
  place(pay, "credit", sub("withholdingTax"), incomeTax);
  place(pay, "credit", sub("socialInsurance"), socialInsurance);
  place(pay, "credit", sub("employmentInsurance"), employmentInsurance);
  place(pay, "credit", input.payFrom === "wallet" ? { kind: "wallet" } : sub("pay"), netPay);

  const aggregate = aggregateSocialInsurance(
    input.items.map(({ result }) => result.socialInsurance),
  );
  const employer: PayrollEntryLine[] = [];
  const welfare: PayrollLineTarget = {
    kind: "account",
    accountCode: PAYROLL_ACCOUNT_CODES.welfare,
    subAccountName: null,
  };
  place(employer, "debit", welfare, aggregate.employerTotal);
  place(employer, "credit", sub("employerSocialInsurance"), aggregate.employerTotal);

  const month = yearMonthLabel(input.payMonth);
  return {
    pay: { description: `${input.title} ${month}支給`, lines: pay },
    employer:
      employer.length > 0
        ? { description: `法定福利費 ${month}分（${input.title}）`, lines: employer }
        : null,
    socialInsurance: aggregate,
    extraSocialInsurance: [],
  };
}

/**
 * What a confirmed bonus run owes, in the shape of a monthly run's summary so that the payment
 * schedule (§7.2) adds it: 源泉所得税 to the pay month's deadline (or its half year), 社会保険料 to the
 * deadline of the pay month as premium month, no 住民税.
 */
export function summarizeBonusRun(run: {
  payMonth: YearMonth;
  withholdingSpecialDue: boolean;
  items: readonly { result: BonusResult }[];
}): PayrollRunSummary {
  let grossPay = 0n;
  let totalDeductions = 0n;
  let netPay = 0n;
  let incomeTax = 0n;
  let socialInsuranceEmployee = 0n;
  let employmentInsuranceEmployee = 0n;
  for (const { result } of run.items) {
    grossPay += result.bonus;
    totalDeductions += result.totalDeductions;
    netPay += result.netPay;
    incomeTax += result.incomeTax;
    socialInsuranceEmployee += result.socialInsurance.employeeTotal;
    employmentInsuranceEmployee += result.employmentInsurance?.employee ?? 0n;
  }
  return {
    kind: "bonus",
    payMonth: run.payMonth,
    premiumMonth: run.payMonth,
    withholdingSpecialDue: run.withholdingSpecialDue,
    residentTaxSpecialDue: false,
    headcount: run.items.length,
    grossPay,
    totalDeductions,
    netPay,
    incomeTax,
    residentTax: 0n,
    socialInsuranceEmployee,
    socialInsuranceEmployer: aggregateSocialInsurance(
      run.items.map(({ result }) => result.socialInsurance),
    ).employerTotal,
    employmentInsuranceEmployee,
  };
}

/** A filing deadline a bonus run adds (§10.4): 被保険者賞与支払届. */
export interface PayrollFilingSlot {
  /** `payroll.bonus_report.<支給月>` */
  ruleKey: string;
  title: string;
  dueDate: CalendarDate;
}

/** 健康保険・厚生年金保険 被保険者賞与支払届: within 5 days of the payment date. */
export function bonusReportSlot(payMonth: YearMonth, paymentDate: CalendarDate): PayrollFilingSlot {
  return {
    ruleKey: `${PAYROLL_RULE_KEY_PREFIX}bonus_report.${payMonth}`,
    title: `被保険者賞与支払届の提出（${yearMonthLabel(payMonth)}支給の賞与）`,
    dueDate: addDays(paymentDate, 5),
  };
}

// ---------------------------------------------------------------------------------------------
// Snapshot (`PayrollBonusRun.items` / `tableIds`)
// ---------------------------------------------------------------------------------------------

/** The `calculateBonus` input of one person, without the run's date and pinned tables. */
export interface PayrollBonusItemInput {
  bonus: Money;
  coverage: PayrollCoverage;
  taxColumn: TaxColumn;
  previousMonth: BonusPreviousMonth | null;
  priorHealthStandardBonus: Money;
  /** An officer's filing as entered (§10.3); `null` for an employee. Not used by the calculation. */
  filing: PredeterminedFiling | null;
}

/** One person of a confirmed bonus run. */
export interface PayrollBonusItem {
  employeeId: string;
  /** The name at confirmation (the payslip shows this one). */
  name: string;
  kind: WorkerKind;
  input: PayrollBonusItemInput;
  result: BonusResult;
}

/** The table versions a bonus run used (`PayrollBonusRun.tableIds`). */
export interface PayrollBonusTableIds {
  bonusWithholding: string;
  withholding: string;
  kenpo: string;
  pension: string;
  /** `null` when nobody was insured by 雇用保険. */
  employment: string | null;
}

/** The full `calculateBonus` input of a stored item (tables pinned separately). */
export function bonusInputOf(
  run: { paymentDate: CalendarDate; calcPeriodOver6Months: boolean },
  item: Pick<PayrollBonusItem, "kind" | "input">,
  tables?: Partial<BonusTables>,
): BonusInput {
  const { filing: _filing, ...input } = item.input;
  return {
    paymentDate: run.paymentDate,
    calcPeriodOver6Months: run.calcPeriodOver6Months,
    worker: item.kind,
    ...input,
    ...(tables ? { tables } : {}),
  };
}

/** The table ids of a bonus run's results; every result of one run uses the same versions. */
export function bonusTableIdsOf(results: readonly BonusResult[]): PayrollBonusTableIds {
  const [first] = results;
  if (!first) throw new RangeError("bonusTableIdsOf: a run has at least one result");
  const employment = results.find((result) => result.tables.employment !== null)?.tables.employment;
  const ids: PayrollBonusTableIds = {
    bonusWithholding: first.tables.bonusWithholding.id,
    withholding: first.tables.withholding.id,
    kenpo: first.tables.kenpo.id,
    pension: first.tables.pension.id,
    employment: employment?.id ?? null,
  };
  for (const result of results) {
    if (
      result.tables.bonusWithholding.id !== ids.bonusWithholding ||
      result.tables.withholding.id !== ids.withholding ||
      result.tables.kenpo.id !== ids.kenpo ||
      result.tables.pension.id !== ids.pension ||
      (result.tables.employment !== null && result.tables.employment.id !== ids.employment)
    ) {
      throw new RangeError("bonusTableIdsOf: the results of one run use different table versions");
    }
  }
  return ids;
}

/**
 * The registered tables of stored ids, to pin a recalculation to the versions a bonus run used.
 * Throws `PayrollSnapshotError` for an id that is not registered or of another kind.
 */
export function pinnedBonusTables(ids: PayrollBonusTableIds): Partial<BonusTables> {
  const pick = <K extends keyof BonusTables>(
    key: K,
    kind: BonusTables[K]["kind"],
    id: string,
  ): BonusTables[K] => {
    const table = findTableById(id);
    if (!table || table.kind !== kind) {
      throw new PayrollSnapshotError(
        `tableIds.${key}`,
        `"${id}" is not a registered ${kind} table`,
      );
    }
    return table as BonusTables[K];
  };
  return {
    bonusWithholding: pick("bonusWithholding", "withholding-bonus", ids.bonusWithholding),
    withholding: pick("withholding", "withholding-monthly", ids.withholding),
    kenpo: pick("kenpo", "kyokai-kenpo", ids.kenpo),
    pension: pick("pension", "pension", ids.pension),
    ...(ids.employment === null
      ? {}
      : { employment: pick("employment", "employment-insurance", ids.employment) }),
  };
}

/** `PayrollBonusRun.items`: every amount (and rational) as a decimal string, no floating point. */
export function serializeBonusRunItems(items: readonly PayrollBonusItem[]): SnapshotJson {
  return toSnapshotJson(items, "");
}

export function serializeBonusTableIds(ids: PayrollBonusTableIds): SnapshotJson {
  return toSnapshotJson(ids, "");
}

function nullableMoney(value: unknown, path: string): Money | null {
  return value === null ? null : nonNegativeMoney(value, path);
}

function previousMonthOf(value: unknown, path: string): BonusPreviousMonth | null {
  if (value === null) return null;
  const data = record(value, path, ["pay", "incomeTax"]);
  return {
    pay: money(data.pay, child(path, "pay")),
    incomeTax: nonNegativeMoney(data.incomeTax, child(path, "incomeTax")),
  };
}

function filingOf(value: unknown, path: string): PredeterminedFiling | null {
  if (value === null) return null;
  const data = record(value, path, ["date", "amount"]);
  const date = data.date === null ? null : text(data.date, child(path, "date"));
  if (date !== null && !isCalendarDate(date)) fail(child(path, "date"), "is not a date");
  return { date, amount: nullableMoney(data.amount, child(path, "amount")) };
}

function bonusItemInputOf(value: unknown, path: string): PayrollBonusItemInput {
  const data = record(value, path, [
    "bonus",
    "coverage",
    "taxColumn",
    "previousMonth",
    "priorHealthStandardBonus",
    "filing",
  ]);
  return {
    bonus: nonNegativeMoney(data.bonus, child(path, "bonus")),
    coverage: readCoverage(data.coverage, child(path, "coverage")),
    taxColumn: readTaxColumn(data.taxColumn, child(path, "taxColumn")),
    previousMonth: previousMonthOf(data.previousMonth, child(path, "previousMonth")),
    priorHealthStandardBonus: nonNegativeMoney(
      data.priorHealthStandardBonus,
      child(path, "priorHealthStandardBonus"),
    ),
    filing: filingOf(data.filing, child(path, "filing")),
  };
}

function withholdingOf(value: unknown, path: string): BonusWithholding {
  const data = record(value, path, [
    "method",
    "ratePercent",
    "rate",
    "divisor",
    "monthlyAmount",
    "monthlyTax",
    "previousMonthTax",
  ]);
  const method = data.method;
  if (!(BONUS_WITHHOLDING_METHODS as readonly unknown[]).includes(method)) {
    fail(child(path, "method"), "is not a bonus withholding method");
  }
  const divisor = data.divisor === null ? null : count(data.divisor, child(path, "divisor"));
  if (divisor !== null && divisor !== 6 && divisor !== 12) {
    fail(child(path, "divisor"), "is neither 6 nor 12");
  }
  const result: BonusWithholding = {
    method: method as BonusWithholdingMethod,
    ratePercent:
      data.ratePercent === null ? null : text(data.ratePercent, child(path, "ratePercent")),
    rate: data.rate === null ? null : rational(data.rate, child(path, "rate")),
    divisor,
    monthlyAmount: nullableMoney(data.monthlyAmount, child(path, "monthlyAmount")),
    monthlyTax: nullableMoney(data.monthlyTax, child(path, "monthlyTax")),
    previousMonthTax: nullableMoney(data.previousMonthTax, child(path, "previousMonthTax")),
  };
  const byRate = result.method === "rate";
  if (byRate !== (result.rate !== null) || byRate !== (result.ratePercent !== null)) {
    fail(child(path, "rate"), "is set exactly when the method is rate");
  }
  if (byRate === (result.divisor !== null) || byRate === (result.monthlyTax !== null)) {
    fail(child(path, "divisor"), "is set exactly when the method is a monthly one");
  }
  if ((result.method === "monthly_10x") !== (result.previousMonthTax !== null)) {
    fail(child(path, "previousMonthTax"), "is set exactly when the method is monthly_10x");
  }
  return result;
}

function bonusResultOf(value: unknown, path: string): BonusResult {
  const data = record(value, path, [
    "bonus",
    "standardBonus",
    "socialInsurance",
    "employmentInsurance",
    "withholdingBase",
    "withholding",
    "incomeTax",
    "totalDeductions",
    "netPay",
    "tables",
  ]);
  const standardPath = child(path, "standardBonus");
  const standard = record(data.standardBonus, standardPath, ["amount", "health", "pension"]);
  const tablesPath = child(path, "tables");
  const tables = record(data.tables, tablesPath, [
    "bonusWithholding",
    "withholding",
    "kenpo",
    "pension",
    "employment",
  ]);
  const result: BonusResult = {
    bonus: nonNegativeMoney(data.bonus, child(path, "bonus")),
    standardBonus: {
      amount: nonNegativeMoney(standard.amount, child(standardPath, "amount")),
      health: nonNegativeMoney(standard.health, child(standardPath, "health")),
      pension: nonNegativeMoney(standard.pension, child(standardPath, "pension")),
    },
    socialInsurance: readSocialInsurance(data.socialInsurance, child(path, "socialInsurance")),
    employmentInsurance: readEmploymentInsurance(
      data.employmentInsurance,
      child(path, "employmentInsurance"),
    ),
    withholdingBase: money(data.withholdingBase, child(path, "withholdingBase")),
    withholding: withholdingOf(data.withholding, child(path, "withholding")),
    incomeTax: nonNegativeMoney(data.incomeTax, child(path, "incomeTax")),
    totalDeductions: money(data.totalDeductions, child(path, "totalDeductions")),
    netPay: money(data.netPay, child(path, "netPay")),
    tables: {
      bonusWithholding: readTableRef(
        tables.bonusWithholding,
        child(tablesPath, "bonusWithholding"),
      ),
      withholding: readTableRef(tables.withholding, child(tablesPath, "withholding")),
      kenpo: readTableRef(tables.kenpo, child(tablesPath, "kenpo")),
      pension: readTableRef(tables.pension, child(tablesPath, "pension")),
      employment:
        tables.employment === null
          ? null
          : readTableRef(tables.employment, child(tablesPath, "employment")),
    },
  };
  // The totals the entries are made from must add up.
  const insurance =
    result.socialInsurance.employeeTotal + (result.employmentInsurance?.employee ?? 0n);
  if (result.bonus - insurance !== result.withholdingBase) {
    fail(child(path, "withholdingBase"), "is not bonus − the insurance deductions");
  }
  if (insurance + result.incomeTax !== result.totalDeductions) {
    fail(child(path, "totalDeductions"), "is not the insurance deductions + incomeTax");
  }
  if (result.bonus - result.totalDeductions !== result.netPay) {
    fail(child(path, "netPay"), "is not bonus − totalDeductions");
  }
  return result;
}

/**
 * Reads `PayrollBonusRun.items` back. Strict like `parsePayrollRunItems`: every key and nothing
 * else, whole-number strings, normalized rationals, consistent totals. Throws
 * `PayrollSnapshotError` naming the path of the first problem.
 */
export function parseBonusRunItems(json: unknown): PayrollBonusItem[] {
  if (!Array.isArray(json)) fail("", "is not an array");
  return json.map((value: unknown, index) => {
    const path = child("", index);
    const data = record(value, path, ["employeeId", "name", "kind", "input", "result"]);
    if (data.kind !== "officer" && data.kind !== "employee") {
      fail(child(path, "kind"), "is neither officer nor employee");
    }
    return {
      employeeId: text(data.employeeId, child(path, "employeeId")),
      name: text(data.name, child(path, "name")),
      kind: data.kind,
      input: bonusItemInputOf(data.input, child(path, "input")),
      result: bonusResultOf(data.result, child(path, "result")),
    };
  });
}

/** Reads `PayrollBonusRun.tableIds` back (strict). */
export function parseBonusTableIds(json: unknown): PayrollBonusTableIds {
  const data = record(json, "tableIds", [
    "bonusWithholding",
    "withholding",
    "kenpo",
    "pension",
    "employment",
  ]);
  return {
    bonusWithholding: text(data.bonusWithholding, "tableIds.bonusWithholding"),
    withholding: text(data.withholding, "tableIds.withholding"),
    kenpo: text(data.kenpo, "tableIds.kenpo"),
    pension: text(data.pension, "tableIds.pension"),
    employment: data.employment === null ? null : text(data.employment, "tableIds.employment"),
  };
}
