/**
 * Row pairing shared by the freee and 弥生 exports (14-reports §11.1): row i carries the i-th debit
 * line and the i-th credit line of an entry; a side that runs out leaves its columns empty.
 */
import type { ReportEntry, ReportLine } from "../source";

export interface PairedRow {
  debit: ReportLine | null;
  credit: ReportLine | null;
  /** Row index within the entry (0-based) and the number of rows. */
  index: number;
  count: number;
}

export function pairLines(entry: ReportEntry): PairedRow[] {
  const debits = entry.lines.filter((line) => line.side === "debit");
  const credits = entry.lines.filter((line) => line.side === "credit");
  const count = Math.max(debits.length, credits.length);
  const rows: PairedRow[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({ debit: debits[i] ?? null, credit: credits[i] ?? null, index: i, count });
  }
  return rows;
}

/** 摘要 of an export row: the entry's, with the state appended for voided entries. */
export function exportDescription(entry: ReportEntry): string {
  return entry.status === "voided" ? `${entry.description}（取消済み）` : entry.description;
}
