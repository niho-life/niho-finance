/**
 * freee の仕訳インポート形式 (14-reports §11.1): the template with separate debit and credit
 * columns, `[表題行]` / `[明細行]` in the first column, one 伝票番号 per entry.
 */
import type { CalendarDate } from "@niho-finance/ledger";
import { slashDate } from "../format";
import { indexSource, type ReportLine, type ReportSource, type SourceIndex } from "../source";
import { exportDescription, pairLines } from "./pairing";
import { freeeTaxName } from "./tax-names";

export const FREEE_HEADER = [
  "[表題行]",
  "日付",
  "伝票番号",
  "決算整理仕訳",
  "借方勘定科目",
  "借方科目コード",
  "借方補助科目",
  "借方取引先",
  "借方取引先コード",
  "借方部門",
  "借方品目",
  "借方メモタグ",
  "借方セグメント1",
  "借方セグメント2",
  "借方セグメント3",
  "借方金額",
  "借方税区分",
  "借方税額",
  "貸方勘定科目",
  "貸方科目コード",
  "貸方補助科目",
  "貸方取引先",
  "貸方取引先コード",
  "貸方部門",
  "貸方品目",
  "貸方メモタグ",
  "貸方セグメント1",
  "貸方セグメント2",
  "貸方セグメント3",
  "貸方金額",
  "貸方税区分",
  "貸方税額",
  "摘要",
] as const;

export interface JournalExportRange {
  from: CalendarDate;
  to: CalendarDate;
}

function sideCells(line: ReportLine | null, index: SourceIndex): string[] {
  if (!line) return Array.from({ length: 14 }, () => "");
  const account = index.accountsById.get(line.accountId);
  if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
  const sub = line.subAccountId ? index.subAccountsById.get(line.subAccountId) : undefined;
  const partner = line.partnerId ? index.partnersById.get(line.partnerId) : undefined;
  const segment = line.segmentId ? index.segmentsById.get(line.segmentId) : undefined;
  const tags = line.memoTagIds
    .map((id) => index.memoTagsById.get(id)?.name)
    .filter((name): name is string => typeof name === "string");
  return [
    account.name,
    account.code,
    sub?.name ?? "",
    partner?.name ?? "",
    "",
    "",
    "",
    tags.join("|"),
    segment?.name ?? "",
    "",
    "",
    line.amount.toString(),
    freeeTaxName(line.taxCategoryCode),
    line.taxAmount.toString(),
  ];
}

/** The rows of the CSV, header included. Entries of `from`..`to` in date and number order. */
export function freeeJournalRows(source: ReportSource, range: JournalExportRange): string[][] {
  const index = indexSource(source);
  const rows: string[][] = [[...FREEE_HEADER]];
  for (const entry of index.entries) {
    if (entry.entryDate < range.from || entry.entryDate > range.to) continue;
    const adjusting = entry.kind === "adjusting" || entry.kind === "closing" ? "1" : "";
    for (const row of pairLines(entry)) {
      rows.push([
        "[明細行]",
        slashDate(entry.entryDate),
        String(entry.no),
        adjusting,
        ...sideCells(row.debit, index),
        ...sideCells(row.credit, index),
        exportDescription(entry),
      ]);
    }
  }
  return rows;
}
