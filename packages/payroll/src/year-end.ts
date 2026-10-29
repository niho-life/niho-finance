import { formatYen, type Money } from "@niho-finance/ledger";
import { PayrollInputError, type PayrollInputIssue } from "./errors";
import { add, ceilToYen, floorToYen, mul, ratio } from "./rational";
import { findYearEndTable } from "./registry";
import { PAYROLL_SUB_ACCOUNTS, type PayrollEntryPlan, type PayrollLineTarget } from "./run";
import { tableRef, type TableRef, type YearEndFormulaBracket, type YearEndTable } from "./tables";

/**
 * 年末調整 (22-payroll §11): the yearly tax of one person from the year's pay, bonuses and
 * withholding and the declarations (扶養控除等・基礎控除・配偶者控除等・特定親族・所得金額調整控除・
 * 保険料控除・住宅借入金等特別控除・前職分), step by step as in 「年末調整のしかた」 35〜40 ページ, and the
 * settlement entry. Pure: every number comes from the year's table (`data/<年>/year-end.json`).
 * The declarations hold categories, counts and income estimates only, never a relative's name.
 */

// ---------------------------------------------------------------------------------------------
// Declarations (§11.4)
// ---------------------------------------------------------------------------------------------

/** 控除対象扶養親族の区分 (12 月 31 日の年齢); `minor` = 16 歳未満 (扶養控除なし、障害者控除などはある). */
export const DEPENDENT_CATEGORIES = [
  "general",
  "specific",
  "elderly",
  "elderly_cohabiting",
  "minor",
] as const;
export type DependentCategory = (typeof DEPENDENT_CATEGORIES)[number];

export const DEPENDENT_CATEGORY_LABELS: Readonly<Record<DependentCategory, string>> = {
  general: "一般の控除対象扶養親族",
  specific: "特定扶養親族（19〜22 歳）",
  elderly: "老人扶養親族（70 歳以上・同居老親等以外）",
  elderly_cohabiting: "同居老親等（70 歳以上）",
  minor: "16 歳未満の扶養親族",
};

/** 障害の区分 of a 扶養親族 or the 同一生計配偶者. */
export const DISABILITY_KINDS = ["none", "general", "special", "special_cohabiting"] as const;
export type DisabilityKind = (typeof DISABILITY_KINDS)[number];

export const DISABILITY_KIND_LABELS: Readonly<Record<DisabilityKind, string>> = {
  none: "なし",
  general: "一般の障害者",
  special: "特別障害者",
  special_cohabiting: "同居特別障害者",
};

/** 本人の障害 (本人に「同居」はない). */
export const SELF_DISABILITY_KINDS = ["none", "general", "special"] as const;
export type SelfDisabilityKind = (typeof SELF_DISABILITY_KINDS)[number];

/** 寡婦 と ひとり親 はどちらか 1 つ. */
export const WIDOW_STATUSES = ["none", "widow", "single_parent"] as const;
export type WidowStatus = (typeof WIDOW_STATUSES)[number];

export const WIDOW_STATUS_LABELS: Readonly<Record<WidowStatus, string>> = {
  none: "なし",
  widow: "寡婦",
  single_parent: "ひとり親",
};

export interface YearEndDependent {
  category: DependentCategory;
  disability: DisabilityKind;
  /**
   * 23 歳未満 (所得金額調整控除・生命保険料控除の特例). Asked for `general` only (16〜18 歳); 特定扶養親族
   * and 16 歳未満 are always under 23, 老人 never.
   */
  under23: boolean;
}

/** 配偶者 (源泉控除対象配偶者・同一生計配偶者・配偶者特別控除の対象). */
export interface YearEndSpouse {
  /** 配偶者の合計所得金額の見積額. */
  totalIncome: Money;
  /** 70 歳以上 (老人控除対象配偶者). */
  elderly: boolean;
  disability: DisabilityKind;
}

export interface YearEndInsurance {
  /** 一般の生命保険料: 新 / 旧. */
  newGeneral: Money;
  oldGeneral: Money;
  /** 介護医療保険料. */
  medical: Money;
  /** 個人年金保険料: 新 / 旧. */
  newPension: Money;
  oldPension: Money;
  /** 23 歳未満の扶養親族がいる (保険料控除申告書; 扶養控除等申告書の扶養親族からも判定する). */
  under23Dependent: boolean;
  /** 地震保険料. */
  earthquake: Money;
  /** 旧長期損害保険料. */
  oldLongTerm: Money;
  /** 申告による社会保険料 (国民年金・国民健康保険など). */
  socialInsurance: Money;
  /** 小規模企業共済等掛金. */
  smallBusinessMutualAid: Money;
}

/** 前職分 (中途入社で前の勤め先の源泉徴収票を出した場合). */
export interface YearEndPreviousEmployer {
  paid: Money;
  socialInsurance: Money;
  withheld: Money;
}

/** What the person declared for the year (`PayrollYearEndDeclaration.declarations`). */
export interface YearEndDeclaration {
  /** 扶養控除等申告書: 控除対象扶養親族・16 歳未満の扶養親族, one per person. */
  dependents: YearEndDependent[];
  /** 本人の障害者・寡婦・ひとり親・勤労学生. */
  self: { disability: SelfDisabilityKind; widowStatus: WidowStatus; workingStudent: boolean };
  /** 基礎控除申告書: 給与以外の所得の見積額 (合計所得金額 = 給与所得 + これ). */
  otherIncome: Money;
  /** 配偶者控除等申告書; `null` = 配偶者なし (or not declared). */
  spouse: YearEndSpouse | null;
  /** 特定親族 (19〜22 歳, 合計所得金額 62 万円超), one per person. */
  specificRelatives: { totalIncome: Money }[];
  /**
   * 所得金額調整控除申告書: the requirement is met by someone not on the 扶養控除等申告書 (e.g. a child
   * the other parent claims). The requirement is otherwise derived from the declarations.
   */
  incomeAdjustment: boolean;
  /** 保険料控除申告書. */
  insurance: YearEndInsurance;
  /** 住宅借入金等特別控除申告書の控除額 (年末調整で控除する額). */
  housingLoanCredit: Money;
  previousEmployer: YearEndPreviousEmployer | null;
}

/** Nothing declared: 基礎控除 only. */
export function emptyYearEndDeclaration(): YearEndDeclaration {
  return {
    dependents: [],
    self: { disability: "none", widowStatus: "none", workingStudent: false },
    otherIncome: 0n,
    spouse: null,
    specificRelatives: [],
    incomeAdjustment: false,
    insurance: {
      newGeneral: 0n,
      oldGeneral: 0n,
      medical: 0n,
      newPension: 0n,
      oldPension: 0n,
      under23Dependent: false,
      earthquake: 0n,
      oldLongTerm: 0n,
      socialInsurance: 0n,
      smallBusinessMutualAid: 0n,
    },
    housingLoanCredit: 0n,
    previousEmployer: null,
  };
}

/** Whether a declared dependent is under 23 at 12 月 31 日. */
export function isUnder23(dependent: YearEndDependent): boolean {
  switch (dependent.category) {
    case "specific":
    case "minor":
      return true;
    case "general":
      return dependent.under23;
    case "elderly":
    case "elderly_cohabiting":
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The steps (§11.2・§11.3)
// ---------------------------------------------------------------------------------------------

/** 2. 給与所得控除後の給与等の金額 (別表第五) of 給与等の収入金額 `income`. */
export function salaryIncomeAfterDeduction(table: YearEndTable, income: Money): Money {
  if (income < 0n) throw new RangeError("salaryIncomeAfterDeduction: income must not be negative");
  const segment = table.salaryIncome.find(
    (candidate) => income >= candidate.from && (candidate.to === null || income < candidate.to),
  );
  if (!segment) throw new RangeError(`salaryIncomeAfterDeduction: no segment for ${income}`);
  switch (segment.kind) {
    case "zero":
      return 0n;
    case "fixed":
      return segment.amount;
    case "rate": {
      const base = segment.step === null ? income : (income / segment.step) * segment.step;
      const value = floorToYen(mul(ratio(base), segment.rate)) - segment.deduction;
      return value < 0n ? 0n : value;
    }
  }
}

/**
 * 3. 所得金額調整控除: (収入（上限 incomeCap）− threshold) × 10%, 1 円未満切り上げ, when the income is
 * above the threshold and `qualifies` (本人が特別障害者、23 歳未満の扶養親族、特別障害者の同一生計配偶者・
 * 扶養親族). Never more than the salary income itself.
 */
export function incomeAdjustmentDeduction(
  table: YearEndTable,
  income: Money,
  qualifies: boolean,
  salaryIncome: Money = salaryIncomeAfterDeduction(table, income),
): Money {
  const { threshold, incomeCap, rate } = table.incomeAdjustment;
  if (!qualifies || income <= threshold) return 0n;
  const capped = income > incomeCap ? incomeCap : income;
  const amount = ceilToYen(mul(ratio(capped - threshold), rate));
  return amount > salaryIncome ? salaryIncome : amount;
}

/** 基礎控除 of the 合計所得金額 (§11.1); above the last bracket 0. */
export function basicDeduction(table: YearEndTable, totalIncome: Money): Money {
  return table.basicDeduction.find((bracket) => totalIncome <= bracket.upTo)?.amount ?? 0n;
}

export type SpouseDeductionKind = "spouse" | "special";

export const SPOUSE_DEDUCTION_LABELS: Readonly<Record<SpouseDeductionKind, string>> = {
  spouse: "配偶者控除",
  special: "配偶者特別控除",
};

/**
 * 配偶者控除・配偶者特別控除: the column of 所得者の合計所得金額 (900 / 950 / 1,000 万円以下; above none)
 * × the row of 配偶者の合計所得金額 (62 万円以下は配偶者控除、老人は 70 歳以上; 62 万円超 133 万円以下は
 * 配偶者特別控除; above none).
 */
export function spouseDeduction(
  table: YearEndTable,
  earnerTotalIncome: Money,
  spouse: { totalIncome: Money; elderly: boolean } | null,
): { amount: Money; kind: SpouseDeductionKind | null } {
  if (!spouse) return { amount: 0n, kind: null };
  const column = table.spouse.earnerIncomeLimits.findIndex((limit) => earnerTotalIncome <= limit);
  if (column < 0) return { amount: 0n, kind: null };
  if (spouse.totalIncome <= table.spouse.deductionIncomeLimit) {
    const amounts = spouse.elderly ? table.spouse.elderly : table.spouse.general;
    return { amount: amounts[column] ?? 0n, kind: "spouse" };
  }
  const row = table.spouse.special.find((candidate) => spouse.totalIncome <= candidate.upTo);
  if (!row) return { amount: 0n, kind: null };
  return { amount: row.amounts[column] ?? 0n, kind: "special" };
}

/** 特定親族特別控除 of one 特定親族 (合計所得金額 62 万円超 123 万円以下; otherwise 0). */
export function specificRelativeDeduction(table: YearEndTable, totalIncome: Money): Money {
  if (totalIncome <= table.specificRelative.incomeOver) return 0n;
  return (
    table.specificRelative.brackets.find((bracket) => totalIncome <= bracket.upTo)?.amount ?? 0n
  );
}

export interface DependentDeductions {
  /** 扶養控除 (一般・特定・老人・同居老親等). */
  dependents: Money;
  /** 障害者控除 (本人・同一生計配偶者・扶養親族). */
  disability: Money;
  /** 寡婦控除 / ひとり親控除. */
  widowOrSingleParent: Money;
  /** 勤労学生控除. */
  workingStudent: Money;
  /** 扶養控除と障害者等の控除の合計 (源泉徴収簿の「扶養控除額及び障害者等の控除額の合計額」). */
  total: Money;
}

function disabilityAmount(table: YearEndTable, kind: DisabilityKind): Money {
  switch (kind) {
    case "none":
      return 0n;
    case "general":
      return table.disability.general;
    case "special":
      return table.disability.special;
    case "special_cohabiting":
      return table.disability.specialCohabiting;
  }
}

/**
 * 扶養控除 per dependent (16 歳未満は 0) and 障害者等の控除: each dependent's and the 同一生計配偶者's
 * (配偶者の合計所得金額 62 万円以下) disability, 本人の障害者・寡婦・ひとり親・勤労学生 (合計所得金額の要件を
 * 満たすときだけ).
 */
export function dependentDeductions(
  table: YearEndTable,
  declaration: Pick<YearEndDeclaration, "dependents" | "spouse" | "self">,
  totalIncome: Money,
): DependentDeductions {
  let dependents = 0n;
  let disability = 0n;
  for (const dependent of declaration.dependents) {
    switch (dependent.category) {
      case "general":
        dependents += table.dependents.general;
        break;
      case "specific":
        dependents += table.dependents.specific;
        break;
      case "elderly":
        dependents += table.dependents.elderly;
        break;
      case "elderly_cohabiting":
        dependents += table.dependents.elderlyCohabiting;
        break;
      case "minor":
        break;
    }
    disability += disabilityAmount(table, dependent.disability);
  }
  const spouse = declaration.spouse;
  if (spouse && spouse.totalIncome <= table.dependents.incomeLimit) {
    disability += disabilityAmount(table, spouse.disability);
  }
  disability += disabilityAmount(table, declaration.self.disability);
  let widowOrSingleParent = 0n;
  if (declaration.self.widowStatus === "widow" && totalIncome <= table.personal.widowIncomeLimit) {
    widowOrSingleParent = table.personal.widow;
  } else if (
    declaration.self.widowStatus === "single_parent" &&
    totalIncome <= table.personal.singleParentIncomeLimit
  ) {
    widowOrSingleParent = table.personal.singleParent;
  }
  const workingStudent =
    declaration.self.workingStudent && totalIncome <= table.personal.workingStudentIncomeLimit
      ? table.personal.workingStudent
      : 0n;
  return {
    dependents,
    disability,
    widowOrSingleParent,
    workingStudent,
    total: dependents + disability + widowOrSingleParent + workingStudent,
  };
}

/** amount × rate + add of the bracket the amount falls in, 1 円未満切り上げ (0 for 0). */
export function formulaAmount(brackets: readonly YearEndFormulaBracket[], amount: Money): Money {
  if (amount <= 0n) return 0n;
  const bracket = brackets.find((candidate) => candidate.upTo === null || amount <= candidate.upTo);
  if (!bracket) throw new RangeError("formulaAmount: the formula has no open bracket");
  return ceilToYen(add(mul(ratio(amount), bracket.rate), ratio(bracket.add)));
}

/**
 * One category with new and old premiums (保険料控除申告書): new only → the new formula; old only →
 * the old formula; both → the larger of the old one alone and the sum (up to `limit`).
 */
function newAndOld(
  newAmount: Money,
  oldAmount: Money,
  newFormula: readonly YearEndFormulaBracket[],
  oldFormula: readonly YearEndFormulaBracket[],
  limit: Money,
): Money {
  const fromNew = formulaAmount(newFormula, newAmount);
  const fromOld = formulaAmount(oldFormula, oldAmount);
  if (oldAmount === 0n) return fromNew > limit ? limit : fromNew;
  if (newAmount === 0n) return fromOld;
  const sum = fromNew + fromOld > limit ? limit : fromNew + fromOld;
  return fromOld > sum ? fromOld : sum;
}

export interface LifeInsuranceDeduction {
  /** 一般の生命保険料控除 (新旧). */
  general: Money;
  /** 介護医療保険料控除. */
  medical: Money;
  /** 個人年金保険料控除 (新旧). */
  pension: Money;
  /** 合計 (上限 12 万円). */
  total: Money;
}

/**
 * 生命保険料控除: 計算式Ⅰ (新・介護医療・新個人年金), Ⅱ (23 歳未満の扶養親族がいるときの新生命保険料),
 * Ⅲ (旧); 一般は新旧で 4 万円（23 歳未満の扶養親族がいるときは 6 万円）、個人年金は 4 万円まで、合計 12 万円まで.
 */
export function lifeInsuranceDeduction(
  table: YearEndTable,
  premiums: Pick<
    YearEndInsurance,
    "newGeneral" | "oldGeneral" | "medical" | "newPension" | "oldPension"
  >,
  under23Dependent: boolean,
): LifeInsuranceDeduction {
  const life = table.lifeInsurance;
  const general = newAndOld(
    premiums.newGeneral,
    premiums.oldGeneral,
    under23Dependent ? life.newUnder23Formula : life.newFormula,
    life.oldFormula,
    under23Dependent ? life.generalUnder23Limit : life.generalLimit,
  );
  const medical = formulaAmount(life.newFormula, premiums.medical);
  const pension = newAndOld(
    premiums.newPension,
    premiums.oldPension,
    life.newFormula,
    life.oldFormula,
    life.pensionLimit,
  );
  const sum = general + medical + pension;
  return { general, medical, pension, total: sum > life.totalLimit ? life.totalLimit : sum };
}

/** 地震保険料控除: 地震保険料は全額 (上限 5 万円)、旧長期損害保険料は式で、合計 5 万円まで. */
export function earthquakeDeduction(
  table: YearEndTable,
  premiums: Pick<YearEndInsurance, "earthquake" | "oldLongTerm">,
): Money {
  const { earthquakeLimit, oldLongTermFormula, totalLimit } = table.earthquake;
  const earthquake = premiums.earthquake > earthquakeLimit ? earthquakeLimit : premiums.earthquake;
  const sum = earthquake + formulaAmount(oldLongTermFormula, premiums.oldLongTerm);
  return sum > totalLimit ? totalLimit : sum;
}

/** 6. 算出所得税額 of 課税給与所得金額 (速算表). Above the table (> 1,805 万円) it is not 年末調整. */
export function computedIncomeTax(table: YearEndTable, taxableIncome: Money): Money {
  if (taxableIncome <= 0n) return 0n;
  const bracket =
    table.taxBrackets.find((candidate) => taxableIncome <= candidate.upTo) ??
    table.taxBrackets[table.taxBrackets.length - 1];
  if (!bracket) throw new RangeError("computedIncomeTax: no tax bracket");
  const tax = floorToYen(mul(ratio(taxableIncome), bracket.rate)) - bracket.deduction;
  return tax < 0n ? 0n : tax;
}

/** 8. 年調年税額 = 年調所得税額 × 102.1%, 100 円未満切り捨て. */
export function annualTaxWithSurtax(table: YearEndTable, annualIncomeTax: Money): Money {
  const { rate, unit } = table.surtax;
  const amount = floorToYen(mul(ratio(annualIncomeTax), rate));
  return (amount / unit) * unit;
}

// ---------------------------------------------------------------------------------------------
// calculateYearEnd
// ---------------------------------------------------------------------------------------------

export interface YearEndInput {
  /** 年分. */
  year: number;
  /** 甲欄 (扶養控除等申告書あり) / 乙欄 (対象外). */
  taxColumn: "kou" | "otsu";
  /** This employer's 給与・賞与 whose payment date is in the year (確定した支給と賞与から). */
  salary: {
    /** 課税支給額 of the monthly runs. */
    pay: Money;
    /** 賞与の額. */
    bonus: Money;
    /** 給与・賞与から控除した社会保険料等 (健保・介護・支援金・厚年〔調整後〕・雇用保険の本人分). */
    socialInsurance: Money;
    /** 源泉所得税（調整後）. */
    withheld: Money;
  };
  declaration: YearEndDeclaration;
  /** Pins the table (e.g. the version a confirmed 年末調整 used); else the registry's for `year`. */
  table?: YearEndTable;
}

export const YEAR_END_INELIGIBLE_CODES = ["otsu", "income_over", "taxable_over"] as const;
export type YearEndIneligibleCode = (typeof YEAR_END_INELIGIBLE_CODES)[number];

export const YEAR_END_WARNING_CODES = [
  "widow_income",
  "single_parent_income",
  "working_student_income",
  "specific_relative_low",
  "specific_relative_high",
  "spouse_earner_income",
  "housing_loan_over",
] as const;
export type YearEndWarningCode = (typeof YEAR_END_WARNING_CODES)[number];

export interface YearEndNote<Code extends string> {
  code: Code;
  /** Owner-facing Japanese. */
  message: string;
}

export type YearEndSettlementKind = "refund" | "shortfall" | "none";

export const YEAR_END_SETTLEMENT_LABELS: Readonly<Record<YearEndSettlementKind, string>> = {
  refund: "過納",
  shortfall: "不足",
  none: "なし",
};

export interface YearEndDeductions {
  /** 社会保険料控除: 給与・賞与から控除した分 + 申告分 + 前職分. */
  socialInsurance: Money;
  smallBusinessMutualAid: Money;
  lifeInsurance: LifeInsuranceDeduction;
  earthquake: Money;
  /** 配偶者控除 or 配偶者特別控除 (`spouseKind`). */
  spouse: Money;
  spouseKind: SpouseDeductionKind | null;
  specificRelative: Money;
  /** 扶養控除と障害者等の控除. */
  dependents: DependentDeductions;
  basic: Money;
  /** 所得控除の合計. */
  total: Money;
}

export interface YearEndResult {
  year: number;
  table: TableRef;
  /** 年末調整の対象か; when not, `ineligible` says why (the numbers are still shown). */
  eligible: boolean;
  ineligible: YearEndNote<YearEndIneligibleCode>[];
  warnings: YearEndNote<YearEndWarningCode>[];
  /** 1. 給与等の総額 (この勤め先の給与・賞与 + 前職分). */
  totalPay: Money;
  /** 2. 給与所得控除後の給与等の金額. */
  salaryIncome: Money;
  /** 3. 所得金額調整控除. */
  incomeAdjustment: Money;
  /** 2 − 3: 給与所得控除後の給与等の金額（調整控除後）. */
  salaryIncomeAfterAdjustment: Money;
  /** 合計所得金額の見積額 = 給与所得 + 給与以外の所得の見積額 (基礎控除・配偶者控除の判定に使う). */
  totalIncome: Money;
  /** 4. 所得控除. */
  deductions: YearEndDeductions;
  /** 5. 課税給与所得金額 (1,000 円未満切り捨て). */
  taxableIncome: Money;
  /** 6. 算出所得税額. */
  computedTax: Money;
  /** 7. 住宅借入金等特別控除の適用額 (算出所得税額まで). */
  housingLoanCredit: Money;
  /** 7. 年調所得税額. */
  annualIncomeTax: Money;
  /** 8. 年調年税額 (× 102.1%, 100 円未満切り捨て). */
  annualTax: Money;
  /** 徴収済み税額: この勤め先の源泉所得税（調整後）+ 前職分. */
  withheld: Money;
  /** 9. 過不足 = 年調年税額 − 徴収済み税額: + 不足 (徴収), − 過納 (還付). */
  difference: Money;
  settlement: { kind: YearEndSettlementKind; label: string; amount: Money };
}

const AMOUNT_FIELDS = [
  ["otherIncome", "給与以外の所得の見積額"],
  ["housingLoanCredit", "住宅借入金等特別控除額"],
] as const;

const INSURANCE_FIELDS = [
  ["newGeneral", "一般の生命保険料（新）"],
  ["oldGeneral", "一般の生命保険料（旧）"],
  ["medical", "介護医療保険料"],
  ["newPension", "個人年金保険料（新）"],
  ["oldPension", "個人年金保険料（旧）"],
  ["earthquake", "地震保険料"],
  ["oldLongTerm", "旧長期損害保険料"],
  ["socialInsurance", "申告による社会保険料"],
  ["smallBusinessMutualAid", "小規模企業共済等掛金"],
] as const;

const PREVIOUS_FIELDS = [
  ["paid", "前職の支払金額"],
  ["socialInsurance", "前職の社会保険料"],
  ["withheld", "前職の源泉徴収税額"],
] as const;

const SALARY_FIELDS = [
  ["pay", "給与の課税支給額"],
  ["bonus", "賞与の額"],
  ["socialInsurance", "給与・賞与から控除した社会保険料"],
  ["withheld", "給与・賞与の源泉所得税"],
] as const;

const isAmount = (value: unknown): value is Money => typeof value === "bigint" && value >= 0n;

const MAX_PEOPLE = 30;

function validateYearEndInput(input: YearEndInput): void {
  const issues: PayrollInputIssue[] = [];
  const push = (code: PayrollInputIssue["code"], field: string, message: string) =>
    issues.push({ code, field, message });
  if (!Number.isSafeInteger(input.year) || input.year < 2000 || input.year > 2100) {
    push("INVALID_YEAR", "year", "年分は 2026 などの西暦にしてください");
  }
  const column: unknown = input.taxColumn;
  if (column !== "kou" && column !== "otsu") {
    push("INVALID_DECLARATION", "taxColumn", "源泉徴収の区分（甲欄・乙欄）が正しくありません");
  }
  for (const [key, label] of SALARY_FIELDS) {
    if (!isAmount(input.salary[key])) {
      push("INVALID_AMOUNT", `salary.${key}`, `${label}は 0 円以上の整数（円）にしてください`);
    }
  }
  const declaration = input.declaration;
  for (const [key, label] of AMOUNT_FIELDS) {
    if (!isAmount(declaration[key])) {
      push("INVALID_AMOUNT", key, `${label}は 0 円以上の整数（円）にしてください`);
    }
  }
  for (const [key, label] of INSURANCE_FIELDS) {
    if (!isAmount(declaration.insurance[key])) {
      push("INVALID_AMOUNT", `insurance.${key}`, `${label}は 0 円以上の整数（円）にしてください`);
    }
  }
  if (declaration.previousEmployer) {
    for (const [key, label] of PREVIOUS_FIELDS) {
      if (!isAmount(declaration.previousEmployer[key])) {
        push(
          "INVALID_AMOUNT",
          `previousEmployer.${key}`,
          `${label}は 0 円以上の整数（円）にしてください`,
        );
      }
    }
  }
  if (declaration.dependents.length > MAX_PEOPLE) {
    push("INVALID_DECLARATION", "dependents", `扶養親族は ${MAX_PEOPLE} 人までです`);
  }
  declaration.dependents.forEach((dependent, index) => {
    if (!(DEPENDENT_CATEGORIES as readonly string[]).includes(dependent.category)) {
      push("INVALID_DECLARATION", `dependents.${index}.category`, "扶養親族の区分を選んでください");
    }
    if (!(DISABILITY_KINDS as readonly string[]).includes(dependent.disability)) {
      push("INVALID_DECLARATION", `dependents.${index}.disability`, "障害の区分を選んでください");
    }
  });
  if (declaration.spouse) {
    if (!isAmount(declaration.spouse.totalIncome)) {
      push(
        "INVALID_AMOUNT",
        "spouse.totalIncome",
        "配偶者の合計所得の見積額は 0 円以上の整数（円）にしてください",
      );
    }
    if (!(DISABILITY_KINDS as readonly string[]).includes(declaration.spouse.disability)) {
      push("INVALID_DECLARATION", "spouse.disability", "配偶者の障害の区分を選んでください");
    }
  }
  if (declaration.specificRelatives.length > MAX_PEOPLE) {
    push("INVALID_DECLARATION", "specificRelatives", `特定親族は ${MAX_PEOPLE} 人までです`);
  }
  declaration.specificRelatives.forEach((relative, index) => {
    if (!isAmount(relative.totalIncome)) {
      push(
        "INVALID_AMOUNT",
        `specificRelatives.${index}.totalIncome`,
        "特定親族の合計所得の見積額は 0 円以上の整数（円）にしてください",
      );
    }
  });
  if (!(SELF_DISABILITY_KINDS as readonly string[]).includes(declaration.self.disability)) {
    push("INVALID_DECLARATION", "self.disability", "本人の障害の区分を選んでください");
  }
  if (!(WIDOW_STATUSES as readonly string[]).includes(declaration.self.widowStatus)) {
    push("INVALID_DECLARATION", "self.widowStatus", "寡婦・ひとり親の区分を選んでください");
  }
  if (issues.length > 0) throw new PayrollInputError(issues);
}

/** 23 歳未満の扶養親族がいる (保険料控除申告書の欄、または扶養控除等申告書の扶養親族から). */
export function hasUnder23Dependent(declaration: YearEndDeclaration): boolean {
  return declaration.insurance.under23Dependent || declaration.dependents.some(isUnder23);
}

/** The requirement of 所得金額調整控除, from the declarations or the person's own check. */
export function incomeAdjustmentQualifies(
  table: YearEndTable,
  declaration: YearEndDeclaration,
): boolean {
  if (declaration.incomeAdjustment) return true;
  if (declaration.self.disability === "special") return true;
  const special = (kind: DisabilityKind) => kind === "special" || kind === "special_cohabiting";
  if (
    declaration.dependents.some(
      (dependent) => isUnder23(dependent) || special(dependent.disability),
    )
  ) {
    return true;
  }
  const spouse = declaration.spouse;
  return (
    spouse !== null &&
    spouse.totalIncome <= table.dependents.incomeLimit &&
    special(spouse.disability)
  );
}

const yen = (amount: Money) => formatYen(amount);

/**
 * 年末調整 of one person (22-payroll §11.2): every step, the eligibility and the 過不足. Throws
 * `PayrollInputError` for a broken input and `PayrollTableMissingError` for a year without data.
 */
export function calculateYearEnd(input: YearEndInput): YearEndResult {
  validateYearEndInput(input);
  const table = input.table ?? findYearEndTable(input.year);
  if (table.year !== input.year) {
    throw new PayrollInputError([
      {
        code: "TABLE_NOT_EFFECTIVE",
        field: "table",
        message: `${input.year} 年分の年末調整に ${table.title} は使えません`,
      },
    ]);
  }
  const { declaration, salary } = input;
  const previous = declaration.previousEmployer;
  const warnings: YearEndNote<YearEndWarningCode>[] = [];

  // 1〜3. 給与等の総額 → 給与所得控除後 → 所得金額調整控除.
  const totalPay = salary.pay + salary.bonus + (previous?.paid ?? 0n);
  const salaryIncome = salaryIncomeAfterDeduction(table, totalPay);
  const incomeAdjustment = incomeAdjustmentDeduction(
    table,
    totalPay,
    incomeAdjustmentQualifies(table, declaration),
    salaryIncome,
  );
  const salaryIncomeAfterAdjustment = salaryIncome - incomeAdjustment;
  const totalIncome = salaryIncomeAfterAdjustment + declaration.otherIncome;

  // 4. 所得控除.
  const socialInsurance =
    salary.socialInsurance +
    declaration.insurance.socialInsurance +
    (previous?.socialInsurance ?? 0n);
  const smallBusinessMutualAid = declaration.insurance.smallBusinessMutualAid;
  const lifeInsurance = lifeInsuranceDeduction(
    table,
    declaration.insurance,
    hasUnder23Dependent(declaration),
  );
  const earthquake = earthquakeDeduction(table, declaration.insurance);
  const spouse = spouseDeduction(table, totalIncome, declaration.spouse);
  if (declaration.spouse && spouse.kind === null) {
    const limit = table.spouse.earnerIncomeLimits[table.spouse.earnerIncomeLimits.length - 1]!;
    if (totalIncome > limit) {
      warnings.push({
        code: "spouse_earner_income",
        message: `本人の合計所得金額が ${yen(limit)} 円を超えるので、配偶者控除・配偶者特別控除はありません`,
      });
    }
  }
  let specificRelative = 0n;
  declaration.specificRelatives.forEach((relative, index) => {
    const amount = specificRelativeDeduction(table, relative.totalIncome);
    specificRelative += amount;
    if (relative.totalIncome <= table.specificRelative.incomeOver) {
      warnings.push({
        code: "specific_relative_low",
        message: `特定親族 ${index + 1} の合計所得が ${yen(table.specificRelative.incomeOver)} 円以下です。特定扶養親族として扶養控除に入れます`,
      });
    } else if (amount === 0n) {
      warnings.push({
        code: "specific_relative_high",
        message: `特定親族 ${index + 1} の合計所得が ${yen(table.specificRelative.brackets[table.specificRelative.brackets.length - 1]!.upTo)} 円を超えるので、特定親族特別控除はありません`,
      });
    }
  });
  const dependents = dependentDeductions(table, declaration, totalIncome);
  if (declaration.self.widowStatus === "widow" && dependents.widowOrSingleParent === 0n) {
    warnings.push({
      code: "widow_income",
      message: `合計所得金額が ${yen(table.personal.widowIncomeLimit)} 円を超えるので、寡婦控除はありません`,
    });
  }
  if (declaration.self.widowStatus === "single_parent" && dependents.widowOrSingleParent === 0n) {
    warnings.push({
      code: "single_parent_income",
      message: `合計所得金額が ${yen(table.personal.singleParentIncomeLimit)} 円を超えるので、ひとり親控除はありません`,
    });
  }
  if (declaration.self.workingStudent && dependents.workingStudent === 0n) {
    warnings.push({
      code: "working_student_income",
      message: `合計所得金額が ${yen(table.personal.workingStudentIncomeLimit)} 円を超えるので、勤労学生控除はありません`,
    });
  }
  const basic = basicDeduction(table, totalIncome);
  const totalDeductions =
    socialInsurance +
    smallBusinessMutualAid +
    lifeInsurance.total +
    earthquake +
    spouse.amount +
    specificRelative +
    dependents.total +
    basic;

  // 5〜8. 課税給与所得金額 → 算出所得税額 → 年調所得税額 → 年調年税額.
  const unit = table.taxableIncomeUnit;
  const remaining = salaryIncomeAfterAdjustment - totalDeductions;
  const taxableIncome = remaining > 0n ? (remaining / unit) * unit : 0n;
  const computedTax = computedIncomeTax(table, taxableIncome);
  const housingLoanCredit =
    declaration.housingLoanCredit > computedTax ? computedTax : declaration.housingLoanCredit;
  if (declaration.housingLoanCredit > computedTax) {
    warnings.push({
      code: "housing_loan_over",
      message: `住宅借入金等特別控除額 ${yen(declaration.housingLoanCredit)} 円のうち、算出所得税額 ${yen(computedTax)} 円までを控除します`,
    });
  }
  const annualIncomeTax = computedTax - housingLoanCredit;
  const annualTax = annualTaxWithSurtax(table, annualIncomeTax);

  // 9. 過不足.
  const withheld = salary.withheld + (previous?.withheld ?? 0n);
  const difference = annualTax - withheld;
  const kind: YearEndSettlementKind =
    difference < 0n ? "refund" : difference > 0n ? "shortfall" : "none";

  const ineligible: YearEndNote<YearEndIneligibleCode>[] = [];
  if (input.taxColumn === "otsu") {
    ineligible.push({
      code: "otsu",
      message: "乙欄の人（扶養控除等申告書を出していない人）は年末調整の対象外です",
    });
  }
  if (totalPay > table.eligibility.incomeLimit) {
    ineligible.push({
      code: "income_over",
      message: `給与等の収入が ${yen(table.eligibility.incomeLimit)} 円を超えるので年末調整の対象外です（本人が確定申告をします）`,
    });
  }
  if (taxableIncome > table.eligibility.taxableIncomeLimit) {
    ineligible.push({
      code: "taxable_over",
      message: `課税給与所得金額が ${yen(table.eligibility.taxableIncomeLimit)} 円を超えるので年末調整の対象外です`,
    });
  }

  return {
    year: input.year,
    table: tableRef(table),
    eligible: ineligible.length === 0,
    ineligible,
    warnings,
    totalPay,
    salaryIncome,
    incomeAdjustment,
    salaryIncomeAfterAdjustment,
    totalIncome,
    deductions: {
      socialInsurance,
      smallBusinessMutualAid,
      lifeInsurance,
      earthquake,
      spouse: spouse.amount,
      spouseKind: spouse.kind,
      specificRelative,
      dependents,
      basic,
      total: totalDeductions,
    },
    taxableIncome,
    computedTax,
    housingLoanCredit,
    annualIncomeTax,
    annualTax,
    withheld,
    difference,
    settlement: {
      kind,
      label: YEAR_END_SETTLEMENT_LABELS[kind],
      amount: difference < 0n ? -difference : difference,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The settlement entry (§11.4)
// ---------------------------------------------------------------------------------------------

/**
 * 精算の仕訳 (dated the last pay run's payment date): 過納 (還付) 2300 預り金〔源泉所得税〕 / 2100 未払金
 * 〔給与〕, 不足 (徴収) the reverse; the wallet instead of 未払金 when that run was paid from one.
 * `null` when 過不足 is 0.
 */
export function buildYearEndSettlementEntry(input: {
  year: number;
  /** The person's name (the entry's description tells the settlements of one year apart). */
  name: string;
  difference: Money;
  payFrom: "wallet" | "accrued";
}): PayrollEntryPlan | null {
  if (input.difference === 0n) return null;
  const withheld: PayrollLineTarget = {
    kind: "account",
    accountCode: PAYROLL_SUB_ACCOUNTS.withholdingTax.accountCode,
    subAccountName: PAYROLL_SUB_ACCOUNTS.withholdingTax.name,
  };
  const pay: PayrollLineTarget =
    input.payFrom === "wallet"
      ? { kind: "wallet" }
      : {
          kind: "account",
          accountCode: PAYROLL_SUB_ACCOUNTS.pay.accountCode,
          subAccountName: PAYROLL_SUB_ACCOUNTS.pay.name,
        };
  const refund = input.difference < 0n;
  const amount = refund ? -input.difference : input.difference;
  return {
    description: `年末調整 ${input.year} 年分 ${input.name}（${refund ? "過納額の還付" : "不足額の徴収"}）`,
    lines: [
      { side: "debit", target: refund ? withheld : pay, amount, taxCategoryCode: "na" },
      { side: "credit", target: refund ? pay : withheld, amount, taxCategoryCode: "na" },
    ],
  };
}
