import type { PayrollTableKind } from "./tables";

export const PAYROLL_INPUT_ERROR_CODES = [
  "INVALID_DATE",
  "INVALID_PREMIUM_MONTH",
  "INVALID_WORKER",
  "INVALID_AMOUNT",
  "INVALID_DEPENDENTS",
  "INVALID_COVERAGE",
  "OFFICER_EMPLOYMENT_INSURANCE",
  "CARE_WITHOUT_HEALTH",
  "UNKNOWN_STANDARD_REMUNERATION",
  "TABLE_NOT_EFFECTIVE",
  "INVALID_ADJUSTMENT",
] as const;
export type PayrollInputErrorCode = (typeof PAYROLL_INPUT_ERROR_CODES)[number];

/** One problem in a payroll input. `message` is owner-facing Japanese; `code` is for programs. */
export interface PayrollInputIssue {
  code: PayrollInputErrorCode;
  /** Path of the input field, e.g. `"standardRemuneration.health"`. */
  field: string;
  message: string;
}

/** Thrown when a payroll input breaks the rules of 22-payroll §4 (金額・扶養親族等の数・適用). */
export class PayrollInputError extends Error {
  readonly issues: readonly PayrollInputIssue[];

  constructor(issues: readonly PayrollInputIssue[]) {
    super(issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
    this.name = "PayrollInputError";
    this.issues = issues;
  }

  get codes(): PayrollInputErrorCode[] {
    return this.issues.map((issue) => issue.code);
  }

  has(code: PayrollInputErrorCode): boolean {
    return this.issues.some((issue) => issue.code === code);
  }
}

/**
 * Thrown when no registered table version covers the requested date or month (22-payroll §3.2).
 * The calculation never falls back to another version.
 */
export class PayrollTableMissingError extends Error {
  readonly tableKind: PayrollTableKind;
  /** The payment date (`YYYY-MM-DD`) or premium month (`YYYY-MM`) that was asked for. */
  readonly needed: string;

  constructor(tableKind: PayrollTableKind, needed: string, message: string) {
    super(message);
    this.name = "PayrollTableMissingError";
    this.tableKind = tableKind;
    this.needed = needed;
  }
}

/** Thrown when a table's JSON breaks the schema of 22-payroll §3.1 (a data bug, not an input error). */
export class PayrollTableFormatError extends Error {
  /** The table id, or its kind when the id itself is unreadable. */
  readonly table: string;
  /** JSON path of the offending value, e.g. `"bands[3].kou"`. */
  readonly path: string;

  constructor(table: string, path: string, problem: string) {
    super(`${table}: ${path === "" ? "" : `${path} `}${problem}`);
    this.name = "PayrollTableFormatError";
    this.table = table;
    this.path = path;
  }
}

/**
 * Thrown when a stored payroll run snapshot (`PayrollRun.items` / `tableIds`, 22-payroll §5.5) does
 * not have the exact shape it was written with (a data bug, not an input error).
 */
export class PayrollSnapshotError extends Error {
  /** JSON path of the offending value, e.g. `"[0].result.netPay"`. */
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`payroll snapshot: ${path === "" ? "" : `${path} `}${problem}`);
    this.name = "PayrollSnapshotError";
    this.path = path;
  }
}
