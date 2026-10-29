import { isCalendarDate, type CalendarDate, type Money } from "@niho-finance/ledger";
import {
  employmentInsurancePremium,
  type EmploymentInsurancePremium,
} from "./employment-insurance";
import { PayrollInputError, type PayrollInputIssue } from "./errors";
import { isYearMonth, type YearMonth } from "./month";
import {
  findEmploymentInsuranceTable,
  findKenpoTable,
  findPensionTable,
  findWithholdingTable,
} from "./registry";
import { socialInsurancePremiums, type SocialInsurancePremiums } from "./social-insurance";
import {
  isTableEffective,
  tableRef,
  type EmploymentInsuranceTable,
  type KenpoTable,
  type PayrollTable,
  type PayrollTableKind,
  type PensionTable,
  type TableRef,
  type WithholdingTable,
} from "./tables";
import { checkTaxColumn, withholdingTax, type TaxColumn } from "./withholding";

/** 役員 (役員報酬; never insured by 雇用保険) or 従業員 (給料手当). */
export type WorkerKind = "officer" | "employee";

export interface PayrollTables {
  withholding: WithholdingTable;
  kenpo: KenpoTable;
  pension: PensionTable;
  employment: EmploymentInsuranceTable;
}

export interface PayrollCoverage {
  health: boolean;
  /** 介護保険第 2 号被保険者 (40〜64 歳). Requires `health`. */
  care: boolean;
  pension: boolean;
  /** 雇用保険. Never for an officer. */
  employment: boolean;
}

export interface PayrollInput {
  /** 支払日: selects the withholding table (年分). */
  paymentDate: CalendarDate;
  /** 対象月 of the social insurance premiums: selects the rate and grade tables. */
  premiumMonth: YearMonth;
  worker: WorkerKind;
  /** 課税支給額: 役員報酬・基本給・課税の手当. */
  taxablePay: Money;
  /** 非課税支給額 (e.g. the non-taxable part of 通勤手当). Counts for 雇用保険, not income tax. */
  nonTaxablePay: Money;
  /** 標準報酬月額 as recorded, separately for health insurance and the pension. */
  standardRemuneration: { health: Money; pension: Money };
  coverage: PayrollCoverage;
  taxColumn: TaxColumn;
  /** 住民税 (特別徴収) of the month, as notified by the municipality. */
  residentTax: Money;
  /**
   * Corrections of earlier months (22-payroll §4 調整), signed yen. `socialInsurance` is added to the
   * employee social insurance deduction (and so lowers the withholding base); `incomeTax` is added
   * to the table tax. Left out = no adjustment.
   */
  adjustments?: PayrollAdjustments;
  /** Pins table versions (e.g. the ones a past run used); the rest come from the registry. */
  tables?: Partial<PayrollTables>;
}

/** 調整: signed whole yen added to the deductions (22-payroll §4). */
export interface PayrollAdjustments {
  incomeTax: Money;
  socialInsurance: Money;
}

export interface PayrollResult {
  /** 総支給額 = 課税 + 非課税. */
  grossPay: Money;
  socialInsurance: SocialInsurancePremiums;
  /** `null` when not insured. */
  employmentInsurance: EmploymentInsurancePremium | null;
  /**
   * 社会保険料等控除後の給与等の金額 = 課税支給額 − 社会保険料（調整後）・雇用保険料の本人負担.
   */
  withholdingBase: Money;
  /** 源泉所得税 of the table (before the adjustment). */
  incomeTax: Money;
  residentTax: Money;
  /** The adjustments applied (0 when the input had none). */
  adjustments: PayrollAdjustments;
  /** incomeTax + adjustments.incomeTax: the income tax withheld. */
  incomeTaxTotal: Money;
  /** socialInsurance.employeeTotal + adjustments.socialInsurance: the 健保・厚年 deduction. */
  socialInsuranceEmployeeTotal: Money;
  /** 社会保険料（調整後）+ 雇用保険料 (本人負担) + 源泉所得税（調整後）+ 住民税. May be negative. */
  totalDeductions: Money;
  /** 差引支給額 = grossPay − totalDeductions. */
  netPay: Money;
  tables: {
    withholding: TableRef;
    kenpo: TableRef;
    pension: TableRef;
    employment: TableRef | null;
  };
}

const AMOUNTS = [
  { key: "taxablePay", label: "課税支給額" },
  { key: "nonTaxablePay", label: "非課税支給額" },
  { key: "residentTax", label: "住民税" },
] as const;

const REMUNERATIONS = [
  { key: "health", label: "標準報酬月額（健康保険）" },
  { key: "pension", label: "標準報酬月額（厚生年金）" },
] as const;

const COVERAGES = [
  { key: "health", label: "健康保険" },
  { key: "care", label: "介護保険" },
  { key: "pension", label: "厚生年金" },
  { key: "employment", label: "雇用保険" },
] as const;

const ADJUSTMENTS = [
  { key: "incomeTax", label: "源泉所得税の調整" },
  { key: "socialInsurance", label: "社会保険料の調整" },
] as const;

function isAmount(value: unknown): value is Money {
  return typeof value === "bigint" && value >= 0n;
}

/** The rules of 22-payroll §4 that need no table. Collects every problem before throwing. */
function validateInput(input: PayrollInput): void {
  const issues: PayrollInputIssue[] = [];
  if (!isCalendarDate(input.paymentDate)) {
    issues.push({
      code: "INVALID_DATE",
      field: "paymentDate",
      message: `支払日「${String(input.paymentDate)}」が正しくありません（YYYY-MM-DD）`,
    });
  }
  if (!isYearMonth(input.premiumMonth)) {
    issues.push({
      code: "INVALID_PREMIUM_MONTH",
      field: "premiumMonth",
      message: `対象月「${String(input.premiumMonth)}」が正しくありません（YYYY-MM）`,
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
  for (const { key, label } of AMOUNTS) {
    if (!isAmount(input[key])) {
      issues.push({
        code: "INVALID_AMOUNT",
        field: key,
        message: `${label}は 0 円以上の整数（円）にしてください`,
      });
    }
  }
  const remuneration: unknown = input.standardRemuneration;
  for (const { key, label } of REMUNERATIONS) {
    const amount: unknown =
      typeof remuneration === "object" && remuneration !== null
        ? (remuneration as Record<string, unknown>)[key]
        : undefined;
    if (!isAmount(amount)) {
      issues.push({
        code: "INVALID_AMOUNT",
        field: `standardRemuneration.${key}`,
        message: `${label}は 0 円以上の整数（円）にしてください`,
      });
    }
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
  try {
    checkTaxColumn(input.taxColumn);
  } catch (error) {
    if (!(error instanceof PayrollInputError)) throw error;
    issues.push(...error.issues);
  }
  if (worker === "officer" && input.coverage?.employment === true) {
    issues.push({
      code: "OFFICER_EMPLOYMENT_INSURANCE",
      field: "coverage.employment",
      message: "役員は雇用保険の被保険者になりません。雇用保険を「なし」にしてください",
    });
  }
  const adjustments: unknown = input.adjustments;
  if (adjustments !== undefined) {
    const values =
      typeof adjustments === "object" && adjustments !== null
        ? (adjustments as Record<string, unknown>)
        : {};
    for (const { key, label } of ADJUSTMENTS) {
      if (typeof values[key] !== "bigint") {
        issues.push({
          code: "INVALID_ADJUSTMENT",
          field: `adjustments.${key}`,
          message: `${label}は円の整数（マイナスも可）にしてください`,
        });
      }
    }
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

const TABLE_LABELS: Record<PayrollTableKind, string> = {
  "withholding-monthly": "源泉徴収税額表",
  "kyokai-kenpo": "協会けんぽの料率・等級表",
  pension: "厚生年金の料率・等級表",
  "employment-insurance": "雇用保険料率",
  "withholding-bonus": "賞与に対する源泉徴収税額の算出率の表",
  "year-end": "年末調整の表",
};

/** A pinned table must be of its kind and in force at the date or month it is used for. */
export function checkPinnedTable(
  table: PayrollTable,
  kind: PayrollTableKind,
  field: string,
  when: string,
): PayrollInputIssue | null {
  const label = TABLE_LABELS[kind];
  if (table.kind !== kind) {
    return {
      code: "TABLE_NOT_EFFECTIVE",
      field: `tables.${field}`,
      message: `${label}の欄に別の種類の表（${table.title}）が指定されています`,
    };
  }
  if (!isTableEffective(table, when)) {
    return {
      code: "TABLE_NOT_EFFECTIVE",
      field: `tables.${field}`,
      message: `指定した${label}（${table.title}）は ${when} に適用されません`,
    };
  }
  return null;
}

function resolveTables(input: PayrollInput): Omit<PayrollTables, "employment"> & {
  employment: EmploymentInsuranceTable | null;
} {
  const pinned = input.tables ?? {};
  const issues = [
    pinned.withholding &&
      checkPinnedTable(pinned.withholding, "withholding-monthly", "withholding", input.paymentDate),
    pinned.kenpo && checkPinnedTable(pinned.kenpo, "kyokai-kenpo", "kenpo", input.premiumMonth),
    pinned.pension && checkPinnedTable(pinned.pension, "pension", "pension", input.premiumMonth),
    input.coverage.employment && pinned.employment
      ? checkPinnedTable(
          pinned.employment,
          "employment-insurance",
          "employment",
          input.premiumMonth,
        )
      : null,
  ].filter((issue): issue is PayrollInputIssue => typeof issue === "object" && issue !== null);
  if (issues.length > 0) throw new PayrollInputError(issues);
  return {
    withholding: pinned.withholding ?? findWithholdingTable(input.paymentDate),
    kenpo: pinned.kenpo ?? findKenpoTable(input.premiumMonth),
    pension: pinned.pension ?? findPensionTable(input.premiumMonth),
    employment: input.coverage.employment
      ? (pinned.employment ?? findEmploymentInsuranceTable(input.premiumMonth))
      : null,
  };
}

/**
 * One month's pay of one officer or employee (22-payroll §2・§4): social insurance and
 * employment insurance premiums, withholding income tax on (taxable pay − those premiums),
 * resident tax as given, the adjustments (調整) and the net pay. Tables come from the registry by
 * date unless pinned in `input.tables`; the result names every table it used.
 *
 * Throws `PayrollInputError` for invalid input (negative or non-integer amounts, a non-integer
 * number of dependents, an officer with employment insurance, a standard remuneration that is not
 * a grade amount, an adjustment that is not a bigint) and `PayrollTableMissingError` when no table covers the date or month.
 */
export function calculatePayroll(input: PayrollInput): PayrollResult {
  validateInput(input);
  const tables = resolveTables(input);
  const socialInsurance = socialInsurancePremiums(
    tables.kenpo,
    tables.pension,
    input.premiumMonth,
    input.standardRemuneration,
    input.coverage,
  );
  const grossPay = input.taxablePay + input.nonTaxablePay;
  const employmentInsurance = tables.employment
    ? employmentInsurancePremium(tables.employment, grossPay)
    : null;
  const adjustments: PayrollAdjustments = {
    incomeTax: input.adjustments?.incomeTax ?? 0n,
    socialInsurance: input.adjustments?.socialInsurance ?? 0n,
  };
  const socialInsuranceEmployeeTotal = socialInsurance.employeeTotal + adjustments.socialInsurance;
  const insuranceDeductions = socialInsuranceEmployeeTotal + (employmentInsurance?.employee ?? 0n);
  const withholdingBase = input.taxablePay - insuranceDeductions;
  const incomeTax = withholdingTax(tables.withholding, input.taxColumn, withholdingBase);
  const incomeTaxTotal = incomeTax + adjustments.incomeTax;
  const totalDeductions = insuranceDeductions + incomeTaxTotal + input.residentTax;
  return {
    grossPay,
    socialInsurance,
    employmentInsurance,
    withholdingBase,
    incomeTax,
    residentTax: input.residentTax,
    adjustments,
    incomeTaxTotal,
    socialInsuranceEmployeeTotal,
    totalDeductions,
    netPay: grossPay - totalDeductions,
    tables: {
      withholding: tableRef(tables.withholding),
      kenpo: tableRef(tables.kenpo),
      pension: tableRef(tables.pension),
      employment: tables.employment ? tableRef(tables.employment) : null,
    },
  };
}
