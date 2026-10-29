import { isCalendarDate, type Money } from "@niho-finance/ledger";
import type { EmploymentInsurancePremium } from "./employment-insurance";
import { PayrollSnapshotError } from "./errors";
import type { PayrollCoverage } from "./payroll";
import { ratio, type Rational } from "./rational";
import type { SocialInsurancePremiums } from "./social-insurance";
import type { TableRef } from "./tables";
import type { TaxColumn } from "./withholding";

/*
 * The snapshot of a confirmed run (`PayrollRun.items`, `PayrollBonusRun.items`, 22-payroll §5.5):
 * bigint ↔ decimal strings, and the strict readers shared by the monthly and the bonus runs.
 * Internal: `index.ts` does not export this module.
 */

/** A JSON value of a snapshot (amounts as strings). */
export type SnapshotJson =
  string | number | boolean | null | SnapshotJson[] | { [key: string]: SnapshotJson };

export function toSnapshotJson(value: unknown, path: string): SnapshotJson {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new PayrollSnapshotError(path, "is not a whole number");
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) => toSnapshotJson(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const record: { [key: string]: SnapshotJson } = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      record[key] = toSnapshotJson(item, path === "" ? key : `${path}.${key}`);
    }
    return record;
  }
  throw new PayrollSnapshotError(path, `cannot be stored (${typeof value})`);
}

// Strict reader: exact keys, exact types, normalized rationals.

export type JsonRecord = Record<string, unknown>;

export function fail(path: string, problem: string): never {
  throw new PayrollSnapshotError(path, problem);
}

export function child(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path === "" ? key : `${path}.${key}`;
}

export function record(
  value: unknown,
  path: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "is not an object");
  }
  const data = value as JsonRecord;
  for (const key of Object.keys(data)) {
    if (!keys.includes(key) && !optional.includes(key)) fail(child(path, key), "is not expected");
  }
  for (const key of keys) if (!(key in data)) fail(child(path, key), "is missing");
  return data;
}

const WHOLE_YEN = /^-?(0|[1-9]\d*)$/;

export function money(value: unknown, path: string): Money {
  if (typeof value !== "string" || !WHOLE_YEN.test(value) || value === "-0") {
    fail(path, "is not a whole number string");
  }
  return BigInt(value);
}

export function nonNegativeMoney(value: unknown, path: string): Money {
  const amount = money(value, path);
  if (amount < 0n) fail(path, "is negative");
  return amount;
}

export function rational(value: unknown, path: string): Rational {
  const data = record(value, path, ["num", "den"]);
  const num = money(data.num, child(path, "num"));
  const den = money(data.den, child(path, "den"));
  if (den <= 0n) fail(child(path, "den"), "is not positive");
  const normalized = ratio(num, den);
  if (normalized.num !== num || normalized.den !== den) fail(path, "is not normalized");
  return normalized;
}

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "is not a boolean");
  return value;
}

export function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") fail(path, "is not a non-empty string");
  return value;
}

export function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "is not a whole number of 0 or more");
  }
  return value;
}

export function readTableRef(value: unknown, path: string): TableRef {
  const data = record(value, path, ["id", "title", "source"]);
  const source = record(data.source, child(path, "source"), ["url", "fetchedAt"]);
  const fetchedAt = text(source.fetchedAt, child(child(path, "source"), "fetchedAt"));
  if (!isCalendarDate(fetchedAt)) fail(child(child(path, "source"), "fetchedAt"), "is not a date");
  return {
    id: text(data.id, child(path, "id")),
    title: text(data.title, child(path, "title")),
    source: { url: text(source.url, child(child(path, "source"), "url")), fetchedAt },
  };
}

export function readTaxColumn(value: unknown, path: string): TaxColumn {
  const column =
    typeof value === "object" && value !== null ? (value as JsonRecord).column : undefined;
  if (column === "kou") {
    const data = record(value, path, ["column", "dependents"]);
    return { column: "kou", dependents: count(data.dependents, child(path, "dependents")) };
  }
  if (column === "otsu") {
    const data = record(value, path, ["column"], ["secondaryDependents"]);
    return data.secondaryDependents === undefined
      ? { column: "otsu" }
      : {
          column: "otsu",
          secondaryDependents: count(data.secondaryDependents, child(path, "secondaryDependents")),
        };
  }
  return fail(child(path, "column"), "is neither kou nor otsu");
}

export function readCoverage(value: unknown, path: string): PayrollCoverage {
  const coverage = record(value, path, ["health", "care", "pension", "employment"]);
  return {
    health: bool(coverage.health, child(path, "health")),
    care: bool(coverage.care, child(path, "care")),
    pension: bool(coverage.pension, child(path, "pension")),
    employment: bool(coverage.employment, child(path, "employment")),
  };
}

/** `SocialInsurancePremiums` of a stored result. */
export function readSocialInsurance(value: unknown, path: string): SocialInsurancePremiums {
  const si = record(value, path, ["health", "pension", "childContribution", "employeeTotal"]);
  const healthPath = child(path, "health");
  const health = record(si.health, healthPath, ["full", "employee", "employer", "breakdown"]);
  const breakdownPath = child(healthPath, "breakdown");
  const breakdown = record(health.breakdown, breakdownPath, ["health", "care", "childSupport"]);
  const pensionPath = child(path, "pension");
  const pension = record(si.pension, pensionPath, ["full", "employee", "employer"]);
  return {
    health: {
      full: rational(health.full, child(healthPath, "full")),
      employee: nonNegativeMoney(health.employee, child(healthPath, "employee")),
      employer: rational(health.employer, child(healthPath, "employer")),
      breakdown: {
        health: rational(breakdown.health, child(breakdownPath, "health")),
        care: rational(breakdown.care, child(breakdownPath, "care")),
        childSupport: rational(breakdown.childSupport, child(breakdownPath, "childSupport")),
      },
    },
    pension: {
      full: rational(pension.full, child(pensionPath, "full")),
      employee: nonNegativeMoney(pension.employee, child(pensionPath, "employee")),
      employer: rational(pension.employer, child(pensionPath, "employer")),
    },
    childContribution: rational(si.childContribution, child(path, "childContribution")),
    employeeTotal: nonNegativeMoney(si.employeeTotal, child(path, "employeeTotal")),
  };
}

/** `EmploymentInsurancePremium | null` of a stored result. */
export function readEmploymentInsurance(
  value: unknown,
  path: string,
): EmploymentInsurancePremium | null {
  if (value === null) return null;
  const ei = record(value, path, ["base", "employee", "employer"]);
  return {
    base: nonNegativeMoney(ei.base, child(path, "base")),
    employee: nonNegativeMoney(ei.employee, child(path, "employee")),
    employer: rational(ei.employer, child(path, "employer")),
  };
}
