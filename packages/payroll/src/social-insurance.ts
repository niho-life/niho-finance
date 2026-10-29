import { formatYen, type Money } from "@niho-finance/ledger";
import { PayrollInputError, type PayrollInputIssue } from "./errors";
import { compareYearMonths, isYearMonth, type YearMonth } from "./month";
import {
  add,
  floorToYen,
  half,
  mul,
  ratio,
  roundHalfDownToYen,
  subtract,
  type Rational,
} from "./rational";
import type { Grade, KenpoTable, PensionTable } from "./tables";

const ZERO: Rational = ratio(0n);

function gradeFor(grades: readonly Grade[], remuneration: Money): Grade {
  const grade = grades.find(
    (candidate) =>
      (candidate.from === null || candidate.from <= remuneration) &&
      (candidate.to === null || remuneration < candidate.to),
  );
  // Validated grade tables cover 0 円 to no upper bound without gaps.
  if (!grade) throw new RangeError(`no grade for ${remuneration} yen`);
  return grade;
}

export interface StandardRemuneration {
  health: { grade: number; smr: Money };
  pension: { grade: number; smr: Money };
}

/**
 * Grades and standard monthly remuneration (標準報酬月額) for a monthly remuneration (報酬月額),
 * separately for health insurance and the pension (their grade ranges differ; 22-payroll §2.2).
 * A helper for 資格取得時・定時決定・随時改定; the calculation itself takes the recorded values.
 */
export function determineStandardRemuneration(
  tables: { kenpo: KenpoTable; pension: PensionTable },
  remuneration: Money,
): StandardRemuneration {
  if (typeof remuneration !== "bigint" || remuneration < 0n) {
    throw new PayrollInputError([
      {
        code: "INVALID_AMOUNT",
        field: "remuneration",
        message: "報酬月額は 0 円以上の整数（円）にしてください",
      },
    ]);
  }
  const health = gradeFor(tables.kenpo.grades, remuneration);
  const pension = gradeFor(tables.pension.grades, remuneration);
  return {
    health: { grade: health.grade, smr: health.smr },
    pension: { grade: pension.grade, smr: pension.smr },
  };
}

/** Coverage of the insurances charged through the health and pension premiums. */
export interface SocialInsuranceCoverage {
  health: boolean;
  /** 介護保険第 2 号被保険者 (40〜64 歳). Requires `health`. */
  care: boolean;
  pension: boolean;
}

export interface HealthPremium {
  /** 全額: smr × (health + care + childSupport rates), unrounded. */
  full: Rational;
  /** 本人負担: full ÷ 2, rounded once (50 銭以下切り捨て・50 銭超切り上げ). */
  employee: Money;
  /** 会社負担: full − employee, unrounded (the yen amount comes from the aggregate). */
  employer: Rational;
  /** 全額 split by rate, unrounded. Sums to `full`. */
  breakdown: { health: Rational; care: Rational; childSupport: Rational };
}

export interface PensionPremium {
  full: Rational;
  employee: Money;
  employer: Rational;
}

export interface SocialInsurancePremiums {
  health: HealthPremium;
  pension: PensionPremium;
  /** 子ども・子育て拠出金: employer only, never deducted from pay. */
  childContribution: Rational;
  /** 本人負担の合計 of health and pension (雇用保険 is separate). */
  employeeTotal: Money;
}

/** Whether 子ども・子育て支援金 is charged for the premium month. */
export function childSupportApplies(kenpo: KenpoTable, premiumMonth: YearMonth): boolean {
  return (
    kenpo.childSupportFrom !== null && compareYearMonths(kenpo.childSupportFrom, premiumMonth) <= 0
  );
}

function isGradeAmount(grades: readonly Grade[], smr: Money): boolean {
  return grades.some((grade) => grade.smr === smr);
}

/**
 * Health (健保・介護・支援金) and pension premiums of one insured person for one premium month
 * (22-payroll §2.3・§2.4).
 *
 * - Health: the rates that apply (health; care when covered; child support from
 *   `childSupportFrom`) are added first, so the employee share is rounded ONCE:
 *   roundHalfDown(smr × combined rate ÷ 2). The breakdown stays unrounded.
 * - Pension: roundHalfDown(smr × rate ÷ 2). 拠出金 = smr × its rate, employer only.
 * - Employer shares are full − employee, kept as rationals; yen amounts are made by
 *   `aggregateSocialInsurance` (納入告知額 = the truncated sum of the full amounts).
 *
 * Throws `PayrollInputError` when a covered `smr` is not a grade amount of its table, or when
 * care is covered without health.
 */
export function socialInsurancePremiums(
  kenpo: KenpoTable,
  pension: PensionTable,
  premiumMonth: YearMonth,
  smr: { health: Money; pension: Money },
  coverage: SocialInsuranceCoverage,
): SocialInsurancePremiums {
  const issues: PayrollInputIssue[] = [];
  if (!isYearMonth(premiumMonth)) {
    issues.push({
      code: "INVALID_PREMIUM_MONTH",
      field: "premiumMonth",
      message: `対象月「${String(premiumMonth)}」が正しくありません（YYYY-MM）`,
    });
  }
  const checks = [
    { key: "health", label: "健康保険", grades: kenpo.grades, covered: coverage.health },
    { key: "pension", label: "厚生年金", grades: pension.grades, covered: coverage.pension },
  ] as const;
  for (const { key, label, grades, covered } of checks) {
    const amount: unknown = smr[key];
    if (typeof amount !== "bigint" || amount < 0n) {
      issues.push({
        code: "INVALID_AMOUNT",
        field: `standardRemuneration.${key}`,
        message: `標準報酬月額（${label}）は 0 円以上の整数（円）にしてください`,
      });
    } else if (covered && !isGradeAmount(grades, amount)) {
      issues.push({
        code: "UNKNOWN_STANDARD_REMUNERATION",
        field: `standardRemuneration.${key}`,
        message: `標準報酬月額（${label}）${formatYen(amount)} 円は等級表にありません。等級表の標準報酬月額を入れてください`,
      });
    }
  }
  if (coverage.care && !coverage.health) {
    issues.push({
      code: "CARE_WITHOUT_HEALTH",
      field: "coverage.care",
      message:
        "介護保険料は健康保険の被保険者だけにかかります。健康保険を「あり」にするか、介護保険を「なし」にしてください",
    });
  }
  if (issues.length > 0) throw new PayrollInputError(issues);
  return premiumsOn(kenpo, pension, premiumMonth, smr, coverage);
}

/**
 * The premiums of §2.3・§2.4 on the given amounts without checking them: the 標準報酬月額 of a month
 * (after `socialInsurancePremiums` has checked the grades) or the 標準賞与額 of a bonus (22-payroll
 * §10.2: the same rates, the same rounding once on the combined rate, the same employer shares).
 */
export function premiumsOn(
  kenpo: KenpoTable,
  pension: PensionTable,
  premiumMonth: YearMonth,
  smr: { health: Money; pension: Money },
  coverage: SocialInsuranceCoverage,
): SocialInsurancePremiums {
  const healthSmr = ratio(smr.health);
  const breakdown = coverage.health
    ? {
        health: mul(healthSmr, kenpo.rates.health),
        care: coverage.care ? mul(healthSmr, kenpo.rates.care) : ZERO,
        childSupport: childSupportApplies(kenpo, premiumMonth)
          ? mul(healthSmr, kenpo.rates.childSupport)
          : ZERO,
      }
    : { health: ZERO, care: ZERO, childSupport: ZERO };
  const healthFull = add(add(breakdown.health, breakdown.care), breakdown.childSupport);
  const healthEmployee = roundHalfDownToYen(half(healthFull));

  const pensionSmr = ratio(smr.pension);
  const pensionFull = coverage.pension ? mul(pensionSmr, pension.rate) : ZERO;
  const pensionEmployee = roundHalfDownToYen(half(pensionFull));
  const childContribution = coverage.pension
    ? mul(pensionSmr, pension.childContributionRate)
    : ZERO;

  return {
    health: {
      full: healthFull,
      employee: healthEmployee,
      employer: subtract(healthFull, ratio(healthEmployee)),
      breakdown,
    },
    pension: {
      full: pensionFull,
      employee: pensionEmployee,
      employer: subtract(pensionFull, ratio(pensionEmployee)),
    },
    childContribution,
    employeeTotal: healthEmployee + pensionEmployee,
  };
}

export interface SocialInsuranceAggregate {
  /** `full` = the sum of the full amounts truncated to the yen (納入告知額); employer = full − employee. */
  health: { full: Money; employee: Money; employer: Money };
  pension: { full: Money; employee: Money; employer: Money };
  /** The sum of 拠出金 truncated to the yen. */
  childContribution: Money;
  employeeTotal: Money;
  /** 会社負担 (法定福利費): health + pension employer shares + 拠出金. */
  employerTotal: Money;
  /** health.full + pension.full + childContribution. */
  total: Money;
}

/**
 * Sums the premiums of every insured person of the office for one premium month, the way the
 * 納入告知額 is made: full amounts are added exactly and truncated to the yen once, and the
 * employer share is that total less the employee shares already deducted (22-payroll §2.3).
 */
export function aggregateSocialInsurance(
  results: readonly SocialInsurancePremiums[],
): SocialInsuranceAggregate {
  let healthFull = ZERO;
  let pensionFull = ZERO;
  let contribution = ZERO;
  let healthEmployee = 0n;
  let pensionEmployee = 0n;
  for (const result of results) {
    healthFull = add(healthFull, result.health.full);
    pensionFull = add(pensionFull, result.pension.full);
    contribution = add(contribution, result.childContribution);
    healthEmployee += result.health.employee;
    pensionEmployee += result.pension.employee;
  }
  const health = {
    full: floorToYen(healthFull),
    employee: healthEmployee,
    employer: floorToYen(healthFull) - healthEmployee,
  };
  const pension = {
    full: floorToYen(pensionFull),
    employee: pensionEmployee,
    employer: floorToYen(pensionFull) - pensionEmployee,
  };
  const childContribution = floorToYen(contribution);
  return {
    health,
    pension,
    childContribution,
    employeeTotal: health.employee + pension.employee,
    employerTotal: health.employer + pension.employer + childContribution,
    total: health.full + pension.full + childContribution,
  };
}
