import type { Money } from "@niho-finance/ledger";
import { PayrollInputError } from "./errors";
import { mul, ratio, roundHalfDownToYen, type Rational } from "./rational";
import type { EmploymentInsuranceTable } from "./tables";

export interface EmploymentInsurancePremium {
  /** 賃金総額 the rates apply to (課税 + 非課税). */
  base: Money;
  /** 労働者負担: wages × employee rate, 50 銭以下切り捨て・50 銭超切り上げ. */
  employee: Money;
  /** 事業主負担: wages × employer rate, unrounded (paid through 年度更新). */
  employer: Rational;
}

/** 雇用保険料 of one employee for one month of wages (22-payroll §2.5). */
export function employmentInsurancePremium(
  table: EmploymentInsuranceTable,
  wages: Money,
): EmploymentInsurancePremium {
  if (typeof wages !== "bigint" || wages < 0n) {
    throw new PayrollInputError([
      {
        code: "INVALID_AMOUNT",
        field: "wages",
        message: "賃金は 0 円以上の整数（円）にしてください",
      },
    ]);
  }
  const base = ratio(wages);
  return {
    base: wages,
    employee: roundHalfDownToYen(mul(base, table.rates.employee)),
    employer: mul(base, table.rates.employer),
  };
}
