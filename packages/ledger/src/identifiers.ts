/**
 * Japanese business identifiers: 法人番号 (corporate number) and the qualified invoice issuer's
 * 登録番号 (T + 13 digits). Only the format and the check digit are verified here; looking a
 * number up at the National Tax Agency is v2.
 */

const FULL_WIDTH_DIGIT = /[０-９]/g;
/** Separators people type inside numbers: spaces and the various hyphens and dashes. */
const NUMBER_SEPARATORS = /[\s‐-―−－ー-]/g;

function toHalfWidthDigits(value: string): string {
  return value.replace(FULL_WIDTH_DIGIT, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

/** Full-width digits → half-width; spaces and hyphens removed. */
export function normalizeCorporateNumber(value: string): string {
  return toHalfWidthDigits(value).replace(NUMBER_SEPARATORS, "");
}

/** Same as `normalizeCorporateNumber`, plus a lower-case or full-width `T` → `T`. */
export function normalizeInvoiceRegistrationNumber(value: string): string {
  return normalizeCorporateNumber(value).replace(/^[tＴｔ]/, "T");
}

/**
 * Check digit of a corporate number from its 12-digit base: 9 − ((Σ odd-position digits +
 * 2 × Σ even-position digits) mod 9), positions counted from the least significant digit.
 */
export function corporateNumberCheckDigit(base: string): number {
  if (!/^\d{12}$/.test(base)) throw new RangeError("the base of a corporate number is 12 digits");
  let odd = 0;
  let even = 0;
  for (let position = 1; position <= 12; position += 1) {
    const digit = Number(base[12 - position]);
    if (position % 2 === 1) odd += digit;
    else even += digit;
  }
  return 9 - ((odd + even * 2) % 9);
}

/** 13 digits whose first digit is the check digit of the other 12. */
export function isValidCorporateNumber(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  return Number(value[0]) === corporateNumberCheckDigit(value.slice(1));
}

/** `T` followed by a valid 13-digit number (the corporate number for a company). */
export function isValidInvoiceRegistrationNumber(value: string): boolean {
  return /^T\d{13}$/.test(value) && isValidCorporateNumber(value.slice(1));
}

/** Owner-facing reason why a (normalized) corporate number is invalid, or `null` when valid. */
export function corporateNumberProblem(value: string): string | null {
  if (!/^\d{13}$/.test(value)) return "法人番号は 13 桁の数字です";
  if (!isValidCorporateNumber(value)) {
    return "法人番号の検査用数字（先頭の 1 桁）が合いません。番号を確かめてください";
  }
  return null;
}

/** Owner-facing reason why a (normalized) registration number is invalid, or `null` when valid. */
export function invoiceRegistrationNumberProblem(value: string): string | null {
  if (!/^T\d{13}$/.test(value)) return "登録番号は T に続く 13 桁の数字です";
  if (!isValidInvoiceRegistrationNumber(value)) {
    return "登録番号の検査用数字（T の次の 1 桁）が合いません。番号を確かめてください";
  }
  return null;
}
