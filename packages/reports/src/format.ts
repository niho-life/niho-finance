import type { CalendarDate, Money } from "@niho-finance/ledger";

/** `2026-11-02` → `2026/11/02` (CSV, PDF and the exports). */
export function slashDate(date: CalendarDate): string {
  return date.replaceAll("-", "/");
}

/** `2026/11/02 – 2027/03/31` */
export function slashPeriod(from: CalendarDate, to: CalendarDate): string {
  return `${slashDate(from)} – ${slashDate(to)}`;
}

/** `20261102` (file names). */
export function compactDate(date: CalendarDate): string {
  return date.replaceAll("-", "");
}

/** `<report>_<from>-<to>.<ext>`: ASCII file names (14-reports §1). */
export function reportFileName(
  report: string,
  from: CalendarDate,
  to: CalendarDate,
  extension: string,
): string {
  return `${report}_${compactDate(from)}-${compactDate(to)}.${extension}`;
}

/** Plain integer yen for CSV cells (no grouping, `-` for negatives). */
export function plainYen(value: Money): string {
  return value.toString();
}

/** Display width in half-width columns (CJK, kana and full-width forms count 2). */
export function halfWidthLength(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const narrow =
      code <= 0xff || (code >= 0xff61 && code <= 0xff9f) || (code >= 0x2000 && code <= 0x206f);
    width += narrow ? 1 : 2;
  }
  return width;
}

/** Cuts `text` so that it fits `max` half-width columns (弥生's 摘要 is 64 columns). */
export function truncateHalfWidth(text: string, max: number): string {
  let width = 0;
  let out = "";
  for (const char of text) {
    const w = halfWidthLength(char);
    if (width + w > max) break;
    width += w;
    out += char;
  }
  return out;
}
