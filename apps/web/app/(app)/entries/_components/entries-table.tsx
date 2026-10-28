import type { EntrySideSummary, JournalEntryListRow } from "@niho-finance/db";
import { formatYen } from "@niho-finance/ledger";
import Link from "next/link";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { entryNo, formatDate } from "@/lib/format";
import { detailHref } from "./list-query";

const COLUMNS = {
  columns:
    "84px 52px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) 104px minmax(72px,0.6fr) minmax(88px,0.7fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function sideText(side: EntrySideSummary | null): string {
  if (!side) return "—";
  return side.subAccountName ? `${side.accountName} / ${side.subAccountName}` : side.accountName;
}

function Side({ side }: { side: EntrySideSummary | null }) {
  return (
    <>
      <span className="block truncate">{sideText(side)}</span>
      {side && side.others > 0 ? (
        <span className="block text-[11px] text-muted-2">ほか {side.others} 行</span>
      ) : null}
    </>
  );
}

/** 取消済み / 反対仕訳 / 訂正済み（→ No. x）/ 締め済み (11 §3). */
export function statusLabels(row: JournalEntryListRow): string[] {
  const labels: string[] = [];
  if (row.status === "voided") {
    labels.push(row.replacedBy ? `訂正済み（→ ${entryNo(row.replacedBy.no)}）` : "取消済み");
  }
  if (row.kind === "reversal") labels.push("反対仕訳");
  if (row.isLocked) labels.push("締め済み");
  return labels;
}

/**
 * The journal (仕訳帳) rows: 日付 ・ No. ・ 摘要 ・ 借方 ・ 貸方 ・ 金額 ・ セグメント ・ 状態 on PC, two
 * lines on phones (日付・摘要 / 借方 → 貸方・金額). Each row is one link to the detail.
 */
export function EntriesTable({
  rows,
  listQuery,
}: {
  rows: readonly JournalEntryListRow[];
  /** The list's query, carried to the detail so that 戻る keeps the filters. */
  listQuery: string;
}) {
  return (
    <Table label="仕訳帳" minWidth={880}>
      <TableHead {...COLUMNS}>
        <Th>日付</Th>
        <Th align="right">No.</Th>
        <Th>摘要</Th>
        <Th>借方</Th>
        <Th>貸方</Th>
        <Th align="right">金額（円）</Th>
        <Th>セグメント</Th>
        <Th>状態</Th>
      </TableHead>
      {rows.map((row) => {
        const labels = statusLabels(row);
        return (
          <TableRow
            key={row.id}
            {...COLUMNS}
            muted={row.status === "voided"}
            className="relative hover:bg-black/[0.02]"
          >
            <Td sm="hide" className="num">
              {formatDate(row.entryDate)}
            </Td>
            <Td sm="hide" align="right" className="text-muted">
              {row.no}
            </Td>
            <Td sm="full">
              <span className="num mr-2 text-[12px] text-muted md:hidden">
                {formatDate(row.entryDate)} · {entryNo(row.no)}
              </span>
              <Link
                href={detailHref(row.id, listQuery)}
                className="font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary"
              >
                {row.description}
              </Link>
              {labels.length > 0 ? (
                <span className="ml-2 text-[11px] text-muted md:hidden">{labels.join(" · ")}</span>
              ) : null}
            </Td>
            <Td sm="hide">
              <Side side={row.debit} />
            </Td>
            <Td sm="hide">
              <Side side={row.credit} />
            </Td>
            <span role="cell" className="min-w-0 truncate text-[12px] text-muted md:hidden">
              {sideText(row.debit)} → {sideText(row.credit)}
            </span>
            <Td align="right" className="font-bold">
              {formatYen(row.amount)}
            </Td>
            <Td sm="hide" className="truncate text-[13px]">
              {row.segment ? `${row.segment.name}${row.segment.others ? " ほか" : ""}` : "—"}
            </Td>
            <Td sm="hide" className="text-[11px] text-muted">
              {labels.join(" · ")}
            </Td>
          </TableRow>
        );
      })}
    </Table>
  );
}
