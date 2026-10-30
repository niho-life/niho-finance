import type { PayableListRow, PayablePartnerGroup } from "@niho-finance/db";
import Link from "next/link";
import { Fragment } from "react";
import { Table, TableGroup, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatDate, formatYenDisplay } from "@/lib/format";
import { payableDetailHref, payableStatusParts } from "../_lib/view";

const COLUMNS = {
  columns:
    "104px minmax(0,1fr) minmax(0,1.2fr) 96px 104px 104px minmax(96px,0.8fr) minmax(112px,0.9fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function StatusText({ row }: { row: PayableListRow }) {
  return (
    <>
      {payableStatusParts(row).map((part, index) => (
        <span
          key={part.text}
          className={`${index > 0 ? "ml-1.5" : ""} ${part.tone === "warn" ? "font-bold text-warn" : ""}`}
        >
          {part.text}
        </span>
      ))}
    </>
  );
}

function groupKey(row: { partnerId: string | null; partnerName: string }): string {
  return `${row.partnerId ?? ""}|${row.partnerName}`;
}

/**
 * The list rows (25 §6): 支払期日 ・ 取引先 ・ 内容 ・ 請求日 ・ 金額 ・ 残り ・ 支払元の予定 ・ 状態 on PC,
 * two lines on phones (期日・取引先 / 内容・残りと状態). Each row is one link to the detail; paid and
 * cancelled rows are muted. 取引先別 puts a heading with the partner's rest above its rows.
 */
export function PayablesTable({
  rows,
  groups,
  listQuery,
}: {
  rows: readonly PayableListRow[];
  /** 取引先別: the subtotals (over every matching row); empty for 期日順. */
  groups: readonly PayablePartnerGroup[];
  /** The list's query, carried to the detail so that 戻る keeps the filters. */
  listQuery: string;
}) {
  const subtotals = new Map(groups.map((group) => [groupKey(group), group]));
  return (
    <Table label="支払の一覧" minWidth={920}>
      <TableHead {...COLUMNS}>
        <Th>支払期日</Th>
        <Th>取引先</Th>
        <Th>内容</Th>
        <Th>請求日</Th>
        <Th align="right">金額（円）</Th>
        <Th align="right">残り（円）</Th>
        <Th>支払元の予定</Th>
        <Th>状態</Th>
      </TableHead>
      {rows.map((row, index) => {
        const group = subtotals.get(groupKey(row));
        const previous = rows[index - 1];
        const heading = group && (!previous || groupKey(previous) !== groupKey(row));
        return (
          <Fragment key={row.documentId}>
            {heading ? (
              <TableGroup>
                {group.partnerName || "取引先なし"}
                <span className="num ml-2 font-normal text-muted">
                  残り {formatYenDisplay(group.remaining)} 円（{group.count} 件）
                </span>
              </TableGroup>
            ) : null}
            <TableRow
              {...COLUMNS}
              muted={row.state === "paid" || row.state === "cancelled"}
              className="relative hover:bg-black/[0.02]"
            >
              <Td sm="full">
                <Link
                  href={payableDetailHref(row.documentId, listQuery)}
                  aria-label={`${row.partnerName} ${row.title}`}
                  className="num font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary"
                >
                  {row.dueDate ? formatDate(row.dueDate) : "期日なし"}
                </Link>
                <span className="ml-2 font-semibold break-words md:hidden">{row.partnerName}</span>
              </Td>
              <Td sm="hide" className="truncate">
                {row.partnerName}
              </Td>
              <Td className="min-w-0">
                <span className="block truncate">{row.title}</span>
                <span className="block text-[12px] md:hidden">
                  <StatusText row={row} />
                </span>
              </Td>
              <Td sm="hide" className="num text-[13px]">
                {formatDate(row.invoiceDate)}
              </Td>
              <Td sm="hide" align="right">
                {formatYenDisplay(row.amount)}
              </Td>
              <Td align="right" className="font-bold">
                {formatYenDisplay(row.remaining > 0n ? row.remaining : 0n)}
              </Td>
              <Td sm="hide" className="truncate text-[13px]">
                {row.plannedWallet?.name ?? "—"}
              </Td>
              <Td sm="hide" className="text-[13px]">
                <StatusText row={row} />
              </Td>
            </TableRow>
          </Fragment>
        );
      })}
    </Table>
  );
}
