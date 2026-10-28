/**
 * 弥生の仕訳形式 (14-reports §11.2): the 25 columns of 仕訳日記帳 without a header row. Simple
 * entries (one debit, one credit) are flag 2000; the rest are vouchers 2110 / 2100 / 2101.
 */
import type { CalendarDate } from "@niho-finance/ledger";
import { slashDate, truncateHalfWidth } from "../format";
import { REPORT_ENTRY_STATUS_LABELS } from "../labels";
import {
  indexSource,
  type ReportEntry,
  type ReportLine,
  type ReportSource,
  type SourceIndex,
} from "../source";
import { exportDescription, pairLines } from "./pairing";
import { isTransitionalPurchase, TAX_NAME_OUT_OF_SCOPE, yayoiTaxName } from "./tax-names";

export const YAYOI_COLUMN_COUNT = 25;
export const YAYOI_DESCRIPTION_WIDTH = 64;
export const YAYOI_MEMO_WIDTH = 180;

export const YAYOI_FLAGS = {
  simple: "2000",
  single: "2111",
  first: "2110",
  middle: "2100",
  last: "2101",
} as const;

function flagOf(index: number, count: number): string {
  if (count === 1) return YAYOI_FLAGS.simple;
  if (index === 0) return YAYOI_FLAGS.first;
  if (index === count - 1) return YAYOI_FLAGS.last;
  return YAYOI_FLAGS.middle;
}

function sideCells(line: ReportLine | null, index: SourceIndex): string[] {
  if (!line) return ["", "", "", TAX_NAME_OUT_OF_SCOPE, "0", "0"];
  const account = index.accountsById.get(line.accountId);
  if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
  const sub = line.subAccountId ? index.subAccountsById.get(line.subAccountId) : undefined;
  return [
    account.name,
    sub?.name ?? "",
    "",
    yayoiTaxName(line.taxCategoryCode),
    line.amount.toString(),
    line.taxAmount.toString(),
  ];
}

function memoOf(entry: ReportEntry, index: SourceIndex): string {
  const parts = [`No.${entry.no}`];
  if (entry.kind === "reversal") {
    const reversed = entry.reversalOfId ? index.entriesById.get(entry.reversalOfId) : undefined;
    parts.push(reversed ? `反対仕訳（No.${reversed.no} の取消）` : "反対仕訳");
  } else {
    parts.push(REPORT_ENTRY_STATUS_LABELS[entry.status]);
  }
  if (entry.lines.some((line) => isTransitionalPurchase(line.taxCategoryCode))) {
    parts.push("登録番号のない仕入（経過措置）を含む");
  }
  return truncateHalfWidth(parts.join(" ・ "), YAYOI_MEMO_WIDTH);
}

/** The rows of the file (no header). Entries of `from`..`to` in date and number order. */
export function yayoiJournalRows(
  source: ReportSource,
  range: { from: CalendarDate; to: CalendarDate },
): string[][] {
  const index = indexSource(source);
  const rows: string[][] = [];
  for (const entry of index.entries) {
    if (entry.entryDate < range.from || entry.entryDate > range.to) continue;
    const closing = entry.kind === "adjusting" || entry.kind === "closing" ? "本決" : "";
    const description = truncateHalfWidth(exportDescription(entry), YAYOI_DESCRIPTION_WIDTH);
    const memo = memoOf(entry, index);
    for (const row of pairLines(entry)) {
      const cells = [
        flagOf(row.index, row.count),
        String(entry.no),
        closing,
        slashDate(entry.entryDate),
        ...sideCells(row.debit, index),
        ...sideCells(row.credit, index),
        description,
        "",
        "",
        "0",
        "",
        memo,
        "0",
        "0",
        "no",
      ];
      if (cells.length !== YAYOI_COLUMN_COUNT) {
        throw new Error(`reports: 弥生 row has ${cells.length} columns`);
      }
      rows.push(cells);
    }
  }
  return rows;
}
