import { formatYen, type Money } from "./money";

/** Up to 15 digits (under 1,000 trillion yen): anything longer is a typing mistake. */
const MAX_DIGITS = 15;

const FULL_WIDTH = /[０-９，．－＋]/g;

function toHalfWidth(value: string): string {
  return value.replace(FULL_WIDTH, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

export interface ParseYenInputOptions {
  /** Accept a leading minus (e.g. an opening balance). Defaults to `false`. */
  allowNegative?: boolean;
}

/**
 * Parses an amount typed into a form: `50000`, `50,000`, `５０，０００`, `¥50,000`, `50,000円`.
 * Returns `null` for anything that is not a whole number of yen (blank, decimals, letters).
 */
export function parseYenInput(text: string, options: ParseYenInputOptions = {}): Money | null {
  let value = toHalfWidth(text)
    .trim()
    .replace(/^[¥￥]\s*/, "")
    .replace(/\s*円$/, "");
  let negative = false;
  if (/^[-−]/.test(value)) {
    if (!options.allowNegative) return null;
    negative = true;
    value = value.slice(1).trim();
  }
  value = value.replace(/,/g, "");
  if (!/^\d+$/.test(value) || value.length > MAX_DIGITS) return null;
  const amount = BigInt(value);
  return negative ? -amount : amount;
}

/** The text an amount input shows: 3-digit grouping, empty for no amount. */
export function formatYenInput(value: Money | null | undefined): string {
  return value === null || value === undefined ? "" : formatYen(value);
}
