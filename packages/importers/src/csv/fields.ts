import { isCalendarDate, type CalendarDate, type Money } from "@niho-finance/ledger";

/**
 * Field readers for statement CSVs (12-imports §3.2). Each returns `null` for a value it cannot
 * read; the format decides whether that makes the row a failure.
 */

/** Full-width digits, letters and punctuation → ASCII, full-width spaces → spaces (NFKC). */
function toHalfWidth(text: string): string {
  return text.normalize("NFKC");
}

/** Trims the surrounding (also full-width) spaces and keeps the rest as written (§3.2). */
export function normalizeText(text: string): string {
  return text.trim();
}

function calendarDate(year: number, month: number, day: number): CalendarDate | null {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999) return null;
  if (!Number.isSafeInteger(month) || !Number.isSafeInteger(day)) return null;
  const value = [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
  return isCalendarDate(value) ? value : null;
}

/** The Gregorian year before the first year of each era: 令和 N = 2018 + N, 平成 N = 1988 + N. */
const ERA_OFFSETS: Readonly<Record<string, number>> = {
  令和: 2018,
  R: 2018,
  平成: 1988,
  H: 1988,
};

function eraDate(
  era: string | undefined,
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
): CalendarDate | null {
  const offset = ERA_OFFSETS[(era ?? "").toUpperCase()];
  if (offset === undefined || year === undefined) return null;
  const eraYear = year === "元" ? 1 : Number(year);
  if (eraYear < 1) return null;
  return calendarDate(offset + eraYear, Number(month), Number(day));
}

const SEPARATED_DATE = /^(\d{4})\s*([/.-])\s*(\d{1,2})\s*\2\s*(\d{1,2})$/;
const KANJI_DATE = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const ZENGIN_DATE = /^(\d{2})(\d{2})(\d{2})$/;
const ERA_SEPARATED_DATE =
  /^(令和|平成|[RH])\s*(元|\d{1,2})\s*([/.-])\s*(\d{1,2})\s*\3\s*(\d{1,2})$/i;
const ERA_KANJI_DATE = /^(令和|平成|[RH])\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/i;

/**
 * 全銀 `YYMMDD`: a 和暦 year without the era, taken as 令和 (`081102` → 2026-11-02). `null` when it
 * is not a real date.
 */
export function parseZenginDate(text: string): CalendarDate | null {
  const match = ZENGIN_DATE.exec(toHalfWidth(text).trim());
  return match ? eraDate("R", match[1], match[2], match[3]) : null;
}

/**
 * A statement date in any notation of 12-imports §3.2: `2026/11/02`, `2026-11-02`, `2026.11.02`,
 * `2026年11月2日`, `20261102`, `R8.11.2`, `令和8年11月2日` (also 元年), `H31.4.30`. Full-width digits
 * and one-digit months and days are accepted; `null` when the text is none of these or not a real
 * date. A bare `YYMMDD` is not read here (a Western `261102` would pass as 令和 26): only the 全銀
 * format reads it, with `parseZenginDate`.
 */
export function parseStatementDate(text: string): CalendarDate | null {
  const value = toHalfWidth(text).trim();

  const separated = SEPARATED_DATE.exec(value);
  if (separated) {
    return calendarDate(Number(separated[1]), Number(separated[3]), Number(separated[4]));
  }
  const written = KANJI_DATE.exec(value) ?? COMPACT_DATE.exec(value);
  if (written) return calendarDate(Number(written[1]), Number(written[2]), Number(written[3]));

  const era = ERA_SEPARATED_DATE.exec(value);
  if (era) return eraDate(era[1], era[2], era[4], era[5]);
  const eraWritten = ERA_KANJI_DATE.exec(value);
  if (eraWritten) return eraDate(eraWritten[1], eraWritten[2], eraWritten[3], eraWritten[4]);

  return null;
}

/** Up to 15 significant digits (under 1,000 trillion yen): anything longer is not an amount. */
const MAX_DIGITS = 15;
const NEGATIVE_SIGN = /^[-−▲△]/;
const GROUPED_DIGITS = /^\d{1,3}(,\d{3})+$/;
const PLAIN_DIGITS = /^\d+$/;
const WHOLE_DECIMALS = /\.0{1,2}$/;

/**
 * A statement amount (12-imports §3.2): 3-digit grouping commas, spaces, `円` / `¥` / `＼`,
 * full-width digits and a `+` are dropped; `-`, `−`, `▲`, `△` or parentheses make it negative;
 * `.0` / `.00` are the only decimals accepted (there is no fractional yen). `null` when blank or
 * not a whole number of yen.
 */
export function parseStatementAmount(text: string): Money | null {
  let value = toHalfWidth(text).replace(/[\s円¥\\]/gu, "");
  if (value === "") return null;

  let negative = false;
  if (value.startsWith("(") && value.endsWith(")")) {
    negative = true;
    value = value.slice(1, -1);
  } else if (NEGATIVE_SIGN.test(value)) {
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }

  value = value.replace(WHOLE_DECIMALS, "");
  if (GROUPED_DIGITS.test(value)) value = value.replace(/,/g, "");
  if (!PLAIN_DIGITS.test(value)) return null;
  if (value.replace(/^0+(?=\d)/, "").length > MAX_DIGITS) return null;

  const amount = BigInt(value);
  return negative ? -amount : amount;
}
