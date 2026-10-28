export const LEDGER_ERROR_CODES = [
  "INVALID_DATE",
  "INVALID_KIND",
  "INVALID_SOURCE_KIND",
  "DESCRIPTION_REQUIRED",
  "INVALID_REVERSAL_LINK",
  "TOO_FEW_LINES",
  "INVALID_SIDE",
  "INVALID_AMOUNT",
  "NON_POSITIVE_AMOUNT",
  "INVALID_TAX_AMOUNT",
  "TAX_AMOUNT_NOT_ALLOWED",
  "TAX_CATEGORY_REQUIRED",
  "UNKNOWN_TAX_CATEGORY",
  "UNKNOWN_ACCOUNT",
  "ACCOUNT_INACTIVE",
  "UNKNOWN_SUB_ACCOUNT",
  "SUB_ACCOUNT_MISMATCH",
  "SEGMENT_REQUIRED",
  "UNBALANCED",
  "INTERNAL_UNBALANCED",
  "OUT_OF_FISCAL_YEAR",
  "PERIOD_LOCKED",
  "FISCAL_YEAR_CLOSED",
  "FISCAL_YEAR_CLOSING",
  "ALREADY_VOIDED",
  "CANNOT_REVERSE_REVERSAL",
  "VOID_REASON_REQUIRED",
] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

/** A rule violation in an entry. `message` is owner-facing Japanese; `code` is for programs. */
export interface LedgerError {
  code: LedgerErrorCode;
  message: string;
  /** Index into `lines` when the error belongs to one line. */
  lineIndex?: number;
}

/** Thrown when an entry breaks the ledger rules (02-accounting-rules §1). */
export class LedgerValidationError extends Error {
  readonly errors: readonly LedgerError[];

  constructor(errors: readonly LedgerError[]) {
    super(errors.map((error) => `${error.code}: ${error.message}`).join("; "));
    this.name = "LedgerValidationError";
    this.errors = errors;
  }

  get codes(): LedgerErrorCode[] {
    return this.errors.map((error) => error.code);
  }

  has(code: LedgerErrorCode): boolean {
    return this.errors.some((error) => error.code === code);
  }
}

export const LEDGER_INVARIANT_CODES = [
  "TRIAL_BALANCE_UNBALANCED",
  "TRIAL_BALANCE_IDENTITY",
  "INTERNAL_NONZERO",
  "UNKNOWN_ACCOUNT",
  "INVALID_SEQUENCE_NUMBER",
  "SEQUENCE_START",
  "SEQUENCE_GAP",
  "SEQUENCE_DUPLICATE",
  "INVALID_TAX_RATE",
  "TAX_RULE_AMBIGUOUS",
] as const;
export type LedgerInvariantCode = (typeof LEDGER_INVARIANT_CODES)[number];

/** Thrown when derived data (balances, numbering, tax rules) breaks an invariant. */
export class LedgerInvariantError extends Error {
  readonly code: LedgerInvariantCode;

  constructor(code: LedgerInvariantCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "LedgerInvariantError";
    this.code = code;
  }
}
