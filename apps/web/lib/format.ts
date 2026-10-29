import { dateParts, formatYen, type CalendarDate, type Money } from "@niho-finance/ledger";

/** `2026-11-02` → `2026/11/02` (the mock's date style). */
export function formatDate(date: string | null | undefined): string {
  return date ? date.replaceAll("-", "/") : "—";
}

/** `2026/11/02 – 2027/03/31` */
export function formatPeriod(startDate: string, endDate: string): string {
  return `${formatDate(startDate)} – ${formatDate(endDate)}`;
}

/** `2026年11月` */
export function formatMonth(date: CalendarDate): string {
  const { year, month } = dateParts(date);
  return `${year}年${month}月`;
}

/**
 * 3-digit grouping with an ASCII `-`; `—` for no amount. For text that leaves the screen or is
 * read by machines (PDF, `aria-label`, the sentences shared with the PDF); on screens use
 * `formatAmountDisplay`.
 */
export function formatAmount(value: Money | null | undefined): string {
  return value === null || value === undefined ? "—" : formatYen(value);
}

/** U+2212 MINUS SIGN: how a negative amount is shown on screens (05-ui-ux §3.1). */
const MINUS_SIGN = "\u2212";

/** A number's text for a screen: a leading ASCII `-` becomes 「−」 (U+2212), e.g. chart labels. */
export function withDisplayMinus(text: string): string {
  return text.startsWith("-") ? `${MINUS_SIGN}${text.slice(1)}` : text;
}

/**
 * An amount shown on a screen: 3-digit grouping, a negative with 「−」 (U+2212) instead of the
 * ASCII `-` (05-ui-ux §3.1). The unit belongs to the column header. Input values
 * (`formatYenInput`), CSV, exports, PDF and `aria-*` keep `formatYen`.
 */
export function formatYenDisplay(value: Money): string {
  return withDisplayMinus(formatYen(value));
}

/** `formatYenDisplay`, or `—` for no amount. */
export function formatAmountDisplay(value: Money | null | undefined): string {
  return value === null || value === undefined ? "—" : formatYenDisplay(value);
}

const JAPAN_DATE_TIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** A timestamp in JST: `2026/11/03 10:12` (01-domain-model §9: timestamps are UTC, shown in JST). */
export function formatDateTime(value: Date | string): string {
  const parts = Object.fromEntries(
    JAPAN_DATE_TIME.formatToParts(new Date(value)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/** `No. 12`: the number owners see for an entry (01 §9). */
export function entryNo(no: number): string {
  return `No. ${no}`;
}

/** Wallet label of the forms: 「名前（科目 / 補助科目）」 (11 §4.1). */
export function walletLabel(wallet: {
  name: string;
  accountName: string;
  subAccountName: string | null;
}): string {
  const account = wallet.subAccountName
    ? `${wallet.accountName} / ${wallet.subAccountName}`
    : wallet.accountName;
  return `${wallet.name}（${account}）`;
}
