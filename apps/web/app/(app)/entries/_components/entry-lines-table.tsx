import type { JournalEntryDetail } from "@niho-finance/db";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatYenDisplay } from "@/lib/format";

const COLUMNS = {
  columns:
    "52px minmax(0,1.5fr) 104px minmax(0,1.1fr) minmax(64px,0.7fr) minmax(0,0.9fr) minmax(0,1.2fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

const SIDE_LABELS = { debit: "借方", credit: "貸方" } as const;

/**
 * The lines of an entry (11 §5): 借方 / 貸方 ・ 科目（コード 名前 / 補助科目）・ 金額 ・ 税区分と税額 ・
 * セグメント ・ 取引先 ・ 摘要とタグ, and the totals.
 */
export function EntryLinesTable({ detail }: { detail: JournalEntryDetail }) {
  return (
    <Table label={`No. ${detail.no} の行`} minWidth={820}>
      <TableHead {...COLUMNS}>
        <Th>貸借</Th>
        <Th>科目</Th>
        <Th align="right">金額（円）</Th>
        <Th>税区分 · 税額</Th>
        <Th>セグメント</Th>
        <Th>取引先</Th>
        <Th>摘要 · タグ</Th>
      </TableHead>
      {detail.lines.map((line) => {
        const tax =
          line.taxAmount > 0n
            ? `${line.taxCategoryName} · ${formatYenDisplay(line.taxAmount)}`
            : line.taxCategoryName;
        const tags = line.memoTags.map((tag) => tag.name).join("・");
        const extras = [
          tax,
          line.segmentName,
          line.partnerName,
          line.description,
          tags ? `タグ ${tags}` : null,
        ].filter(Boolean);
        return (
          <TableRow key={line.lineNo} {...COLUMNS}>
            <Td sm="hide" className="text-[13px] text-muted">
              {SIDE_LABELS[line.side]}
            </Td>
            <Td>
              <span className="mr-2 text-[12px] text-muted md:hidden">
                {SIDE_LABELS[line.side]}
              </span>
              <span className="num mr-1.5 text-[12px] text-muted">{line.accountCode}</span>
              {line.accountName}
              {line.subAccountName ? (
                <span className="text-muted"> / {line.subAccountName}</span>
              ) : null}
            </Td>
            <Td align="right" className="font-bold">
              {formatYenDisplay(line.amount)}
            </Td>
            <Td sm="hide" className="text-[13px]">
              {line.taxCategoryName}
              {line.taxAmount > 0n ? (
                <span className="num ml-1.5 text-muted">{formatYenDisplay(line.taxAmount)}</span>
              ) : null}
            </Td>
            <Td sm="hide" className="truncate text-[13px]">
              {line.segmentName ?? "—"}
            </Td>
            <Td sm="hide" className="truncate text-[13px]">
              {line.partnerName ?? "—"}
            </Td>
            <Td sm="hide" className="text-[13px]">
              {line.description ?? ""}
              {tags ? <span className="block text-[11px] text-muted">タグ {tags}</span> : null}
            </Td>
            <span role="cell" className="text-[12px] text-muted md:hidden" data-sm="full">
              {extras.join(" · ")}
            </span>
          </TableRow>
        );
      })}
      <TableRow {...COLUMNS} className="bg-surface-2 font-bold">
        <Td sm="hide" />
        <Td>
          合計
          <span className="num ml-3 text-[12px] font-normal text-muted">
            借方 {formatYenDisplay(detail.debitTotal)} / 貸方 {formatYenDisplay(detail.creditTotal)}
          </span>
        </Td>
        <Td align="right">{formatYenDisplay(detail.debitTotal)}</Td>
      </TableRow>
    </Table>
  );
}
