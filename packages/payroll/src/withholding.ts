import type { Money } from "@niho-finance/ledger";
import { PayrollInputError } from "./errors";
import { add, floorToYen, mul, ratio } from "./rational";
import { KOU_COLUMNS, type WithholdingSegment, type WithholdingTable } from "./tables";

/**
 * 甲欄 (with 扶養控除等申告書; `dependents` = 扶養親族等の数) or 乙欄 (without; `secondaryDependents`
 * = the number on 従たる給与についての扶養控除等申告書, if one was filed).
 */
export type TaxColumn =
  { column: "kou"; dependents: number } | { column: "otsu"; secondaryDependents?: number };

function invalidCount(field: string, label: string): PayrollInputError {
  return new PayrollInputError([
    { code: "INVALID_DEPENDENTS", field, message: `${label}は 0 以上の整数にしてください` },
  ]);
}

function readCount(value: unknown, field: string, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidCount(field, label);
  }
  return value;
}

/** Checks the shape of a tax column given by untyped callers; returns the dependents counted. */
export function checkTaxColumn(column: TaxColumn): number {
  const value: unknown = column;
  if (typeof value !== "object" || value === null) {
    throw new PayrollInputError([
      { code: "INVALID_DEPENDENTS", field: "taxColumn", message: "甲欄か乙欄を選んでください" },
    ]);
  }
  if (column.column === "kou") {
    return readCount(column.dependents, "taxColumn.dependents", "扶養親族等の数");
  }
  if (column.column === "otsu") {
    return column.secondaryDependents === undefined
      ? 0
      : readCount(
          column.secondaryDependents,
          "taxColumn.secondaryDependents",
          "従たる給与の扶養親族等の数",
        );
  }
  throw new PayrollInputError([
    {
      code: "INVALID_DEPENDENTS",
      field: "taxColumn.column",
      message: "甲欄か乙欄を選んでください",
    },
  ]);
}

function bandFor(table: WithholdingTable, amount: Money) {
  const band = table.bands.find((row) => row.from <= amount && amount < row.to);
  if (!band) throw new RangeError(`${table.id}: no row for ${amount} yen`);
  return band;
}

/**
 * Tax of the formula part of the table (740,000 円以上): the table value at exactly a point,
 * otherwise tax(over) + (amount − over) × rate of the segment the amount falls in, truncated.
 */
function formulaTax(
  table: WithholdingTable,
  points: readonly { at: Money; tax: Money }[],
  segments: readonly WithholdingSegment[],
  amount: Money,
): Money {
  const exact = points.find((point) => point.at === amount);
  if (exact) return exact.tax;
  const segment = segments.find(
    (candidate) =>
      candidate.over < amount && (candidate.under === null || amount < candidate.under),
  );
  const base = segment && points.find((point) => point.at === segment.over);
  if (!segment || !base) throw new RangeError(`${table.id}: no formula for ${amount} yen`);
  return floorToYen(add(ratio(base.tax), mul(ratio(amount - segment.over), segment.rate)));
}

function clampAtZero(value: Money): Money {
  return value < 0n ? 0n : value;
}

/**
 * 源泉所得税 (月額表) for `amount` = その月の社会保険料等控除後の給与等の金額 (22-payroll §2.6).
 *
 * - 甲欄: the row of `amount` and the column of the dependents (0〜7). From 8 dependents on, the
 *   7-dependent tax less `extraDependentDeduction` per dependent beyond 7, never below 0.
 * - 乙欄: the 乙 value of the row; below the first row, `amount` × 3.063%. With secondary
 *   dependents, less `extraDependentDeduction` each, never below 0.
 * - At and above 740,000 円 the formula of §3.1. Fractions of a yen are truncated
 *   (国税通則法第 119 条第 2 項). An amount of 0 or less has no tax.
 */
export function withholdingTax(table: WithholdingTable, column: TaxColumn, amount: Money): Money {
  if (typeof amount !== "bigint") {
    throw new PayrollInputError([
      {
        code: "INVALID_AMOUNT",
        field: "amount",
        message: "社会保険料等控除後の給与等の金額は整数（円）にしてください",
      },
    ]);
  }
  const counted = checkTaxColumn(column);
  const base = clampAtZero(amount);
  const firstPoint = table.kouPoints[0]!.at;
  const deduction = table.extraDependentDeduction;

  if (column.column === "kou") {
    const index = counted < KOU_COLUMNS ? counted : KOU_COLUMNS - 1;
    const beyond = BigInt(counted - index);
    let tax: Money;
    if (base < table.lowBand.below) {
      tax = 0n;
    } else if (base < firstPoint) {
      tax = bandFor(table, base).kou[index]!;
    } else {
      const points = table.kouPoints.map((point) => ({ at: point.at, tax: point.kou[index]! }));
      tax = formulaTax(table, points, table.kouSegments, base);
    }
    return clampAtZero(tax - beyond * deduction);
  }

  let tax: Money;
  if (base < table.lowBand.below) {
    tax = floorToYen(mul(ratio(base), table.lowBand.otsuRate));
  } else if (base < table.otsuPoints[0]!.at) {
    tax = bandFor(table, base).otsu;
  } else {
    const points = table.otsuPoints.map((point) => ({ at: point.at, tax: point.otsu }));
    tax = formulaTax(table, points, table.otsuSegments, base);
  }
  return clampAtZero(tax - BigInt(counted) * deduction);
}
