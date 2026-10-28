import type { Money } from "@niho-finance/ledger";
import type { RowFailure } from "../types";
import { parseStatementAmount } from "./fields";
import { rowFailure } from "./rows";
import { isBlankRow } from "./table";

/** The cell at `index`, or `""` when the row is shorter. */
export function cellAt(row: readonly string[], index: number): string {
  return row[index] ?? "";
}

/** A header cell compared without spaces and without full-width / half-width differences. */
export function headerKey(cell: string): string {
  return cell.normalize("NFKC").replace(/\s/gu, "");
}

/** Header rows are looked for in the first rows of the file only (12-imports §3.1). */
const HEADER_SEARCH_ROWS = 5;

/** Index of the first of the leading rows that `matches`, or `-1`. */
export function findHeaderRow(
  table: readonly (readonly string[])[],
  matches: (keys: string[]) => boolean,
): number {
  return table.slice(0, HEADER_SEARCH_ROWS).findIndex((row) => matches(row.map(headerKey)));
}

/** The failure of a file whose header row is not in its first rows (a format chosen by hand). */
export function missingHeaderFailures(
  table: readonly (readonly string[])[],
  header: readonly string[],
): RowFailure[] {
  const index = table.findIndex((row) => !isBlankRow(row));
  const first = table[index];
  return first
    ? [rowFailure(index + 1, `ヘッダ行（${header.join("、")}）が見つかりません`, first)]
    : [];
}

/** An amount cell: blank (no amount), unreadable, or a whole number of yen. */
export type AmountCell = { kind: "blank" } | { kind: "invalid" } | { kind: "amount"; value: Money };

export function readAmountCell(text: string): AmountCell {
  if (text.trim() === "") return { kind: "blank" };
  const value = parseStatementAmount(text);
  return value === null ? { kind: "invalid" } : { kind: "amount", value };
}
